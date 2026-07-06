export type Speaker = "me" | "them";

export interface Meeting {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  summaryMd: string;
}

export interface Segment {
  id: number;
  meetingId: string;
  speaker: Speaker;
  text: string;
  t0Ms: number;
  t1Ms: number;
}

export interface ChatMessage {
  id: number;
  meetingId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface SttModel {
  id: string;
  label: string;
  sizeMb: number;
  file: string;
  url: string;
  installed: boolean;
}

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  installed: boolean;
  recommended?: string;
}

export interface DetectionState {
  meetingApp: string | null;
  micBusy: boolean;
  likelyMeeting: boolean;
}

export interface AppStatus {
  ollamaUp: boolean;
  whisperReady: boolean;
  sttModel: string | null;
  llmModel: string | null;
  permissions: { microphone: boolean; screenRecording: boolean };
}

export interface DownloadProgress {
  id: string;
  kind: "stt" | "ollama";
  pct: number;
  status: "downloading" | "done" | "error";
  error?: string;
}

export interface Settings {
  sttModel: string;
  llmModel: string;
  detectionEnabled: boolean;
}
