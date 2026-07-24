# 🥣 Oatmeal

**The meeting notetaker that never leaves your Mac.**

### Install in one command

Paste this into **Terminal** (Apple Silicon Mac, macOS 14.4+):

```bash
curl -fsSL https://raw.githubusercontent.com/sankalpdamani/oatmeal/main/install.sh | bash
```

It reads your Mac's memory, downloads the right build (see below), installs
Oatmeal to your Applications, clears the macOS security flag, and opens it — no
Settings changes and no "unverified developer" prompt. Force a build with
`… | OATMEAL_VARIANT=lite bash` (or `=full`).

**Prefer to click?** Two builds — you can switch Whisper models inside the app
either way (Settings ▸ Transcription):

| Build | Bundled model | Size | Best for |
|---|---|---|---|
| [**Full**](https://github.com/sankalpdamani/oatmeal/releases/latest/download/Oatmeal-macOS-arm64.dmg) | small.en | ~550 MB | 16 GB+ Macs — best accuracy out of the box |
| [**Lite**](https://github.com/sankalpdamani/oatmeal/releases/latest/download/Oatmeal-macOS-arm64-lite.dmg) | base.en | ~250 MB | 8 GB Macs / slow connections — fastest |

<sub>Right-click → <b>Open</b> on first launch (unsigned build). Summaries &amp; chat need a local LLM like <a href="https://ollama.com/download">Ollama</a> running.</sub>

Oatmeal listens to your calls (system audio + microphone), transcribes both
sides locally with Whisper, keeps a **live summary** as the meeting happens,
and lets you **chat with the transcript** — powered entirely by models running
on your machine. No cloud, no account, no API keys.

- **Install:** one command (see [above](#install-in-one-command)), or grab the
  `.dmg` from [Releases](https://github.com/sankalpdamani/oatmeal/releases/latest).
  Landing page lives in `site/` (deployed on Vercel)
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
| macOS | 14.4+ (Apple Silicon) | — |
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

### Models

- **Whisper (speech-to-text):** `base.en` and `small.en` are both **bundled
  with the downloadable app**, and Oatmeal auto-selects one based on your Mac's
  memory (the lighter `base.en` on ~8 GB machines so transcription keeps up,
  `small.en` on larger ones). `large-v3-turbo` is downloadable in **Settings**,
  where you can also override the choice. (Building from source? CI bundles the
  models into the DMG; a local `npm run dist` ships without them and you
  download one in Settings.)
- **LLM (summaries & chat):** bring your own — Oatmeal talks to any local
  OpenAI-compatible server ([Ollama](https://ollama.com/download), LM Studio,
  Jan, …). Pull whatever model fits your machine (e.g. `ollama pull qwen2.5:7b`);
  if you don't pick one, Oatmeal uses the lightest model you already have. On
  Ollama it also auto-pulls the `nomic-embed-text` embedding model for
  meaning-based chat search on long meetings.

First run: grant **Microphone** and **System Audio** permissions — the guided
setup screen walks you through both (no Screen Recording needed; system audio
uses a Core Audio tap).

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
