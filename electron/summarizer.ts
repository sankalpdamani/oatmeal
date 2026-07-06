// Rolling live summary: every tick, fold new transcript segments into the
// previous summary. Never re-reads the whole transcript.
import type { Segment } from "../shared/types";
import { chatOnce } from "./ollama";
import * as db from "./db";

const TICK_MS = 25000;

const SYSTEM_PROMPT = `You are a meeting notetaker. You maintain a live, running summary of an in-progress meeting.
You are given the CURRENT SUMMARY (may be empty at the start) and NEW TRANSCRIPT lines since the last update.
"Me" is the user of this app; "Them" is everyone else on the call.

Rewrite the summary to fold in the new material. Keep it tight and skimmable. Use exactly this markdown structure:

## TL;DR
One or two sentences.

## Key points
- ...

## Decisions
- ... (omit section if none yet)

## Action items
- [ ] ... (omit section if none yet)

## Open questions
- ... (omit section if none yet)

Rules: never invent facts not in the transcript; keep prior summary content unless contradicted; output ONLY the markdown summary, no preamble.`;

export class Summarizer {
  private meetingId: string;
  private model: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingSegments: Segment[] = [];
  private summary: string;
  private busy = false;
  private onSummary: (md: string) => void;

  constructor(meetingId: string, model: string, onSummary: (md: string) => void) {
    this.meetingId = meetingId;
    this.model = model;
    this.onSummary = onSummary;
    this.summary = db.getMeeting(meetingId)?.summaryMd ?? "";
  }

  push(seg: Segment) {
    this.pendingSegments.push(seg);
  }

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  async tick(): Promise<void> {
    if (this.busy || this.pendingSegments.length === 0) return;
    const batch = this.pendingSegments;
    this.pendingSegments = [];
    this.busy = true;
    try {
      const delta = batch
        .map((s) => `${s.speaker === "me" ? "Me" : "Them"}: ${s.text}`)
        .join("\n");
      const user = `CURRENT SUMMARY:\n${this.summary || "(empty — meeting just started)"}\n\nNEW TRANSCRIPT:\n${delta}`;
      const md = (
        await chatOnce(this.model, [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ])
      ).trim();
      if (md) {
        this.summary = md;
        db.saveSummary(this.meetingId, md);
        this.onSummary(md);
      }
    } catch (e) {
      console.error("summarizer tick failed:", e);
      // put the batch back so nothing is lost
      this.pendingSegments = batch.concat(this.pendingSegments);
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tick(); // final fold-in
  }
}
