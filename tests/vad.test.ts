import { describe, expect, it } from "vitest";
import { SpeechChunker, rmsInt16 } from "../electron/vad";

// 20ms of 16kHz Int16 mono = 320 samples = 640 bytes.
function frame(amplitude: number, ms = 20): Buffer {
  const samples = (16000 * ms) / 1000;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // Square-ish wave so RMS ≈ amplitude.
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

const QUIET = 50;
const LOUD = 4000;

describe("rmsInt16", () => {
  it("measures amplitude", () => {
    expect(rmsInt16(frame(0))).toBe(0);
    expect(rmsInt16(frame(LOUD))).toBeCloseTo(LOUD, -1);
  });
});

describe("SpeechChunker", () => {
  it("produces no chunks for pure silence", () => {
    const c = new SpeechChunker();
    for (let i = 0; i < 200; i++) {
      const ev = c.push(frame(QUIET));
      expect(ev.chunk).toBeUndefined();
      expect(ev.inSpeech).toBe(false);
    }
    expect(c.flush()).toBeUndefined();
  });

  it("emits a chunk after speech followed by silence, including pre-roll", () => {
    const c = new SpeechChunker();
    // 400ms of quiet to prime the pre-roll ring
    for (let i = 0; i < 20; i++) c.push(frame(QUIET));
    // 1s of speech
    for (let i = 0; i < 50; i++) c.push(frame(LOUD));
    // silence until flush (hangover 500 + silenceFlush 700)
    let chunk;
    for (let i = 0; i < 80 && !chunk; i++) chunk = c.push(frame(QUIET)).chunk;
    expect(chunk).toBeDefined();
    // 1s speech + ~300ms pre-roll + ~700ms trailing silence
    expect(chunk!.durationMs).toBeGreaterThanOrEqual(1200);
    // pre-roll means the chunk starts BEFORE the speech onset at 400ms
    expect(chunk!.startMs).toBeLessThan(400);
    expect(chunk!.startMs).toBeGreaterThanOrEqual(0);
  });

  it("drops sub-minSpeech blips", () => {
    const c = new SpeechChunker();
    for (let i = 0; i < 10; i++) c.push(frame(QUIET));
    for (let i = 0; i < 5; i++) c.push(frame(LOUD)); // 100ms blip < 400ms min
    let sawChunk = false;
    for (let i = 0; i < 100; i++) if (c.push(frame(QUIET)).chunk) sawChunk = true;
    expect(sawChunk).toBe(false);
  });

  it("force-flushes long speech at maxChunkMs and keeps talking", () => {
    const c = new SpeechChunker({ maxChunkMs: 2000 });
    let chunks = 0;
    for (let i = 0; i < 500; i++) {
      const ev = c.push(frame(LOUD)); // 10s of continuous speech
      if (ev.chunk) {
        chunks++;
        expect(ev.inSpeech).toBe(true); // still mid-speech after force flush
      }
    }
    expect(chunks).toBeGreaterThanOrEqual(4);
  });

  it("adapts its gate to the noise floor", () => {
    const c = new SpeechChunker();
    const before = c.gate();
    for (let i = 0; i < 300; i++) c.push(frame(400)); // steady loud-ish noise
    expect(c.gate()).toBeGreaterThan(before);
  });

  it("flush() returns the buffered tail at meeting end", () => {
    const c = new SpeechChunker();
    for (let i = 0; i < 10; i++) c.push(frame(QUIET));
    for (let i = 0; i < 30; i++) c.push(frame(LOUD)); // 600ms speech, no trailing silence
    const tail = c.flush();
    expect(tail).toBeDefined();
    expect(tail!.durationMs).toBeGreaterThanOrEqual(600);
  });
});
