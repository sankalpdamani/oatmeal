// Manages the bundled whisper.cpp `whisper-server` process and STT model files.
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { DownloadProgress, SttModel } from "../shared/types";

const WHISPER_PORT = 17771;
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export const STT_CATALOG: Omit<SttModel, "installed">[] = [
  {
    id: "base.en",
    label: "Whisper base.en — fastest, rougher",
    sizeMb: 148,
    file: "ggml-base.en.bin",
    url: `${HF_BASE}/ggml-base.en.bin`,
  },
  {
    id: "small.en",
    label: "Whisper small.en — recommended balance",
    sizeMb: 488,
    file: "ggml-small.en.bin",
    url: `${HF_BASE}/ggml-small.en.bin`,
  },
  {
    id: "large-v3-turbo",
    label: "Whisper large-v3-turbo — best accuracy, multilingual",
    sizeMb: 1624,
    file: "ggml-large-v3-turbo.bin",
    url: `${HF_BASE}/ggml-large-v3-turbo.bin`,
  },
  {
    id: "small.en-tdrz",
    label: "Whisper small.en-tdrz — separates remote speakers' turns",
    sizeMb: 488,
    file: "ggml-small.en-tdrz.bin",
    url: `${HF_BASE}/ggml-small.en-tdrz.bin`,
  },
];

export function modelsDir(): string {
  const dir = path.join(app.getPath("userData"), "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function bundledModelsDir(): string {
  // Models shipped inside the app. Packaged: Resources/models. Dev: <repo>/resources/models.
  return app.isPackaged
    ? path.join(process.resourcesPath, "models")
    : path.join(app.getAppPath(), "resources", "models");
}

// Resolve a model file to a readable path. A user-downloaded copy in userData
// takes precedence over a copy bundled with the app; returns null if neither
// exists.
export function modelFilePath(file: string): string | null {
  const userCopy = path.join(modelsDir(), file);
  if (fs.existsSync(userCopy)) return userCopy;
  const bundled = path.join(bundledModelsDir(), file);
  if (fs.existsSync(bundled)) return bundled;
  return null;
}

function binDir(): string {
  // Packaged: Resources/bin. Dev: <repo>/resources/bin.
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin")
    : path.join(app.getAppPath(), "resources", "bin");
}

export function binaryPath(name: string): string {
  return path.join(binDir(), name);
}

export function listSttModels(): SttModel[] {
  return STT_CATALOG.map((m) => ({
    ...m,
    installed: modelFilePath(m.file) !== null,
  }));
}

export async function downloadSttModel(
  id: string,
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  const entry = STT_CATALOG.find((m) => m.id === id);
  if (!entry) throw new Error(`unknown STT model: ${id}`);
  const dest = path.join(modelsDir(), entry.file);
  const tmp = dest + ".part";
  const res = await fetch(entry.url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") || entry.sizeMb * 1024 * 1024);
  let got = 0;
  let lastPct = -1;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      got += chunk.byteLength;
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress({ id, kind: "stt", pct, status: "downloading" });
      }
      controller.enqueue(chunk);
    },
  });
  const { Readable, Writable } = await import("node:stream");
  await pipeline(
    Readable.fromWeb(res.body.pipeThrough(counter) as any),
    fs.createWriteStream(tmp)
  );
  fs.renameSync(tmp, dest);
  onProgress({ id, kind: "stt", pct: 100, status: "done" });
}

// --- whisper-server lifecycle ---

let proc: ChildProcess | null = null;
let currentModel: string | null = null;
let ready = false;
let stopping = false;

export function whisperReady(): boolean {
  return ready;
}

export function currentSttModel(): string | null {
  return currentModel;
}

async function waitForServer(timeoutMs = 30000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/`, {
        method: "GET",
        signal: AbortSignal.timeout(1000),
      });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function startWhisper(modelId: string): Promise<void> {
  const entry = STT_CATALOG.find((m) => m.id === modelId);
  if (!entry) throw new Error(`unknown STT model: ${modelId}`);
  const modelPath = modelFilePath(entry.file);
  if (!modelPath) throw new Error(`model not available: ${modelId}`);

  await stopWhisper();
  stopping = false;

  const bin = binaryPath("whisper-server");
  const args = [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(WHISPER_PORT),
    "--threads", "4",
    "--no-timestamps",
  ];
  // tdrz models emit [SPEAKER_TURN] markers so multiple remote speakers'
  // words land in separate transcript lines instead of one run-on segment.
  if (modelId.endsWith("-tdrz")) args.push("--tinydiarize");
  proc = spawn(bin, args);
  proc.stderr?.on("data", () => {});
  proc.stdout?.on("data", () => {});
  proc.on("exit", (code) => {
    ready = false;
    proc = null;
    if (!stopping) {
      console.error(`whisper-server exited unexpectedly (code ${code}), restarting`);
      if (currentModel) startWhisper(currentModel).catch((e) => console.error(e));
    }
  });

  const ok = await waitForServer();
  if (!ok) throw new Error("whisper-server did not become ready");
  ready = true;
  currentModel = modelId;
}

export async function stopWhisper(): Promise<void> {
  if (!proc) return;
  stopping = true;
  ready = false;
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  proc = null;
}

// PCM (16kHz mono Int16) -> WAV in memory
export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

export async function transcribeChunk(pcm: Buffer): Promise<string> {
  if (!ready) return "";
  const wav = pcmToWav(pcm);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "chunk.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`whisper inference failed: HTTP ${res.status}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
