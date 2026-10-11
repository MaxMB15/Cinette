#!/usr/bin/env bash
set -euo pipefail

# Cross-compile libmpv for iOS (aarch64-apple-ios).
# Depends on ffmpeg + libplacebo being present in libs/ios (run the other two
# build scripts first).
#
# Output:
#   libs/ios/lib/libmpv.a
#   libs/ios/include/mpv/*.h
#   libs/ios/lib/pkgconfig/mpv.pc

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIBS_DIR="$REPO_ROOT/libs"
BUILD_ROOT="$LIBS_DIR/build-ios"
PREFIX="$LIBS_DIR/ios"
MPV_SRC="$BUILD_ROOT/mpv-src"
MPV_BUILD="$BUILD_ROOT/mpv-build"
CROSS_FILE="$BUILD_ROOT/ios-arm64.cross"

MPV_TAG="v0.40.0"
IOS_MIN="17.0"
ARCH="arm64"
SDK="iphoneos"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$MPV_BUILD" "$PREFIX/lib/libmpv"*.a
fi

mkdir -p "$BUILD_ROOT" "$PREFIX"

for tool in meson ninja pkg-config; do
  command -v "$tool" &>/dev/null || { echo "Error: $tool not found (brew install meson ninja pkg-config)"; exit 1; }
done

# Verify dep artefacts exist.
for dep in libavcodec.a libavformat.a libavutil.a libplacebo.a; do
  [[ -f "$PREFIX/lib/$dep" ]] || { echo "Error: $PREFIX/lib/$dep missing. Run build-ffmpeg-ios.sh and build-libplacebo-ios.sh first."; exit 1; }
done

SYSROOT="$(xcrun --sdk "$SDK" --show-sdk-path)"

# --- Clone mpv ----------------------------------------------------------------
if [[ ! -d "$MPV_SRC/.git" ]]; then
  echo "==> Cloning mpv ${MPV_TAG}..."
  git clone https://github.com/mpv-player/mpv.git --depth=1 --branch "$MPV_TAG" "$MPV_SRC"
else
  echo "==> mpv source already present, skipping clone."
fi

# --- Regenerate the cross-file (shared format with libplacebo script) --------
cat >"$CROSS_FILE" <<EOF
[binaries]
c = ['$(xcrun --sdk $SDK -f clang)']
cpp = ['$(xcrun --sdk $SDK -f clang++)']
objc = ['$(xcrun --sdk $SDK -f clang)']
objcpp = ['$(xcrun --sdk $SDK -f clang++)']
ar = ['$(xcrun --sdk $SDK -f ar)']
strip = ['$(xcrun --sdk $SDK -f strip)']
pkg-config = '$(command -v pkg-config)'

[built-in options]
c_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT']
cpp_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT']
objc_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT', '-fobjc-arc']
objcpp_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT', '-fobjc-arc']
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

# Point pkg-config at ONLY our iOS prefix (exclude host Homebrew libs).
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"

echo "==> pkg-config visible packages:"
pkg-config --list-all | sort

echo "==> Running meson setup for mpv..."
rm -rf "$MPV_BUILD"
meson setup "$MPV_BUILD" "$MPV_SRC" \
  --cross-file "$CROSS_FILE" \
  --prefix "$PREFIX" \
  --buildtype=release \
  --default-library=static \
  -Dlibmpv=true \
  -Dcplayer=false \
  -Dtests=false \
  -Dmanpage-build=disabled \
  -Dhtml-build=disabled \
  -Dios-gl=enabled \
  -Dgl=enabled \
  -Dgl-cocoa=disabled \
  -Dcocoa=disabled \
  -Dvulkan=disabled \
  -Daudiounit=enabled \
  -Davfoundation=disabled \
  -Dcoreaudio=disabled \
  -Dvideotoolbox-gl=disabled \
  -Dvideotoolbox-pl=disabled \
  -Dswift-build=disabled \
  -Dlua=disabled \
  -Djavascript=disabled \
  -Dsdl2=disabled \
  -Dsdl2-audio=disabled \
  -Dsdl2-gamepad=disabled \
  -Dsdl2-video=disabled \
  -Djack=disabled \
  -Dopenal=disabled \
  -Dalsa=disabled \
  -Dpulse=disabled \
  -Dpipewire=disabled \
  -Dwayland=disabled \
  -Dx11=disabled \
  -Degl=disabled \
  -Degl-android=disabled \
  -Degl-angle=disabled \
  -Degl-angle-win32=disabled \
  -Degl-drm=disabled \
  -Degl-wayland=disabled \
  -Degl-x11=disabled \
  -Ddrm=disabled \
  -Dlibarchive=disabled \
  -Drubberband=disabled \
  -Duchardet=disabled \
  -Dzimg=disabled \
  -Dlcms2=disabled \
  -Ddvdnav=disabled \
  -Dcdda=disabled \
  -Dlibbluray=disabled \
  -Dvapoursynth=disabled \
  -Dpdf-build=disabled

echo "==> Building libmpv (~5-10 min)..."
ninja -C "$MPV_BUILD"
ninja -C "$MPV_BUILD" install

if [[ ! -f "$PREFIX/lib/libmpv.a" ]]; then
  echo "Error: libmpv.a not produced"
  exit 1
fi

echo ""
echo "==> libmpv iOS static lib installed:"
ls -lh "$PREFIX/lib/libmpv.a"
echo "==> Done."
