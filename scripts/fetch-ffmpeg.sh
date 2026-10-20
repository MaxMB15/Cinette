#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

set -euo pipefail

# Downloads the ffmpeg that the app runs for downloads and recordings, and
# names it for the current Rust target triple so Tauri can bundle it as a
# sidecar.
# Usage: ./scripts/fetch-ffmpeg.sh [macos|linux|windows]
#
# Each platform gets one exact build, pinned by the SHA-256 of its archive,
# and the script only installs an archive whose hash matches. The macOS and
# Linux builds come from scripts/build-ffmpeg.sh, which
# .github/workflows/ffmpeg-build.yml runs and tests, and they're on this repo's
# ffmpeg-sidecar pre-release. Windows still uses a build from BtbN, from the
# pre-release first and BtbN's own copy second. docs/development.md says how to
# move to a new ffmpeg.
#
# On macOS and Linux, when no source gives the pinned archive or no build is
# pinned for this machine, such as an arm64 Linux machine, the script builds
# ffmpeg from source with scripts/build-ffmpeg.sh instead. FFMPEG_PINNED_ONLY=1 makes it
# fail then, as the Build & Bundle and release workflows do. A release must ship
# the pinned build, since a Linux build made on a newer system than Debian 12
# wouldn't run on Debian 12, and Build & Bundle fails a pin that doesn't work.

# The sidecar's name, the same as FFMPEG_SIDECAR in the app. The Linux packages
# install it in /usr/bin, so it can't be plain ffmpeg.
SIDECAR=max-video-player-ffmpeg

# The pre-release that holds a copy of each archive below.
MIRROR="https://github.com/MaxMB15/Cinette/releases/download/ffmpeg-sidecar-8.1"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/apps/player/src-tauri/binaries"

TARGET_TRIPLE="$(rustc -Vv | grep '^host:' | cut -d' ' -f2)"
case "$(uname -s)" in
  Darwin) HOST_PLATFORM=macos ;;
  Linux)  HOST_PLATFORM=linux ;;
  *)      HOST_PLATFORM=windows ;;
esac
PLATFORM="${1:-$HOST_PLATFORM}"

# FFMPEG_VERSION is the ffmpeg release a build comes from, and the weekly
# .github/workflows/ffmpeg-update-check.yml reads those lines. FILE is the
# archive's name on the pre-release, and UPSTREAM is the builder's copy, if
# there is one. TARGETS lists the Rust targets the build runs on.
#
# The builds stay on ffmpeg 8.1. ffmpeg 9.0 checks TLS certificates by
# default, which needs changes in the app first. docs/development.md explains.
EXT=""
UPSTREAM=""
case "$PLATFORM" in
  macos)
    # One build for each CPU. They share one FFMPEG_VERSION line, since the
    # ffmpeg workflows read one for each platform.
    FFMPEG_VERSION=8.1.3
    TARGETS="aarch64-apple-darwin x86_64-apple-darwin"
    case "$TARGET_TRIPLE" in
      x86_64-apple-darwin)
        # Intel, built on GitHub's macos-15-intel runner.
        FILE="$SIDECAR-$FFMPEG_VERSION-build3-macos-x86_64.tar.xz"
        SHA256=abd0a2c220bf0c2887221cc8535911ab752f4355c97f22a52029d7c49f7b9bdc
        ;;
      *)
        # Apple Silicon, built on GitHub's macos-15 runner. The TARGETS check
        # below turns away any other target.
        FILE="$SIDECAR-$FFMPEG_VERSION-build3-macos-arm64.tar.xz"
        SHA256=c19b722843fe9b67578d0c48ad172010f138f3f71b9655d35ad922b163579c8f
        ;;
    esac
    ;;
  linux)
    # x86_64, built in Debian 12, so it runs on Debian 12, Ubuntu 24.04 and
    # later.
    FFMPEG_VERSION=8.1.3
    TARGETS="x86_64-unknown-linux-gnu"
    FILE="$SIDECAR-$FFMPEG_VERSION-build3-linux-x86_64.tar.xz"
    SHA256=259334278fad99a360089c70986af1a5260496749544dcb51f43ca6b06c29c4a
    ;;
  windows)
    # x86_64, from BtbN's FFmpeg-Builds. It's the release/8.1 branch 9 commits
    # after the 8.1.3 tag. BtbN deletes daily builds after about two weeks but
    # keeps the last one of each month, like this one, for about two years.
    # CI doesn't build for Windows yet.
    FFMPEG_VERSION=8.1.3
    TARGETS="x86_64-pc-windows-msvc x86_64-pc-windows-gnu"
    FILE="ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip"
    UPSTREAM="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/$FILE"
    SHA256=7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa
    EXT=".exe"
    ;;
  *) echo "Unknown platform: $PLATFORM" >&2; exit 1 ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DEST="$OUT_DIR/${SIDECAR}-${TARGET_TRIPLE}${EXT}"
install_sidecar() {
  mkdir -p "$OUT_DIR"
  cp "$1" "$DEST"
  chmod +x "$DEST"
  echo "Installed sidecar: $DEST"
}

# build_from_source WHY builds ffmpeg for this machine and installs it, or
# fails with WHY when it can't or mustn't.
build_from_source() {
  local why="$1"
  if [[ "$PLATFORM" == windows || "$PLATFORM" != "$HOST_PLATFORM" ]]; then
    echo "$why" >&2
    exit 1
  fi
  if [[ "${FFMPEG_PINNED_ONLY:-}" == 1 ]]; then
    echo "$why FFMPEG_PINNED_ONLY is 1, so the script won't build one from source." >&2
    exit 1
  fi
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning::$why Building ffmpeg from source instead."
  else
    echo "$why Building ffmpeg from source instead." >&2
  fi
  "$ROOT/scripts/build-ffmpeg.sh" "$TMP/build"
  install_sidecar "$TMP/build/ffmpeg"
  exit 0
}

# The sidecar gets this machine's target name, so a build for another CPU, such
# as the arm64 macOS build on an Intel Mac, would install and then fail to run.
if [[ " $TARGETS " != *" $TARGET_TRIPLE "* ]]; then
  build_from_source "No ffmpeg build is pinned for $TARGET_TRIPLE. The $PLATFORM build runs on $TARGETS."
fi

VERIFIED=""
for URL in "$MIRROR/$FILE" ${UPSTREAM:+"$UPSTREAM"}; do
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
  build_from_source "No source gave the pinned ffmpeg archive $FILE."
fi

# Extract a single ffmpeg binary out of whatever archive format we got.
cd "$TMP"
case "$FILE" in
  *.zip) unzip -o dl >/dev/null ;;
  *.tar.xz) tar xf dl ;;
esac
FOUND="$(find "$TMP" -type f -name "ffmpeg${EXT}" | head -n1)"
if [[ -z "$FOUND" ]]; then echo "ffmpeg binary not found in archive" >&2; exit 1; fi
install_sidecar "$FOUND"
