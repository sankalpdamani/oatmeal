import { describe, expect, it } from "vitest";
import { cleanTranscript, isNoise, splitSpeakerTurns } from "../electron/text";

describe("cleanTranscript", () => {
  it("strips non-speech tags anywhere in the line", () => {
    expect(cleanTranscript("[BLANK_AUDIO] Let's start.")).toBe("Let's start.");
    expect(cleanTranscript("So the plan (silence) is simple.")).toBe("So the plan is simple.");
    expect(cleanTranscript("[MUSIC]")).toBe("");
  });
  it("collapses whitespace", () => {
    expect(cleanTranscript("a  b   c")).toBe("a b c");
  });
});

describe("isNoise", () => {
  it("rejects classic hallucinations and empties", () => {
    for (const s of ["", ".", "—", "you", "Thank you.", "Thanks for watching", "[silence]"]) {
      expect(isNoise(s), s).toBe(true);
    }
  });
  it("keeps real speech", () => {
    for (const s of ["We ship on the 18th.", "Thank you all for joining today's review"]) {
      expect(isNoise(s), s).toBe(false);
    }
  });
});

describe("splitSpeakerTurns", () => {
  it("splits on tdrz markers in any casing/format", () => {
    expect(splitSpeakerTurns("Hello there. [SPEAKER_TURN] Hi, thanks.")).toEqual([
      "Hello there.",
      "Hi, thanks.",
    ]);
    expect(splitSpeakerTurns("One [SPEAKER TURN] Two [speaker_turn] Three")).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });
  it("returns whole text when no markers", () => {
    expect(splitSpeakerTurns("Just one speaker talking.")).toEqual([
      "Just one speaker talking.",
    ]);
  });
  it("drops empty parts", () => {
    expect(splitSpeakerTurns("[SPEAKER_TURN] Hi [SPEAKER_TURN]")).toEqual(["Hi"]);
  });
});
