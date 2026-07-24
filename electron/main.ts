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
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppStatus, DetectionState, Segment, Settings } from "../shared/types";
import * as db from "./db";
import * as whisper from "./whisper";
import * as llm from "./ollama";
import { Recorder } from "./recorder";
import { generateSummary, generateTitle, stripEmojis } from "./finalize";
import * as retrieval from "./retrieval";

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
// Embed transcript chunks in the background during a meeting so chat is instant.
let embedTimer: ReturnType<typeof setInterval> | null = null;
const EMBED_INTERVAL_MS = 45000;

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args);
}

// Size the default Whisper model to the machine so transcription keeps up in
// real time: the lighter/faster base.en on low-memory Macs, small.en otherwise.
// Falls back to whatever is actually bundled (the lite build ships base.en
// only), so the default always works offline. Applies until the user explicitly
// picks a model in Settings (which persists sttModel).
function defaultSttModel(): string {
  const totalGib = os.totalmem() / 1024 ** 3;
  const preferred = totalGib <= 8.5 ? "base.en" : "small.en";
  const installed = whisper.listSttModels().filter((m) => m.installed).map((m) => m.id);
  if (installed.includes(preferred)) return preferred;
  return installed[0] ?? preferred;
}

function getSettings(): Settings {
  return {
    sttModel: db.getSetting("sttModel") ?? defaultSttModel(),
    // Empty until the user picks one or we adopt an installed model — we never
    // force a specific (heavy) model on the user's machine. See resolveLlmModel.
    llmModel: db.getSetting("llmModel") ?? "",
    llmBaseUrl: db.getSetting("llmBaseUrl") ?? llm.DEFAULT_LLM_BASE_URL,
    embedModel: db.getSetting("embedModel") ?? "nomic-embed-text",
    detectionEnabled: (db.getSetting("detectionEnabled") ?? "true") === "true",
  };
}

// Auto-pull the embedding model once the LLM server is reachable (Ollama only).
let embedModelEnsured = false;
// Resolved embedding model actually used for retrieval — works on ANY server.
let resolvedEmbedModel: string | null = null;
async function ensureEmbedModel(): Promise<void> {
  const model = getSettings().embedModel;
  if (!model) return;
  try {
    if (!(await llm.isOllama())) return; // only Ollama supports pulling
    if (await llm.hasModel(model)) {
      retrieval.resetEmbedAvailability();
      return;
    }
    console.log(`auto-pulling embedding model "${model}"…`);
    await llm.pullModel(model);
    retrieval.resetEmbedAvailability();
    resolvedEmbedModel = null; // re-detect now that it's installed
    console.log(`embedding model "${model}" ready`);
  } catch (e) {
    console.error("auto-pull of embedding model skipped:", (e as Error).message);
  }
}

// The embedding model to actually use. Prefers the configured name if the
// server has it; otherwise auto-detects any embedding model the server exposes
// (works on Ollama, LM Studio, Jan, … — not just Ollama). Cached until settings
// change. Empty string means "use configured as-is" (retrieval will fall back
// to keyword search if it isn't available).
async function resolveEmbedModel(): Promise<string> {
  if (resolvedEmbedModel !== null) return resolvedEmbedModel;
  const configured = getSettings().embedModel;
  try {
    const ids = (await llm.listLlmModels()).map((m) => m.id);
    if (configured && ids.includes(configured)) resolvedEmbedModel = configured;
    else resolvedEmbedModel = ids.find((id) => /embed/i.test(id)) ?? configured ?? "";
  } catch {
    resolvedEmbedModel = configured ?? "";
  }
  return resolvedEmbedModel;
}

// Warm embeddings for a meeting using the resolved (server-appropriate) model.
function prewarm(meetingId: string, includeLast = false) {
  void resolveEmbedModel().then((em) => retrieval.prewarmEmbeddings(meetingId, em, includeLast));
}

// Roughly how big a model is, from a "…7b"/"…14b" hint in its name (used to
// prefer lighter models on unknown machines). No hint → treated as large.
function paramSize(id: string): number {
  const m = id.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  return m ? parseFloat(m[1]) : 999;
}

// The model to use for chat/summaries. Respects an explicit choice; otherwise
// adopts the lightest model the user already has installed (and remembers it),
// so we never impose a model their machine can't run. Empty if none available.
async function resolveLlmModel(): Promise<string> {
  const chosen = db.getSetting("llmModel");
  if (chosen) return chosen;
  try {
    const ids = (await llm.listLlmModels()).map((m) => m.id).filter((id) => !/embed/i.test(id));
    if (ids.length > 0) {
      const pick = [...ids].sort((a, b) => paramSize(a) - paramSize(b))[0];
      db.setSetting("llmModel", pick); // adopt as this machine's default
      return pick;
    }
  } catch {
    /* server unreachable / no models yet */
  }
  return "";
}

