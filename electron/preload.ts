import { contextBridge, ipcRenderer } from "electron";
import type {
  AppStatus,
  ChatMessage,
  DetectionState,
  DownloadProgress,
  LlmModel,
  Meeting,
  Segment,
  Settings,
  SttModel,
} from "../shared/types";

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void) {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) =>
    cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  status: (): Promise<AppStatus> => ipcRenderer.invoke("status"),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke("settings:set", patch),

  listMeetings: (): Promise<Meeting[]> => ipcRenderer.invoke("meetings:list"),
  searchMeetings: (
    query: string
  ): Promise<{
    segments: {
      meetingId: string;
      meetingTitle: string;
      startedAt: number;
      speaker: string;
      snippet: string;
      t0Ms: number;
    }[];
    meetings: Meeting[];
  }> => ipcRenderer.invoke("meetings:search", query),
  getMeeting: (
    id: string
  ): Promise<{ meeting: Meeting | null; segments: Segment[]; chat: ChatMessage[] }> =>
    ipcRenderer.invoke("meetings:get", id),
  renameMeeting: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke("meetings:rename", id, title),
  deleteMeeting: (id: string): Promise<void> => ipcRenderer.invoke("meetings:delete", id),

  startRecording: (title: string, appName?: string | null): Promise<string> =>
    ipcRenderer.invoke("recording:start", title, appName),
  stopRecording: (): Promise<void> => ipcRenderer.invoke("recording:stop"),
  activeRecording: (): Promise<string | null> => ipcRenderer.invoke("recording:active"),
  keepRecording: (): Promise<void> => ipcRenderer.invoke("recording:keep"),
  exportTranscript: (meetingId: string): Promise<string | null> =>
    ipcRenderer.invoke("transcript:export", meetingId),

  listSttModels: (): Promise<SttModel[]> => ipcRenderer.invoke("stt:list"),
  downloadSttModel: (id: string): Promise<void> => ipcRenderer.invoke("stt:download", id),
  useSttModel: (id: string): Promise<void> => ipcRenderer.invoke("stt:use", id),

  listLlmModels: (): Promise<LlmModel[]> => ipcRenderer.invoke("llm:list"),

  sendChat: (meetingId: string, content: string): Promise<string> =>
    ipcRenderer.invoke("chat:send", meetingId, content),

  requestMic: (): Promise<boolean> => ipcRenderer.invoke("permissions:request-mic"),
  requestSystemAudio: (): Promise<boolean> =>
    ipcRenderer.invoke("permissions:request-systemaudio"),
  relaunch: (): Promise<void> => ipcRenderer.invoke("app:relaunch"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("open-external", url),
  integrationStatus: (): Promise<
    { id: string; label: string; installed: boolean; connected: boolean; configPath: string }[]
  > => ipcRenderer.invoke("integrations:status"),
  connectIntegration: (
    id: string
  ): Promise<
    { id: string; label: string; installed: boolean; connected: boolean; configPath: string }[]
  > => ipcRenderer.invoke("integrations:connect", id),
  checkForUpdate: (): Promise<{
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    releasePage: string;
  }> => ipcRenderer.invoke("updates:check"),
  openPrivacySettings: (pane: "mic" | "systemaudio"): Promise<void> =>
    ipcRenderer.invoke("open-privacy-settings", pane),

  onSegment: (cb: (seg: Segment) => void) => on("segment", cb),
  onDetection: (cb: (state: DetectionState) => void) => on("detection", cb),
  onDetectionStartRequested: (cb: () => void) => on("detection-start-requested", cb),
  onDownloadProgress: (cb: (p: DownloadProgress) => void) => on("download-progress", cb),
  onChatToken: (cb: (meetingId: string, token: string) => void) => on("chat-token", cb),
  onChatDone: (cb: (meetingId: string, full: string) => void) => on("chat-done", cb),
  onRecordingState: (
    cb: (s: { meetingId: string; recording: boolean; reason?: string }) => void
  ) => on("recording-state", cb),
  onFinalizing: (cb: (s: { meetingId: string }) => void) => on("finalizing", cb),
  onFinalized: (
    cb: (s: { meetingId: string; title: string; summaryMd: string }) => void
  ) => on("finalized", cb),
  onAutoEndPending: (cb: (s: { graceMs: number }) => void) => on("auto-end-pending", cb),
  onAutoEndCancelled: (cb: () => void) => on("auto-end-cancelled", cb),
  onRecorderError: (cb: (msg: string) => void) => on("recorder-error", cb),
};

export type OatmealApi = typeof api;
contextBridge.exposeInMainWorld("oatmeal", api);
