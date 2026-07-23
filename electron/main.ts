import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  shell,
  Tray,
  nativeImage,
} from "electron";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppStatus, DetectionState, Segment, Settings } from "../shared/types";
import * as db from "./db";
import * as whisper from "./whisper";
import * as llm from "./ollama";
import { Recorder } from "./recorder";
import { generateSummary, generateTitle } from "./finalize";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let detectProc: ChildProcess | null = null;
let notifiedForCurrentMeeting = false;

// One active recording at a time.
let recorder: Recorder | null = null;
let activeMeetingId: string | null = null;
let startedByApp: string | null = null; // meeting app that triggered the recording
let endGraceTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_END_GRACE_MS = 30000;

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args);
}

function getSettings(): Settings {
  return {
    sttModel: db.getSetting("sttModel") ?? "small.en",
    llmModel: db.getSetting("llmModel") ?? "qwen2.5:14b",
    llmBaseUrl: db.getSetting("llmBaseUrl") ?? llm.DEFAULT_LLM_BASE_URL,
    detectionEnabled: (db.getSetting("detectionEnabled") ?? "true") === "true",
  };
}

async function getStatus(): Promise<AppStatus> {
  const s = getSettings();
  const perms = await checkPermissions();
  return {
    llmUp: await llm.llmUp(),
    whisperReady: whisper.whisperReady(),
    sttModel: whisper.currentSttModel() ?? s.sttModel,
    llmModel: s.llmModel,
    llmBaseUrl: s.llmBaseUrl,
    permissions: perms,
  };
}

// Read-only permission status. Safe to call on a poll — never prompts.
function checkPermissions(): Promise<{ microphone: boolean; screenRecording: boolean }> {
  return runHelperPerms("permcheck");
}

// Explicitly ask for the microphone (shows the prompt once). Triggered only by
// a user action, never by status polling.
function requestMicPermission(): Promise<{ microphone: boolean; screenRecording: boolean }> {
  return runHelperPerms("reqmic");
}

