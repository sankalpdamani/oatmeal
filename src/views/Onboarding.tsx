import { useEffect } from "react";
import { useStore } from "../store";

// First-launch setup. Shown whenever Microphone or Screen Recording isn't
// granted yet, so people are guided through the two macOS permissions (and the
// one relaunch ScreenCaptureKit requires) instead of starting a meeting that
// silently fails.
export default function Onboarding() {
  const status = useStore((s) => s.status);
  const refresh = useStore((s) => s.refresh);

  // Poll while on this screen so a grant reflects within a couple seconds.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const mic = !!status?.permissions.microphone;
  const systemAudio = !!status?.permissions.systemAudio;

  // Explicit requests (prompt once). The polled status check is read-only, so
  // these are the only things that show a permission dialog.
  const grantMic = async () => {
    try {
      await window.oatmeal.requestMic();
    } finally {
      await refresh();
    }
  };
  const grantSystemAudio = async () => {
    try {
      await window.oatmeal.requestSystemAudio();
    } finally {
      await refresh();
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-[460px]">
        <div className="mb-1 text-center text-[30px]">🥣</div>
        <h1 className="mb-1 text-center text-[20px] font-semibold tracking-tight">
          Welcome to Oatmeal
        </h1>
        <p className="mb-6 text-center text-[13px] leading-relaxed text-ink-secondary">
          Two quick audio permissions and you're set. Everything — audio,
          transcripts, notes — stays on this Mac.
        </p>

        <div className="flex flex-col gap-2">
          <Step
            n={1}
            done={mic}
            title="Microphone"
            desc="Transcribes your side of the call."
            primary={mic ? undefined : { label: "Grant", onClick: grantMic }}
            secondary={
              mic
                ? undefined
                : { label: "Open Settings", onClick: () => void window.oatmeal.openPrivacySettings("mic") }
            }
          />
          <Step
            n={2}
            done={systemAudio}
            title="System Audio"
            desc="Captures the other side of the call. No screen recording."
            primary={systemAudio ? undefined : { label: "Grant", onClick: grantSystemAudio }}
            secondary={
              systemAudio
                ? undefined
                : {
                    label: "Open Settings",
                    onClick: () => void window.oatmeal.openPrivacySettings("systemaudio"),
                  }
            }
          />
        </div>

        <p className="mt-5 text-center text-[12px] leading-relaxed text-ink-tertiary">
          Summaries &amp; chat use a local model (Ollama, LM Studio, …) — optional;
          transcription works without it. Set it up anytime in Settings.
        </p>
      </div>
    </div>
  );
}

type Action = { label: string; onClick: () => void };

function Step(props: {
  n: number;
  done: boolean;
  title: string;
  desc: string;
  primary?: Action;
  secondary?: Action;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-hairline px-3 py-3">
      <div
        className={
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold " +
          (props.done ? "bg-surface-green text-accent" : "bg-fill-soft-opaque text-ink-secondary")
        }
      >
        {props.done ? "✓" : props.n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{props.title}</div>
        <div className="text-[12px] text-ink-tertiary">{props.desc}</div>
      </div>
      {props.done ? (
        <span className="shrink-0 text-[12px] font-medium text-accent">Granted</span>
      ) : (
        <div className="flex shrink-0 items-center gap-1.5">
          {props.secondary && (
            <button
              onClick={props.secondary.onClick}
              className="rounded-md bg-fill-soft-opaque px-2.5 py-1 text-[12px] font-medium hover:bg-fill-soft-hover"
            >
              {props.secondary.label}
            </button>
          )}
          {props.primary && (
            <button
              onClick={props.primary.onClick}
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover"
            >
              {props.primary.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
