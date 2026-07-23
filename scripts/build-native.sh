#!/bin/bash
# Builds the native pieces Oatmeal needs: the Swift audio helper.
# whisper-server is built separately from vendor/whisper.cpp (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources/bin
# Ensure the bundled-models dir exists so packaging never fails when no default
# model is present (CI populates it; a plain local build leaves it empty and the
# app falls back to downloading a model in Settings).
mkdir -p resources/models
swiftc -O -o resources/bin/OatmealAudio native/OatmealAudio.swift \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework CoreAudio \
  -framework AppKit
echo "OatmealAudio built -> resources/bin/OatmealAudio"
