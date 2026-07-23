import { useEffect, useState } from "react";
import { useStore } from "./store";
import Home from "./views/Home";
import MeetingView from "./views/MeetingView";
import Onboarding from "./views/Onboarding";
import SettingsModal from "./views/SettingsModal";

export default function App() {
  const view = useStore((s) => s.view);
  const status = useStore((s) => s.status);
  const refresh = useStore((s) => s.refresh);
  const recorderError = useStore((s) => s.recorderError);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
  }, [refresh]);

  // No microphone blocks recording entirely — take over the whole view with
  // guided setup rather than letting a meeting start and silently fail.
  const needsPermissions = !!status && !status.permissions.microphone;
  // System audio and a local LLM are non-blocking nudges once mic is in.
  const needsBanner =
    !!status && !needsPermissions && (!status.permissions.systemAudio || !status.llmUp);

  return (
    <div className="flex h-full flex-col">
      <div className="titlebar-drag flex h-11 shrink-0 items-center justify-between pl-20 pr-3">
        <span className="text-[13px] font-semibold tracking-tight text-ink-secondary-strong">
          Oatmeal
        </span>
        <button
          onClick={() => setSettingsOpen(true)}
          className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-fill-soft-hover"
        >
          Settings
        </button>
      </div>

      {recorderError && (
        <div className="mx-4 mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger-hover">
          {recorderError}
        </div>
      )}

      {needsBanner && <SetupBanner onOpenSettings={() => setSettingsOpen(true)} />}

      <div className="min-h-0 flex-1">
        {needsPermissions ? (
          <Onboarding />
        ) : view.name === "home" ? (
          <Home />
        ) : (
          <MeetingView meetingId={view.id} />
        )}
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function SetupBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const status = useStore((s) => s.status);
  if (!status) return null;
  const items: { label: string; action?: () => void; actionLabel?: string }[] = [];
  if (!status.permissions.systemAudio)
    items.push({
      label: "System Audio not enabled — the other side won't be transcribed",
      action: () => void window.oatmeal.requestSystemAudio(),
      actionLabel: "Enable",
    });
  if (!status.llmUp)
    items.push({
      label: "No local LLM server detected — summaries and chat need one",
      action: () => void window.oatmeal.openExternal("https://ollama.com/download"),
      actionLabel: "Get Ollama",
    });
  if (items.length === 0) return null;
  return (
    <div className="mx-4 mb-2 space-y-1">
      {items.map((it) => (
        <div
          key={it.label}
          className="flex items-center justify-between rounded-lg border border-hairline bg-surface-tint px-3 py-2 text-[13px]"
        >
          <span>{it.label}</span>
          <span className="flex gap-2">
            {it.action && (
              <button
                onClick={it.action}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover"
              >
                {it.actionLabel}
              </button>
            )}
            <button
              onClick={onOpenSettings}
              className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-fill-soft-hover"
            >
              Details
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
