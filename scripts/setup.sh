#!/usr/bin/env bash
# One-command bootstrap for Oatmeal. After cloning the repo, run:
#
#   npm run setup
#
# It verifies prerequisites, installs JS deps, builds the whisper.cpp server and
# the native Swift audio helper, and rebuilds better-sqlite3 for Electron — so
# `npm run dev` / `npm run dist` work straight afterward.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "┌─ Oatmeal setup ────────────────────────────────────────────"

# 1. Preflight. Halts here with actionable output if a build tool is missing.
bash scripts/doctor.sh

# 2. JS dependencies.
if [ ! -d node_modules ]; then
  echo "==> installing JS dependencies (npm install)"
  npm install
else
  echo "==> node_modules present — skipping npm install"
fi

# 3. whisper.cpp server (pinned ref -> resources/bin/whisper-server).
echo "==> building whisper-server"
bash scripts/build-whisper.sh

# 4. Native Swift audio helper (-> resources/bin/OatmealAudio).
echo "==> building native audio helper"
bash scripts/build-native.sh

# 5. Native module ABI: better-sqlite3 must match Electron's Node ABI.
echo "==> rebuilding better-sqlite3 for Electron"
npm run rebuild

echo "└─ Setup complete ───────────────────────────────────────────"
echo
echo "Next:"
echo "  • Install & start Ollama (https://ollama.com/download), then: ollama pull qwen2.5:14b"
echo "  • Run the app:        npm run dev"
echo "  • Build a DMG:        npm run dist"
echo "  • Re-check anytime:   npm run doctor"
echo
echo "On first launch: grant Microphone + Screen Recording, then download a"
echo "Whisper model in Settings."
