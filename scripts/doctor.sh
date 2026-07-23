#!/usr/bin/env bash
# Preflight check for building and running Oatmeal.
# Reports every requirement with a clear ✓ / ✗ and tells you how to fix gaps.
# Exits non-zero if a *build-critical* tool is missing so `npm run setup` halts
# early with an actionable message. Ollama is runtime-only and only warns.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "Oatmeal doctor — checking prerequisites"
echo

# --- Platform (Oatmeal is macOS / Apple Silicon only) ---
if [ "$(uname -s)" = "Darwin" ]; then
  ok "macOS ($(sw_vers -productVersion 2>/dev/null || echo '?'))"
  if [ "$(uname -m)" = "arm64" ]; then
    ok "Apple Silicon (arm64)"
  else
    warn "Not Apple Silicon — Oatmeal targets arm64 Macs; audio capture needs Apple Silicon."
  fi
else
  warn "Not macOS — Oatmeal only runs on macOS 13+. You can still edit code, but it won't build/run here."
fi

# --- Xcode Command Line Tools (swiftc + frameworks for the audio helper) ---
if xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null 2>&1; then
  ok "Xcode Command Line Tools ($(swiftc --version 2>/dev/null | head -n1))"
else
  bad "Xcode Command Line Tools missing — install with:  xcode-select --install"
fi

# --- Node 22+ ---
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -ge 22 ]; then
    ok "Node $(node -v)"
  else
    bad "Node $(node -v) too old — need Node 22+. With nvm:  nvm install 22 && nvm use 22  (an .nvmrc is provided)"
  fi
else
  bad "Node not found — install Node 22+ (nvm recommended; an .nvmrc pins the version)"
fi

# --- npm ---
if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v)"
else
  bad "npm not found — it ships with Node"
fi

# --- cmake (builds whisper.cpp) ---
if command -v cmake >/dev/null 2>&1; then
  ok "cmake $(cmake --version | head -n1 | awk '{print $3}')"
else
  bad "cmake not found — install with:  brew install cmake"
fi

# --- git (clones the pinned whisper.cpp source) ---
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  bad "git not found — install with:  xcode-select --install  (or brew install git)"
fi

echo
echo "Runtime dependency"

# --- Ollama (summaries + chat). Runtime only: warn, never fail the build. ---
if command -v ollama >/dev/null 2>&1; then
  if curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
    ok "Ollama installed and running"
  else
    warn "Ollama installed but not running — start it (open the app, or run 'ollama serve'). Oatmeal needs it for summaries & chat."
  fi
else
  warn "Ollama not installed — summaries & chat need it. Get it at https://ollama.com/download, then pull a model (e.g. 'ollama pull qwen2.5:14b')."
fi

# --- Build artifacts (informational) ---
echo
echo "Build artifacts"
[ -x resources/bin/whisper-server ] && ok "resources/bin/whisper-server present" || warn "whisper-server not built yet — run: npm run setup"
[ -x resources/bin/OatmealAudio ]   && ok "resources/bin/OatmealAudio present"   || warn "OatmealAudio not built yet — run: npm run setup"

echo
if [ "$fail" -ne 0 ]; then
  echo "✗ Missing build prerequisites above. Fix them and re-run: npm run doctor"
  exit 1
fi
echo "✓ All build prerequisites satisfied."
