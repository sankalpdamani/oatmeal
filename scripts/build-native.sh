#!/bin/bash
# Builds the native pieces Oatmeal needs: the Swift audio helper.
# whisper-server is built separately from vendor/whisper.cpp (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources/bin
swiftc -O -o resources/bin/OatmealAudio native/OatmealAudio.swift \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework CoreAudio \
  -framework AppKit
echo "OatmealAudio built -> resources/bin/OatmealAudio"
