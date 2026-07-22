// End-of-call finalization: from the full transcript, generate a polished
// summary (the meeting "note") and an AI-written title. No live summarizing —
// this runs once when the meeting ends (Granola-style).
import type { Segment } from "../shared/types";
import { chatOnce } from "./ollama";

const SUMMARY_SYSTEM = `You are an expert meeting notetaker. You are given the full transcript of a meeting that just ended. "Me" is the app user; "Them" is everyone else on the call.

Write clean, skimmable notes as if a sharp chief-of-staff wrote them. Use this exact markdown structure, omitting any section that has no content:

## TL;DR
One or two sentences capturing what the meeting was about and its outcome.

## Key points
- concise bullets of what was discussed

## Decisions
- decisions that were made

## Action items
- [ ] owner — task

## Open questions
- anything left unresolved

Rules: only use facts stated in the transcript; never invent names, numbers, or commitments; attribute action items to whoever took them when clear; output ONLY the markdown note, no preamble or sign-off.`;

const TITLE_SYSTEM = `You write short titles for meetings. Given a transcript, output a concise, specific 3–6 word title (Title Case) that names the topic — like "Q3 Roadmap Planning" or "Mercor Role Discussion". No quotes, no punctuation at the end, no preamble. Output only the title.`;

function transcriptText(segments: Segment[], maxChars = 24000): string {
  const lines = segments.map((s) => `${s.speaker === "me" ? "Me" : "Them"}: ${s.text}`);
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
  const md = await chatOnce(model, [
    { role: "system", content: SUMMARY_SYSTEM },
    { role: "user", content: `TRANSCRIPT:\n${transcriptText(segments)}` },
  ]);
  return md.trim();
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
  return title || "Untitled meeting";
}
