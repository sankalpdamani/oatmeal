import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Markdown } from "../markdown";

export default function MeetingView({ meetingId }: { meetingId: string }) {
  const navigate = useStore((s) => s.navigate);
  const segments = useStore((s) => s.segments);
  const summaryMd = useStore((s) => s.summaryMd);
  const recordingId = useStore((s) => s.recordingMeetingId);
  const stopMeeting = useStore((s) => s.stopMeeting);
  const meetings = useStore((s) => s.meetings);
  const meeting = meetings.find((m) => m.id === meetingId);
  const isLive = recordingId === meetingId;
  const [tab, setTab] = useState<"summary" | "chat">("summary");
  const [title, setTitle] = useState(meeting?.title ?? "");

  useEffect(() => {
    setTitle(meeting?.title ?? "");
  }, [meeting?.title]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments.length]);

  return (
    <div className="flex h-full flex-col px-4 pb-4">
      <div className="flex shrink-0 items-center gap-3 pb-3">
        <button
          onClick={() => navigate({ name: "home" })}
          className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-fill-soft-hover"
        >
          ← Back
        </button>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() && title !== meeting?.title) {
              void window.oatmeal.renameMeeting(meetingId, title.trim());
              void useStore.getState().refresh();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[17px] font-semibold tracking-tight outline-none placeholder:text-ink-tertiary"
          placeholder="Untitled meeting"
        />
        {isLive ? (
          <div className="flex items-center gap-3">
            <div className="dancing-bars flex items-end gap-[3px]">
              <span /><span /><span /><span />
            </div>
            <button
              onClick={() => void stopMeeting()}
              className="rounded-lg bg-danger px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-danger-hover"
            >
              End meeting
            </button>
          </div>
        ) : (
          <span className="text-[12px] text-ink-tertiary">
            {meeting?.endedAt
              ? `Ended ${new Date(meeting.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : ""}
          </span>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_420px] gap-4">
        {/* Transcript */}
        <div className="flex min-h-0 flex-col rounded-card border border-hairline bg-surface-raised shadow-card">
          <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-2.5">
            <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">
              Transcript
            </span>
            {isLive && (
              <span className="flex items-center gap-1.5 text-[12px] text-accent">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
                Listening
              </span>
            )}
          </div>
          <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {segments.length === 0 ? (
              <div className="pt-10 text-center text-[13px] text-ink-tertiary">
                {isLive
                  ? "Waiting for someone to speak…"
                  : "No transcript for this meeting."}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {segments.map((seg) => (
                  <div key={seg.id} className="flex gap-3">
                    <span
                      className={
                        "mt-0.5 w-12 shrink-0 text-right text-[11px] font-semibold uppercase " +
                        (seg.speaker === "me" ? "text-accent" : "text-ink-tertiary")
                      }
                    >
                      {seg.speaker === "me" ? "Me" : "Them"}
                    </span>
                    <p className="min-w-0 text-[13.5px] leading-relaxed">{seg.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right pane: summary / chat */}
        <div className="flex min-h-0 flex-col rounded-card border border-hairline bg-surface-raised shadow-card">
          <div className="flex shrink-0 gap-1 border-b border-hairline px-3 py-2">
            {(["summary", "chat"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "rounded-md px-3 py-1 text-[12.5px] font-medium capitalize " +
                  (tab === t
                    ? "bg-fill-soft-opaque text-ink"
                    : "text-ink-secondary hover:bg-fill-soft-hover")
                }
              >
                {t === "summary" ? (isLive ? "Live summary" : "Summary") : "Chat"}
              </button>
            ))}
          </div>
          {tab === "summary" ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13.5px]">
              {summaryMd ? (
                <Markdown text={summaryMd} />
              ) : (
                <div className="pt-10 text-center text-[13px] text-ink-tertiary">
                  {isLive
                    ? "Summary appears here about half a minute into the conversation."
                    : "No summary was generated for this meeting."}
                </div>
              )}
            </div>
          ) : (
            <ChatPane meetingId={meetingId} />
          )}
        </div>
      </div>
    </div>
  );
}

function ChatPane({ meetingId }: { meetingId: string }) {
  const chat = useStore((s) => s.chat);
  const streaming = useStore((s) => s.chatStreaming);
  const sendChat = useStore((s) => s.sendChat);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {chat.length === 0 && streaming === null ? (
          <div className="pt-10 text-center text-[13px] text-ink-tertiary">
            Ask anything about this meeting —<br />
            “what did we decide?”, “list the action items”…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {chat.map((m) => (
              <ChatBubble key={m.id} role={m.role} content={m.content} />
            ))}
            {streaming !== null && (
              <ChatBubble role="assistant" content={streaming || "…"} />
            )}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-hairline p-3">
        <div className="flex items-end gap-2 rounded-lg border border-hairline bg-surface px-3 py-2">
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
            placeholder="Ask about this meeting…"
            className="max-h-32 min-w-0 flex-1 resize-none bg-transparent text-[13.5px] outline-none placeholder:text-ink-tertiary"
          />
          <button
            onClick={send}
            disabled={!input.trim() || streaming !== null}
            className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-40"
          >
            Send
          </button>
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