function runHelperPerms(
  sub: "permcheck" | "reqmic"
): Promise<{ microphone: boolean; screenRecording: boolean }> {
  return new Promise((resolve) => {
    execFile(whisper.binaryPath("OatmealAudio"), [sub], { timeout: 15000 }, (err, stdout) => {
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
        send("detection", state);
        // Offer to start notes when a meeting appears and we're idle.
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
        // Auto-end: if this recording was started for a meeting app and that
        // app is no longer present, the call has ended. (We can't use mic-idle
        // while recording — our own capture holds the mic.)
        if (activeMeetingId && startedByApp) {
          const appGone = state.meetingApp !== startedByApp;
          if (appGone) armAutoEnd();
          else cancelAutoEnd();
        }
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

function armAutoEnd() {
  if (endGraceTimer || !activeMeetingId) return;
  send("auto-end-pending", { graceMs: AUTO_END_GRACE_MS });
  endGraceTimer = setTimeout(() => {
    endGraceTimer = null;
    void stopRecording("auto");
  }, AUTO_END_GRACE_MS);
}

function cancelAutoEnd() {
  if (endGraceTimer) {
    clearTimeout(endGraceTimer);
    endGraceTimer = null;
    send("auto-end-cancelled");
  }
}

async function startRecording(title: string, appName?: string | null): Promise<string> {
  if (activeMeetingId) throw new Error("a meeting is already being recorded");
  const s = getSettings();
  if (!whisper.whisperReady()) await whisper.startWhisper(s.sttModel);

  const id = randomUUID();
  db.createMeeting(id, title || (appName ? `${appName} meeting` : "New meeting"));
  activeMeetingId = id;
  startedByApp = appName ?? null;

  recorder = new Recorder(
    id,
    (seg) => send("segment", seg),
    (code) => void abortRecording(code)
  );
  recorder.start();
  send("recording-state", { meetingId: id, recording: true });
  return id;
}

// The audio helper died before/while capturing (permissions, no display, …).
// Tear the recording down instead of leaving the UI stuck "listening", and
// tell the user what to do — Screen Recording only takes effect after a relaunch.
async function abortRecording(code: number | null): Promise<void> {
  const id = activeMeetingId;
  cancelAutoEnd();
  await recorder?.stop().catch(() => {});
  recorder = null;
  activeMeetingId = null;
  startedByApp = null;
  notifiedForCurrentMeeting = false;

  if (id) {
    // Nothing usable was captured — discard the empty meeting we just created.
    if (db.listSegments(id).length === 0) db.deleteMeeting(id);
    else db.endMeeting(id);
    send("recording-state", { meetingId: id, recording: false, reason: "error" });
  }

  // code 5 = ScreenCaptureKit/system-audio couldn't start, almost always the
  // Screen Recording grant not yet in effect for this launch.
  const msg =
    code === 5
      ? "Couldn't capture system audio. If you just enabled Screen Recording for Oatmeal, quit and reopen the app — macOS only applies it on the next launch."
      : `Audio helper stopped (code ${code}). Check Screen Recording & Microphone permissions, then relaunch Oatmeal.`;
  send("recorder-error", msg);
}

// Stop capture, then generate the polished note + AI title (Granola-style).
async function stopRecording(reason: "manual" | "auto" = "manual"): Promise<void> {
  if (!activeMeetingId) return;
  const id = activeMeetingId;
  cancelAutoEnd();
  await recorder?.stop();
  recorder = null;
  db.endMeeting(id);
  activeMeetingId = null;
  startedByApp = null;
  notifiedForCurrentMeeting = false;
  send("recording-state", { meetingId: id, recording: false, reason });

  // Finalize: summary + title from the full transcript.
  send("finalizing", { meetingId: id });
  const segments: Segment[] = db.listSegments(id);
  const model = getSettings().llmModel;
  try {
    const existing = db.getMeeting(id);
    const wasAutoTitled = !existing?.title || /meeting$|^New meeting$/i.test(existing.title);
    const [summary, title] = await Promise.all([
      generateSummary(model, segments),
      wasAutoTitled ? generateTitle(model, segments) : Promise.resolve(existing!.title),
    ]);
    db.saveSummary(id, summary);
    if (title && title !== existing?.title) db.renameMeeting(id, title);
  } catch (e) {
    console.error("finalize failed:", e);
    send("recorder-error", `Couldn't write the summary — is your LLM server running? (${String(e)})`);
  }
  const m = db.getMeeting(id);
  send("finalized", { meetingId: id, title: m?.title ?? "", summaryMd: m?.summaryMd ?? "" });
}

function transcriptMarkdown(meetingId: string): string {
  const m = db.getMeeting(meetingId);
  const segs = db.listSegments(meetingId);
  const when = m ? new Date(m.startedAt).toLocaleString() : "";
  const body = segs
    .map((s) => `**${s.speaker === "me" ? "Me" : "Them"}:** ${s.text}`)
    .join("\n\n");
  return `# ${m?.title ?? "Meeting"}\n\n_${when}_\n\n${body || "_No transcript captured._"}\n`;
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
    if (patch.llmBaseUrl !== undefined) llm.setLlmBaseUrl(s.llmBaseUrl);
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

  ipcMain.handle("recording:start", (_e, title: string, appName?: string | null) =>
    startRecording(title, appName)
  );
  ipcMain.handle("recording:stop", () => stopRecording("manual"));
  ipcMain.handle("recording:active", () => activeMeetingId);
  ipcMain.handle("recording:keep", () => cancelAutoEnd());

  ipcMain.handle("transcript:export", async (_e, meetingId: string) => {
    const m = db.getMeeting(meetingId);
    const safe = (m?.title ?? "meeting").replace(/[^\w\- ]+/g, "").trim() || "meeting";
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: "Download transcript",
      defaultPath: `${safe}.md`,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Text", extensions: ["txt"] },
      ],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, transcriptMarkdown(meetingId), "utf8");
    return filePath;
  });

  ipcMain.handle("stt:list", () => whisper.listSttModels());
  ipcMain.handle("stt:download", async (_e, id: string) => {
    await whisper.downloadSttModel(id, (p) => send("download-progress", p));
  });
  ipcMain.handle("stt:use", async (_e, id: string) => {
    db.setSetting("sttModel", id);
    await whisper.startWhisper(id);
  });

  ipcMain.handle("llm:list", () => llm.listLlmModels());

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
    const full = await llm.chatStream(s.llmModel, messages, (t) =>
      send("chat-token", meetingId, t)
    );
    db.addChatMessage(meetingId, "assistant", full);
    send("chat-done", meetingId, full);
    return full;
  });

  ipcMain.handle("permissions:check", () => checkPermissions());
  ipcMain.handle("permissions:request-mic", () => requestMicPermission());
  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });
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
  llm.setLlmBaseUrl(getSettings().llmBaseUrl);
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
