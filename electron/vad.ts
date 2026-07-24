// Energy-based voice-activity chunker with an adaptive noise floor, pre-roll,
// and hangover. Pure logic (no I/O) so it is unit-testable: feed PCM frames,
// get back speech chunks that start slightly BEFORE speech onset (pre-roll)
// and end after a hangover — so word starts and tails aren't clipped.

export interface ChunkerEvent {
  /** A finished speech chunk, ready for transcription. */
  chunk?: { pcm: Buffer; startMs: number; durationMs: number };
  /** True while the current frame is judged to contain speech. */
  inSpeech: boolean;
}

export interface ChunkerOptions {
  sampleRate?: number; // Hz, default 16000 (Int16 mono)
  preRollMs?: number; // audio kept before speech onset (default 300)
  hangoverMs?: number; // grace after level drops before silence counts (default 500)
  silenceFlushMs?: number; // trailing silence that ends a chunk (default 700)
  minSpeechMs?: number; // ignore blips shorter than this (default 400)
  maxChunkMs?: number; // force flush so live view stays live (default 12000)
  minThreshold?: number; // absolute RMS floor for the gate (default 250)
  floorRatio?: number; // speech gate = noiseFloor * ratio (default 2.5)
}

const BYTES_PER_MS = (16000 * 2) / 1000;

export function rmsInt16(pcm: Buffer): number {
  const n = pcm.length / 2;
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i);
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / n);
}

interface Frame {
  pcm: Buffer;
  ms: number;
}

export class SpeechChunker {
  private readonly opt: Required<ChunkerOptions>;
  private preRoll: Frame[] = []; // rolling window kept while idle
  private preRollMsTotal = 0;
  private active: Frame[] = []; // frames of the chunk being built
  private activeMs = 0;
  private speechMs = 0; // ms of frames that were above the gate
  private trailingSilenceMs = 0;
  private inSpeech = false;
  private noiseFloor = 200; // EMA of RMS while idle; primes fast from real audio
  private clockMs = 0; // total audio time consumed
  private chunkStartMs = 0;

  constructor(options: ChunkerOptions = {}) {
    this.opt = {
      sampleRate: options.sampleRate ?? 16000,
      preRollMs: options.preRollMs ?? 300,
      hangoverMs: options.hangoverMs ?? 500,
      silenceFlushMs: options.silenceFlushMs ?? 700,
      minSpeechMs: options.minSpeechMs ?? 400,
      maxChunkMs: options.maxChunkMs ?? 12000,
      minThreshold: options.minThreshold ?? 250,
      floorRatio: options.floorRatio ?? 2.5,
    };
  }

  /** The RMS level above which a frame counts as speech right now. */
  gate(): number {
    return Math.max(this.opt.minThreshold, this.noiseFloor * this.opt.floorRatio);
  }

  push(pcm: Buffer): ChunkerEvent {
    const ms = pcm.length / BYTES_PER_MS;
    const level = rmsInt16(pcm);
    const speechFrame = level >= this.gate();
    this.clockMs += ms;

    // Track the noise floor only on non-speech frames so speech doesn't raise it.
    if (!speechFrame) {
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
    }

    if (!this.inSpeech) {
      if (speechFrame) {
        // Speech onset: start a chunk from the pre-roll so the first word survives.
        this.inSpeech = true;
        this.active = [...this.preRoll, { pcm, ms }];
        this.activeMs = this.preRollMsTotal + ms;
        this.chunkStartMs = this.clockMs - this.activeMs;
        this.speechMs = ms;
        this.trailingSilenceMs = 0;
        this.preRoll = [];
        this.preRollMsTotal = 0;
        return { inSpeech: true };
      }
      // Idle: maintain the pre-roll ring.
      this.preRoll.push({ pcm, ms });
      this.preRollMsTotal += ms;
      while (this.preRollMsTotal - (this.preRoll[0]?.ms ?? 0) >= this.opt.preRollMs) {
        this.preRollMsTotal -= this.preRoll.shift()!.ms;
      }
      return { inSpeech: false };
    }

    // In speech: collect the frame.
    this.active.push({ pcm, ms });
    this.activeMs += ms;
    if (speechFrame) {
      this.speechMs += ms;
      this.trailingSilenceMs = 0;
    } else {
      this.trailingSilenceMs += ms;
    }

    const pastHangover = this.trailingSilenceMs >= this.opt.hangoverMs;
    const silenceDone =
      this.trailingSilenceMs >= this.opt.silenceFlushMs && pastHangover;
    const tooLong = this.activeMs >= this.opt.maxChunkMs;

    if (silenceDone || tooLong) {
      const chunk = this.finishChunk(tooLong);
      return { chunk, inSpeech: tooLong }; // still talking on force-flush
    }
    return { inSpeech: true };
  }

  /** Flush whatever is buffered (call at meeting end). */
  flush(): ChunkerEvent["chunk"] | undefined {
    if (!this.inSpeech) return undefined;
    const chunk = this.finishChunk(false);
    this.inSpeech = false;
    return chunk;
  }

  private finishChunk(carrySpeech: boolean): ChunkerEvent["chunk"] | undefined {
    const frames = this.active;
    const startMs = this.chunkStartMs;
    const durationMs = this.activeMs;
    const speechMs = this.speechMs;

    if (carrySpeech) {
      // Force-flush mid-speech: carry the tail into the next chunk as pre-roll
      // so the word spanning the boundary appears (whole) in the next chunk.
      let tail: Frame[] = [];
      let tailMs = 0;
      while (frames.length > 0 && tailMs < this.opt.preRollMs) {
        const f = frames[frames.length - 1];
        if (tailMs + f.ms > this.opt.preRollMs && tail.length > 0) break;
        tail.unshift(frames.pop()!);
        tailMs += f.ms;
      }
      this.active = [...tail];
      this.activeMs = tailMs;
      this.chunkStartMs = this.clockMs - tailMs;
      this.speechMs = tailMs;
      this.trailingSilenceMs = 0;
    } else {
      this.active = [];
      this.activeMs = 0;
      this.speechMs = 0;
      this.trailingSilenceMs = 0;
      this.inSpeech = false;
    }

    if (speechMs < this.opt.minSpeechMs) return undefined; // blip — drop it
    return {
      pcm: Buffer.concat(frames.map((f) => f.pcm)),
      startMs: Math.max(0, Math.round(startMs)),
      durationMs: Math.round(durationMs),
    };
  }
}
