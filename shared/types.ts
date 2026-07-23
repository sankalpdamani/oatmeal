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

export interface LlmModel {
  id: string;
}

export interface DetectionState {
  meetingApp: string | null;
  micBusy: boolean;
  likelyMeeting: boolean;
}

export interface AppStatus {
  llmUp: boolean;
  whisperReady: boolean;
  sttModel: string | null;
  llmModel: string | null;
  llmBaseUrl: string;
  permissions: { microphone: boolean; systemAudio: boolean };
}

export interface DownloadProgress {
  id: string;
  kind: "stt";
  pct: number;
  status: "downloading" | "done" | "error";
  error?: string;
}

export interface Settings {
  sttModel: string;
  llmModel: string;
  llmBaseUrl: string;
  detectionEnabled: boolean;
}
