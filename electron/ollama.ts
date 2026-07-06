// Thin client for the local Ollama daemon (http://127.0.0.1:11434).
import type { DownloadProgress, OllamaModel } from "../shared/types";

const OLLAMA = "http://127.0.0.1:11434";

// Curated pull suggestions shown in settings alongside installed models.
const CURATED: { name: string; note: string }[] = [
  { name: "qwen2.5:14b", note: "Best quality on 24GB Macs" },
  { name: "llama3.2:3b", note: "Fast, light — good for live summaries" },
  { name: "qwen2.5:7b", note: "Balanced speed/quality" },
];

export async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listOllamaModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`ollama /api/tags: HTTP ${res.status}`);
  const json = (await res.json()) as { models?: { name: string; size: number }[] };
  const installed: OllamaModel[] = (json.models ?? []).map((m) => ({
    name: m.name,
    sizeBytes: m.size,
    installed: true,
  }));
  const installedNames = new Set(installed.map((m) => m.name));
  for (const c of CURATED) {
    if (!installedNames.has(c.name)) {
      installed.push({ name: c.name, sizeBytes: 0, installed: false, recommended: c.note });
    } else {
      const row = installed.find((m) => m.name === c.name)!;
      row.recommended = c.note;
    }
  }
  return installed;
}

export async function pullOllamaModel(
  name: string,
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  const res = await fetch(`${OLLAMA}/api/pull`, {
    method: "POST",
    body: JSON.stringify({ model: name, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`ollama pull failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { total?: number; completed?: number; status?: string };
        if (j.total && j.completed !== undefined) {
          const pct = Math.floor((j.completed / j.total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            onProgress({ id: name, kind: "ollama", pct, status: "downloading" });
          }
        }
      } catch {
        /* partial line */
      }
    }
  }
  onProgress({ id: name, kind: "ollama", pct: 100, status: "done" });
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatOnce(model: string, messages: ChatTurn[]): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`ollama chat: HTTP ${res.status}`);
  const json = (await res.json()) as { message?: { content?: string } };
  return json.message?.content ?? "";
}

export async function chatStream(
  model: string,
  messages: ChatTurn[],
  onToken: (t: string) => void
): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`ollama chat: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        const t = j.message?.content ?? "";
        if (t) {
          full += t;
          onToken(t);
        }
      } catch {
        /* partial line */
      }
    }
  }
  return full;
}
