#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Bundle libmpv and its dependencies for Linux AppImage distribution.
# Analogous to bundle-libmpv.sh (macOS). Uses ldd + patchelf instead of dylibbundler.
# CWD when run: workspace root (via beforeBundleCommand cwd)
#
# For .deb/.rpm packages libmpv is declared as a system dependency in
# tauri.conf.json, so this bundling step only matters for AppImage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_RELEASE="$WORKSPACE_ROOT/target/release"
BINARY="$TARGET_RELEASE/max-video-player"

# Ensure binary exists
if [[ ! -f "$BINARY" ]]; then
  echo "Error: Binary not found at $BINARY"
  exit 1
fi

# Check for patchelf
if ! command -v patchelf &>/dev/null; then
  echo "Error: patchelf not found. Run: sudo apt-get install patchelf"
  exit 1
fi

# Find libmpv. Prefer libs/linux/ (source build), then system pkg-config.
# Source build is preferred because it includes audio outputs we control.
LIBMPV_PATH=""
if [[ -f "$WORKSPACE_ROOT/libs/linux/libmpv.so" ]]; then
  LIBMPV_PATH="$WORKSPACE_ROOT/libs/linux/libmpv.so"
  echo "    Using source-built libmpv from libs/linux/"
elif pkg-config --exists mpv 2>/dev/null; then
  LIBMPV_DIR=$(pkg-config --variable=libdir mpv 2>/dev/null || echo "")
  if [[ -n "$LIBMPV_DIR" ]]; then
    # Try versioned names first (libmpv.so.2, libmpv.so.1), then unversioned
    for name in libmpv.so.2 libmpv.so.1 libmpv.so; do
      if [[ -f "$LIBMPV_DIR/$name" ]]; then
        LIBMPV_PATH="$LIBMPV_DIR/$name"
        break
      fi
    done
  fi
fi
if [[ -z "$LIBMPV_PATH" ]]; then
  echo "Error: libmpv.so not found in libs/linux/ or via pkg-config"
  exit 1
fi

echo "==> Bundling libmpv for Linux AppImage..."
echo "    libmpv: $LIBMPV_PATH"

# Tauri's AppImage bundler places extra libs alongside the binary.
# Set RPATH to $ORIGIN so the binary finds them in the same directory.
BUNDLE_DIR="$TARGET_RELEASE"

# Copy libmpv next to the binary
cp "$LIBMPV_PATH" "$BUNDLE_DIR/libmpv.so"
# Create versioned symlinks that the linker may look for
ln -sf libmpv.so "$BUNDLE_DIR/libmpv.so.2"
ln -sf libmpv.so "$BUNDLE_DIR/libmpv.so.1"

# System libraries that must NOT be bundled. They are always present on the
# target system and bundling them causes ABI conflicts. In particular, GPU
# drivers (Mesa/VA-API/VDPAU) and their LLVM backend must always come from the
# system: they dlopen kernel modules and must match the host kernel ABI. Mixing
# bundled GLib/libffi with system Mesa corrupts internal GL dispatch tables.
SYSTEM_LIBS_RE="linux-vdso|ld-linux|libc\.so|libm\.so|libdl\.so|libpthread"
SYSTEM_LIBS_RE+="|librt\.so|libstdc\+\+|libgcc_s|libresolv|libnss_"
SYSTEM_LIBS_RE+="|libX[a-z]|libxcb|libwayland|libdrm|libgbm"
# GL stack. Always use the system Mesa or vendor driver, never bundle.
SYSTEM_LIBS_RE+="|libGL\.so|libEGL\.so|libGLX|libGLdispatch|libOpenGL"
# GTK stack and its transitive deps, which must match the system WebKit/GTK.
SYSTEM_LIBS_RE+="|libgtk|libgdk|libglib|libgobject|libgio|libpango|libcairo|libatk"
SYSTEM_LIBS_RE+="|libffi|libpcre|libharfbuzz|libfribidi|libgraphite"
# Hardware video acceleration comes from the system to match the GPU driver.
SYSTEM_LIBS_RE+="|libva|libvdpau|libnvidia|libcuda"
# LLVM backend used by Mesa shader compilers, which must match the Mesa version.
SYSTEM_LIBS_RE+="|libLLVM|libclang"
# Core system services.
SYSTEM_LIBS_RE+="|libdbus|libsystemd|libfontconfig|libfreetype|libudev"

