import Database from "better-sqlite3";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { ChatMessage, Meeting, Segment, Speaker } from "../shared/types";

let db: Database.Database;

export function initDb() {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(path.join(dir, "oatmeal.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      summary_md TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      t0_ms INTEGER NOT NULL,
      t1_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_segments_meeting ON segments(meeting_id);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_meeting ON chat_messages(meeting_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

const rowToMeeting = (r: any): Meeting => ({
  id: r.id,
  title: r.title,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  summaryMd: r.summary_md,
});

export function createMeeting(id: string, title: string): Meeting {
  db.prepare("INSERT INTO meetings (id, title, started_at) VALUES (?, ?, ?)").run(
    id,
    title,
    Date.now()
  );
  return getMeeting(id)!;
}

export function getMeeting(id: string): Meeting | null {
  const r = db
    .prepare("SELECT id, title, started_at, ended_at, summary_md FROM meetings WHERE id = ?")
    .get(id);
  return r ? rowToMeeting(r) : null;
}

export function listMeetings(): Meeting[] {
  return db
    .prepare(
      "SELECT id, title, started_at, ended_at, summary_md FROM meetings ORDER BY started_at DESC"
    )
    .all()
    .map(rowToMeeting);
}

export function endMeeting(id: string) {
  db.prepare("UPDATE meetings SET ended_at = ? WHERE id = ?").run(Date.now(), id);
}

export function renameMeeting(id: string, title: string) {
  db.prepare("UPDATE meetings SET title = ? WHERE id = ?").run(title, id);
}

export function deleteMeeting(id: string) {
  db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
}

export function saveSummary(meetingId: string, summaryMd: string) {
  db.prepare("UPDATE meetings SET summary_md = ? WHERE id = ?").run(summaryMd, meetingId);
}

export function addSegment(
  meetingId: string,
  speaker: Speaker,
  text: string,
  t0Ms: number,
  t1Ms: number
): Segment {
  const info = db
    .prepare(
      "INSERT INTO segments (meeting_id, speaker, text, t0_ms, t1_ms) VALUES (?, ?, ?, ?, ?)"
    )
    .run(meetingId, speaker, text, t0Ms, t1Ms);
  return {
    id: Number(info.lastInsertRowid),
    meetingId,
    speaker,
    text,
    t0Ms,
    t1Ms,
  };
}

export function listSegments(meetingId: string): Segment[] {
  return db
    .prepare(
      "SELECT id, meeting_id, speaker, text, t0_ms, t1_ms FROM segments WHERE meeting_id = ? ORDER BY t0_ms ASC"
    )
    .all(meetingId)
    .map((r: any) => ({
      id: r.id,
      meetingId: r.meeting_id,
      speaker: r.speaker as Speaker,
      text: r.text,
      t0Ms: r.t0_ms,
      t1Ms: r.t1_ms,
    }));
}

export function addChatMessage(
  meetingId: string,
  role: "user" | "assistant",
  content: string
): ChatMessage {
  const createdAt = Date.now();
  const info = db
    .prepare(
      "INSERT INTO chat_messages (meeting_id, role, content, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(meetingId, role, content, createdAt);
  return { id: Number(info.lastInsertRowid), meetingId, role, content, createdAt };
}

export function listChatMessages(meetingId: string): ChatMessage[] {
  return db
    .prepare(
      "SELECT id, meeting_id, role, content, created_at FROM chat_messages WHERE meeting_id = ? ORDER BY created_at ASC"
    )
    .all(meetingId)
    .map((r: any) => ({
      id: r.id,
      meetingId: r.meeting_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
}

export function getSetting(key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
