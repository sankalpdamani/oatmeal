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

// MARK: - System audio capture (Core Audio process tap)
//
// Uses a Core Audio process tap + private aggregate device (macOS 14.4+) to
// capture system audio. This needs only the lightweight "System Audio Recording
// Only" permission — NOT Screen Recording, which ScreenCaptureKit would require.

final class SystemAudioTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(0)
    private var ioProcID: AudioDeviceIOProcID?
    private var format: AVAudioFormat?
    private var downsampler: Downsampler?
    private let queue = DispatchQueue(label: "oatmeal.systap")

    func start() throws {
        // 1. Tap all system audio (stereo, all processes — Oatmeal plays none, so
        //    there's nothing of ours to exclude). This is what prompts for the
        //    "System Audio Recording Only" permission on first use.
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.name = "Oatmeal System Audio"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        var status = AudioHardwareCreateProcessTap(desc, &tapID)
        guard status == noErr, tapID != kAudioObjectUnknown else {
            throw NSError(domain: "oatmeal", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "process tap create failed (\(status))"
            ])
        }

        // 2. Tap UID, needed to attach it to an aggregate device.
        var uidRef: CFString = "" as CFString
        var uidSize = UInt32(MemoryLayout<CFString>.size)
        var uidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        status = withUnsafeMutablePointer(to: &uidRef) {
            AudioObjectGetPropertyData(tapID, &uidAddr, 0, nil, &uidSize, $0)
        }
        guard status == noErr else {
            throw NSError(domain: "oatmeal", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "tap UID read failed (\(status))"
            ])
        }
        let tapUID = uidRef as String

        // 3. Private aggregate device that pulls from the tap.
        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Oatmeal Audio",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[String: Any]](),
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapUIDKey: tapUID,
                    kAudioSubTapDriftCompensationKey: true,
                ]
            ],
        ]
        status = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggregateID)
        guard status == noErr, aggregateID != 0 else {
            throw NSError(domain: "oatmeal", code: 12, userInfo: [
                NSLocalizedDescriptionKey: "aggregate device create failed (\(status))"
            ])
        }

        // 4. Format the aggregate delivers on its input scope.
        var asbd = AudioStreamBasicDescription()
        var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: 0)
        status = AudioObjectGetPropertyData(aggregateID, &fmtAddr, 0, nil, &asbdSize, &asbd)
        guard status == noErr, let fmt = AVAudioFormat(streamDescription: &asbd) else {
            throw NSError(domain: "oatmeal", code: 13, userInfo: [
                NSLocalizedDescriptionKey: "aggregate format read failed (\(status))"
            ])
        }
        self.format = fmt
        self.downsampler = Downsampler(from: fmt)

        // 5. Receive audio via an IOProc and forward it downsampled.
        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, queue) {
            [weak self] _, inInputData, _, _, _ in
            self?.handle(inInputData)
        }
        guard status == noErr, ioProcID != nil else {
            throw NSError(domain: "oatmeal", code: 14, userInfo: [
                NSLocalizedDescriptionKey: "IOProc create failed (\(status))"
            ])
        }
        status = AudioDeviceStart(aggregateID, ioProcID)
        guard status == noErr else {
            throw NSError(domain: "oatmeal", code: 15, userInfo: [
                NSLocalizedDescriptionKey: "device start failed (\(status))"
            ])
        }
        log("system audio tap started")
    }

    private func handle(_ inInputData: UnsafePointer<AudioBufferList>) {
        guard let fmt = format else { return }
        guard let pcm = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: inInputData, deallocator: nil)
        else { return }
        guard let data = downsampler?.convert(pcm) else { return }
        writeFrame(tag: UInt8(ascii: "S"), data)
    }

    func stop() {
        if let ioProcID = ioProcID {
            AudioDeviceStop(aggregateID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
            self.ioProcID = nil
        }
        if aggregateID != 0 {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = 0
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
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

func printJSON(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
}

// Read-only mic status. NEVER prompts — safe to call on a poll.
func runPermCheck() {
    let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    printJSON(["microphone": mic])
}

// Explicitly request the microphone (prompts once if undecided).
func runRequestMic() {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let sem = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
        sem.wait()
    }
    let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    printJSON(["microphone": mic])
}

// Explicitly request System Audio Recording by briefly creating a tap, which
// triggers the macOS prompt. Reports whether the tap could start.
func runRequestSystemAudio() {
    let tap = SystemAudioTap()
    var ok = false
    do {
        try tap.start()
        ok = true
    } catch {
        log("system audio request failed: \(error.localizedDescription)")
    }
    tap.stop()
    printJSON(["systemAudio": ok])
}

// MARK: - Main

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "capture"

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

switch cmd {
case "capture":
    let mic = MicCapture()
    let sys = SystemAudioTap()
    do {
        try mic.start()
    } catch {
        log("mic start failed: \(error.localizedDescription)")
        exit(4)
    }
    do {
        try sys.start()
    } catch {
        log("system audio tap failed: \(error.localizedDescription)")
        exit(5)
    }
    RunLoop.main.run()
case "detect":
    runDetectWatch()
case "permcheck":
    runPermCheck()
case "reqmic":
    runRequestMic()
case "reqsysaudio":
    runRequestSystemAudio()
case "permissions":
    // Back-compat: treat as a read-only check so nothing prompts on a poll.
    runPermCheck()
default:
    log("unknown command: \(cmd)")
    exit(64)
}