async function getStatus(): Promise<AppStatus> {
  const s = getSettings();
  const up = await llm.llmUp();
  if (up && !embedModelEnsured) {
    embedModelEnsured = true;
    void ensureEmbedModel();
  }
  const model = up ? await resolveLlmModel() : s.llmModel;
  return {
    llmUp: up,
    whisperReady: whisper.whisperReady(),
    sttModel: whisper.currentSttModel() ?? s.sttModel,
    llmModel: model || null,
    llmBaseUrl: s.llmBaseUrl,
    permissions: {
      // Mic has a clean, non-prompting status API. System Audio (Core Audio
      // taps) has no preflight, so we remember once it has been granted.
      microphone: await micGranted(),
      systemAudio: db.getSetting("systemAudioGranted") === "true",
    },
  };
}

function runHelper(sub: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    execFile(whisper.binaryPath("OatmealAudio"), [sub], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve({});
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({});
      }
    });
  });
}

// Read-only mic status — safe to poll, never prompts.
async function micGranted(): Promise<boolean> {
  return !!(await runHelper("permcheck")).microphone;
}

// Explicit prompts, triggered only by a user action.
async function requestMicPermission(): Promise<boolean> {
  return !!(await runHelper("reqmic")).microphone;
}

async function requestSystemAudioPermission(): Promise<boolean> {
  const ok = !!(await runHelper("reqsysaudio")).systemAudio;
  if (ok) db.setSetting("systemAudioGranted", "true");
  return ok;
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

  // Embed transcript chunks as the meeting runs so chat is instant afterward.
  retrieval.resetEmbedAvailability();
  embedTimer = setInterval(() => prewarm(id), EMBED_INTERVAL_MS);

  send("recording-state", { meetingId: id, recording: true });
  return id;
}

function stopEmbedTimer() {
  if (embedTimer) {
    clearInterval(embedTimer);
    embedTimer = null;
  }
}

// The audio helper died before/while capturing (permissions, format, …).
// Tear the recording down instead of leaving the UI stuck "listening".
async function abortRecording(code: number | null): Promise<void> {
  const id = activeMeetingId;
  cancelAutoEnd();
  stopEmbedTimer();
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

  if (code === 5) {
    // System-audio tap couldn't start — the System Audio Recording permission
    // isn't in effect. Forget the cached grant so the UI re-prompts for it.
    db.setSetting("systemAudioGranted", "false");
  }
  console.error(`audio helper exited with code ${code}`);
  const msg =
    code === 5
      ? "Couldn't capture system audio. Enable System Audio Recording for Oatmeal in System Settings ▸ Privacy & Security, then try again."
      : code === 4
        ? "Couldn't access the microphone. Grant Microphone access to Oatmeal in System Settings ▸ Privacy & Security."
        : "Audio capture stopped unexpectedly. Check Oatmeal's Microphone and System Audio permissions in System Settings, then start again.";
  send("recorder-error", msg);
}

// Stop capture, then generate the polished note + AI title (Granola-style).
async function stopRecording(reason: "manual" | "auto" = "manual"): Promise<void> {
  if (!activeMeetingId) return;
  const id = activeMeetingId;
  cancelAutoEnd();
  stopEmbedTimer();
  await recorder?.stop();
  recorder = null;
  db.endMeeting(id);
  activeMeetingId = null;
  startedByApp = null;
  notifiedForCurrentMeeting = false;
  send("recording-state", { meetingId: id, recording: false, reason });

  // Embed the whole transcript (including the final partial chunk) so chat is
  // ready the moment the meeting opens. Best-effort; doesn't block finalize.
  prewarm(id, true);

  // Finalize: summary + title from the full transcript.
  send("finalizing", { meetingId: id });
  const segments: Segment[] = db.listSegments(id);
  const model = await resolveLlmModel();
  if (!model) {
    // No local model available — skip the AI note rather than erroring.
    const m0 = db.getMeeting(id);
    send("finalized", { meetingId: id, title: m0?.title ?? "", summaryMd: m0?.summaryMd ?? "" });
    return;
  }
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
    send(
      "recorder-error",
      "Couldn't write the summary — your local AI wasn't reachable. Open it (e.g. Ollama), then reopen this meeting to try again."
    );
  }
  const m = db.getMeeting(id);
  send("finalized", { meetingId: id, title: m?.title ?? "", summaryMd: m?.summaryMd ?? "" });
}

