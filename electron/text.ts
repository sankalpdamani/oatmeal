// Pure text helpers for transcript post-processing. No Electron imports —
// unit-tested directly.

// Whisper emits bracketed non-speech tags — [BLANK_AUDIO], (silence), [MUSIC] —
// which can appear mid- or end-of-line on otherwise real speech. Strip them
// everywhere before the whole-line noise check below sees the text.
const TAG_RE =
  /[\[(]\s*(blank_audio|silence|music|inaudible|no ?speech|no ?audio|applause|noise|sound)\s*[\])]/gi;
export function cleanTranscript(text: string): string {
  return (text ?? "")
    .replace(TAG_RE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Whisper hallucinates fillers on near-silent audio; drop the classics.
const NOISE_RE =
  /^[\s.\-—]*$|^\(?\[?(silence|music|inaudible|blank_audio|no audio|applause)\]?\)?[.\s]*$/i;
export function isNoise(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (NOISE_RE.test(t)) return true;
  if (/^(thank you\.?|thanks for watching\.?|you)$/i.test(t)) return true;
  return false;
}

// tdrz models mark a change of speaker with [SPEAKER_TURN]. Split a chunk's
// text into per-turn parts (turn identity across chunks is unknown, so parts
// keep the same speaker label — they just become separate transcript lines).
const TURN_RE = /\s*\[?SPEAKER[_ ]?TURN\]?\s*/gi;
export function splitSpeakerTurns(text: string): string[] {
  return text
    .split(TURN_RE)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
