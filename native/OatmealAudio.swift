// OatmealAudio — native audio helper for Oatmeal.
//
// Subcommands:
//   capture          Capture mic + system audio, emit framed 16kHz mono Int16 PCM on stdout.
//                    Frame: [tag: 1 byte 'M' (mic) | 'S' (system)][length: UInt32 LE][payload]
//   detect --watch   Poll for a likely-active meeting (meeting app running + mic in use),
//                    print a JSON line whenever the state changes.
//   permissions      Print JSON of current mic/screen permission state and trigger prompts.

import AVFoundation
import AppKit
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

let stdoutLock = NSLock()

func writeFrame(tag: UInt8, _ data: Data) {
    var frame = Data(capacity: data.count + 5)
    frame.append(tag)
    var len = UInt32(data.count).littleEndian
    withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }
    frame.append(data)
    stdoutLock.lock()
    FileHandle.standardOutput.write(frame)
    stdoutLock.unlock()
}

func log(_ msg: String) {
    FileHandle.standardError.write(("[OatmealAudio] " + msg + "\n").data(using: .utf8)!)
}

// MARK: - Format conversion to 16kHz mono Int16

final class Downsampler {
    private let converter: AVAudioConverter
    private let outFormat: AVAudioFormat

    init?(from format: AVAudioFormat) {
        guard let out = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)
        else { return nil }
        guard let conv = AVAudioConverter(from: format, to: out) else { return nil }
        self.converter = conv
        self.outFormat = out
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
        let ratio = 16000.0 / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else {
            return nil
        }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if err != nil { return nil }
        guard out.frameLength > 0, let ch = out.int16ChannelData else { return nil }
        return Data(bytes: ch[0], count: Int(out.frameLength) * 2)
    }
}

// MARK: - Microphone capture

final class MicCapture {
    private let engine = AVAudioEngine()
    private var downsampler: Downsampler?

    func start() throws {
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw NSError(domain: "oatmeal", code: 1) }
        downsampler = Downsampler(from: format)
        input.installTap(onBus: 0, bufferSize: 4800, format: format) { [weak self] buffer, _ in
            guard let data = self?.downsampler?.convert(buffer) else { return }
            writeFrame(tag: UInt8(ascii: "M"), data)
        }
        try engine.start()
        log("mic capture started (\(Int(format.sampleRate))Hz \(format.channelCount)ch)")
    }
}

// MARK: - System audio capture (ScreenCaptureKit)

final class SystemCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var downsampler: Downsampler?
    private let queue = DispatchQueue(label: "oatmeal.sysaudio")

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "oatmeal", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "no display found"
            ])
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 1
        // We only want audio; keep video cost minimal.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
        log("system audio capture started")
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc)
        else { return }
        guard let format = AVAudioFormat(streamDescription: asbdPtr) else { return }

        var bufferListSizeNeeded = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &bufferListSizeNeeded,
            bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        let ablPtr = UnsafeMutableRawPointer.allocate(
            byteCount: bufferListSizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { ablPtr.deallocate() }
        var blockBuffer: CMBlockBuffer?
        let abl = ablPtr.assumingMemoryBound(to: AudioBufferList.self)
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: abl,
            bufferListSize: bufferListSizeNeeded, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer)
        guard status == noErr else { return }

        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frameCount > 0,
              let pcm = AVAudioPCMBuffer(
                pcmFormat: format, bufferListNoCopy: abl, deallocator: nil)
        else { return }
        pcm.frameLength = frameCount

        if downsampler == nil { downsampler = Downsampler(from: format) }
        guard let data = downsampler?.convert(pcm) else { return }
        writeFrame(tag: UInt8(ascii: "S"), data)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("system stream stopped: \(error.localizedDescription)")
        exit(3)
    }
}

// MARK: - Meeting detection

let meetingBundleIDs: [String: String] = [
    "us.zoom.xos": "Zoom",
    "com.microsoft.teams2": "Microsoft Teams",
    "com.microsoft.teams": "Microsoft Teams",
    "Cisco-Systems.Spark": "Webex",
    "com.webex.meetingmanager": "Webex",
    "com.apple.FaceTime": "FaceTime",
    "com.hnc.Discord": "Discord",
    "com.tinyspeck.slackmacgap": "Slack",
]

func micInUseElsewhere() -> Bool {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID) == noErr,
        deviceID != 0
    else { return false }
    var running: UInt32 = 0
    size = UInt32(MemoryLayout<UInt32>.size)
    addr.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &running) == noErr
    else { return false }
    return running != 0
}

func detectState() -> (app: String?, micBusy: Bool) {
    let running = NSWorkspace.shared.runningApplications
    var found: String? = nil
    for app in running {
        if let bid = app.bundleIdentifier, let name = meetingBundleIDs[bid] {
            found = name
            break
        }
    }
    return (found, micInUseElsewhere())
}

func runDetectWatch() {
    var lastJSON = ""
    while true {
        let (app, micBusy) = detectState()
        let likely = app != nil && micBusy
        let appJSON = app.map { "\"\($0)\"" } ?? "null"
        let json = "{\"meetingApp\":\(appJSON),\"micBusy\":\(micBusy),\"likelyMeeting\":\(likely)}"
        if json != lastJSON {
            lastJSON = json
            stdoutLock.lock()
            FileHandle.standardOutput.write((json + "\n").data(using: .utf8)!)
            stdoutLock.unlock()
        }
        Thread.sleep(forTimeInterval: 3.0)
    }
}

// MARK: - Permissions

func printPerms() {
    let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    let screen = CGPreflightScreenCaptureAccess()
    let obj: [String: Any] = ["microphone": mic, "screenRecording": screen]
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
}

// Read-only status. NEVER prompts — safe to call on a poll. (Prompting here is
// what made the Screen Recording dialog reappear every refresh.)
func runPermCheck() {
    printPerms()
}

// Explicitly request the microphone (prompts once if undecided). Does not touch
// Screen Recording — that's granted in System Settings and needs a relaunch.
func runRequestMic() {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let sem = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
        sem.wait()
    }
    printPerms()
}

// MARK: - Main

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "capture"

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

switch cmd {
case "capture":
    let mic = MicCapture()
    let sys = SystemCapture()
    do {
        try mic.start()
    } catch {
        log("mic start failed: \(error.localizedDescription)")
        exit(4)
    }
    Task {
        do {
            try await sys.start()
        } catch {
            log("system capture failed: \(error.localizedDescription)")
            exit(5)
        }
    }
    RunLoop.main.run()
case "detect":
    runDetectWatch()
case "permcheck":
    runPermCheck()
case "reqmic":
    runRequestMic()
case "permissions":
    // Back-compat: treat as a read-only check so nothing prompts on a poll.
    runPermCheck()
default:
    log("unknown command: \(cmd)")
    exit(64)
}
