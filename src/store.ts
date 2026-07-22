import { create } from "zustand";
import type {
  AppStatus,
  ChatMessage,
  DetectionState,
  DownloadProgress,
  Meeting,
  Segment,
  Settings,
} from "../shared/types";

export type View = { name: "home" } | { name: "meeting"; id: string };

interface State {
  view: View;
  status: AppStatus | null;
  settings: Settings | null;
  meetings: Meeting[];
  detection: DetectionState;
  downloads: Record<string, DownloadProgress>;
  recordingMeetingId: string | null;
  finalizingMeetingId: string | null;
  autoEndPending: boolean;
  recorderError: string | null;

  // current meeting detail
  segments: Segment[];
  summaryMd: string;
  chat: ChatMessage[];
  chatStreaming: string | null; // partial assistant reply

  navigate: (v: View) => void;
  refresh: () => Promise<void>;
  openMeeting: (id: string) => Promise<void>;
  startMeeting: (title: string, appName?: string | null) => Promise<void>;
  stopMeeting: () => Promise<void>;
  keepRecording: () => Promise<void>;
  sendChat: (content: string) => Promise<void>;
  sayMore: () => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  view: { name: "home" },
  status: null,
  settings: null,
  meetings: [],
  detection: { meetingApp: null, micBusy: false, likelyMeeting: false },
  downloads: {},
  recordingMeetingId: null,
  finalizingMeetingId: null,
  autoEndPending: false,
  recorderError: null,
  segments: [],
  summaryMd: "",
  chat: [],
  chatStreaming: null,

  navigate: (v) => set({ view: v }),

  refresh: async () => {
    const [status, settings, meetings, active] = await Promise.all([
      window.oatmeal.status(),
      window.oatmeal.getSettings(),
      window.oatmeal.listMeetings(),
      window.oatmeal.activeRecording(),
    ]);
    set({ status, settings, meetings, recordingMeetingId: active });
  },

  openMeeting: async (id) => {
    const { meeting, segments, chat } = await window.oatmeal.getMeeting(id);
    set({
      view: { name: "meeting", id },
      segments,
      chat,
      summaryMd: meeting?.summaryMd ?? "",
      chatStreaming: null,
    });
  },

  startMeeting: async (title, appName) => {
    set({ recorderError: null });
    const id = await window.oatmeal.startRecording(title, appName ?? null);
    set({ recordingMeetingId: id });
    await get().refresh();
    await get().openMeeting(id);
  },

  stopMeeting: async () => {
    await window.oatmeal.stopRecording();
    set({ recordingMeetingId: null });
  },

  keepRecording: async () => {
    await window.oatmeal.keepRecording();
    set({ autoEndPending: false });
  },

  sendChat: async (content) => {
    const view = get().view;
    if (view.name !== "meeting") return;
    const id = view.id;
    set((s) => ({
      chat: [
        ...s.chat,
        { id: -Date.now(), meetingId: id, role: "user", content, createdAt: Date.now() },
      ],
      chatStreaming: "",
    }));
    try {
      await window.oatmeal.sendChat(id, content);
    } catch (e) {
      set((s) => ({
        chatStreaming: null,
        chat: [
          ...s.chat,
          {
            id: -Date.now() - 1,
            meetingId: id,
            role: "assistant",
            content: `Something went wrong talking to Ollama: ${String(e)}`,
            createdAt: Date.now(),
          },
        ],
      }));
    }
  },

  sayMore: async () => {
    const { chat, chatStreaming } = get();
    if (chatStreaming !== null) return;
    const lastAssistant = [...chat].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    await get().sendChat(
      "Say more — expand your previous answer with additional detail and specifics drawn from the transcript."
    );
  },
}));

// Wire main-process events once.
export function initStoreEvents() {
  const s = useStore;
  window.oatmeal.onSegment((seg) => {
    const st = s.getState();
    if (st.view.name === "meeting" && st.view.id === seg.meetingId) {
      s.setState({ segments: [...st.segments, seg] });
    }
  });
  window.oatmeal.onDetection((detection) => s.setState({ detection }));
  window.oatmeal.onDownloadProgress((p) =>
    s.setState((st) => ({ downloads: { ...st.downloads, [p.id]: p } }))
  );
  window.oatmeal.onChatToken((meetingId, token) => {
    const st = s.getState();
    if (st.view.name === "meeting" && st.view.id === meetingId) {
      s.setState({ chatStreaming: (st.chatStreaming ?? "") + token });
    }
  });
  window.oatmeal.onChatDone((meetingId, full) => {
    const st = s.getState();
    if (st.view.name === "meeting" && st.view.id === meetingId) {
      s.setState({
        chatStreaming: null,
        chat: [
          ...st.chat,
          { id: Date.now(), meetingId, role: "assistant", content: full, createdAt: Date.now() },
        ],
      });
    }
  });
  window.oatmeal.onRecordingState(({ recording, meetingId }) => {
    s.setState({
      recordingMeetingId: recording ? meetingId : null,
      autoEndPending: false,
    });
    void s.getState().refresh();
  });
  window.oatmeal.onFinalizing(({ meetingId }) => {
    s.setState({ finalizingMeetingId: meetingId, autoEndPending: false });
  });
  window.oatmeal.onFinalized(({ meetingId, summaryMd }) => {
    const st = s.getState();
    const patch: Partial<ReturnType<typeof s.getState>> = { finalizingMeetingId: null };
    if (st.view.name === "meeting" && st.view.id === meetingId) patch.summaryMd = summaryMd;
    s.setState(patch);
    void st.refresh();
  });
  window.oatmeal.onAutoEndPending(() => s.setState({ autoEndPending: true }));
  window.oatmeal.onAutoEndCancelled(() => s.setState({ autoEndPending: false }));
  window.oatmeal.onRecorderError((msg) =>
    s.setState({ recorderError: msg, finalizingMeetingId: null })
  );
  window.oatmeal.onDetectionStartRequested(() => {
    const st = s.getState();
    if (!st.recordingMeetingId) {
      void st.startMeeting("", st.detection.meetingApp);
    }
  });
}
