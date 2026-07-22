# Oatmeal — Local-First Meeting Notetaker (Granola-style)

**Date:** 2026-07-06 · **Status:** Approved by Sankalp

## What it is

A locally hosted Granola-style meeting notetaker for macOS. Listens to calls via
system audio + microphone, transcribes locally with whisper.cpp, shows a live
rolling summary during the meeting, and lets you chat with the transcript —
all powered by local models (Ollama for LLM, whisper.cpp for STT). No cloud,
no accounts, no calendar integration.

Plus a public landing page where people can download the app.

## Decisions (locked with user)

| Question | Decision |
|---|---|
| Form factor | Electron desktop app (menu-bar presence, native Swift audio helper) |
| Scope | Transcript + live summary + chat. No notes editor (later). |
| STT default | whisper.cpp `small.en`; in-app model manager for base.en / large-v3-turbo |
| Persistence | Persistent meeting library, SQLite on disk |
| Name | **Oatmeal** (Granola's internal design system is literally called "oats") |
| Distribution | GitHub Release (DMG) + landing page on Vercel with download button |
| Theme | Granola's palette/radii/shadows (extracted token *values*); free fonts (Inter + free grotesk), no Granola assets/code copied |

## Architecture

1. **Electron main** (Node 22 + TS): windows, tray, SQLite (`better-sqlite3`),
   model downloads, orchestration of helper processes, Ollama client,
   rolling summarizer.
2. **Swift audio helper** (`OatmealAudio`, compiled via swiftc at build time):
   - System audio via ScreenCaptureKit (Screen Recording permission)
   - Mic via AVAudioEngine (Microphone permission)
   - Emits tagged 16kHz mono PCM frames on stdout: mic → `me`, system → `them`
   - `detect` subcommand: polls running meeting apps (Zoom, Teams, Webex,
     FaceTime) → used for "Meeting detected" notification
3. **whisper.cpp** `whisper-server` (Metal build, bundled binary): loads GGML
   model once; Electron buffers PCM per stream, segments on silence (RMS VAD),
   POSTs WAV chunks to `/inference`, receives text.
4. **Ollama** (localhost:11434): list installed models, pull curated models,
   streaming chat. Default `qwen2.5:14b`. UI handles Ollama-not-running.
5. **Renderer** (Vite + React + TS + Tailwind v4): Oatmeal theme.

## Data model (SQLite, `~/Library/Application Support/Oatmeal/oatmeal.db`)

- `meetings(id, title, started_at, ended_at, summary_md)`
- `segments(id, meeting_id, speaker me|them, text, t0_ms, t1_ms)`
- `chat_messages(id, meeting_id, role, content, created_at)`
- `settings(key, value)` — chosen STT model, Ollama model, detection on/off

## Summary (post-call, Granola parity — revised 2026-07-22)

Granola-parity pass. Key behavior changes:

- **Post-call summary only** (no live rolling summary). When the meeting ends,
  `finalize.ts` generates the polished note (TL;DR / key points / decisions /
  action items / open questions) from the full transcript in one pass.
- **AI-generated title** at end of call, from the transcript (`generateTitle`).
- **Auto-stop & finalize**: detection tracks the meeting app that started the
  recording; when that app quits, a 30s grace timer fires, then the meeting
  auto-stops, summarizes, and self-names. A toast offers "Keep recording".
  (Mic-idle can't be used mid-call — our own capture holds the mic.)
- **Granola layout**: the summary/notes is the document (serif title, full
  width). Transcript is tucked behind a bottom-left "Transcript" dock button
  that opens a right-side drawer with a **Download** button (Markdown/txt).
  Chat is a floating panel launched from an "Ask anything" pill, with a
  **Say more** button that expands the last answer. Chat answers are grounded
  in transcript + summary only (no web search).

## Chat

Per-meeting chat grounded in transcript + current summary; streams tokens.
Works live and after the meeting.

## Error handling

- Permissions not granted → guided onboarding screens (System Settings deep links)
- Ollama down → banner with launch/install instructions
- STT model missing → download UI with progress
- Helper/whisper-server crash → auto-restart, transcript continues
- Unsigned DMG → landing page documents right-click-Open / `xattr -dc`

## Landing page (`site/`)

Static single page, Oatmeal-themed, deployed to Vercel. Hero + how-it-works +
privacy pitch ("your meetings never leave your Mac") + download button → GitHub
release DMG (arm64). Documents requirements (macOS 13+, Apple Silicon, Ollama).

## Verification

- `tsc --noEmit` + `vite build` + `electron-builder` all pass
- End-to-end: play a video as fake meeting → live transcript (Them) + mic (Me)
  → live summary updates → chat answers from transcript
- Landing page deployed and download link resolves
