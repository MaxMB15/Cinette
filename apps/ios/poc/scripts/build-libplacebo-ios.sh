#!/usr/bin/env bash
set -euo pipefail

# Cross-compile libplacebo for iOS (aarch64-apple-ios).
# libplacebo is a hard dependency of mpv >=0.37; we only need its GLSL backend
# for OpenGL ES on iOS — Vulkan/D3D11 are disabled.
#
# Output:
#   libs/ios/lib/libplacebo.a
#   libs/ios/include/libplacebo/*.h
#   libs/ios/lib/pkgconfig/libplacebo.pc

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIBS_DIR="$REPO_ROOT/libs"
BUILD_ROOT="$LIBS_DIR/build-ios"
PREFIX="$LIBS_DIR/ios"
LP_SRC="$BUILD_ROOT/libplacebo-src"
LP_BUILD="$BUILD_ROOT/libplacebo-build"

LP_TAG="v7.349.0"   # compatible with mpv 0.40.0 (mpv requires >=6.338.2)
IOS_MIN="17.0"
ARCH="arm64"
SDK="iphoneos"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$LP_BUILD" "$PREFIX/lib/libplacebo.a"
fi

mkdir -p "$BUILD_ROOT" "$PREFIX"

for tool in meson ninja pkg-config; do
  command -v "$tool" &>/dev/null || { echo "Error: $tool not found (brew install meson ninja pkg-config)"; exit 1; }
done

SYSROOT="$(xcrun --sdk "$SDK" --show-sdk-path)"

# --- Clone libplacebo ---------------------------------------------------------
if [[ ! -d "$LP_SRC/.git" ]]; then
  echo "==> Cloning libplacebo ${LP_TAG}..."
  git clone https://github.com/haasn/libplacebo.git --depth=1 --branch "$LP_TAG" --recurse-submodules "$LP_SRC"
else
  echo "==> libplacebo source already present, skipping clone."
  (cd "$LP_SRC" && git submodule update --init --recursive)
fi

# --- Meson cross-file (regenerated each run) ---------------------------------
CROSS_FILE="$BUILD_ROOT/ios-arm64.cross"
cat >"$CROSS_FILE" <<EOF
[binaries]
c = ['$(xcrun --sdk $SDK -f clang)']
cpp = ['$(xcrun --sdk $SDK -f clang++)']
ar = ['$(xcrun --sdk $SDK -f ar)']
strip = ['$(xcrun --sdk $SDK -f strip)']
pkg-config = '$(command -v pkg-config)'

[built-in options]
c_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT']
cpp_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT']
c_link_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT']
cpp_link_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT']

[host_machine]
system = 'darwin'
subsystem = 'ios'
kernel = 'xnu'
cpu_family = 'aarch64'
cpu = 'arm64'
endian = 'little'

[properties]
needs_exe_wrapper = true
EOF

# Isolate pkg-config to our iOS prefix so it doesn't find Homebrew libs.
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"

echo "==> Running meson setup for libplacebo..."
rm -rf "$LP_BUILD"
meson setup "$LP_BUILD" "$LP_SRC" \
  --cross-file "$CROSS_FILE" \
  --prefix "$PREFIX" \
  --buildtype=release \
  --default-library=static \
  -Dvulkan=disabled \
  -Dvk-proc-addr=disabled \
  -Dopengl=enabled \
  -Dd3d11=disabled \
  -Dshaderc=disabled \
  -Dglslang=disabled \
  -Ddemos=false \
  -Dtests=false \
  -Dbench=false \
  -Dfuzz=false \
  -Dlcms=disabled \
  -Dxxhash=disabled

echo "==> Building libplacebo..."
ninja -C "$LP_BUILD"
ninja -C "$LP_BUILD" install

if [[ ! -f "$PREFIX/lib/libplacebo.a" ]]; then
  echo "Error: libplacebo.a not produced"
  exit 1
fi

echo ""
echo "==> libplacebo iOS static lib installed:"
ls -lh "$PREFIX/lib/libplacebo.a"
echo "==> Done."
