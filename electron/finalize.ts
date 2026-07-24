// End-of-call finalization: from the full transcript, generate a polished
// summary (the meeting "note") and an AI-written title. No live summarizing —
// this runs once when the meeting ends (Granola-style).
//
// Long meetings use map-reduce: the transcript is split into sections, each
// section is summarized on its own, and the final note is synthesized from the
// section notes — so a 90-minute call never loses its middle to truncation.
import type { Segment } from "../shared/types";
import { chatOnce } from "./ollama";

// Strip emojis / decorative pictographs (and any space they leave) from model
// output — notes and answers should be plain, copy-pasteable text.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]\s?/gu;
export function stripEmojis(text: string): string {
  return text
    .replace(EMOJI_RE, "")
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

const NOTE_STRUCTURE = `## TL;DR
One or two sentences capturing what the meeting was about and its outcome.

## Key points
- concise bullets of what was discussed

## Decisions
- decisions that were made

## Action items
- [ ] owner — task

## Open questions
- anything left unresolved`;

const SUMMARY_SYSTEM = `You are an expert meeting notetaker. You are given the full transcript of a meeting that just ended. "Me" is the app user; "Them" is everyone else on the call.

Write clean, skimmable notes as if a sharp chief-of-staff wrote them. Use this exact markdown structure, omitting any section that has no content:

${NOTE_STRUCTURE}

Rules: only use facts stated in the transcript; never invent names, numbers, or commitments; attribute action items to whoever took them when clear; do not use emojis or decorative symbols; output ONLY the markdown note, no preamble or sign-off.`;

const SECTION_SYSTEM = `You are an expert meeting notetaker. You are given ONE SECTION of a longer meeting transcript. "Me" is the app user; "Them" is everyone else on the call.

Write dense factual notes for THIS SECTION ONLY as plain markdown bullets: what was discussed, any decisions, any commitments/action items (with owner), any open questions. Only use facts stated in the section; never invent names or numbers; no emojis; output ONLY the bullets, no headers, preamble, or sign-off.`;

const REDUCE_SYSTEM = `You are an expert meeting notetaker. A long meeting was summarized section-by-section; you are given the ordered section notes. Merge them into ONE final set of meeting notes.

Use this exact markdown structure, omitting any section that has no content:

${NOTE_STRUCTURE}

Rules: only use facts from the section notes; deduplicate; keep chronology where it matters; attribute action items to owners when stated; do not use emojis; output ONLY the markdown note, no preamble or sign-off.`;

const TITLE_SYSTEM = `You write short titles for meetings. Given a transcript, output a concise, specific 3–6 word title (Title Case) that names the topic — like "Q3 Roadmap Planning" or "Mercor Role Discussion". No quotes, no emojis, no punctuation at the end, no preamble. Output only the title.`;

// Single-pass budget. Roughly 6k tokens of transcript — safe for the small
// local models people actually run (8k-context 3B/7B models) with room for
// the system prompt and the reply.
export const SINGLE_PASS_CHARS = 24000;
export const SECTION_CHARS = 16000;

export function segmentsToLines(segments: Segment[]): string[] {
  return segments.map((s) => `${s.speaker === "me" ? "Me" : "Them"}: ${s.text}`);
}

// Split transcript lines into sections of at most maxChars, never splitting a
// line. Pure and unit-tested.
export function splitIntoSections(lines: string[], maxChars = SECTION_CHARS): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > maxChars && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

function transcriptText(segments: Segment[], maxChars = SINGLE_PASS_CHARS): string {
  const lines = segmentsToLines(segments);
  let text = lines.join("\n");
  if (text.length > maxChars) {
    // Keep the opening (sets context) and the ending (conclusions/next steps).
    const head = text.slice(0, Math.floor(maxChars * 0.6));
    const tail = text.slice(-Math.floor(maxChars * 0.4));
    text = `${head}\n…(middle of transcript omitted)…\n${tail}`;
  }
  return text;
}

export async function generateSummary(model: string, segments: Segment[]): Promise<string> {
  if (segments.length === 0) return "";
  const lines = segmentsToLines(segments);
  const full = lines.join("\n");

  if (full.length <= SINGLE_PASS_CHARS) {
    const md = await chatOnce(model, [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: `TRANSCRIPT:\n${full}` },
    ]);
    return stripEmojis(md.trim());
  }

  // Map: summarize each section independently (sequential — local LLMs don't
  // benefit from concurrent requests and some servers reject them).
  const sections = splitIntoSections(lines);
  const notes: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const md = await chatOnce(model, [
      { role: "system", content: SECTION_SYSTEM },
      {
        role: "user",
        content: `SECTION ${i + 1} of ${sections.length}:\n${sections[i]}`,
      },
    ]);
    notes.push(`### Section ${i + 1}\n${md.trim()}`);
  }

  // Reduce: synthesize the final note from the section notes.
  const md = await chatOnce(model, [
    { role: "system", content: REDUCE_SYSTEM },
    { role: "user", content: `SECTION NOTES:\n\n${notes.join("\n\n")}` },
  ]);
  return stripEmojis(md.trim());
}

export async function generateTitle(model: string, segments: Segment[]): Promise<string> {
  if (segments.length === 0) return "Untitled meeting";
  let title = (
    await chatOnce(model, [
      { role: "system", content: TITLE_SYSTEM },
      { role: "user", content: `TRANSCRIPT:\n${transcriptText(segments, 6000)}` },
    ])
  )
    .trim()
    .replace(/^["'`]|["'`.]$/g, "")
    .split("\n")[0]
    .slice(0, 80);
  return stripEmojis(title).trim() || "Untitled meeting";
}
