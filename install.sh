#!/bin/bash
# Oatmeal one-line installer (Apple Silicon macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/sankalpdamani/oatmeal/main/install.sh | bash
#
# Downloads the latest release DMG, installs Oatmeal to /Applications, clears
# the macOS quarantine flag (so no "unverified developer" prompt), and launches
# it. No System Settings changes required.
set -euo pipefail

APP="/Applications/Oatmeal.app"
BASE="https://github.com/sankalpdamani/oatmeal/releases/latest/download"

# --- prerequisites ---
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Oatmeal runs on macOS only." >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "Oatmeal requires an Apple Silicon Mac (M1 or newer)." >&2
  exit 1
fi

# --- pick a build for this Mac ---
# Full = base.en + small.en (better accuracy). Lite = base.en only (smaller,
# faster on low-memory Macs). Auto-choose by installed RAM; override with
#   curl -fsSL <url> | OATMEAL_VARIANT=lite bash     (or =full)
MEM_GIB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
VARIANT="${OATMEAL_VARIANT:-}"
if [ -z "$VARIANT" ]; then
  if [ "$MEM_GIB" -le 8 ] && [ "$MEM_GIB" -gt 0 ]; then VARIANT="lite"; else VARIANT="full"; fi
fi
if [ "$VARIANT" = "lite" ]; then
  DMG_URL="$BASE/Oatmeal-macOS-arm64-lite.dmg"
  echo "🥣  Installing Oatmeal (lite build — fast on ${MEM_GIB}GB Macs)…"
else
  DMG_URL="$BASE/Oatmeal-macOS-arm64.dmg"
  echo "🥣  Installing Oatmeal (full build)…"
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DMG="$TMP/Oatmeal.dmg"

echo "→  Downloading the latest build…"
curl -fL --progress-bar -o "$DMG" "$DMG_URL"

echo "→  Copying to /Applications…"
VOL="$(hdiutil attach "$DMG" -nobrowse -noautoopen | grep -o '/Volumes/.*' | tail -1)"
rm -rf "$APP"
cp -R "$VOL/Oatmeal.app" "$APP"
hdiutil detach "$VOL" >/dev/null

echo "→  Clearing macOS quarantine…"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "✅  Installed. Launching Oatmeal…"
open "$APP"

echo
echo "Note: summaries & chat need Ollama running. If you don't have it:"
echo "  brew install ollama && brew services start ollama && ollama pull llama3.2:3b"
