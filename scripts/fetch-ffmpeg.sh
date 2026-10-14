#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

set -euo pipefail

# Downloads a static ffmpeg binary and names it for the current Rust target
# triple so Tauri can bundle it as a sidecar.
# Usage: ./scripts/fetch-ffmpeg.sh [macos|linux|windows]
#
# Each platform gets one exact build, pinned by the SHA-256 of its archive.
# The script tries the copy on this repo's ffmpeg-sidecar pre-release first and
# the builder's own copy second, and only installs an archive whose hash
# matches. docs/development.md says how to move to a new ffmpeg.

# The sidecar's name, the same as FFMPEG_SIDECAR in the app. The Linux packages
# install it in /usr/bin, so it can't be plain ffmpeg.
SIDECAR=max-video-player-ffmpeg

# The pre-release that holds a copy of each archive below.
MIRROR="https://github.com/MaxMB15/MaxVideoPlayer/releases/download/ffmpeg-sidecar-8.1"

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

# FFMPEG_VERSION is the ffmpeg release a build comes from, and the weekly
# .github/workflows/ffmpeg-update-check.yml reads those lines. FILE is the
# archive's name on the pre-release, and UPSTREAM is the builder's copy.
# TARGETS lists the Rust targets the build runs on.
#
# The builds stay on ffmpeg 8.1. ffmpeg 9.0 checks TLS certificates by
# default, which needs changes in the app first. docs/development.md explains.
EXT=""
case "$PLATFORM" in
  macos)
    # Apple Silicon, from Martin Riedl's build server, which keeps every
    # release build it has made. It has no 8.1.3 build.
    FFMPEG_VERSION=8.1.2
    TARGETS="aarch64-apple-darwin"
    FILE="ffmpeg-$FFMPEG_VERSION-macos-arm64.zip"
    UPSTREAM="https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2/ffmpeg.zip"
    SHA256=ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c
    ;;
  linux)
    # x86_64, from BtbN's FFmpeg-Builds. It's the release/8.1 branch 9 commits
    # after the 8.1.3 tag. BtbN deletes daily builds after about two weeks but
    # keeps the last one of each month, like this one, for about two years.
    FFMPEG_VERSION=8.1.3
    TARGETS="x86_64-unknown-linux-gnu"
    FILE="ffmpeg-n8.1.3-9-g29e619e767-linux64-gpl-8.1.tar.xz"
    UPSTREAM="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/$FILE"
    SHA256=97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79
    ;;
  windows)
    # x86_64, from the same BtbN build as Linux. CI doesn't build for Windows
    # yet.
    FFMPEG_VERSION=8.1.3
    TARGETS="x86_64-pc-windows-msvc x86_64-pc-windows-gnu"
    FILE="ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip"
    UPSTREAM="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/$FILE"
    SHA256=7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa
    EXT=".exe"
    ;;
  *) echo "Unknown platform: $PLATFORM" >&2; exit 1 ;;
esac

# The sidecar gets this machine's target name, so a build for another CPU, such
# as the arm64 macOS build on an Intel Mac, would install and then fail to run.
if [[ " $TARGETS " != *" $TARGET_TRIPLE "* ]]; then
  echo "No ffmpeg build is pinned for $TARGET_TRIPLE. The $PLATFORM build runs on $TARGETS." >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

VERIFIED=""
for URL in "$MIRROR/$FILE" "$UPSTREAM"; do
  echo "Fetching ffmpeg $FFMPEG_VERSION for $PLATFORM ($TARGET_TRIPLE) from $URL"
  rm -f "$TMP/dl"
  # The download hosts drop connections now and then, so retry on any error.
  if ! curl -fL --retry 3 --retry-all-errors --retry-delay 5 "$URL" -o "$TMP/dl"; then
    echo "Couldn't download $URL" >&2
    continue
  fi
  GOT="$(sha256_of "$TMP/dl")"
  if [[ "$GOT" == "$SHA256" ]]; then
    VERIFIED=1
    break
  fi
  echo "The file from $URL has SHA-256 $GOT, not the pinned $SHA256" >&2
done
if [[ -z "$VERIFIED" ]]; then
  echo "No source gave the pinned ffmpeg archive $FILE" >&2
  exit 1
fi

# Extract a single ffmpeg binary out of whatever archive format we got.
cd "$TMP"
case "$FILE" in
  *.zip) unzip -o dl >/dev/null ;;
  *.tar.xz) tar xf dl ;;
esac
FOUND="$(find "$TMP" -type f -name "ffmpeg${EXT}" | head -n1)"
if [[ -z "$FOUND" ]]; then echo "ffmpeg binary not found in archive" >&2; exit 1; fi

DEST="$OUT_DIR/${SIDECAR}-${TARGET_TRIPLE}${EXT}"
cp "$FOUND" "$DEST"
chmod +x "$DEST"
echo "Installed sidecar: $DEST"
