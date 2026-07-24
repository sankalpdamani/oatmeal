#!/usr/bin/env node
// Oatmeal MCP server (stdio). Gives Claude access to the local Oatmeal
// meeting database (read-only) and — when the app is running — recording
// control via the app's loopback control endpoint.
//
// Data source: ~/Library/Application Support/Oatmeal/oatmeal.db (SQLite).
// Control endpoint: http://127.0.0.1:17772 (served by the Oatmeal app).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DB_PATH = path.join(
  homedir(),
  "Library",
  "Application Support",
  "Oatmeal",
  "oatmeal.db"
);
const CONTROL = "http://127.0.0.1:17772";

// ---------- helpers ----------

function openDb(): DatabaseSync {
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Oatmeal database not found at ${DB_PATH}. Open the Oatmeal app once so it can initialize its database (or install it from https://github.com/sankalpdamani/oatmeal/releases).`
    );
  }
  // Open per-call: cheap for SQLite, and always sees the app's latest writes.
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

interface MeetingRow {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  summary_md: string;
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

function meetingJson(m: MeetingRow, segmentCount?: number) {
  return {
    id: m.id,
    title: m.title,
    startedAt: iso(m.started_at),
    endedAt: iso(m.ended_at),
    inProgress: m.ended_at == null,
    hasSummary: m.summary_md.length > 0,
    ...(segmentCount !== undefined ? { segmentCount } : {}),
  };
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

async function controlRequest(
  route: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL}${route}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(
      "The Oatmeal app is not running (its control endpoint on 127.0.0.1:17772 did not respond). Ask the user to open /Applications/Oatmeal.app, then retry. Reading past meetings/transcripts still works without the app."
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(json.error ?? `Oatmeal control endpoint returned HTTP ${res.status}`));
  }
  return json;
}

// ---------- server ----------

const server = new McpServer({ name: "oatmeal", version: "0.1.0" });

server.registerTool(
  "oatmeal_list_meetings",
  {
    title: "List meetings",
    description:
      "List meetings recorded by Oatmeal (the user's local meeting notetaker), newest first. Returns id, title, start/end times, whether a summary exists, and segment counts. Use the id with other oatmeal tools.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(25)
        .describe("Maximum meetings to return (default 25)"),
      query: z.string().optional()
        .describe("Optional case-insensitive substring filter on the meeting title"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ limit, query }) => {
    try {
      const db = openDb();
      const rows = (query
        ? db
            .prepare(
              "SELECT id, title, started_at, ended_at, summary_md FROM meetings WHERE title LIKE ? ORDER BY started_at DESC LIMIT ?"
            )
            .all(`%${query}%`, limit)
        : db
            .prepare(
              "SELECT id, title, started_at, ended_at, summary_md FROM meetings ORDER BY started_at DESC LIMIT ?"
            )
            .all(limit)) as unknown as MeetingRow[];
      const counts = db
        .prepare("SELECT meeting_id, COUNT(*) AS n FROM segments GROUP BY meeting_id")
        .all() as unknown as { meeting_id: string; n: number }[];
      const countMap = new Map(counts.map((c) => [c.meeting_id, c.n]));
      db.close();
      return ok({
        meetings: rows.map((m) => meetingJson(m, countMap.get(m.id) ?? 0)),
      });
    } catch (e) {
      return err(String(e instanceof Error ? e.message : e));
    }
  }
);

