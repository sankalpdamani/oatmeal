// Spawns the OatmealAudio helper, parses tagged PCM frames, segments speech on
// silence (RMS gate), and turns chunks into transcript segments via whisper-server.
import { spawn, type ChildProcess } from "node:child_process";
import type { Segment, Speaker } from "../shared/types";
import * as db from "./db";
import { binaryPath, transcribeChunk } from "./whisper";

const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2;
const SILENCE_RMS = 350; // Int16 RMS below this counts as silence
const SILENCE_FLUSH_MS = 700; // flush after this much trailing silence
const MIN_CHUNK_MS = 1200; // ignore blips shorter than this
const MAX_CHUNK_MS = 12000; // force flush so live view stays live

interface StreamState {
  speaker: Speaker;
  buf: Buffer[];
  bufMs: number;
  silenceMs: number;
  startedAtMs: number; // meeting-relative time of chunk start
}

export class Recorder {
  private proc: ChildProcess | null = null;
  private meetingId: string;
  private t0 = 0;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private streams: Record<"M" | "S", StreamState>;
  private onSegment: (s: Segment) => void;
  private onError: (msg: string) => void;

  constructor(
    meetingId: string,
    onSegment: (s: Segment) => void,
    onError: (msg: string) => void
  ) {
    this.meetingId = meetingId;
    this.onSegment = onSegment;
    this.onError = onError;
    this.streams = {
      M: { speaker: "me", buf: [], bufMs: 0, silenceMs: 0, startedAtMs: 0 },
      S: { speaker: "them", buf: [], bufMs: 0, silenceMs: 0, startedAtMs: 0 },
    };
  }

  start() {
    this.t0 = Date.now();
    this.proc = spawn(binaryPath("OatmealAudio"), ["capture"]);
    let pending = Buffer.alloc(0);
    this.proc.stdout!.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      // Frame: [tag 1B][len UInt32 LE][payload]
      while (pending.length >= 5) {
        const len = pending.readUInt32LE(1);
        if (pending.length < 5 + len) break;
        const tag = String.fromCharCode(pending[0]) as "M" | "S";
        const payload = pending.subarray(5, 5 + len);
        pending = pending.subarray(5 + len);
        if (tag === "M" || tag === "S") this.ingest(tag, Buffer.from(payload));
      }
    });
    this.proc.stderr!.on("data", (d: Buffer) => {
      console.error("[helper]", d.toString().trim());
    });
    this.proc.on("exit", (code) => {
      this.proc = null;
      if (!this.stopped && code !== 0) {
        this.onError(
          `Audio helper stopped (code ${code}). Check Screen Recording & Microphone permissions.`
        );
      }
    });
  }

  private ingest(tag: "M" | "S", pcm: Buffer) {
    const st = this.streams[tag];
    const ms = (pcm.length / BYTES_PER_SEC) * 1000;
    if (st.buf.length === 0) {
      st.startedAtMs = Date.now() - this.t0 - ms;
    }
    st.buf.push(pcm);
    st.bufMs += ms;

    let sumSq = 0;
    const n = pcm.length / 2;
    for (let i = 0; i < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i);
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    st.silenceMs = rms < SILENCE_RMS ? st.silenceMs + ms : 0;

    const shouldFlush =
      (st.silenceMs >= SILENCE_FLUSH_MS && st.bufMs - st.silenceMs >= MIN_CHUNK_MS) ||
      st.bufMs >= MAX_CHUNK_MS;
    if (shouldFlush) this.flush(tag);
    else if (st.silenceMs >= st.bufMs && st.bufMs > 3000) {
      // pure silence — discard to keep memory flat
      st.buf = [];
      st.bufMs = 0;
      st.silenceMs = 0;
    }
  }

  private flush(tag: "M" | "S") {
    const st = this.streams[tag];
    if (st.buf.length === 0) return;
    const pcm = Buffer.concat(st.buf);
    const t0Ms = Math.max(0, Math.round(st.startedAtMs));
    const t1Ms = t0Ms + Math.round(st.bufMs);
    st.buf = [];
    st.bufMs = 0;
    st.silenceMs = 0;

    // Serialize whisper calls; the server handles one inference at a time well.
    this.queue = this.queue.then(async () => {
      try {
        const text = await transcribeChunk(pcm);
        if (!text || isNoise(text)) return;
        const seg = db.addSegment(this.meetingId, st.speaker, text, t0Ms, t1Ms);
        this.onSegment(seg);
      } catch (e) {
        console.error("transcribe failed:", e);
      }
    });
  }

  async stop() {
    this.stopped = true;
    this.flush("M");
    this.flush("S");
    this.proc?.kill("SIGTERM");
    this.proc = null;
    await this.queue;
  }
}

// Whisper hallucinates fillers on near-silent audio; drop the classics.
const NOISE_RE =
  /^[\s.\-—]*$|^\(?\[?(silence|music|inaudible|blank_audio|no audio|applause)\]?\)?[.\s]*$/i;
function isNoise(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (NOISE_RE.test(t)) return true;
  if (/^(thank you\.?|thanks for watching\.?|you)$/i.test(t)) return true;
  return false;
}
