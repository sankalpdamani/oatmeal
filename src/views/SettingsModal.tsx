import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { LlmModel, SttModel } from "../../shared/types";

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.status);
  const downloads = useStore((s) => s.downloads);
  const refresh = useStore((s) => s.refresh);
  const [stt, setStt] = useState<SttModel[]>([]);
  const [llms, setLlms] = useState<LlmModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const sttModels = await window.oatmeal.listSttModels();
    setStt(sttModels);
    try {
      setLlms(await window.oatmeal.listLlmModels());
    } catch {
      setLlms([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Re-list models when a download finishes.
  const doneCount = Object.values(downloads).filter((d) => d.status === "done").length;
  useEffect(() => {
    void load();
    void refresh();
  }, [doneCount, refresh]);

  const downloadStt = async (id: string) => {
    setBusy(id);
    try {
      await window.oatmeal.downloadSttModel(id);
    } catch (e) {
      console.error(e);
      alert("Couldn't download that model. Check your internet connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  const useStt = async (id: string) => {
    setBusy(id);
    try {
      await window.oatmeal.useSttModel(id);
      await refresh();
    } catch (e) {
      console.error(e);
      alert("Couldn't switch to that model. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const useLlm = async (name: string) => {
    const model = name.trim();
    if (!model) return;
    await window.oatmeal.setSettings({ llmModel: model });
    await refresh();
  };

  const setLlmUrl = async (url: string) => {
    await window.oatmeal.setSettings({ llmBaseUrl: url.trim() });
    await refresh();
    await load();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-[620px] overflow-y-auto rounded-card border border-hairline bg-surface-raised p-5 shadow-pop"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold tracking-tight">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-fill-soft-hover"
          >
            Done
          </button>
        </div>

        <Section title="Transcription (whisper.cpp — runs on this Mac)">
          <div className="flex flex-col gap-2">
            {stt.map((m) => {
              const dl = downloads[m.id];
              const active = status?.sttModel === m.id && status?.whisperReady;
              return (
                <ModelRow
                  key={m.id}
                  title={m.label}
                  subtitle={`${m.sizeMb} MB`}
                  active={!!active}
                  installed={m.installed}
                  progress={dl?.status === "downloading" ? dl.pct : null}
                  busy={busy === m.id}
                  onDownload={() => void downloadStt(m.id)}
                  onUse={() => void useStt(m.id)}
                />
              );
            })}
          </div>
        </Section>

        <Section title="Intelligence (your local LLM — summaries & chat)">
          <div className="flex flex-col gap-2">
            <label className="rounded-lg border border-hairline px-3 py-2.5">
              <div className="mb-1 text-[12px] font-medium text-ink-secondary">
                Server URL (OpenAI-compatible)
              </div>
              <input
                type="text"
                key={`url-${settings?.llmBaseUrl ?? ""}`}
                defaultValue={settings?.llmBaseUrl ?? ""}
                placeholder="http://127.0.0.1:11434/v1"
                spellCheck={false}
                onBlur={(e) => void setLlmUrl(e.target.value)}
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-ink-tertiary"
              />
              <div className="mt-1 text-[12px] text-ink-tertiary">
                Bring your own model on Ollama, LM Studio, Jan, llama.cpp, vLLM,
                LocalAI…{" "}
                <span className={status && !status.llmUp ? "text-danger" : "text-accent"}>
                  {status && !status.llmUp ? "○ not reachable" : "● connected"}
                </span>
              </div>
            </label>

            {status && !status.llmUp ? (
              <div className="rounded-lg bg-surface-tint px-3 py-2.5 text-[13px] leading-relaxed">
                No model server is answering at that URL. Start your local LLM
                app (and load a model), or{" "}
                <button
                  className="font-medium text-accent underline"
                  onClick={() => void window.oatmeal.openExternal("https://ollama.com/download")}
                >
                  get Ollama
                </button>{" "}
                (free), then set the model below.
              </div>
            ) : (
              <label className="rounded-lg border border-hairline px-3 py-2.5">
                <div className="mb-1 text-[12px] font-medium text-ink-secondary">Model</div>
                <input
                  type="text"
                  key={`model-${settings?.llmModel ?? ""}`}
                  defaultValue={settings?.llmModel ?? ""}
                  placeholder="pick one below or type a model name"
                  spellCheck={false}
                  onBlur={(e) => void useLlm(e.target.value)}
                  className="w-full bg-transparent text-[13px] outline-none placeholder:text-ink-tertiary"
                />
                <div className="mt-1 text-[12px] text-ink-tertiary">
                  Bring any model you like. If you don't choose one, Oatmeal uses
                  the lightest model you already have installed.
                </div>
                {llms.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {llms.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => void useLlm(m.id)}
                        className={
                          "rounded-full px-2.5 py-1 text-[12px] font-medium " +
                          (settings?.llmModel === m.id
                            ? "bg-surface-green text-accent"
                            : "bg-fill-soft-opaque hover:bg-fill-soft-hover")
                        }
                      >
                        {m.id}
                      </button>
                    ))}
                  </div>
                )}
              </label>
            )}

            <label className="rounded-lg border border-hairline px-3 py-2.5">
              <div className="mb-1 text-[12px] font-medium text-ink-secondary">
                Embedding model (smarter search on long meetings)
              </div>
              <input
                type="text"
                key={`embed-${settings?.embedModel ?? ""}`}
                defaultValue={settings?.embedModel ?? ""}
                placeholder="nomic-embed-text"
                spellCheck={false}
                onBlur={(e) =>
                  void window.oatmeal
                    .setSettings({ embedModel: e.target.value.trim() })
                    .then(() => refresh())
                }
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-ink-tertiary"
              />
              <div className="mt-1 text-[12px] text-ink-tertiary">
                Powers meaning-based chat search on long meetings. On Ollama it's
                installed automatically; otherwise install it in your model app.
                Without it, Oatmeal uses keyword search.
              </div>
            </label>
          </div>
        </Section>

        <Section title="Permissions">
          <div className="flex flex-col gap-2">
            <PermRow
              ok={!!status?.permissions.microphone}
              label="Microphone — your side of the call"
              onFix={() => void window.oatmeal.requestMic().then(() => refresh())}
            />
            <PermRow
              ok={!!status?.permissions.systemAudio}
              label="System Audio — the other side (no screen recording)"
              onFix={() => void window.oatmeal.requestSystemAudio().then(() => refresh())}
            />
          </div>
        </Section>

        <Section title="Connect your AI tools (MCP)">
          <IntegrationsPanel />
        </Section>

        <Section title="Updates">
          <UpdateRow />
        </Section>

        <p className="mt-4 text-[12px] leading-relaxed text-ink-tertiary">
          Everything — audio, transcripts, summaries, chats — stays on this Mac.
          Oatmeal makes no network calls except to your local LLM server and
          whisper, and to download models you ask for.
        </p>
      </div>
    </div>
  );
}

interface IntegrationRow {
  id: string;
  label: string;
  installed: boolean;
  connected: boolean;
  stale: boolean;
  detail: string | null;
  cliCommand: string | null;
  openable: boolean;
  configPath: string;
}

function IntegrationsPanel() {
  const [rows, setRows] = useState<IntegrationRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void window.oatmeal.integrationStatus().then(setRows);
  }, []);

  const connect = async (id: string, openAfter: boolean) => {
    setBusy(id);
    try {
      setRows(await window.oatmeal.connectIntegration(id));
      setJustConnected(id);
      setTimeout(() => setJustConnected((j) => (j === id ? null : j)), 6000);
      // Land the user in the tool they just connected (GUI tools only).
      if (openAfter) await window.oatmeal.openIntegration(id);
    } catch (e) {
      console.error(e);
      alert("Couldn't write that tool's config. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const copy = async (id: string, cmd: string) => {
    await navigator.clipboard.writeText(cmd);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 2500);
  };

  const visible = rows.filter((r) => r.installed);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">
        One click adds Oatmeal's MCP server to a tool's config so its AI can
        list your meetings, read transcripts and summaries, search them, and
        start/stop recording. Everything runs locally over stdio — transcripts
        never leave this Mac, so you can query them with whatever models your
        company has approved.
      </p>
      {visible.length === 0 && (
        <div className="rounded-lg border border-hairline px-3 py-2.5 text-[13px] text-ink-secondary">
          No supported tools found. Install Claude Code, Claude Desktop, Codex
          CLI, or GitHub Copilot and come back.
        </div>
      )}
      {visible.map((r) => (
        <div key={r.id} className="rounded-lg border border-hairline px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{r.label}</div>
              <div className="truncate text-[11.5px] text-ink-tertiary">
                {r.connected && r.detail ? r.detail : r.configPath}
              </div>
            </div>
            <div className="ml-3 flex shrink-0 items-center gap-1.5">
              {r.connected && !r.stale && (
                <span className="rounded-full bg-surface-green px-2.5 py-1 text-[12px] font-medium text-accent">
                  {justConnected === r.id ? "Connected — restart it to load" : "Connected"}
                </span>
              )}
              {r.connected && r.stale && (
                <button
                  disabled={busy === r.id}
                  onClick={() => void connect(r.id, false)}
                  className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-50"
                  title="The configured server path no longer exists — reconnect to fix it"
                >
                  {busy === r.id ? "Fixing…" : "Reconnect"}
                </button>
              )}
              {!r.connected && (
                <button
                  disabled={busy === r.id}
                  onClick={() => void connect(r.id, r.openable)}
                  className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-50"
                >
                  {busy === r.id ? "Connecting…" : "Connect"}
                </button>
              )}
              {r.openable && r.connected && (
                <button
                  onClick={() => void window.oatmeal.openIntegration(r.id)}
                  className="rounded-md bg-fill-soft-opaque px-2.5 py-1 text-[12px] font-medium hover:bg-fill-soft-hover"
                >
                  Open
                </button>
              )}
            </div>
          </div>
          {r.cliCommand && (
            <div className="mt-2 flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md bg-fill-soft px-2 py-1.5 font-mono text-[11px] text-ink-secondary-strong">
                {r.cliCommand}
              </code>
              <button
                onClick={() => void copy(r.id, r.cliCommand!)}
                className="shrink-0 rounded-md bg-fill-soft-opaque px-2 py-1.5 text-[11.5px] font-medium hover:bg-fill-soft-hover"
                title="Copy, paste in your terminal, hit enter"
              >
                {copied === r.id ? "Copied ✓" : "Copy"}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function UpdateRow() {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "checking" }
    | { phase: "done"; current: string; latest: string | null; available: boolean; page: string }
  >({ phase: "idle" });

  const check = async () => {
    setState({ phase: "checking" });
    const info = await window.oatmeal.checkForUpdate();
    setState({
      phase: "done",
      current: info.currentVersion,
      latest: info.latestVersion,
      available: info.updateAvailable,
      page: info.releasePage,
    });
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
      <span className="text-[13px]">
        {state.phase === "done" ? (
          state.available ? (
            <>
              Update available: <strong>{state.latest}</strong> (you have {state.current})
            </>
          ) : state.latest ? (
            <>You're up to date ({state.current})</>
          ) : (
            <>Couldn't reach the update server — try again later</>
          )
        ) : (
          <>Oatmeal checks for new versions once a day</>
        )}
      </span>
      {state.phase === "done" && state.available ? (
        <button
          onClick={() => void window.oatmeal.openExternal(state.page)}
          className="ml-3 shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover"
        >
          Download
        </button>
      ) : (
        <button
          disabled={state.phase === "checking"}
          onClick={() => void check()}
          className="ml-3 shrink-0 rounded-md bg-fill-soft-opaque px-2.5 py-1 text-[12px] font-medium hover:bg-fill-soft-hover disabled:opacity-50"
        >
          {state.phase === "checking" ? "Checking…" : "Check now"}
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">
        {title}
      </h3>
      {children}
    </div>
  );
}

function ModelRow(props: {
  title: string;
  subtitle: string;
  active: boolean;
  installed: boolean;
  progress: number | null;
  busy: boolean;
  onDownload: () => void;
  onUse: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{props.title}</span>
          {props.active && (
            <span className="rounded-full bg-surface-green px-2 py-0.5 text-[11px] font-medium text-accent">
              In use
            </span>
          )}
        </div>
        <div className="text-[12px] text-ink-tertiary">{props.subtitle}</div>
      </div>
      <div className="ml-3 shrink-0">
        {props.progress !== null ? (
          <div className="w-28">
            <div className="h-1.5 overflow-hidden rounded-full bg-fill-soft-opaque">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${props.progress}%` }}
              />
            </div>
            <div className="mt-0.5 text-right text-[11px] text-ink-tertiary">
              {props.progress}%
            </div>
          </div>
        ) : props.installed ? (
          props.active ? null : (
            <button
              disabled={props.busy}
              onClick={props.onUse}
              className="rounded-md bg-fill-soft-opaque px-2.5 py-1 text-[12px] font-medium hover:bg-fill-soft-hover disabled:opacity-50"
            >
              {props.busy ? "Loading…" : "Use"}
            </button>
          )
        ) : (
          <button
            disabled={props.busy}
            onClick={props.onDownload}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-50"
          >
            Download
          </button>
        )}
      </div>
    </div>
  );
}

function PermRow({ ok, label, onFix }: { ok: boolean; label: string; onFix: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
      <span className="text-[13px]">
        <span className={ok ? "text-accent" : "text-danger"}>{ok ? "●" : "○"}</span>{" "}
        {label}
      </span>
      {!ok && (
        <button
          onClick={onFix}
          className="rounded-md bg-fill-soft-opaque px-2.5 py-1 text-[12px] font-medium hover:bg-fill-soft-hover"
        >
          Grant
        </button>
      )}
    </div>
  );
}
