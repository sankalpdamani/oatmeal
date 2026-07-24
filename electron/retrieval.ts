// Retrieval for meeting chat. Chunks the transcript, embeds chunks with a local
// embedding model, and fuses semantic (cosine) + lexical (keyword) ranking to
// pick the most relevant excerpts. Embeddings are cached in SQLite; if no
// embedding model is available it falls back to pure lexical, so chat always
// works. Built for long (30–60 min+) meetings where the whole transcript can't
// fit in a local model's context.
import type { Segment } from "../shared/types";
import * as db from "./db";
import * as llm from "./ollama";

const CHUNK_CHARS = 1000; // ~250 tokens per chunk
const DEFAULT_MAX_CHARS = 5000; // budget of excerpts sent to the model

// Once we learn the embedding model/server isn't available, stop hammering it
// (fast keyword-only search) until settings change or a new recording starts.
let embedDisabled = false;
export function resetEmbedAvailability(): void {
  embedDisabled = false;
}

const STOPWORDS = new Set(
  "the a an and or of to in on for is are was were be been do does did what who how why when where which that this it its as at by with from about into over your you our their they them we can will would could should".split(
    " "
  )
);
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t)
  );
}

// Small stable hash so the same chunk text reuses its cached embedding.
function hashKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

interface Chunk {
  key: string;
  text: string;
  idx: number; // chronological order
}

function chunkSegments(segs: Segment[]): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join("\n");
    chunks.push({ key: hashKey(text), text, idx: chunks.length });
    buf = [];
    len = 0;
  };
  for (const s of segs) {
    const line = `${s.speaker === "me" ? "Me" : "Them"}: ${s.text}`;
    buf.push(line);
    len += line.length + 1;
    if (len >= CHUNK_CHARS) flush();
  }
  flush();
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// Embed any chunks we don't already have a vector for, in one batch.
async function ensureEmbeddings(
  meetingId: string,
  chunks: Chunk[],
  model: string
): Promise<Map<string, number[]>> {
  const have = db.getEmbeddings(meetingId);
  const missing = chunks.filter((c) => !have.has(c.key));
  if (missing.length > 0) {
    const vecs = await llm.embed(model, missing.map((c) => c.text));
    missing.forEach((c, i) => {
      const v = vecs[i];
      if (v && v.length) {
        db.putEmbedding(meetingId, c.key, v);
        have.set(c.key, v);
      }
    });
  }
  return have;
}

// Embed chunks ahead of time so chat is instant instead of embedding on the
// first question. Skips the last (still-growing) chunk during a live meeting;
// pass includeLast at the end (or when opening a finished meeting) to embed all.
export async function prewarmEmbeddings(
  meetingId: string,
  embedModel: string,
  includeLast = false
): Promise<void> {
  if (embedDisabled) return;
  const segs = db.listSegments(meetingId);
  if (segs.length === 0) return;
  let chunks = chunkSegments(segs);
  if (!includeLast && chunks.length > 1) chunks = chunks.slice(0, -1);
  try {
    await ensureEmbeddings(meetingId, chunks, embedModel);
  } catch (e) {
    embedDisabled = true;
    console.error("embedding unavailable, using keyword search:", (e as Error).message);
  }
}

function recentTail(chunks: Chunk[], maxChars: number): string {
  const all = chunks.map((c) => c.text).join("\n");
  return all.length > maxChars ? "…\n" + all.slice(-maxChars) : all;
}

function assemble(chunks: Chunk[], ordered: number[], maxChars: number): string {
  const pickedIdx: number[] = [];
  let chars = 0;
  for (const i of ordered) {
    const t = chunks[i].text;
    if (chars + t.length > maxChars) continue;
    pickedIdx.push(i);
    chars += t.length + 1;
    if (chars >= maxChars) break;
  }
  // Re-order chronologically so the excerpt reads naturally.
  pickedIdx.sort((a, b) => a - b);
  return pickedIdx.map((i) => chunks[i].text).join("\n…\n");
}

// Returns the transcript excerpts most relevant to `query`.
export async function retrieveContext(
  meetingId: string,
  query: string,
  embedModel: string,
  maxChars = DEFAULT_MAX_CHARS
): Promise<string> {
  const segs = db.listSegments(meetingId);
  if (segs.length === 0) return "";
  const chunks = chunkSegments(segs);

  // Short meeting: everything fits, skip ranking entirely.
  if (chunks.map((c) => c.text).join("\n").length <= maxChars) {
    return chunks.map((c) => c.text).join("\n");
  }

  // Lexical ranking (always available).
  const qTerms = new Set(tokenize(query));
  const lexScored = chunks.map((c) => {
    let score = 0;
    for (const t of tokenize(c.text)) if (qTerms.has(t)) score++;
    return { key: c.key, idx: c.idx, score };
  });
  const anyLex = lexScored.some((x) => x.score > 0);
  const lexRank = new Map(
    [...lexScored].sort((a, b) => b.score - a.score || a.idx - b.idx).map((x, r) => [x.key, r])
  );

  // Semantic ranking (best-effort; falls back to lexical on any failure).
  let semRank: Map<string, number> | null = null;
  if (!embedDisabled) {
    try {
      const vecs = await ensureEmbeddings(meetingId, chunks, embedModel);
      const [qvec] = await llm.embed(embedModel, [query]);
      if (qvec) {
        const sims = chunks
          .map((c) => ({ key: c.key, sim: vecs.has(c.key) ? cosine(qvec, vecs.get(c.key)!) : -1 }))
          .sort((a, b) => b.sim - a.sim);
        semRank = new Map(sims.map((x, r) => [x.key, r]));
      }
    } catch (e) {
      embedDisabled = true;
      console.error("semantic retrieval unavailable, using keyword search:", (e as Error).message);
    }
  }

  // Nothing to go on (no keyword hits, no embeddings) → most recent tail.
  if (!semRank && !anyLex) return recentTail(chunks, maxChars);

  // Reciprocal-rank fusion of the two rankings.
  const K = 60;
  const fused = chunks
    .map((c) => {
      const lr = lexRank.get(c.key) ?? chunks.length;
      const sr = semRank?.get(c.key) ?? chunks.length;
      const score = 1 / (K + lr) + (semRank ? 1 / (K + sr) : 0);
      return { idx: c.idx, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.idx);

  return assemble(chunks, fused, maxChars);
}
