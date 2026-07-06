import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  shell,
  Tray,
  nativeImage,
} from "electron";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppStatus, DetectionState, Settings } from "../shared/types";
import * as db from "./db";
import * as whisper from "./whisper";
import * as ollama from "./ollama";
import { Recorder } from "./recorder";
import { Summarizer } from "./summarizer";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let detectProc: ChildProcess | null = null;
let lastDetection: DetectionState = { meetingApp: null, micBusy: false, likelyMeeting: false };
let notifiedForCurrentMeeting = false;

// One active recording at a time.
let recorder: Recorder | null = null;
let summarizer: Summarizer | null = null;
let activeMeetingId: string | null = null;

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args);
}

function getSettings(): Settings {
  return {
    sttModel: db.getSetting("sttModel") ?? "small.en",
    llmModel: db.getSetting("llmModel") ?? "qwen2.5:14b",
    detectionEnabled: (db.getSetting("detectionEnabled") ?? "true") === "true",
  };
}

async function getStatus(): Promise<AppStatus> {
  const s = getSettings();
  const perms = await checkPermissions();
  return {
    ollamaUp: await ollama.ollamaUp(),
    whisperReady: whisper.whisperReady(),
    sttModel: whisper.currentSttModel() ?? s.sttModel,
    llmModel: s.llmModel,
    permissions: perms,
  };
}

function checkPermissions(): Promise<{ microphone: boolean; screenRecording: boolean }> {
  return new Promise((resolve) => {
    execFile(whisper.binaryPath("OatmealAudio"), ["permissions"], { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve({ microphone: false, screenRecording: false });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve({ microphone: false, screenRecording: false });
        }
      });
  });
}

function startDetection() {
  if (detectProc) return;
  detectProc = spawn(whisper.binaryPath("OatmealAudio"), ["detect"]);
  let buf = "";
  detectProc.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const state = JSON.parse(line) as DetectionState;
        lastDetection = state;
        send("detection", state);
        if (state.likelyMeeting && !activeMeetingId && !notifiedForCurrentMeeting) {
          notifiedForCurrentMeeting = true;
          const n = new Notification({
            title: "Meeting detected",
            body: `${state.meetingApp} looks active. Start taking notes?`,
          });
          n.on("click", () => {
            win?.show();
            send("detection-start-requested");
          });
          n.show();
        }
        if (!state.likelyMeeting) notifiedForCurrentMeeting = false;
      } catch {
        /* skip */
      }
    }
  });
  detectProc.on("exit", () => {
    detectProc = null;
  });
}

function stopDetection() {
  detectProc?.kill("SIGTERM");
  detectProc = null;
}

async function startRecording(title: string): Promise<string> {
  if (activeMeetingId) throw new Error("a meeting is already being recorded");
  const s = getSettings();
  if (!whisper.whisperReady()) await whisper.startWhisper(s.sttModel);

  const id = randomUUID();
  db.createMeeting(id, title || "Untitled meeting");
  activeMeetingId = id;

  summarizer = new Summarizer(id, s.llmModel, (md) => send("summary", id, md));
  recorder = new Recorder(
    id,
    (seg) => {
      send("segment", seg);
      summarizer?.push(seg);
    },
    (msg) => send("recorder-error", msg)
  );
  recorder.start();
  summarizer.start();
  send("recording-state", { meetingId: id, recording: true });
  return id;
}

async function stopRecording(): Promise<void> {
  if (!activeMeetingId) return;
  const id = activeMeetingId;
  await recorder?.stop();
  recorder = null;
  await summarizer?.stop();
  summarizer = null;
  db.endMeeting(id);
  activeMeetingId = null;
  send("recording-state", { meetingId: id, recording: false });
  send("summary", id, db.getMeeting(id)?.summaryMd ?? "");
}

function buildTranscriptContext(meetingId: string): string {
  const segs = db.listSegments(meetingId);
  // Guard the context window: keep the most recent ~24k chars.
  const lines = segs.map((s) => `${s.speaker === "me" ? "Me" : "Them"}: ${s.text}`);
  let text = lines.join("\n");
  if (text.length > 24000) text = "…(earlier transcript truncated)\n" + text.slice(-24000);
  return text;
}

