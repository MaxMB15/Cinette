#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

set -euo pipefail

# Downloads a static ffmpeg binary and names it for the current Rust target
# triple so Tauri can bundle it as a sidecar.
# Usage: ./scripts/fetch-ffmpeg.sh [macos|linux|windows]

# The sidecar's name, the same as FFMPEG_SIDECAR in the app. The Linux packages
# install it in /usr/bin, so it can't be plain ffmpeg.
SIDECAR=max-video-player-ffmpeg

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/apps/player/src-tauri/binaries"
mkdir -p "$OUT_DIR"

TARGET_TRIPLE="$(rustc -Vv | grep '^host:' | cut -d' ' -f2)"
PLATFORM="${1:-}"
if [[ -z "$PLATFORM" ]]; then
  case "$(uname -s)" in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    *)      PLATFORM=windows ;;
  esac
fi

EXT=""
case "$PLATFORM" in
  macos)
    URL="https://www.osxexperts.net/ffmpeg7arm.zip"   # static arm64 ffmpeg 7
    ;;
  linux)
    URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    ;;
  windows)
    URL="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    EXT=".exe"
    ;;
  *) echo "Unknown platform: $PLATFORM" >&2; exit 1 ;;
esac

echo "Fetching ffmpeg for $PLATFORM ($TARGET_TRIPLE) from $URL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# The download hosts drop connections now and then, so retry on any error.
curl -fL --retry 3 --retry-all-errors --retry-delay 5 "$URL" -o "$TMP/dl"

# Extract a single ffmpeg binary out of whatever archive format we got.
cd "$TMP"
case "$URL" in
  *.zip) unzip -o dl >/dev/null ;;
  *.tar.xz) tar xf dl ;;
esac
FOUND="$(find "$TMP" -type f -name "ffmpeg${EXT}" | head -n1)"
if [[ -z "$FOUND" ]]; then echo "ffmpeg binary not found in archive" >&2; exit 1; fi

DEST="$OUT_DIR/${SIDECAR}-${TARGET_TRIPLE}${EXT}"
cp "$FOUND" "$DEST"
chmod +x "$DEST"
echo "Installed sidecar: $DEST"
