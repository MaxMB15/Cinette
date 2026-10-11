#!/usr/bin/env bash
set -euo pipefail

# Cross-compile libass + its transitive deps (freetype, fribidi, harfbuzz) for iOS.
# mpv 0.40.0 hard-requires libass, even for IPTV where subtitles aren't used.
#
# Output:
#   libs/ios/lib/lib{freetype,fribidi,harfbuzz,ass}.a
#   libs/ios/include/{ft2build.h,fribidi/,harfbuzz/,ass/}
#   libs/ios/lib/pkgconfig/{freetype2,fribidi,harfbuzz,libass}.pc

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIBS_DIR="$REPO_ROOT/libs"
BUILD_ROOT="$LIBS_DIR/build-ios"
PREFIX="$LIBS_DIR/ios"
CROSS_FILE="$BUILD_ROOT/ios-arm64.cross"

IOS_MIN="17.0"
ARCH="arm64"
SDK="iphoneos"

# Versions pinned for reproducibility.
FREETYPE_TAG="VER-2-13-3"
FRIBIDI_TAG="v1.0.16"
HARFBUZZ_TAG="10.2.0"
LIBASS_TAG="0.17.3"

mkdir -p "$BUILD_ROOT" "$PREFIX"

for tool in meson ninja pkg-config autoreconf pkg-config; do
  command -v "$tool" &>/dev/null || { echo "Error: $tool not found"; exit 1; }
done

SYSROOT="$(xcrun --sdk "$SDK" --show-sdk-path)"
CC="$(xcrun --sdk $SDK -f clang)"
CXX="$(xcrun --sdk $SDK -f clang++)"
AR="$(xcrun --sdk $SDK -f ar)"
RANLIB="$(xcrun --sdk $SDK -f ranlib)"
COMMON_FLAGS="-arch ${ARCH} -miphoneos-version-min=${IOS_MIN} -isysroot ${SYSROOT}"

# Reuse the cross-file we'd generate anyway (mpv script writes the same one).
cat >"$CROSS_FILE" <<EOF
[binaries]
c = ['$CC']
cpp = ['$CXX']
objc = ['$CC']
objcpp = ['$CXX']
ar = ['$AR']
ranlib = ['$RANLIB']
strip = ['$(xcrun --sdk $SDK -f strip)']
pkg-config = '$(command -v pkg-config)'

[built-in options]
c_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT']
cpp_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT']
objc_args = ['-arch', '$ARCH', '-miphoneos-version-min=$IOS_MIN', '-isysroot', '$SYSROOT', '-fobjc-arc']
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

export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"

# ============================================================================
# freetype — no external deps in this pass (we skip harfbuzz/bzip2/png/zlib)
# ============================================================================
if [[ ! -f "$PREFIX/lib/libfreetype.a" ]]; then
  echo ""
  echo "######################## freetype $FREETYPE_TAG ########################"
  FT_SRC="$BUILD_ROOT/freetype-src"
  FT_BUILD="$BUILD_ROOT/freetype-build"
  if [[ ! -d "$FT_SRC/.git" ]]; then
    git clone https://gitlab.freedesktop.org/freetype/freetype.git --depth=1 --branch "$FREETYPE_TAG" "$FT_SRC"
  fi
  rm -rf "$FT_BUILD"
  meson setup "$FT_BUILD" "$FT_SRC" \
    --cross-file "$CROSS_FILE" --prefix "$PREFIX" --buildtype=release \
    --default-library=static \
    -Dzlib=disabled -Dbzip2=disabled -Dpng=disabled -Dbrotli=disabled -Dharfbuzz=disabled -Dtests=disabled
  ninja -C "$FT_BUILD" install
fi

# ============================================================================
# fribidi — zero external deps
# ============================================================================
if [[ ! -f "$PREFIX/lib/libfribidi.a" ]]; then
  echo ""
  echo "######################## fribidi $FRIBIDI_TAG ########################"
  FB_SRC="$BUILD_ROOT/fribidi-src"
  FB_BUILD="$BUILD_ROOT/fribidi-build"
  if [[ ! -d "$FB_SRC/.git" ]]; then
    git clone https://github.com/fribidi/fribidi.git --depth=1 --branch "$FRIBIDI_TAG" "$FB_SRC"
  fi
  rm -rf "$FB_BUILD"
  meson setup "$FB_BUILD" "$FB_SRC" \
    --cross-file "$CROSS_FILE" --prefix "$PREFIX" --buildtype=release \
    --default-library=static \
    -Dtests=false -Ddocs=false -Dbin=false
  ninja -C "$FB_BUILD" install
fi

# ============================================================================
# harfbuzz — optional freetype integration (we enable since freetype is present)
# ============================================================================
if [[ ! -f "$PREFIX/lib/libharfbuzz.a" ]]; then
  echo ""
  echo "######################## harfbuzz $HARFBUZZ_TAG ########################"
  HB_SRC="$BUILD_ROOT/harfbuzz-src"
  HB_BUILD="$BUILD_ROOT/harfbuzz-build"
  if [[ ! -d "$HB_SRC/.git" ]]; then
    git clone https://github.com/harfbuzz/harfbuzz.git --depth=1 --branch "$HARFBUZZ_TAG" "$HB_SRC"
  fi
  rm -rf "$HB_BUILD"
  meson setup "$HB_BUILD" "$HB_SRC" \
    --cross-file "$CROSS_FILE" --prefix "$PREFIX" --buildtype=release \
    --default-library=static \
    -Dtests=disabled -Ddocs=disabled -Dutilities=disabled \
    -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dicu=disabled -Dcairo=disabled
  ninja -C "$HB_BUILD" install
fi

# ============================================================================
# libass — autotools build, using env vars for cross-compile
# ============================================================================
if [[ ! -f "$PREFIX/lib/libass.a" ]]; then
  echo ""
  echo "######################## libass $LIBASS_TAG ########################"
  LA_SRC="$BUILD_ROOT/libass-src"
  if [[ ! -d "$LA_SRC/.git" ]]; then
    git clone https://github.com/libass/libass.git --depth=1 --branch "$LIBASS_TAG" "$LA_SRC"
  fi
  cd "$LA_SRC"
  if [[ ! -x "./configure" ]]; then
    ./autogen.sh
  fi
  make distclean 2>/dev/null || true

  # autotools cross-compile via explicit env + --host triple
  export CC="$CC"
  export CXX="$CXX"
  export AR="$AR"
  export RANLIB="$RANLIB"
  export CFLAGS="$COMMON_FLAGS -O2"
  export CXXFLAGS="$COMMON_FLAGS -O2"
  export LDFLAGS="$COMMON_FLAGS"

  ./configure \
    --host=aarch64-apple-darwin \
    --prefix="$PREFIX" \
    --enable-static --disable-shared \
    --disable-require-system-font-provider \
    --disable-fontconfig \
    --disable-directwrite \
    --disable-coretext \
    --disable-libunibreak \
    --disable-asm
  make -j"$(sysctl -n hw.ncpu)"
  make install
  cd - >/dev/null
fi

echo ""
echo "==> Subtitle deps installed:"
ls -lh "$PREFIX/lib/libfreetype.a" "$PREFIX/lib/libfribidi.a" "$PREFIX/lib/libharfbuzz.a" "$PREFIX/lib/libass.a"
echo "==> Done."
