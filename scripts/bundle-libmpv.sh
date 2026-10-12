#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Bundle libmpv and its dependencies into the macOS app for distribution.
# Run as beforeBundleCommand during tauri build. Requires: brew install mpv dylibbundler
# CWD when run: workspace root (via beforeBundleCommand cwd)
# No-op on non-macOS (e.g. when building on Windows/Linux).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIBS_BUNDLE="$WORKSPACE_ROOT/libs/macos-bundle"

if [[ "$(uname -s)" == "Linux" ]]; then
  echo "==> Dispatching to Linux bundler..."
  exec "$SCRIPT_DIR/bundle-libmpv-linux.sh"
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping libmpv bundle (unsupported platform: $(uname -s))"
  mkdir -p "$LIBS_BUNDLE"
  exit 0
fi
LIBS_DIR="$WORKSPACE_ROOT/libs"
LIBS_MACOS="$LIBS_DIR/macos"
TARGET_RELEASE="$WORKSPACE_ROOT/target/release"
APP_NAME="max-video-player"

# Ensure libmpv exists (from build-libmpv.sh)
if [[ ! -f "$LIBS_MACOS/libmpv.dylib" && ! -f "$LIBS_MACOS/libmpv.2.dylib" ]]; then
  echo "Error: libmpv not found. Run ./scripts/build-libmpv.sh macos first."
  exit 1
fi

# Binary must exist (cargo build runs before beforeBundleCommand)
BINARY="$TARGET_RELEASE/$APP_NAME"
if [[ ! -f "$BINARY" ]]; then
  echo "Error: Binary not found at $BINARY"
  exit 1
fi

# dylibbundler must be installed
if ! command -v dylibbundler &>/dev/null; then
  echo "Error: dylibbundler not found. Run: brew install dylibbundler"
  exit 1
fi

# Create output dir and run dylibbundler
rm -rf "$LIBS_BUNDLE"
mkdir -p "$LIBS_BUNDLE"

# Resolve Homebrew prefix for transitive dep search (works on Apple Silicon + Intel)
BREW_LIB="$(brew --prefix 2>/dev/null || echo /opt/homebrew)/lib"

# -s tells dylibbundler where to find libraries it can't resolve via @rpath.
# Without this it drops into an interactive prompt (and hangs in CI).
dylibbundler -od -b -x "$BINARY" -d "$LIBS_BUNDLE" -p "@executable_path/../Frameworks" \
  -s "$LIBS_MACOS" \
  -s "$BREW_LIB"

# dylibbundler rewrites every LC_RPATH it finds to the -p path, so libmpv (built
# with one rpath per Homebrew dependency) ends up carrying the same entry ~11
# times. dyld refuses to load an image with duplicate LC_RPATHs once it is linked
# against the macOS 26 SDK, which crashed v0.5.0 at launch. Keep the first copy.
rpaths_of() {
  otool -l "$1" | awk '$1 == "cmd" && $2 == "LC_RPATH" {
    getline; getline
    sub(/^ *path /, ""); sub(/ \(offset [0-9]+\)$/, "")
    print
  }'
}

dedupe_rpaths() {
  local file="$1" rpath count changed=0
  while IFS= read -r rpath; do
    count=$(rpaths_of "$file" | grep -cxF -- "$rpath")
    # install_name_tool -delete_rpath removes one matching entry per call.
    while (( count > 1 )); do
      install_name_tool -delete_rpath "$rpath" "$file"
      count=$((count - 1))
      changed=1
    done
  done < <(rpaths_of "$file" | sort | uniq -d)
  if (( changed )); then
    # Editing load commands invalidates the signature; arm64 won't load unsigned code.
    codesign --force --preserve-metadata=entitlements,requirements,flags,runtime --sign - "$file"
    echo "Removed duplicate LC_RPATH entries from $(basename "$file")"
  fi
}

