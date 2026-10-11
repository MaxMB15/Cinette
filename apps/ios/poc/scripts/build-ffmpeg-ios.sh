#!/usr/bin/env bash
set -euo pipefail

# Cross-compile ffmpeg for iOS (aarch64-apple-ios, device only for now).
# Output:
#   libs/ios/lib/libav{codec,format,util,filter,swresample,swscale}.a
#   libs/ios/include/...
#   libs/ios/lib/pkgconfig/*.pc   (consumed by libplacebo + mpv meson builds)
#
# Usage: ./scripts/build-ffmpeg-ios.sh [--clean]

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIBS_DIR="$REPO_ROOT/libs"
BUILD_ROOT="$LIBS_DIR/build-ios"
PREFIX="$LIBS_DIR/ios"
FFMPEG_SRC="$BUILD_ROOT/ffmpeg-src"
FFMPEG_BUILD="$BUILD_ROOT/ffmpeg-build"

FFMPEG_TAG="n7.1.1"          # matches mpv 0.40.0's supported ffmpeg range (7.x).
IOS_MIN="17.0"
ARCH="arm64"
SDK="iphoneos"

if [[ "${1:-}" == "--clean" ]]; then
  echo "==> Cleaning ffmpeg build artefacts..."
  rm -rf "$FFMPEG_BUILD" "$PREFIX/lib/libav"*.a "$PREFIX/lib/libsw"*.a
fi

mkdir -p "$BUILD_ROOT" "$PREFIX"

# --- Toolchain discovery ------------------------------------------------------
CC="$(xcrun --sdk "$SDK" -f clang)"
SYSROOT="$(xcrun --sdk "$SDK" --show-sdk-path)"
if [[ -z "$CC" || -z "$SYSROOT" ]]; then
  echo "Error: could not locate iPhoneOS SDK toolchain. Install Xcode + command-line tools."
  exit 1
fi

echo "==> Cross-compile target:  aarch64-apple-ios${IOS_MIN}"
echo "==> clang:                 $CC"
echo "==> sdk:                   $SYSROOT"
echo "==> install prefix:        $PREFIX"

# --- Clone ffmpeg (shallow, pinned) ------------------------------------------
if [[ ! -d "$FFMPEG_SRC/.git" ]]; then
  echo "==> Cloning ffmpeg ${FFMPEG_TAG}..."
  git clone https://github.com/FFmpeg/FFmpeg.git --depth=1 --branch "$FFMPEG_TAG" "$FFMPEG_SRC"
else
  echo "==> ffmpeg source already present, skipping clone."
fi

# --- Configure & build --------------------------------------------------------
mkdir -p "$FFMPEG_BUILD"
cd "$FFMPEG_BUILD"

COMMON_FLAGS="-arch ${ARCH} -miphoneos-version-min=${IOS_MIN} -isysroot ${SYSROOT} -O2"

echo "==> Running ffmpeg configure..."
"$FFMPEG_SRC/configure" \
  --prefix="$PREFIX" \
  --enable-cross-compile \
  --target-os=darwin \
  --arch="$ARCH" \
  --cpu=generic \
  --cc="$CC" \
  --sysroot="$SYSROOT" \
  --extra-cflags="$COMMON_FLAGS" \
  --extra-ldflags="$COMMON_FLAGS" \
  --enable-pic \
  --enable-static \
  --disable-shared \
  --disable-programs \
  --disable-doc \
  --disable-debug \
  --disable-avdevice \
  --disable-encoders \
  --disable-muxers \
  --disable-autodetect \
  --disable-sdl2 \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-securetransport \
  --enable-protocol=https \
  --enable-protocol=tls

echo "==> Building ffmpeg (this takes 5-10 min)..."
make -j"$(sysctl -n hw.ncpu)"
make install

# Sanity: at minimum libavcodec + libavformat should be present.
for lib in libavcodec libavformat libavutil libswresample libswscale libavfilter; do
  if [[ ! -f "$PREFIX/lib/${lib}.a" ]]; then
    echo "Error: $PREFIX/lib/${lib}.a missing after install"
    exit 1
  fi
done

echo ""
echo "==> ffmpeg iOS static libs installed to: $PREFIX/lib"
ls -lh "$PREFIX/lib/"*.a
echo ""
echo "==> pkgconfig:"
ls "$PREFIX/lib/pkgconfig/"
echo ""
echo "==> Done."
