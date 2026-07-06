import { useState } from "react";
import { useStore } from "../store";

export default function Home() {
  const meetings = useStore((s) => s.meetings);
  const detection = useStore((s) => s.detection);
  const recordingId = useStore((s) => s.recordingMeetingId);
  const startMeeting = useStore((s) => s.startMeeting);
  const openMeeting = useStore((s) => s.openMeeting);
  const refresh = useStore((s) => s.refresh);
  const [starting, setStarting] = useState(false);

  const start = async (title: string) => {
    setStarting(true);
    try {
      await startMeeting(title);
    } catch (e) {
      alert(String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto px-6 pb-10 pt-2">
      {detection.likelyMeeting && !recordingId && (
        <div className="flex items-center justify-between rounded-card border border-hairline bg-surface-green px-4 py-3 shadow-card">
          <div className="flex items-center gap-3">
            <div className="dancing-bars flex items-end gap-[3px]">
              <span /><span /><span /><span />
            </div>
            <div>
              <div className="text-[14px] font-semibold">
                {detection.meetingApp} looks active
              </div>
              <div className="text-[12px] text-ink-secondary">
                Start taking notes for this meeting?
              </div>
            </div>
          </div>
          <button
            disabled={starting}
            onClick={() => void start(`${detection.meetingApp} meeting`)}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-50"
          >
            Start notes
          </button>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <h1 className="text-[22px] font-semibold tracking-tight">Meetings</h1>
        <button
          disabled={starting || !!recordingId}
          onClick={() => void start("")}
          className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-ink-inverse shadow-card hover:bg-accent-hover disabled:opacity-50"
        >
          {recordingId ? "Recording…" : "New meeting"}
        </button>
      </div>

      {meetings.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-2 text-center">
          <div className="text-4xl">🥣</div>
          <div className="text-[15px] font-medium">No meetings yet</div>
          <div className="max-w-sm text-[13px] leading-relaxed text-ink-secondary">
            Start a meeting and Oatmeal will transcribe both sides of the call,
            keep a live summary, and let you chat with the transcript — all on
            this Mac.
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {meetings.map((m) => (
            <li key={m.id}>
              <button
                onClick={() => void openMeeting(m.id)}
                className="group flex w-full items-center justify-between rounded-card border border-hairline bg-surface-raised px-4 py-3 text-left shadow-card transition hover:bg-surface-elevated"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-semibold">
                      {m.title}
                    </span>
                    {recordingId === m.id && (
                      <span className="flex items-center gap-1 rounded-full bg-surface-green px-2 py-0.5 text-[11px] font-medium text-accent">
                        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
                        Live
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                    {new Date(m.startedAt).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                    {m.summaryMd
                      ? " · " + firstLine(m.summaryMd)
                      : m.endedAt
                        ? " · no summary"
                        : ""}
                  </div>
                </div>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${m.title}"? This can't be undone.`)) {
                      void window.oatmeal.deleteMeeting(m.id).then(refresh);
                    }
                  }}
                  className="ml-3 hidden shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-tertiary hover:bg-fill-soft-hover hover:text-danger group-hover:block"
                >
                  Delete
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function firstLine(md: string): string {
  const line = md
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return line ? line.slice(0, 90) : "";
}
