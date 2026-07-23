# 🥣 Oatmeal

**The meeting notetaker that never leaves your Mac.**

<p align="center">
  <a href="https://github.com/sankalpdamani/oatmeal/releases/latest/download/Oatmeal-macOS-arm64.dmg">
    <img src="https://img.shields.io/badge/⬇%20Download%20for%20macOS-Apple%20Silicon-2f7d32?style=for-the-badge" alt="Download Oatmeal for macOS (Apple Silicon)">
  </a>
</p>

<p align="center"><sub>Apple Silicon Mac · macOS 13+ · unsigned build — right-click → <b>Open</b> on first launch</sub></p>

Oatmeal listens to your calls (system audio + microphone), transcribes both
sides locally with Whisper, keeps a **live summary** as the meeting happens,
and lets you **chat with the transcript** — powered entirely by models running
on your machine. No cloud, no account, no API keys.

- **Download:** grab the latest `.dmg` from
  [Releases](https://github.com/sankalpdamani/oatmeal/releases/latest) (or the
  button above). Landing page lives in `site/` (deployed on Vercel)
- **Speakers for free:** your mic is "Me", system audio is "Them"
- **Meeting detection:** notices when Zoom/Teams/Webex/FaceTime is using the
  mic and offers to start notes
- **Bring your own models:** Whisper sizes downloadable in-app; any Ollama
  model for summaries & chat

## Architecture

| Piece | Tech | Job |
|---|---|---|
| `electron/` | Electron main (Node 22 + TS) | windows, tray, SQLite, orchestration |
| `native/OatmealAudio.swift` | ScreenCaptureKit + AVAudioEngine | system-audio & mic capture → tagged 16kHz PCM on stdout; meeting detection; permission checks |
| `vendor/whisper.cpp` | whisper.cpp `whisper-server` (Metal) | local speech-to-text over localhost HTTP |
| Ollama | localhost:11434 | rolling live summary + transcript chat |
| `src/` | Vite + React + Tailwind v4 | UI (meeting library, live view, chat) |
| `site/` | static HTML | landing page |

Audio flow: `OatmealAudio capture` emits framed PCM (`M` = mic, `S` = system)
→ Electron segments speech on silence (RMS gate) → WAV chunks POSTed to
`whisper-server /inference` → transcript segments → SQLite + renderer.
Every ~25s the summarizer folds new segments into the running summary
(previous summary + delta, never the full transcript).

## Build from source

Everything the app needs is either committed here or fetched, pinned, at build
time — one command wires it all up.

### Requirements

| Tool | Version | Install |
|---|---|---|
| macOS | 13+ (Apple Silicon) | — |
| Xcode Command Line Tools | current | `xcode-select --install` |
| Node | 22+ (pinned in `.nvmrc`) | `nvm install && nvm use`, or [nodejs.org](https://nodejs.org) |
| cmake | 3.x | `brew install cmake` |
| git | any | ships with the CLT above |
| Ollama | current | [ollama.com/download](https://ollama.com/download) — runtime only (summaries & chat) |

Not sure what's missing? Run `npm run doctor` — it checks every item above and
tells you exactly how to fix any gap.

### Quickstart

```bash
npm run setup   # doctor + npm install + whisper-server + native helper + sqlite rebuild
npm run dev     # run the app
```

`npm run setup` is idempotent and does everything: it verifies prerequisites,
installs JS deps, clones and builds `whisper-server` from a **pinned**
whisper.cpp release into `resources/bin/`, builds the Swift audio helper, and
rebuilds `better-sqlite3` against Electron's ABI. To move whisper.cpp to a
newer release, bump `WHISPER_CPP_REF` in `scripts/build-whisper.sh` (or override
it once: `WHISPER_CPP_REF=v1.7.5 npm run build:whisper`).

### Package a DMG

```bash
npm run dist    # -> release/Oatmeal-<version>-arm64.dmg
```

### Runtime models

Two model families are downloaded on demand (kept out of the repo — they're
hundreds of MB to GBs):

- **Whisper (speech-to-text):** download a size in **Settings** on first run.
- **Ollama (summaries & chat):** install [Ollama](https://ollama.com/download),
  start it, and pull a model, e.g. `ollama pull qwen2.5:14b`. The app detects
  whether Ollama is up and links you to the download if it isn't.

First run: grant **Microphone** and **Screen Recording** permissions (System
Settings deep links are in-app).

The DMG is ad-hoc signed but not notarized. If macOS says Oatmeal "is
damaged and can't be opened," drag it to `/Applications` and run once:
`xattr -dr com.apple.quarantine /Applications/Oatmeal.app`.

## Privacy

Everything — audio, transcripts, summaries, chats — lives in
`~/Library/Application Support/Oatmeal/`. The only network calls are to
localhost (whisper-server, Ollama) and to Hugging Face / Ollama when *you*
ask to download a model.

## Theming

The palette (warm paper surfaces, ink neutrals, olive accent) is sampled from
Granola's design tokens as a visual homage. All code, markup, and copy are
original; no Granola assets, fonts, or code are included. Not affiliated with
Granola.

MIT © Sankalp Damani