function registerIpc() {
  ipcMain.handle("status", () => getStatus());
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    for (const [k, v] of Object.entries(patch)) db.setSetting(k, String(v));
    const s = getSettings();
    if (patch.detectionEnabled !== undefined) {
      patch.detectionEnabled ? startDetection() : stopDetection();
    }
    return s;
  });

  ipcMain.handle("meetings:list", () => db.listMeetings());
  ipcMain.handle("meetings:get", (_e, id: string) => ({
    meeting: db.getMeeting(id),
    segments: db.listSegments(id),
    chat: db.listChatMessages(id),
  }));
  ipcMain.handle("meetings:rename", (_e, id: string, title: string) =>
    db.renameMeeting(id, title)
  );
  ipcMain.handle("meetings:delete", (_e, id: string) => db.deleteMeeting(id));

  ipcMain.handle("recording:start", (_e, title: string) => startRecording(title));
  ipcMain.handle("recording:stop", () => stopRecording());
  ipcMain.handle("recording:active", () => activeMeetingId);

  ipcMain.handle("stt:list", () => whisper.listSttModels());
  ipcMain.handle("stt:download", async (_e, id: string) => {
    await whisper.downloadSttModel(id, (p) => send("download-progress", p));
  });
  ipcMain.handle("stt:use", async (_e, id: string) => {
    db.setSetting("sttModel", id);
    await whisper.startWhisper(id);
  });

  ipcMain.handle("ollama:list", () => ollama.listOllamaModels());
  ipcMain.handle("ollama:pull", async (_e, name: string) => {
    await ollama.pullOllamaModel(name, (p) => send("download-progress", p));
  });

  ipcMain.handle("chat:send", async (_e, meetingId: string, content: string) => {
    const s = getSettings();
    db.addChatMessage(meetingId, "user", content);
    const meeting = db.getMeeting(meetingId);
    const transcript = buildTranscriptContext(meetingId);
    const history = db.listChatMessages(meetingId).slice(-12);
    const system = `You answer questions about a meeting using its transcript and summary. "Me" is the app user; "Them" is everyone else. Quote the transcript when helpful. If something isn't in the transcript, say so plainly.

MEETING: ${meeting?.title ?? ""}
SUMMARY:
${meeting?.summaryMd || "(no summary yet)"}

TRANSCRIPT:
${transcript || "(no transcript yet)"}`;
    const messages = [
      { role: "system" as const, content: system },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];
    const full = await ollama.chatStream(s.llmModel, messages, (t) =>
      send("chat-token", meetingId, t)
    );
    db.addChatMessage(meetingId, "assistant", full);
    send("chat-done", meetingId, full);
    return full;
  });

  ipcMain.handle("permissions:check", () => checkPermissions());
  ipcMain.handle("open-external", (_e, url: string) => shell.openExternal(url));
  ipcMain.handle("open-privacy-settings", (_e, pane: "mic" | "screen") => {
    const url =
      pane === "mic"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    return shell.openExternal(url);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#f7f7f2",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  win.on("closed", () => (win = null));
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    // 16x16 template dot — simple bowl glyph placeholder
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR4nGNgGAWDHzAiC/z//x+riocPH4LVSEtLM6LLMZFrMwsuCXt7e5xOOnLkCFwtC7oELvDs2TMMtSSbjA5GDRg1gIGBgYHx////WBMSAwMDg7GxMd5EBgD9phGeb84LhAAAAABJRU5ErkJggg=="
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Oatmeal");
  tray.on("click", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  db.initDb();
  registerIpc();
  createWindow();
  createTray();
  if (getSettings().detectionEnabled) startDetection();

  // Warm up whisper in the background if the default model is present.
  const s = getSettings();
  const installed = whisper.listSttModels().find((m) => m.id === s.sttModel)?.installed;
  if (installed) whisper.startWhisper(s.sttModel).catch((e) => console.error(e));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Keep running in the tray (meeting detection) like a real notetaker.
});

app.on("before-quit", async (e) => {
  if (activeMeetingId) {
    e.preventDefault();
    await stopRecording();
    app.quit();
  }
  stopDetection();
  await whisper.stopWhisper();
});