// Loopback-only control endpoint for the Oatmeal MCP server (mcp/).
// Lets Claude check status and start/stop recordings when the app is running.
const CONTROL_PORT = 17772;
function startControlServer() {
  const srv = http.createServer(async (req, res) => {
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      if (req.method === "GET" && req.url === "/status") {
        const meeting = activeMeetingId ? db.getMeeting(activeMeetingId) : null;
        return json(200, {
          recording: !!activeMeetingId,
          meetingId: activeMeetingId,
          meetingTitle: meeting?.title ?? null,
          whisperReady: whisper.whisperReady(),
          llmUp: await llm.llmUp(),
        });
      }
      if (req.method === "POST" && req.url === "/start") {
        if (activeMeetingId) {
          return json(409, {
            error: "A meeting is already being recorded. Stop it first with /stop.",
          });
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const { title = "" } = body ? (JSON.parse(body) as { title?: string }) : {};
        const id = await startRecording(title || "");
        win?.show();
        return json(200, { started: true, meetingId: id });
      }
      if (req.method === "POST" && req.url === "/stop") {
        if (!activeMeetingId) return json(409, { error: "No active recording to stop." });
        const id = activeMeetingId;
        await stopRecording("manual");
        const m = db.getMeeting(id);
        return json(200, {
          stopped: true,
          meetingId: id,
          title: m?.title ?? "",
          summaryMarkdown: m?.summaryMd ?? "",
        });
      }
      json(404, { error: "Unknown route. Available: GET /status, POST /start, POST /stop." });
    } catch (e) {
      json(500, { error: String(e instanceof Error ? e.message : e) });
    }
  });
  srv.on("error", (e) => console.error("control server error:", e));
  srv.listen(CONTROL_PORT, "127.0.0.1");
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

function registerIpc() {
  ipcMain.handle("status", () => getStatus());
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    for (const [k, v] of Object.entries(patch)) db.setSetting(k, String(v));
    const s = getSettings();
    if (patch.detectionEnabled !== undefined) {
      patch.detectionEnabled ? startDetection() : stopDetection();
    }
    if (patch.llmBaseUrl !== undefined) {
      llm.setLlmBaseUrl(s.llmBaseUrl);
      retrieval.resetEmbedAvailability();
      embedModelEnsured = false;
      resolvedEmbedModel = null;
    }
    if (patch.embedModel !== undefined) {
      retrieval.resetEmbedAvailability();
      embedModelEnsured = false;
      resolvedEmbedModel = null;
    }
    return s;
  });

  ipcMain.handle("meetings:list", () => db.listMeetings());
  ipcMain.handle("meetings:get", (_e, id: string) => {
    // Warm embeddings when a meeting is opened so its first chat is instant.
    prewarm(id, true);
    return {
      meeting: db.getMeeting(id),
      segments: db.listSegments(id),
      chat: db.listChatMessages(id),
    };
  });
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
    const model = await resolveLlmModel();
    if (!model) {
      const full =
        "No local model is set up yet. Open your AI app (e.g. Ollama) and pick a model in Settings, then ask again.";
      db.addChatMessage(meetingId, "assistant", full);
      send("chat-done", meetingId, full);
      return full;
    }
    const meeting = db.getMeeting(meetingId);
    // Retrieve only the relevant transcript excerpts for this question, plus the
    // summary (a compact whole-meeting view). Keeps the prompt small and fast.
    const transcript = await retrieval.retrieveContext(meetingId, content, await resolveEmbedModel());
    const history = db.listChatMessages(meetingId).slice(-8);
    const system = `You answer questions about a meeting using its summary and the relevant transcript excerpts below. In the transcript, "Me" is the person you're talking to — address them as "you". "Them" is the other participant(s) on the call — refer to them naturally as "the other participant", "someone on the call", or "the other side", and never write the literal word "Them". Quote wording from the excerpts when helpful. If the answer isn't in the excerpts, say so plainly. Keep answers short and skimmable. Do not use emojis or decorative symbols.

MEETING: ${meeting?.title ?? ""}
SUMMARY:
${meeting?.summaryMd || "(no summary yet)"}

RELEVANT TRANSCRIPT:
${transcript || "(no transcript yet)"}`;
    const messages = [
      { role: "system" as const, content: system },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];
    let full = "";
    try {
      // Cap output length so answers come back fast and stay skimmable.
      full = stripEmojis(
        (await llm.chatStream(model, messages, (t) => send("chat-token", meetingId, t), 512)).trim()
      );
    } catch (e) {
      // ollama.ts throws customer-friendly messages; show one as the reply.
      full = (e as Error)?.message || "Something went wrong. Please try again.";
    }
    if (!full) {
      full = "I didn't get a reply that time. Try asking again, or choose a different model in Settings.";
    }
    db.addChatMessage(meetingId, "assistant", full);
    send("chat-done", meetingId, full);
    return full;
  });

  ipcMain.handle("permissions:request-mic", () => requestMicPermission());
  ipcMain.handle("permissions:request-systemaudio", () => requestSystemAudioPermission());
  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("open-external", (_e, url: string) => shell.openExternal(url));
  ipcMain.handle("open-privacy-settings", (_e, pane: "mic" | "systemaudio") => {
    // The "System Audio Recording Only" list lives in the Screen Recording pane.
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
  startControlServer();
  createWindow();
  createTray();

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