for f in "$BINARY" "$LIBS_BUNDLE"/*.dylib; do
  dedupe_rpaths "$f"
  if [[ -n "$(rpaths_of "$f" | sort | uniq -d)" ]]; then
    echo "Error: $(basename "$f") still has duplicate LC_RPATH entries" >&2
    exit 1
  fi
done

# Homebrew bottles target the macOS version of the machine that builds them, so
# a newer runner quietly raises the real minimum (v0.5.0 needed macOS 26.4 while
# declaring 10.15). Check everything we ship against minimumSystemVersion.
TAURI_CONF="$WORKSPACE_ROOT/apps/desktop/src-tauri/tauri.conf.json"
MIN_MACOS=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["bundle"]["macOS"]["minimumSystemVersion"])' "$TAURI_CONF")

minos_of() {
  otool -l "$1" | awk '$1 == "cmd" && ($2 == "LC_BUILD_VERSION" || $2 == "LC_VERSION_MIN_MACOSX") { found = 1 }
    found && ($1 == "minos" || $1 == "version") { print $2; exit }'
}

sdk_of() {
  otool -l "$1" | awk '$1 == "cmd" && $2 == "LC_BUILD_VERSION" { found = 1 } found && $1 == "sdk" { print $2; exit }'
}

newer_than() {
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" != "$2" ]]
}

# Homebrew's tesseract bottle records the exact macOS version of the machine that
# built it (15.7.5, then 15.7.9 after a rebuild) instead of 15.0, although it is
# built against the 15.4 SDK and every system symbol it imports exists on 15.0.
# ffmpeg links it for its OCR filter, which we never use. Lower a point-release
# minimum to ours; a different major version still fails the check below.
TESSERACT="$LIBS_BUNDLE/libtesseract.5.dylib"
if [[ -f "$TESSERACT" ]]; then
  minos=$(minos_of "$TESSERACT")
  if newer_than "$minos" "$MIN_MACOS" && [[ "${minos%%.*}" == "${MIN_MACOS%%.*}" ]]; then
    vtool -set-build-version macos "$MIN_MACOS" "$(sdk_of "$TESSERACT")" -replace -output "$TESSERACT" "$TESSERACT"
    codesign --force --preserve-metadata=entitlements,requirements,flags,runtime --sign - "$TESSERACT"
    echo "Lowered the minimum macOS of $(basename "$TESSERACT") from $minos to $MIN_MACOS"
  fi
fi

too_new=""
for f in "$BINARY" "$LIBS_BUNDLE"/*.dylib "$WORKSPACE_ROOT"/apps/desktop/src-tauri/binaries/ffmpeg-*; do
  [[ -f "$f" ]] || continue
  minos=$(minos_of "$f")
  [[ -n "$minos" ]] || continue
  if newer_than "$minos" "$MIN_MACOS"; then
    too_new+=$'\n'"  $(basename "$f") needs macOS $minos"
  fi
done

if [[ -n "$too_new" ]]; then
  msg="bundled binaries need a newer macOS than minimumSystemVersion ($MIN_MACOS):$too_new"
  if [[ -n "${CI:-}" ]]; then
    echo "Error: $msg" >&2
    exit 1
  fi
  # Local Homebrew targets this Mac's macOS, so a dev build can't meet the minimum.
  echo "Warning: $msg" >&2
  echo "This build only runs on this Mac's macOS version. Release builds run on a macOS $MIN_MACOS CI runner." >&2
fi

# Tauri signs the app, its binary and the ffmpeg sidecar, but not the libraries it
# copies into Contents/Frameworks. Under the hardened runtime a Developer ID app
# only loads libraries signed by the same team, and notarization rejects unsigned
# or untimestamped code, so sign them here with the identity Tauri will use.
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" && "$APPLE_SIGNING_IDENTITY" != "-" ]]; then
  dylibs=("$LIBS_BUNDLE"/*.dylib)
  codesign --force --timestamp --options runtime --sign "$APPLE_SIGNING_IDENTITY" "${dylibs[@]}"
  echo "Signed ${#dylibs[@]} libraries with $APPLE_SIGNING_IDENTITY"
fi

echo "Bundled libmpv and dependencies to $LIBS_BUNDLE"
