import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Meeting } from "../../shared/types";

interface SegmentHit {
  meetingId: string;
  meetingTitle: string;
  startedAt: number;
  speaker: string;
  snippet: string;
  t0Ms: number;
}

export default function Home() {
  const meetings = useStore((s) => s.meetings);
  const detection = useStore((s) => s.detection);
  const recordingId = useStore((s) => s.recordingMeetingId);
  const finalizingId = useStore((s) => s.finalizingMeetingId);
  const startMeeting = useStore((s) => s.startMeeting);
  const openMeeting = useStore((s) => s.openMeeting);
  const refresh = useStore((s) => s.refresh);
  const [starting, setStarting] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ segments: SegmentHit[]; meetings: Meeting[] } | null>(
    null
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void window.oatmeal.searchMeetings(q).then(setResults);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const searching = results !== null;

  const start = async (title: string, appName?: string | null) => {
    setStarting(true);
    try {
      await startMeeting(title, appName);
    } catch (e) {
      console.error(e);
      alert("Couldn't start recording. Check Oatmeal's Microphone and System Audio permissions in System Settings, then try again.");
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
            onClick={() => void start("", detection.meetingApp)}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-50"
          >
            Start notes
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <h1 className="text-[22px] font-semibold tracking-tight">Meetings</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search meetings…"
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-[13px] outline-none placeholder:text-ink-tertiary focus:ring-1 focus:ring-accent"
        />
        <button
          disabled={starting || !!recordingId}
          onClick={() => void start("")}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-ink-inverse shadow-card hover:bg-accent-hover disabled:opacity-50"
        >
          {recordingId ? "Recording…" : "New meeting"}
        </button>
      </div>

      {searching ? (
        <SearchResults
          results={results!}
          onOpen={(id) => {
            setQuery("");
            setResults(null);
            void openMeeting(id);
          }}
        />
      ) : meetings.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-2 text-center">
          <div className="text-4xl">🥣</div>
          <div className="text-[15px] font-medium">No meetings yet</div>
          <div className="max-w-sm text-[13px] leading-relaxed text-ink-secondary">
            Start a meeting and Oatmeal will transcribe both sides of the call,
            write the notes when it ends, and let you chat with the transcript —
            all on this Mac.
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
                    {finalizingId === m.id && (
                      <span className="rounded-full bg-surface-tint px-2 py-0.5 text-[11px] font-medium text-accent">
                        Summarizing…
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

function SearchResults({
  results,
  onOpen,
}: {
  results: { segments: SegmentHit[]; meetings: Meeting[] };
  onOpen: (id: string) => void;
}) {
  const empty = results.segments.length === 0 && results.meetings.length === 0;
  if (empty) {
    return (
      <div className="pt-12 text-center text-[13px] text-ink-tertiary">
        Nothing found. Try different words.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {results.meetings.length > 0 && (
        <div>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">
            Meetings
          </h2>
          <ul className="flex flex-col gap-1.5">
            {results.meetings.map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => onOpen(m.id)}
                  className="w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-left text-[13.5px] font-medium hover:bg-surface-elevated"
                >
                  {m.title}
                  <span className="ml-2 text-[12px] font-normal text-ink-tertiary">
                    {new Date(m.startedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {results.segments.length > 0 && (
        <div>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">
            In transcripts
          </h2>
          <ul className="flex flex-col gap-1.5">
            {results.segments.map((s, i) => (
              <li key={`${s.meetingId}-${s.t0Ms}-${i}`}>
                <button
                  onClick={() => onOpen(s.meetingId)}
                  className="w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-left hover:bg-surface-elevated"
                >
                  <span className="block truncate text-[12px] text-ink-tertiary">
                    {s.meetingTitle} ·{" "}
                    {new Date(s.startedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · {s.speaker === "me" ? "Me" : "Them"}
                  </span>
                  <span className="block text-[13px] leading-relaxed">{s.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
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
