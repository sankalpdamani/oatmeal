#!/usr/bin/env bash
# Builds whisper.cpp `whisper-server` (Metal) into resources/bin/.
#
# The whisper.cpp source is not committed to this repo; it is cloned at a
# pinned ref so every build is reproducible. Bump WHISPER_CPP_REF to move to a
# newer release, or override it for a one-off:
#
#   WHISPER_CPP_REF=v1.7.5 npm run build:whisper
#
set -euo pipefail
cd "$(dirname "$0")/.."

WHISPER_CPP_REPO="${WHISPER_CPP_REPO:-https://github.com/ggml-org/whisper.cpp}"
WHISPER_CPP_REF="${WHISPER_CPP_REF:-v1.7.6}"
SRC="vendor/whisper.cpp"
BUILD="$SRC/build"

echo "==> whisper.cpp @ ${WHISPER_CPP_REF}"

# 1. Fetch source at the pinned ref (idempotent).
if [ ! -d "$SRC/.git" ]; then
  mkdir -p vendor
  # Shallow clone of the pinned tag/branch; fall back to a full clone + checkout
  # so a commit SHA in WHISPER_CPP_REF also works.
  if ! git clone --depth 1 --branch "$WHISPER_CPP_REF" "$WHISPER_CPP_REPO" "$SRC" 2>/dev/null; then
    echo "    (ref is not a tag/branch — cloning full history to check it out)"
    git clone "$WHISPER_CPP_REPO" "$SRC"
    git -C "$SRC" checkout "$WHISPER_CPP_REF"
  fi
else
  echo "    reusing existing checkout, pinning to ${WHISPER_CPP_REF}"
  git -C "$SRC" fetch --tags --depth 1 origin "$WHISPER_CPP_REF" 2>/dev/null || git -C "$SRC" fetch --tags origin
  git -C "$SRC" checkout "$WHISPER_CPP_REF"
fi

# 2. Configure + build the server (Metal is on by default on Apple Silicon).
#    Prefer the named target; fall back to a full build if the target name has
#    drifted across whisper.cpp versions.
cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$BUILD" -j --target whisper-server \
  || cmake --build "$BUILD" -j

# 3. Install the binary where the app looks for it (resources/bin/).
mkdir -p resources/bin
BIN="$(find "$BUILD" -name whisper-server -type f -perm -u+x | head -n1)"
if [ -z "$BIN" ]; then
  echo "ERROR: whisper-server binary not found after build" >&2
  exit 1
fi
cp "$BIN" resources/bin/whisper-server
echo "==> whisper-server built -> resources/bin/whisper-server"