# bundle_all_deps: recursively resolve and copy dependencies to a fixpoint.
# Uses the bundle dir itself as the visited set. If a .so already exists
# there, it's been processed and won't be traversed again.
#
# Uses process substitution (< <(...)) instead of a pipeline so that:
#   1. The while loop body runs in the current shell, so queue+= propagates.
#   2. "|| true" after the process substitution suppresses grep exit-1 when a
#      lib has no "=> /" lines (e.g. only linux-vdso / ld-linux deps), which
#      would otherwise trigger set -euo pipefail and kill the script silently.
bundle_all_deps() {
  local queue=("$@")
  while [[ ${#queue[@]} -gt 0 ]]; do
    local lib="${queue[0]}"
    queue=("${queue[@]:1}")
    while IFS= read -r dep; do
      local basename_dep
      basename_dep=$(basename "$dep")
      if echo "$basename_dep" | grep -qE "$SYSTEM_LIBS_RE"; then
        continue
      fi
      if [[ ! -f "$BUNDLE_DIR/$basename_dep" ]]; then
        cp "$dep" "$BUNDLE_DIR/"
        echo "    bundled: $basename_dep"
        queue+=("$BUNDLE_DIR/$basename_dep")
      fi
    done < <(ldd "$lib" 2>/dev/null | grep "=> /" | awk '{print $3}' || true)
  done
}

# Bundle libmpv and all transitive dependencies
bundle_all_deps "$LIBMPV_PATH"

# Set RPATH so the binary and all bundled libs find co-located libs
echo "    Setting RPATH on binary..."
patchelf --set-rpath '$ORIGIN' "$BINARY" \
  || { echo "Error: patchelf --set-rpath failed on $BINARY"; exit 1; }
patchelf --set-rpath '$ORIGIN' "$BUNDLE_DIR/libmpv.so" \
  || { echo "Error: patchelf --set-rpath failed on $BUNDLE_DIR/libmpv.so"; exit 1; }

# Also set RPATH on all bundled .so files so they can find each other
for so in "$BUNDLE_DIR"/*.so*; do
  if [[ -f "$so" && ! -L "$so" ]]; then
    patchelf --set-rpath '$ORIGIN' "$so" 2>/dev/null || true
  fi
done

# Verify audio output support
echo ""
echo "==> Verifying bundled audio libraries..."
AUDIO_LIBS=0
for pattern in libpulse libasound libpipewire; do
  if ls "$BUNDLE_DIR"/${pattern}* 2>/dev/null | head -1 >/dev/null; then
    echo "    ✓ Found ${pattern}"
    AUDIO_LIBS=$((AUDIO_LIBS + 1))
  fi
done
if [[ $AUDIO_LIBS -eq 0 ]]; then
  echo "    ⚠ WARNING: No audio libraries bundled. AppImage may have no audio output."
  echo "    Install audio dev packages and rebuild libmpv: sudo apt-get install libpulse-dev libasound2-dev"
fi

# CI audit: list every bundled library so regressions in SYSTEM_LIBS_RE are
# visible in build logs. A GL/GTK lib showing up here would indicate the filter
# regressed and will cause ABI conflicts at runtime.
echo ""
echo "==> Bundled libraries (full inventory for CI audit):"
for so in "$BUNDLE_DIR"/*.so*; do
  if [[ -f "$so" && ! -L "$so" ]]; then
    size=$(stat -c%s "$so" 2>/dev/null || stat -f%z "$so" 2>/dev/null || echo "?")
    printf "    %-50s %s bytes\n" "$(basename "$so")" "$size"
  fi
done

echo ""
echo "    Done. Bundled libs placed alongside binary in $BUNDLE_DIR"
