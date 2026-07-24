// Client for a local, OpenAI-compatible LLM server. Talks the OpenAI `/v1`
// chat API so the customer can bring their own model on whatever offline
// framework they like — Ollama, LM Studio, Jan, llama.cpp-server, vLLM,
// LocalAI, … The base URL is configurable in Settings; it defaults to Ollama's
// OpenAI-compatible endpoint.
import type { LlmModel } from "../shared/types";

// Ollama's OpenAI-compatible endpoint. Other frameworks expose the same shape
// on their own port (LM Studio :1234/v1, Jan :1337/v1, llama.cpp :8080/v1, …).
export const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:11434/v1";

let baseUrl = DEFAULT_LLM_BASE_URL;

export function setLlmBaseUrl(url: string): void {
  const trimmed = (url || "").trim().replace(/\/+$/, "");
  baseUrl = trimmed || DEFAULT_LLM_BASE_URL;
}

export function llmBaseUrl(): string {
  return baseUrl;
}

// Reachable if the server answers the OpenAI models endpoint.
export async function llmUp(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Models the server currently exposes (OpenAI `/v1/models`).
export async function listLlmModels(): Promise<LlmModel[]> {
  const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`LLM /models: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? [])
    .map((m) => ({ id: m.id }))
    .filter((m) => !!m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Customer-facing messages (no status codes, jargon, or shell commands). Dev
// detail is logged to the console for debugging.
const UNREACHABLE_MSG =
  "Can't reach your local AI right now. Make sure it's running (e.g. open Ollama), then try again.";

async function llmError(res: Response, model: string): Promise<Error> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    /* ignore */
  }
  console.error(`LLM HTTP ${res.status} for model "${model}": ${body}`);
  if (res.status === 404) {
    return new Error("That AI model isn't ready. Open Settings and choose a model to use.");
  }
  return new Error("Your local AI had trouble answering that. Please try again in a moment.");
}

// Embed one or more texts via the OpenAI-compatible /v1/embeddings endpoint
// (Ollama, LM Studio, … all support it). Returns vectors in input order.
export async function embed(model: string, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: inputs }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw await llmError(res, model);
  const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
  const rows = (json.data ?? []).slice().sort((a, b) => a.index - b.index);
  return rows.map((r) => r.embedding);
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatOnce(model: string, messages: ChatTurn[]): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(180000),
    });
  } catch {
    throw new Error(UNREACHABLE_MSG);
  }
  if (!res.ok) throw await llmError(res, model);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

export async function chatStream(
  model: string,
  messages: ChatTurn[],
  onToken: (t: string) => void
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch {
    throw new Error(UNREACHABLE_MSG);
  }
  if (!res.ok || !res.body) throw await llmError(res, model);
  // OpenAI streaming is server-sent events: "data: {json}\n\n", ending "data: [DONE]".
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
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const t = j.choices?.[0]?.delta?.content ?? "";
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
