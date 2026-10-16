#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

set -euo pipefail

# Builds libmpv from source for the desktop app. iOS gets libmpv from MPVKit
# through Swift Package Manager instead, so it has no case here.
# Output: libs/<platform>/ at the repository root.
#
# Usage: ./scripts/build-libmpv.sh macos|linux

PLATFORM="${1:-}"
LIBS_DIR="$(cd "$(dirname "$0")/.." && pwd)/libs"

case "$PLATFORM" in
  macos)
    echo "==> Building libmpv from source for macOS..."
    mkdir -p "$LIBS_DIR/macos"

    # Homebrew has no packages for Intel Macs, so they use MacPorts.
    # docs/development.md has the full setup for both.
    if [[ "$(uname -m)" == x86_64 ]]; then
      INSTALL_HINT="sudo port install meson ninja pkgconfig ffmpeg7 libass libplacebo dylibbundler"
      FFMPEG_PC=/opt/local/libexec/ffmpeg7/lib/pkgconfig
    else
      INSTALL_HINT="brew install meson ninja pkg-config ffmpeg@7 libass libplacebo dylibbundler"
      FFMPEG_PC="\$(brew --prefix ffmpeg@7)/lib/pkgconfig"
    fi

    # Check build tools
    for tool in meson ninja pkg-config; do
      if ! command -v "$tool" &>/dev/null; then
        echo "Error: $tool not found. Run: $INSTALL_HINT"
        exit 1
      fi
    done

    if ! pkg-config --exists libavcodec; then
      echo "Error: ffmpeg not found. Run: $INSTALL_HINT"
      echo "Then: export PKG_CONFIG_PATH=\"$FFMPEG_PC:\$PKG_CONFIG_PATH\""
      exit 1
    fi

    # Clone mpv source (shallow, latest)
    MPV_SRC="$LIBS_DIR/mpv-src"
    # Pin to a stable release to avoid bleeding-edge dependency bumps (e.g. libplacebo >=7.360.1)
    MPV_TAG="v0.40.0"
    if [[ ! -d "$MPV_SRC/.git" ]]; then
      echo "    Cloning mpv source (${MPV_TAG})..."
      git clone https://github.com/mpv-player/mpv.git --depth=1 --branch "$MPV_TAG" "$MPV_SRC"
    else
      echo "    mpv source already present, skipping clone."
    fi

    # Patch: mpv 0.40.0 uses FF_PROFILE_* macros removed in ffmpeg 8.x.
    # Replace with the AV_PROFILE_* equivalents (available since ffmpeg 5.0).
    DEMUX_MKV="$MPV_SRC/demux/demux_mkv.c"
    if grep -q 'FF_PROFILE_ARIB' "$DEMUX_MKV" 2>/dev/null; then
      echo "    Patching demux_mkv.c: FF_PROFILE_* -> AV_PROFILE_* ..."
      # macOS sed requires an explicit backup extension with -i; use '' for in-place
      sed -i.bak \
        -e 's/FF_PROFILE_ARIB_PROFILE_A/AV_PROFILE_ARIB_PROFILE_A/g' \
        -e 's/FF_PROFILE_ARIB_PROFILE_C/AV_PROFILE_ARIB_PROFILE_C/g' \
        -e 's/FF_PROFILE_UNKNOWN/AV_PROFILE_UNKNOWN/g' \
        "$DEMUX_MKV"
      rm -f "${DEMUX_MKV}.bak"
    fi

    # Target the app's declared minimum instead of whatever the build machine's
    # toolchain defaults to, so bundle-libmpv.sh's minimum-version check passes.
    TAURI_CONF="$(dirname "$LIBS_DIR")/apps/player/src-tauri/tauri.conf.json"
    export MACOSX_DEPLOYMENT_TARGET
    MACOSX_DEPLOYMENT_TARGET=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["bundle"]["macOS"]["minimumSystemVersion"])' "$TAURI_CONF")
    echo "    Deployment target: macOS $MACOSX_DEPLOYMENT_TARGET"

    # Build
    BUILD_DIR="$MPV_SRC/build-macos"
    echo "    Running meson setup..."
    # libavdevice is only for capture devices (av://), which we never open.
    # Homebrew links it against sdl2-compat, which needs an SDL3 we don't bundle
    # and aborts the app at launch when it can't find one.
    # No Lua, so the fallback window has mpv's keys but not its on-screen
    # controls. The release app runs under the hardened runtime, which kills
    # it when LuaJIT runs the code it compiles, and mpv loads its built-in Lua
    # scripts in every player. Homebrew's LuaJIT isn't built for that runtime.
    meson setup "$BUILD_DIR" "$MPV_SRC" \
      --buildtype=release \
      --wipe \
      -Dlibmpv=true \
      -Dgl=enabled \
      -Dvulkan=disabled \
      -Dcocoa=enabled \
      -Dlibavdevice=disabled \
      -Dlua=disabled

    echo "    Building libmpv dylib only (this takes a few minutes)..."
    ninja -C "$BUILD_DIR" libmpv.2.dylib

    # Copy dylib to libs/macos/
    DYLIB=$(find "$BUILD_DIR" -name "libmpv*.dylib" | head -1)
    if [[ -z "$DYLIB" ]]; then
      echo "Error: libmpv.dylib not found after build"
      exit 1
    fi
    # A Mac with both Homebrew and MacPorts can link libraries from each.
    # dylibbundler keeps one copy of each library file name, so when both have
    # a file of the same name, code built against one gets the other's.
    PREFIXES=$(otool -L "$DYLIB" | awk 'NR > 1 { print $1 }' \
      | grep -oE '^(/opt/homebrew|/opt/local|/usr/local)/' | sort -u || true)
    if (( $(grep -c . <<< "$PREFIXES" || true) > 1 )); then
      echo "Error: libmpv links libraries from more than one of these: ${PREFIXES//$'\n'/ }"
      echo "Keep only one package manager's pkg-config on PATH and PKG_CONFIG_PATH."
      exit 1
    fi

    rm -f "$LIBS_DIR/macos/libmpv.dylib" "$LIBS_DIR/macos/libmpv.2.dylib"
    cp "$DYLIB" "$LIBS_DIR/macos/libmpv.dylib"
    # Symlink for the versioned install name (@rpath/libmpv.2.dylib)
    ln -sf libmpv.dylib "$LIBS_DIR/macos/libmpv.2.dylib"
    echo "    Built libmpv -> $LIBS_DIR/macos/libmpv.dylib"
    echo "    Done."
    ;;

  linux)
    echo "==> Building libmpv from source for Linux..."
    mkdir -p "$LIBS_DIR/linux"

    # Check build tools
    for tool in meson ninja pkg-config; do
      if ! command -v "$tool" &>/dev/null; then
        echo "Error: $tool not found. Run: sudo apt-get install meson ninja-build pkg-config"
        exit 1
      fi
    done

    if ! pkg-config --exists libavcodec; then
      echo "Error: ffmpeg dev packages not found."
      echo "Run: sudo apt-get install libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libavfilter-dev"
      exit 1
    fi

    # Check audio dev packages. At least one is REQUIRED for playback with sound.
    # Without these, the resulting libmpv.so will have zero AO (audio output)
    # drivers and mpv will silently disable all audio.
    AUDIO_FOUND=false
    for lib in libpulse alsa libpipewire-0.3; do
      if pkg-config --exists "$lib" 2>/dev/null; then
        AUDIO_FOUND=true
      fi
    done
    if [[ "$AUDIO_FOUND" != "true" ]]; then
      echo ""
      echo "============================================================"
      echo "  ERROR: No audio dev packages found!"
      echo "  libmpv will have NO audio output support without them."
      echo ""
      echo "  Install at least one:"
      echo "    sudo apt-get install libpulse-dev libasound2-dev libpipewire-0.3-dev"
      echo ""
      echo "  Then re-run this script."
      echo "============================================================"
      echo ""
      exit 1
    fi

    # Clone mpv source (same version as macOS for consistency)
    MPV_SRC="$LIBS_DIR/mpv-src"
    MPV_TAG="v0.40.0"
    if [[ ! -d "$MPV_SRC/.git" ]]; then
      echo "    Cloning mpv source (${MPV_TAG})..."
      git clone https://github.com/mpv-player/mpv.git --depth=1 --branch "$MPV_TAG" "$MPV_SRC"
    else
      echo "    mpv source already present, skipping clone."
    fi

    # Build with audio + video output support.
    # Audio backends are conditionally enabled based on available dev headers.
    # If no audio dev headers are found, the build continues, since the
    # AUDIO_FOUND check above already warns the user.
    BUILD_DIR="$MPV_SRC/build-linux"
    echo "    Running meson setup..."

    MESON_ARGS=(
      --buildtype=release
      --wipe
      -Dlibmpv=true
      # Video output: EGL/GL on X11 and Wayland
      -Dgl=enabled
      -Degl=enabled
      -Dx11=enabled
      -Dwayland=enabled
      -Dvulkan=disabled
      # mpv's on-screen controls are a Lua script, and the separate fallback
      # window has no other controls, so the build needs LuaJIT.
      -Dlua=luajit
      # Disable optional features we don't need, so auto-detection doesn't pull
      # in deps that may not be on the CI runner (javascript, etc.)
      # Note: libplacebo is a hard requirement of mpv 0.40.0 (not a meson option),
      # so libplacebo-dev must be installed.
      -Djavascript=disabled
      -Dcaca=disabled
      -Dsdl2=disabled
      -Ddrm=disabled
      -Djack=disabled
      -Doss-audio=disabled
      -Dsndio=disabled
      -Dopenal=disabled
    )

    # Note: X11 support requires: libx11-dev libxss-dev libxext-dev libxpresent-dev libxrandr-dev
    # Wayland EGL requires: libwayland-dev

    # Enable audio outputs that have dev headers available.
    # Using -D<backend>=enabled makes meson fail if the dep can't be satisfied,
    # catching misconfigured build environments early.
    if pkg-config --exists alsa 2>/dev/null; then
      MESON_ARGS+=(-Dalsa=enabled)
      echo "    Audio: ALSA enabled"
    fi
    if pkg-config --exists libpulse 2>/dev/null; then
      MESON_ARGS+=(-Dpulse=enabled)
      echo "    Audio: PulseAudio enabled"
    fi
    if pkg-config --exists libpipewire-0.3 2>/dev/null; then
      MESON_ARGS+=(-Dpipewire=enabled)
      echo "    Audio: PipeWire enabled"
    fi

    meson setup "$BUILD_DIR" "$MPV_SRC" "${MESON_ARGS[@]}"

    echo "    Building libmpv.so (this takes a few minutes)..."
    # Build all targets, because the .so name varies by mpv version and config
    ninja -C "$BUILD_DIR"

    # Copy .so to libs/linux/
    SO=$(find "$BUILD_DIR" -name "libmpv.so*" -type f | head -1)
    if [[ -z "$SO" ]]; then
      echo "Error: libmpv.so not found after build"
      exit 1
    fi
    rm -f "$LIBS_DIR/linux/libmpv.so" "$LIBS_DIR/linux/libmpv.so.2"
    cp "$SO" "$LIBS_DIR/linux/libmpv.so"
    ln -sf libmpv.so "$LIBS_DIR/linux/libmpv.so.2"
    echo "    Built libmpv -> $LIBS_DIR/linux/libmpv.so"
    echo "    Done."
    ;;

  *)
    echo "Usage: $0 {macos|linux}"
    echo ""
    echo "Builds libmpv for the target platform."
    echo "Output goes to libs/<platform>/"
    exit 1
    ;;
esac
