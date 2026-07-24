import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Markdown } from "../markdown";

export default function MeetingView({ meetingId }: { meetingId: string }) {
  const navigate = useStore((s) => s.navigate);
  const summaryMd = useStore((s) => s.summaryMd);
  const segments = useStore((s) => s.segments);
  const recordingId = useStore((s) => s.recordingMeetingId);
  const finalizingId = useStore((s) => s.finalizingMeetingId);
  const autoEndPending = useStore((s) => s.autoEndPending);
  const stopMeeting = useStore((s) => s.stopMeeting);
  const keepRecording = useStore((s) => s.keepRecording);
  const meetings = useStore((s) => s.meetings);
  const meeting = meetings.find((m) => m.id === meetingId);

  const isLive = recordingId === meetingId;
  const isFinalizing = finalizingId === meetingId;
  const [title, setTitle] = useState(meeting?.title ?? "");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => setTitle(meeting?.title ?? ""), [meeting?.title]);

  return (
    <div className="relative flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 px-6 pb-2 pt-1">
        <button
          onClick={() => navigate({ name: "home" })}
          className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-fill-soft-hover"
        >
          ← Meetings
        </button>
        {isLive && (
          <span className="flex items-center gap-2 text-[12px] text-accent">
            <span className="dancing-bars flex items-end gap-[3px]">
              <span /><span /><span /><span />
            </span>
            Recording
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {isLive ? (
            <button
              onClick={() => void stopMeeting()}
              className="rounded-lg bg-danger px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-danger-hover"
            >
              End meeting
            </button>
          ) : (
            <button
              onClick={() => void window.oatmeal.exportTranscript(meetingId)}
              className="rounded-lg bg-fill-soft-opaque px-3 py-1.5 text-[12.5px] font-medium hover:bg-fill-soft-hover"
            >
              ↓ Download transcript
            </button>
          )}
        </div>
      </div>

      {/* Document body: the summary/notes */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-8 pb-40 pt-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title.trim() && title !== meeting?.title) {
                void window.oatmeal.renameMeeting(meetingId, title.trim());
                void useStore.getState().refresh();
              }
            }}
            placeholder="Untitled meeting"
            className="mb-1 w-full bg-transparent font-serif text-[30px] font-semibold tracking-tight outline-none placeholder:text-ink-tertiary"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          />
          <div className="mb-6 text-[13px] text-ink-tertiary">
            {meeting &&
              new Date(meeting.startedAt).toLocaleString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
          </div>

          {isFinalizing ? (
            <FinalizingState />
          ) : isLive ? (
            <LiveState count={segments.length} />
          ) : summaryMd ? (
            <div className="text-[14.5px] leading-relaxed">
              <Markdown text={summaryMd} />
            </div>
          ) : (
            <div className="rounded-card border border-hairline bg-surface-sunken px-5 py-8 text-center text-[13.5px] text-ink-secondary">
              No summary was generated — the transcript may have been empty.
              {segments.length > 0 && " Open the transcript below to read it."}
            </div>
          )}
        </div>
      </div>

      {/* Auto-end toast */}
      {autoEndPending && (
        <div className="absolute inset-x-0 bottom-24 z-30 flex justify-center">
          <div className="flex items-center gap-3 rounded-full border border-hairline bg-surface-tooltip px-4 py-2 text-[13px] text-white shadow-pop">
            <span>Meeting looks over — wrapping up…</span>
            <button
              onClick={() => void keepRecording()}
              className="rounded-full bg-white/15 px-3 py-1 text-[12px] font-medium hover:bg-white/25"
            >
              Keep recording
            </button>
          </div>
        </div>
      )}

      {/* Bottom dock: transcript icon + chat launcher (Granola-style) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between p-4">
        <button
          onClick={() => setTranscriptOpen(true)}
          title="View transcript"
          className="pointer-events-auto flex h-10 items-center gap-2 rounded-full border border-hairline bg-surface-raised px-3.5 text-[12.5px] font-medium text-ink-secondary shadow-card hover:bg-surface-elevated"
        >
          <TranscriptIcon />
          Transcript
          {segments.length > 0 && (
            <span className="text-ink-tertiary">· {segments.length}</span>
          )}
        </button>

        {!chatOpen && (
          <button
            onClick={() => setChatOpen(true)}
            className="pointer-events-auto flex h-11 items-center gap-2 rounded-full bg-surface-raised px-5 text-[13.5px] text-ink-secondary shadow-pop ring-1 ring-hairline hover:ring-accent"
          >
            Ask anything
            <span className="text-ink-tertiary">↑</span>
          </button>
        )}
      </div>

      {chatOpen && <ChatPanel meetingId={meetingId} onClose={() => setChatOpen(false)} />}

      {transcriptOpen && (
        <TranscriptDrawer
          meetingId={meetingId}
          isLive={isLive}
          onClose={() => setTranscriptOpen(false)}
        />
      )}
    </div>
  );
}

function LiveState({ count }: { count: number }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-hairline bg-surface-sunken px-6 py-12 text-center">
      <span className="dancing-bars flex items-end gap-1">
        <span /><span /><span /><span />
      </span>
      <div className="text-[15px] font-medium">Listening to your meeting</div>
      <div className="max-w-sm text-[13px] leading-relaxed text-ink-secondary">
        Oatmeal is transcribing quietly in the background. Your polished notes are
        written automatically when the call ends.
      </div>
      <div className="text-[12px] text-ink-tertiary">
        {count > 0 ? `${count} lines captured so far` : "Waiting for speech…"}
      </div>
    </div>
  );
}

function FinalizingState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-hairline bg-surface-green px-6 py-12 text-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      <div className="text-[15px] font-medium">Writing your notes…</div>
      <div className="max-w-sm text-[13px] leading-relaxed text-ink-secondary">
        Summarizing the meeting and giving it a name. This runs on your local
        model, so it takes a moment.
      </div>
    </div>
  );
}

function TranscriptIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="1.5" rx="0.75" fill="currentColor" />
      <rect x="2" y="7" width="9" height="1.5" rx="0.75" fill="currentColor" />
      <rect x="2" y="11" width="11" height="1.5" rx="0.75" fill="currentColor" />
    </svg>
  );
}

function TranscriptDrawer({
  meetingId,
  isLive,
  onClose,
}: {
  meetingId: string;
  isLive: boolean;
  onClose: () => void;
}) {
  const segments = useStore((s) => s.segments);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isLive && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [segments.length, isLive]);

  return (
    <div className="absolute inset-0 z-40 flex" onClick={onClose}>
      <div className="flex-1 bg-ink/20" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-[440px] flex-col border-l border-hairline bg-surface-raised shadow-pop"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">
            Transcript {isLive && "· live"}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void window.oatmeal.exportTranscript(meetingId)}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-secondary hover:bg-fill-soft-hover"
            >
              ↓ Download
            </button>
            <button
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-fill-soft-hover"
            >
              ✕
            </button>
          </div>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {segments.length === 0 ? (
            <div className="pt-10 text-center text-[13px] text-ink-tertiary">
              {isLive ? "Waiting for speech…" : "No transcript captured."}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {segments.map((seg) => (
                <div key={seg.id} className="flex gap-3">
                  <span
                    className={
                      "mt-0.5 w-11 shrink-0 text-right text-[11px] font-semibold uppercase " +
                      (seg.speaker === "me" ? "text-accent" : "text-ink-tertiary")
                    }
                  >
                    {seg.speaker === "me" ? "Me" : "Them"}
                  </span>
                  <p className="min-w-0 text-[13px] leading-relaxed">{seg.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatPanel({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  const chat = useStore((s) => s.chat);
  const streaming = useStore((s) => s.chatStreaming);
  const sendChat = useStore((s) => s.sendChat);
  const sayMore = useStore((s) => s.sayMore);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, streaming?.length]);

  const send = () => {
    const text = input.trim();
    if (!text || streaming !== null) return;
    setInput("");
    void sendChat(text);
  };

  const empty = chat.length === 0 && streaming === null;
  const canSayMore = streaming === null && chat.some((m) => m.role === "assistant");

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4">
      <div className="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-surface-raised shadow-pop">
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-2">
          <span className="text-[12px] font-medium text-ink-secondary">
            Chat with this meeting
          </span>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-fill-soft-hover"
          >
            ✕
          </button>
        </div>

        {!empty && (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <div className="flex flex-col gap-3">
              {chat.map((m) => (
                <ChatBubble key={m.id} role={m.role} content={m.content} />
              ))}
              {streaming !== null && <ChatBubble role="assistant" content={streaming || "…"} />}
            </div>
            {canSayMore && (
              <button
                onClick={() => void sayMore()}
                className="mt-3 rounded-full border border-hairline px-3 py-1 text-[12px] font-medium text-ink-secondary hover:bg-fill-soft-hover"
              >
                Say more
              </button>
            )}
          </div>
        )}

        {empty && (
          <div className="px-4 pt-4 text-[13px] text-ink-tertiary">
            Ask anything about this meeting — “what did we decide?”, “list the action
            items”, “what were the next steps?”
          </div>
        )}

        <div className="shrink-0 p-3">
          <div className="flex items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              autoFocus
              placeholder="Ask anything"
              className="max-h-32 min-w-0 flex-1 resize-none self-center bg-transparent text-[13.5px] leading-6 outline-none placeholder:text-ink-tertiary"
            />
            <button
              onClick={send}
              disabled={!input.trim() || streaming !== null}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  return role === "user" ? (
    <div className="ml-10 self-end rounded-xl rounded-br-sm bg-accent-soft px-3 py-2 text-[13.5px] leading-relaxed">
      {content}
    </div>
  ) : (
    <div className="mr-6 self-start rounded-xl rounded-bl-sm bg-surface-sunken px-3 py-2 text-[13.5px] leading-relaxed">
      <Markdown text={content} />
    </div>
  );
}
