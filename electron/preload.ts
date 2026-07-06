import { contextBridge, ipcRenderer } from "electron";
import type {
  AppStatus,
  ChatMessage,
  DetectionState,
  DownloadProgress,
  Meeting,
  OllamaModel,
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
  getMeeting: (
    id: string
  ): Promise<{ meeting: Meeting | null; segments: Segment[]; chat: ChatMessage[] }> =>
    ipcRenderer.invoke("meetings:get", id),
  renameMeeting: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke("meetings:rename", id, title),
  deleteMeeting: (id: string): Promise<void> => ipcRenderer.invoke("meetings:delete", id),

  startRecording: (title: string): Promise<string> =>
    ipcRenderer.invoke("recording:start", title),
  stopRecording: (): Promise<void> => ipcRenderer.invoke("recording:stop"),
  activeRecording: (): Promise<string | null> => ipcRenderer.invoke("recording:active"),

  listSttModels: (): Promise<SttModel[]> => ipcRenderer.invoke("stt:list"),
  downloadSttModel: (id: string): Promise<void> => ipcRenderer.invoke("stt:download", id),
  useSttModel: (id: string): Promise<void> => ipcRenderer.invoke("stt:use", id),

  listOllamaModels: (): Promise<OllamaModel[]> => ipcRenderer.invoke("ollama:list"),
  pullOllamaModel: (name: string): Promise<void> => ipcRenderer.invoke("ollama:pull", name),

  sendChat: (meetingId: string, content: string): Promise<string> =>
    ipcRenderer.invoke("chat:send", meetingId, content),

  checkPermissions: (): Promise<{ microphone: boolean; screenRecording: boolean }> =>
    ipcRenderer.invoke("permissions:check"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("open-external", url),
  openPrivacySettings: (pane: "mic" | "screen"): Promise<void> =>
    ipcRenderer.invoke("open-privacy-settings", pane),

  onSegment: (cb: (seg: Segment) => void) => on("segment", cb),
  onSummary: (cb: (meetingId: string, md: string) => void) => on("summary", cb),
  onDetection: (cb: (state: DetectionState) => void) => on("detection", cb),
  onDetectionStartRequested: (cb: () => void) => on("detection-start-requested", cb),
  onDownloadProgress: (cb: (p: DownloadProgress) => void) => on("download-progress", cb),
  onChatToken: (cb: (meetingId: string, token: string) => void) => on("chat-token", cb),
  onChatDone: (cb: (meetingId: string, full: string) => void) => on("chat-done", cb),
  onRecordingState: (cb: (s: { meetingId: string; recording: boolean }) => void) =>
    on("recording-state", cb),
  onRecorderError: (cb: (msg: string) => void) => on("recorder-error", cb),
};

export type OatmealApi = typeof api;
contextBridge.exposeInMainWorld("oatmeal", api);