server.registerTool(
  "oatmeal_get_meeting",
  {
    title: "Get meeting summary & metadata",
    description:
      "Get one Oatmeal meeting: metadata plus its AI-written summary notes (markdown with TL;DR, key points, decisions, action items). For the raw conversation, use oatmeal_get_transcript.",
    inputSchema: {
      meeting_id: z.string().describe("Meeting id from oatmeal_list_meetings"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ meeting_id }) => {
    try {
      const db = openDb();
      const m = db
        .prepare(
          "SELECT id, title, started_at, ended_at, summary_md FROM meetings WHERE id = ?"
        )
        .get(meeting_id) as unknown as MeetingRow | undefined;
      if (!m) {
        db.close();
        return err(
          `No meeting with id "${meeting_id}". Call oatmeal_list_meetings to see valid ids.`
        );
      }
      const seg = db
        .prepare("SELECT COUNT(*) AS n FROM segments WHERE meeting_id = ?")
        .get(meeting_id) as unknown as { n: number };
      db.close();
      return ok({ ...meetingJson(m, seg.n), summaryMarkdown: m.summary_md || null });
    } catch (e) {
      return err(String(e instanceof Error ? e.message : e));
    }
  }
);

server.registerTool(
  "oatmeal_get_transcript",
  {
    title: "Get meeting transcript",
    description:
      'Get the transcript of an Oatmeal meeting as ordered speaker-labeled lines ("Me" is the Oatmeal user, "Them" is everyone else on the call). Paginated: use offset/limit and the returned totalSegments to fetch long meetings in parts.',
    inputSchema: {
      meeting_id: z.string().describe("Meeting id from oatmeal_list_meetings"),
      offset: z.number().int().min(0).default(0)
        .describe("Segment offset to start from (default 0)"),
      limit: z.number().int().min(1).max(500).default(200)
        .describe("Max segments to return (default 200, max 500)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ meeting_id, offset, limit }) => {
    try {
      const db = openDb();
      const exists = db
        .prepare("SELECT id, title FROM meetings WHERE id = ?")
        .get(meeting_id) as unknown as { id: string; title: string } | undefined;
      if (!exists) {
        db.close();
        return err(
          `No meeting with id "${meeting_id}". Call oatmeal_list_meetings to see valid ids.`
        );
      }
      const total = (
        db
          .prepare("SELECT COUNT(*) AS n FROM segments WHERE meeting_id = ?")
          .get(meeting_id) as unknown as { n: number }
      ).n;
      const rows = db
        .prepare(
          "SELECT speaker, text, t0_ms FROM segments WHERE meeting_id = ? ORDER BY t0_ms ASC LIMIT ? OFFSET ?"
        )
        .all(meeting_id, limit, offset) as unknown as {
        speaker: string;
        text: string;
        t0_ms: number;
      }[];
      db.close();
      const fmtTime = (ms: number) => {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      };
      return ok({
        meetingId: meeting_id,
        title: exists.title,
        totalSegments: total,
        offset,
        returned: rows.length,
        transcript: rows.map(
          (r) => `[${fmtTime(r.t0_ms)}] ${r.speaker === "me" ? "Me" : "Them"}: ${r.text}`
        ),
      });
    } catch (e) {
      return err(String(e instanceof Error ? e.message : e));
    }
  }
);

server.registerTool(
  "oatmeal_search",
  {
    title: "Search meetings",
    description:
      "Full-text search across all Oatmeal meeting transcripts, summaries, and titles. Returns matching snippets with their meeting id/title so you can follow up with oatmeal_get_transcript or oatmeal_get_meeting.",
    inputSchema: {
      query: z.string().min(2).describe("Search text (case-insensitive substring match)"),
      limit: z.number().int().min(1).max(100).default(20)
        .describe("Max matches to return (default 20)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    try {
      const db = openDb();
      const like = `%${query}%`;
      const segMatches = db
        .prepare(
          `SELECT s.meeting_id, m.title, s.speaker, s.text, s.t0_ms
           FROM segments s JOIN meetings m ON m.id = s.meeting_id
           WHERE s.text LIKE ? ORDER BY m.started_at DESC, s.t0_ms ASC LIMIT ?`
        )
        .all(like, limit) as unknown as {
        meeting_id: string;
        title: string;
        speaker: string;
        text: string;
        t0_ms: number;
      }[];
      const summaryMatches = db
        .prepare(
          "SELECT id, title, started_at FROM meetings WHERE summary_md LIKE ? OR title LIKE ? ORDER BY started_at DESC LIMIT ?"
        )
        .all(like, like, limit) as unknown as {
        id: string;
        title: string;
        started_at: number;
      }[];
      db.close();
      return ok({
        query,
        transcriptMatches: segMatches.map((r) => ({
          meetingId: r.meeting_id,
          meetingTitle: r.title,
          speaker: r.speaker === "me" ? "Me" : "Them",
          snippet: r.text,
        })),
        meetingsMatchingTitleOrSummary: summaryMatches.map((r) => ({
          meetingId: r.id,
          title: r.title,
          startedAt: iso(r.started_at),
        })),
      });
    } catch (e) {
      return err(String(e instanceof Error ? e.message : e));
    }
  }
);

server.registerTool(
  "oatmeal_recording_status",
  {
    title: "Get recording status",
    description:
      "Check whether the Oatmeal app is running and whether it is currently recording a meeting (and which one).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const status = await controlRequest("/status", "GET");
      return ok({ appRunning: true, ...status });
    } catch (e) {
      return ok({
        appRunning: false,
        note: String(e instanceof Error ? e.message : e),
      });
    }
  }
);

server.registerTool(
  "oatmeal_start_recording",
  {
    title: "Start recording a meeting",
    description:
      "Start recording a new meeting in the Oatmeal app (captures system audio + microphone and transcribes locally). Requires the Oatmeal app to be running. The meeting is auto-titled by AI when it ends unless a title is given.",
    inputSchema: {
      title: z.string().optional()
        .describe("Optional meeting title; omit to let Oatmeal name it from the conversation"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ title }) => {
    try {
      const resp = await controlRequest("/start", "POST", { title: title ?? "" });
      return ok(resp);
    } catch (e) {
      return err(String(e instanceof Error ? e.message : e));
    }
  }
);

server.registerTool(
  "oatmeal_stop_recording",
  {
    title: "Stop recording & finalize",
    description:
      "Stop the active Oatmeal recording. This ends the meeting, generates the AI summary notes, and names the meeting. Takes a moment (local LLM). Returns the final title and summary.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async () => {
    try {
      const resp = await controlRequest("/stop", "POST");
      return ok(resp);
    } catch (e) {
      return err(String(e instanceof Error ? e.message : e));
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[oatmeal-mcp] ready");
