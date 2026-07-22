# 🥣 Oatmeal

**The meeting notetaker that never leaves your Mac.**

Oatmeal listens to your calls (system audio + microphone), transcribes both
sides locally with Whisper, keeps a **live summary** as the meeting happens,
and lets you **chat with the transcript** — powered entirely by models running
on your machine. No cloud, no account, no API keys.

- **Website / download:** see the `site/` landing page (deployed on Vercel)
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

Requirements: macOS 13+, Apple Silicon, Xcode CLT, Node 22, cmake.

```bash
# 1. whisper.cpp (once)
git clone --depth 1 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
cmake -S vendor/whisper.cpp -B vendor/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build vendor/whisper.cpp/build -j --target whisper-server
cp vendor/whisper.cpp/build/bin/whisper-server resources/bin/

# 2. App
npm install
npm run rebuild        # better-sqlite3 for Electron ABI
npm run build:native   # Swift helper -> resources/bin/OatmealAudio
npx vite build
npx electron .         # run

# 3. DMG
npm run dist           # -> release/Oatmeal-<version>-arm64.dmg
```

First run: grant **Microphone** and **Screen Recording** permissions (System
Settings deep links are in-app), download a Whisper model in Settings, and
have [Ollama](https://ollama.com) running.

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
