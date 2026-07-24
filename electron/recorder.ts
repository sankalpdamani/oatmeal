// Spawns the OatmealAudio helper, parses tagged PCM frames, and turns speech
// into transcript segments via whisper-server. Chunking is handled by the
// SpeechChunker VAD (adaptive noise floor + pre-roll + hangover) in vad.ts.
import { spawn, type ChildProcess } from "node:child_process";
import type { Segment, Speaker } from "../shared/types";
import * as db from "./db";
import { binaryPath, transcribeChunk } from "./whisper";
import { SpeechChunker } from "./vad";
import { cleanTranscript, isNoise, splitSpeakerTurns } from "./text";

export class Recorder {
  private proc: ChildProcess | null = null;
  private meetingId: string;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private chunkers: Record<"M" | "S", { chunker: SpeechChunker; speaker: Speaker }>;
  private onSegment: (s: Segment) => void;
  private onError: (exitCode: number | null) => void;
  private onSpeech: (() => void) | null;
  /** Wall-clock ms of the last frame judged to contain speech (either stream). */
  lastSpeechAt: number = Date.now();

  constructor(
    meetingId: string,
    onSegment: (s: Segment) => void,
    onError: (exitCode: number | null) => void,
    onSpeech?: () => void
  ) {
    this.meetingId = meetingId;
    this.onSegment = onSegment;
    this.onError = onError;
    this.onSpeech = onSpeech ?? null;
    this.chunkers = {
      M: { chunker: new SpeechChunker(), speaker: "me" },
      S: { chunker: new SpeechChunker(), speaker: "them" },
    };
  }

  start() {
    this.lastSpeechAt = Date.now();
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
      if (!this.stopped && code !== 0) this.onError(code);
    });
  }

  private ingest(tag: "M" | "S", pcm: Buffer) {
    const { chunker, speaker } = this.chunkers[tag];
    const ev = chunker.push(pcm);
    if (ev.inSpeech) {
      this.lastSpeechAt = Date.now();
      this.onSpeech?.();
    }
    if (ev.chunk) this.transcribe(speaker, ev.chunk);
  }

  private transcribe(
    speaker: Speaker,
    chunk: { pcm: Buffer; startMs: number; durationMs: number }
  ) {
    // Serialize whisper calls; the server handles one inference at a time well.
    this.queue = this.queue.then(async () => {
      try {
        const text = cleanTranscript(await transcribeChunk(chunk.pcm));
        if (!text || isNoise(text)) return;
        // tdrz models mark remote speaker changes; store each turn as its own
        // segment with times apportioned by character share.
        const parts = splitSpeakerTurns(text).filter((p) => !isNoise(p));
        if (parts.length === 0) return;
        const totalChars = parts.reduce((n, p) => n + p.length, 0);
        let cursor = chunk.startMs;
        for (const part of parts) {
          const span = Math.round((part.length / totalChars) * chunk.durationMs);
          const seg = db.addSegment(this.meetingId, speaker, part, cursor, cursor + span);
          cursor += span;
          this.onSegment(seg);
        }
      } catch (e) {
        console.error("transcribe failed:", e);
      }
    });
  }

  async stop() {
    this.stopped = true;
    for (const tag of ["M", "S"] as const) {
      const { chunker, speaker } = this.chunkers[tag];
      const tail = chunker.flush();
      if (tail) this.transcribe(speaker, tail);
    }
    this.proc?.kill("SIGTERM");
    this.proc = null;
    await this.queue;
  }
}

