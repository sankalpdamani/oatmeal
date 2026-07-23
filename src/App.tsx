import { useEffect, useState } from "react";
import { useStore } from "./store";
import Home from "./views/Home";
import MeetingView from "./views/MeetingView";
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

  const needsSetup =
    status &&
    (!status.llmUp ||
      !status.permissions.microphone ||
      !status.permissions.screenRecording);

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

      {needsSetup && <SetupBanner onOpenSettings={() => setSettingsOpen(true)} />}

      <div className="min-h-0 flex-1">
        {view.name === "home" ? <Home /> : <MeetingView meetingId={view.id} />}
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function SetupBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const status = useStore((s) => s.status);
  if (!status) return null;
  const items: { label: string; action?: () => void; actionLabel?: string }[] = [];
  if (!status.permissions.microphone)
    items.push({
      label: "Microphone access needed",
      action: () => void window.oatmeal.openPrivacySettings("mic"),
      actionLabel: "Open Settings",
    });
  if (!status.permissions.screenRecording) {
    items.push({
      label: "Screen Recording access needed (for system audio)",
      action: () => void window.oatmeal.openPrivacySettings("screen"),
      actionLabel: "Open Settings",
    });
    // ScreenCaptureKit only picks up the grant on a fresh launch, so people who
    // just enabled it are stuck until they relaunch — offer that directly.
    items.push({
      label: "Already enabled it? Relaunch for macOS to apply it",
      action: () => void window.oatmeal.relaunch(),
      actionLabel: "Relaunch",
    });
  }
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
