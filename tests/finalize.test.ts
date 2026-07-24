import { describe, expect, it } from "vitest";
import { splitIntoSections, segmentsToLines, stripEmojis } from "../electron/finalize";
import type { Segment } from "../shared/types";

const seg = (speaker: "me" | "them", text: string): Segment => ({
  id: 1,
  meetingId: "m",
  speaker,
  text,
  t0Ms: 0,
  t1Ms: 1000,
});

describe("segmentsToLines", () => {
  it("labels speakers", () => {
    expect(segmentsToLines([seg("me", "hi"), seg("them", "hello")])).toEqual([
      "Me: hi",
      "Them: hello",
    ]);
  });
});

describe("splitIntoSections", () => {
  it("keeps short transcripts as one section", () => {
    expect(splitIntoSections(["a", "b"], 100)).toHaveLength(1);
  });

  it("splits at the size budget without breaking lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i} ${"x".repeat(50)}`);
    const sections = splitIntoSections(lines, 500);
    expect(sections.length).toBeGreaterThan(5);
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(500);
    // No line lost or split
    expect(sections.join("\n").split("\n")).toHaveLength(lines.length);
  });

  it("handles a single oversized line", () => {
    const big = "y".repeat(2000);
    const sections = splitIntoSections(["a", big, "b"], 500);
    expect(sections.join("\n")).toContain(big);
  });
});

describe("stripEmojis", () => {
  it("removes pictographs but keeps text", () => {
    expect(stripEmojis("Ship it \u{1F680} now")).toBe("Ship it now");
    expect(stripEmojis("plain text")).toBe("plain text");
  });
});
