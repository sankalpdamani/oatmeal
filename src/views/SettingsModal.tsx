import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { OllamaModel, SttModel } from "../../shared/types";

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.status);
  const downloads = useStore((s) => s.downloads);
  const refresh = useStore((s) => s.refresh);
  const [stt, setStt] = useState<SttModel[]>([]);
  const [llms, setLlms] = useState<OllamaModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const sttModels = await window.oatmeal.listSttModels();
    setStt(sttModels);
    try {
      setLlms(await window.oatmeal.listOllamaModels());
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
      alert(String(e));
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
      alert(String(e));
    } finally {
      setBusy(null);
    }
  };

  const pullLlm = async (name: string) => {
    setBusy(name);
    try {
      await window.oatmeal.pullOllamaModel(name);
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(null);
    }
  };

  const useLlm = async (name: string) => {
    await window.oatmeal.setSettings({ llmModel: name });
    await refresh();
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

        <Section title="Intelligence (Ollama — summaries & chat)">
          {status && !status.ollamaUp ? (
            <div className="rounded-lg bg-surface-tint px-3 py-2.5 text-[13px] leading-relaxed">
              Ollama isn't running. Oatmeal uses it for live summaries and chat.{" "}
              <button
                className="font-medium text-accent underline"
                onClick={() => void window.oatmeal.openExternal("https://ollama.com/download")}
              >
                Download Ollama
              </button>{" "}
              (free), open it once, then come back here.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {llms.map((m) => {
                const dl = downloads[m.name];
                return (
                  <ModelRow
                    key={m.name}
                    title={m.name}
                    subtitle={
                      m.installed
                        ? `${(m.sizeBytes / 1e9).toFixed(1)} GB${m.recommended ? " · " + m.recommended : ""}`
                        : (m.recommended ?? "available to pull")
                    }
                    active={settings?.llmModel === m.name}
                    installed={m.installed}
                    progress={dl?.status === "downloading" ? dl.pct : null}
                    busy={busy === m.name}
                    onDownload={() => void pullLlm(m.name)}
                    onUse={() => void useLlm(m.name)}
                  />
                );
              })}
            </div>
          )}
        </Section>

        <Section title="Meeting detection">
          <label className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
            <span className="text-[13px]">
              Notify me when a meeting app is using the microphone
            </span>
            <input
              type="checkbox"
              checked={settings?.detectionEnabled ?? true}
              onChange={(e) =>
                void window.oatmeal
                  .setSettings({ detectionEnabled: e.target.checked })
                  .then(() => refresh())
              }
              className="h-4 w-4 accent-(--color-accent)"
            />
          </label>
        </Section>

        <Section title="Permissions">
          <div className="flex flex-col gap-2">
            <PermRow
              ok={!!status?.permissions.microphone}
              label="Microphone — your side of the call"
              onFix={() => void window.oatmeal.openPrivacySettings("mic")}
            />
            <PermRow
              ok={!!status?.permissions.screenRecording}
              label="Screen Recording — system audio (their side)"
              onFix={() => void window.oatmeal.openPrivacySettings("screen")}
            />
          </div>
        </Section>

        <p className="mt-4 text-[12px] leading-relaxed text-ink-tertiary">
          Everything — audio, transcripts, summaries, chats — stays on this Mac.
          Oatmeal makes no network calls except to localhost (Ollama, whisper)
          and to download models you ask for.
        </p>
      </div>
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
