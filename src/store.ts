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
  recorderError: string | null;

  // current meeting detail
  segments: Segment[];
  summaryMd: string;
  chat: ChatMessage[];
  chatStreaming: string | null; // partial assistant reply

  navigate: (v: View) => void;
  refresh: () => Promise<void>;
  openMeeting: (id: string) => Promise<void>;
  startMeeting: (title: string) => Promise<void>;
  stopMeeting: () => Promise<void>;
  sendChat: (content: string) => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  view: { name: "home" },
  status: null,
  settings: null,
  meetings: [],
  detection: { meetingApp: null, micBusy: false, likelyMeeting: false },
  downloads: {},
  recordingMeetingId: null,
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

  startMeeting: async (title) => {
    set({ recorderError: null });
    const id = await window.oatmeal.startRecording(title);
    set({ recordingMeetingId: id });
    await get().refresh();
    await get().openMeeting(id);
  },

  stopMeeting: async () => {
    await window.oatmeal.stopRecording();
    set({ recordingMeetingId: null });
    await get().refresh();
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
  window.oatmeal.onSummary((meetingId, md) => {
    const st = s.getState();
    if (st.view.name === "meeting" && st.view.id === meetingId) {
      s.setState({ summaryMd: md });
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
          {
            id: Date.now(),
            meetingId,
            role: "assistant",
            content: full,
            createdAt: Date.now(),
          },
        ],
      });
    }
  });
  window.oatmeal.onRecordingState(({ recording, meetingId }) => {
    s.setState({ recordingMeetingId: recording ? meetingId : null });
    void s.getState().refresh();
  });
  window.oatmeal.onRecorderError((msg) => s.setState({ recorderError: msg }));
  window.oatmeal.onDetectionStartRequested(() => {
    const st = s.getState();
    if (!st.recordingMeetingId) {
      void st.startMeeting(st.detection.meetingApp ? `${st.detection.meetingApp} meeting` : "");
    }
  });
}
