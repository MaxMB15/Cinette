#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Builds libmpv and FFmpeg for Android. scripts/build-libmpv.sh android runs
# this. It follows mpv-android's buildscripts
# (https://github.com/mpv-android/mpv-android/tree/master/buildscripts),
# with fewer dependencies: no Lua, curl, libxml2, dav1d, fontconfig or
# libunibreak.
#
# FFmpeg is built as shared libraries, because the app calls
# av_jni_set_java_vm in libavcodec before mpv starts, so MediaCodec and
# AudioTrack can reach the JVM. Everything else is linked into libmpv.so.
#
# Usage: scripts/lib/libmpv-android.sh LIBS_DIR [ABI...]
#   ABI is arm64-v8a or armeabi-v7a. Both by default.
# Needs NDK_HOME, curl, git, make, meson, ninja, pkg-config and python3.
# Output: LIBS_DIR/android/<ABI>/*.so. The build folders are in
# LIBS_DIR/android-build, which can go once the libraries are built.

set -euo pipefail

LIBS_DIR="$1"
shift
ABIS=("$@")
if (( ${#ABIS[@]} == 0 )); then
  ABIS=(arm64-v8a armeabi-v7a)
fi

# The app's minSdk, in gen/android/app/build.gradle.kts.
API=28

FFMPEG_VERSION=8.1.3
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
# The 3.6 LTS. FFmpeg's mbedtls code needs the 3.x API.
MBEDTLS_VERSION=3.6.7
MBEDTLS_SHA256=a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6
FREETYPE_VERSION=2.14.1
FREETYPE_SHA256=32427e8c471ac095853212a37aef816c60b42052d4d9e48230bab3bdf2936ccc
FRIBIDI_VERSION=1.0.17
FRIBIDI_SHA256=6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2
HARFBUZZ_VERSION=14.6.0
HARFBUZZ_SHA256=d07a007327277708a2a73ae437887cdbaf282937f6d03ca5467723e9099af586
LIBASS_VERSION=0.17.5
LIBASS_SHA256=2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc
MPV_VERSION=0.41.0
MPV_SHA256=ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209
# libplacebo's release tarballs leave out the submodules it builds with, so
# it comes from git, checked against the tag's commit.
LIBPLACEBO_TAG=v7.360.1
LIBPLACEBO_COMMIT=cee9b076f2c63104ccfd497fa79c39a867293ec4

: "${NDK_HOME:?Set NDK_HOME to the NDK, such as \$ANDROID_HOME/ndk/30.0.16248370}"
for tool in curl git make meson ninja pkg-config python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: $tool not found. docs/android.md lists what the build needs." >&2
    exit 1
  fi
done

case "$(uname -s)" in
  Darwin) HOST_TAG=darwin-x86_64 ;;
  *) HOST_TAG=linux-x86_64 ;;
esac
TOOLCHAIN="$NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG"
if [[ ! -x "$TOOLCHAIN/bin/clang" ]]; then
  echo "Error: no NDK toolchain at $TOOLCHAIN" >&2
  exit 1
fi
export PATH="$TOOLCHAIN/bin:$PATH"

if command -v nproc >/dev/null 2>&1; then
  JOBS="${JOBS:-$(nproc)}"
else
  JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"
fi

WORK="$LIBS_DIR/android-build"
SOURCES="$WORK/sources"
mkdir -p "$SOURCES"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# fetch FILE SHA256 URL saves FILE in $SOURCES and checks it, once.
fetch() {
  local file="$1" sha256="$2" url="$3" got
  if [[ -f "$SOURCES/$file" ]] && [[ "$(sha256_of "$SOURCES/$file")" == "$sha256" ]]; then
    return
  fi
  echo "    Downloading $file"
  curl -fsSL --retry 3 -o "$SOURCES/$file.part" "$url"
  got="$(sha256_of "$SOURCES/$file.part")"
  if [[ "$got" != "$sha256" ]]; then
    echo "Error: $url has SHA-256 $got, not the pinned $sha256" >&2
    rm -f "$SOURCES/$file.part"
    exit 1
  fi
  mv "$SOURCES/$file.part" "$SOURCES/$file"
}

# unpack FILE DIR unpacks FILE from $SOURCES into $SOURCES/DIR, once.
unpack() {
  local file="$1" dir="$2"
  if [[ ! -d "$SOURCES/$dir" ]]; then
    mkdir -p "$SOURCES/$dir.part"
    tar -xf "$SOURCES/$file" -C "$SOURCES/$dir.part" --strip-components=1
    mv "$SOURCES/$dir.part" "$SOURCES/$dir"
  fi
}

echo "==> Getting the sources"
fetch "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256" \
  "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
fetch "mbedtls-$MBEDTLS_VERSION.tar.bz2" "$MBEDTLS_SHA256" \
  "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-$MBEDTLS_VERSION/mbedtls-$MBEDTLS_VERSION.tar.bz2"
fetch "freetype-$FREETYPE_VERSION.tar.xz" "$FREETYPE_SHA256" \
  "https://download.savannah.gnu.org/releases/freetype/freetype-$FREETYPE_VERSION.tar.xz"
fetch "fribidi-$FRIBIDI_VERSION.tar.xz" "$FRIBIDI_SHA256" \
  "https://github.com/fribidi/fribidi/releases/download/v$FRIBIDI_VERSION/fribidi-$FRIBIDI_VERSION.tar.xz"
fetch "harfbuzz-$HARFBUZZ_VERSION.tar.xz" "$HARFBUZZ_SHA256" \
  "https://github.com/harfbuzz/harfbuzz/releases/download/$HARFBUZZ_VERSION/harfbuzz-$HARFBUZZ_VERSION.tar.xz"
fetch "libass-$LIBASS_VERSION.tar.xz" "$LIBASS_SHA256" \
  "https://github.com/libass/libass/releases/download/$LIBASS_VERSION/libass-$LIBASS_VERSION.tar.xz"
fetch "mpv-$MPV_VERSION.tar.gz" "$MPV_SHA256" \
  "https://github.com/mpv-player/mpv/archive/refs/tags/v$MPV_VERSION.tar.gz"

unpack "ffmpeg-$FFMPEG_VERSION.tar.xz" ffmpeg
unpack "mbedtls-$MBEDTLS_VERSION.tar.bz2" mbedtls
unpack "freetype-$FREETYPE_VERSION.tar.xz" freetype
unpack "fribidi-$FRIBIDI_VERSION.tar.xz" fribidi
unpack "harfbuzz-$HARFBUZZ_VERSION.tar.xz" harfbuzz
unpack "libass-$LIBASS_VERSION.tar.xz" libass
unpack "mpv-$MPV_VERSION.tar.gz" mpv

if [[ ! -d "$SOURCES/libplacebo" ]]; then
  git clone --quiet --depth 1 --branch "$LIBPLACEBO_TAG" --recurse-submodules --shallow-submodules \
    https://code.videolan.org/videolan/libplacebo.git "$SOURCES/libplacebo.part"
  mv "$SOURCES/libplacebo.part" "$SOURCES/libplacebo"
fi
got="$(git -C "$SOURCES/libplacebo" rev-parse HEAD)"
if [[ "$got" != "$LIBPLACEBO_COMMIT" ]]; then
  echo "Error: libplacebo $LIBPLACEBO_TAG is commit $got, not the pinned $LIBPLACEBO_COMMIT" >&2
  exit 1
fi

# build_abi ABI builds everything for one ABI into $WORK/<ABI>/prefix.
build_abi() {
  local abi="$1" cc_triple cpu_family cpu ffmpeg_arch ffmpeg_cpu cflags=""
  case "$abi" in
    arm64-v8a)
      cc_triple=aarch64-linux-android$API
      cpu_family=aarch64 cpu=armv8-a ffmpeg_arch=aarch64 ffmpeg_cpu=armv8-a
      ;;
    armeabi-v7a)
      cc_triple=armv7a-linux-androideabi$API
      cpu_family=arm cpu=armv7-a ffmpeg_arch=arm ffmpeg_cpu=armv7-a
      cflags="-mfpu=neon"
      ;;
    *)
      echo "Error: unknown ABI $abi. Use arm64-v8a or armeabi-v7a." >&2
      exit 1
      ;;
  esac

  local dir="$WORK/$abi" prefix="$WORK/$abi/prefix"
  mkdir -p "$prefix/lib/pkgconfig" "$prefix/include"

  export CC="$cc_triple-clang" CXX="$cc_triple-clang++"
  export AR=llvm-ar RANLIB=llvm-ranlib NM=llvm-nm STRIP=llvm-strip
  export CFLAGS="-fPIC -O2 $cflags" CXXFLAGS="-fPIC -O2 $cflags"
  # 16 KB pages, which Android 15 devices can have.
  export LDFLAGS="-Wl,-z,max-page-size=16384"
  # Only the libraries built here, never the build machine's.
  export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
  unset PKG_CONFIG_PATH PKG_CONFIG_SYSROOT_DIR

  cat >"$dir/cross.txt" <<CROSS
[built-in options]
buildtype = 'release'
default_library = 'static'
wrap_mode = 'nodownload'
prefix = '$prefix'
libdir = 'lib'
c_args = ['-fPIC', '-O2'$( [[ -n "$cflags" ]] && printf ", '%s'" $cflags )]
cpp_args = ['-fPIC', '-O2'$( [[ -n "$cflags" ]] && printf ", '%s'" $cflags )]
c_link_args = ['-Wl,-z,max-page-size=16384']
cpp_link_args = ['-Wl,-z,max-page-size=16384']
[binaries]
c = '$CC'
cpp = '$CXX'
ar = 'llvm-ar'
nm = 'llvm-nm'
strip = 'llvm-strip'
pkg-config = 'pkg-config'
[properties]
pkg_config_libdir = '$prefix/lib/pkgconfig'
[host_machine]
system = 'android'
cpu_family = '$cpu_family'
cpu = '$cpu'
endian = 'little'
CROSS

  # logged NAME DIR COMMAND... runs COMMAND in DIR with its output in
  # NAME's log, and stops the build with the end of the log if it fails.
  logged() {
    local name="$1" in="$2"
    shift 2
    if ! (cd "$in" && "$@") >>"$dir/$name.log" 2>&1; then
      echo "Error: building $name for $abi failed. The end of $dir/$name.log:" >&2
      tail -40 "$dir/$name.log" >&2
      exit 1
    fi
  }

  # meson_build NAME SRC ARGS... builds and installs a meson project.
  meson_build() {
    local name="$1" src="$2"
    shift 2
    echo "    $abi: $name"
    rm -f "$dir/$name.log"
    logged "$name" "$dir" meson setup "build-$name" "$src" --cross-file cross.txt --wipe "$@"
    logged "$name" "$dir" ninja -C "build-$name" -j "$JOBS" install
  }

  echo "==> Building for $abi"

  echo "    $abi: mbedtls"
  rm -rf "$dir/mbedtls" "$dir/mbedtls.log"
  cp -R "$SOURCES/mbedtls" "$dir/mbedtls"
  # Since 3.6.6 mbedTLS reads /dev/random, which can block. config.py loads
  # modules from its own folder, so it can't run with -I.
  logged mbedtls "$dir/mbedtls" python3 scripts/config.py set MBEDTLS_PLATFORM_DEV_RANDOM '"/dev/urandom"'
  logged mbedtls "$dir/mbedtls" make -j "$JOBS" no_test
  logged mbedtls "$dir/mbedtls" make DESTDIR="$prefix" install

  echo "    $abi: ffmpeg"
  rm -rf "$dir/build-ffmpeg" "$dir/ffmpeg.log"
  mkdir -p "$dir/build-ffmpeg"
  logged ffmpeg "$dir/build-ffmpeg" "$SOURCES/ffmpeg/configure" \
      --prefix="$prefix" \
      --target-os=android --enable-cross-compile \
      --arch="$ffmpeg_arch" --cpu="$ffmpeg_cpu" \
      --cc="$CC" --cxx="$CXX" --ar=llvm-ar --ranlib=llvm-ranlib --nm=llvm-nm --strip=llvm-strip \
      --pkg-config=pkg-config \
      --extra-cflags="-I$prefix/include $cflags" \
      --extra-ldflags="-L$prefix/lib -Wl,-z,max-page-size=16384" \
      --enable-shared --disable-static --enable-pic \
      --enable-gpl --enable-version3 \
      --enable-jni --enable-mediacodec --enable-mbedtls \
      --disable-vulkan --disable-programs --disable-doc --disable-avdevice \
      --disable-muxers --disable-encoders --disable-devices \
      --enable-encoder=mjpeg,png
  logged ffmpeg "$dir/build-ffmpeg" make -j "$JOBS"
  logged ffmpeg "$dir/build-ffmpeg" make install

  meson_build freetype "$SOURCES/freetype" \
    -Dbrotli=disabled -Dbzip2=disabled -Dharfbuzz=disabled -Dpng=disabled \
    -Dzlib=internal -Dtests=disabled
  meson_build fribidi "$SOURCES/fribidi" -Dtests=false -Ddocs=false -Dbin=false
  meson_build harfbuzz "$SOURCES/harfbuzz" \
    -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled \
    -Dchafa=disabled -Dicu=disabled -Dgraphite=disabled -Dtests=disabled \
    -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled \
    -Draster=disabled -Dvector=disabled -Dgpu=disabled -Dsubset=disabled
  meson_build libass "$SOURCES/libass" \
    -Dfontconfig=disabled -Dlibunibreak=disabled -Drequire-system-font-provider=false \
    -Dtest=disabled -Dcompare=disabled -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled
  meson_build libplacebo "$SOURCES/libplacebo" \
    -Dvulkan=disabled -Dopengl=enabled -Dd3d11=disabled -Dglslang=disabled \
    -Dshaderc=disabled -Dlcms=disabled -Ddovi=disabled -Dlibdovi=disabled \
    -Dxxhash=disabled -Dunwind=disabled -Ddemos=false -Dtests=false -Dbench=false

  # harfbuzz and libplacebo are C++. Linking them into libmpv.so needs the
  # NDK's static C++ library, which their .pc files don't name.
  for pc in harfbuzz libplacebo; do
    sed -i.bak '/^Libs:/ s|$| -lc++_static -lc++abi|' "$prefix/lib/pkgconfig/$pc.pc"
    rm -f "$prefix/lib/pkgconfig/$pc.pc.bak"
  done

  meson_build mpv "$SOURCES/mpv" \
    --default-library=shared \
    -Dlibmpv=true -Dcplayer=false -Dgpl=true \
    -Dlua=disabled -Djavascript=disabled -Diconv=disabled \
    -Dlibarchive=disabled -Dlibbluray=disabled -Ddvdnav=disabled -Dcdda=disabled \
    -Duchardet=disabled -Drubberband=disabled -Dzimg=disabled -Dlcms2=disabled \
    -Dvapoursynth=disabled -Dlibavdevice=disabled -Djpeg=disabled \
    -Dvulkan=disabled -Dshaderc=disabled -Dspirv-cross=disabled \
    -Dgl=enabled -Degl-android=enabled -Daudiotrack=enabled -Daaudio=enabled \
    -Dopensles=enabled -Dandroid-media-ndk=enabled \
    -Dmanpage-build=disabled -Dhtml-build=disabled -Dpdf-build=disabled

  # Only the libraries go here, since Gradle packs the whole folder.
  local out="$LIBS_DIR/android/$abi"
  rm -rf "$out"
  mkdir -p "$out"
  for lib in mpv avcodec avfilter avformat avutil swresample swscale; do
    # Each library's real file, under the name it's linked by.
    local so
    so="$(readlink -f "$prefix/lib/lib$lib.so")"
    cp "$so" "$out/lib$lib.so"
  done
  echo "    $abi: done -> $out"
}

for abi in "${ABIS[@]}"; do
  build_abi "$abi"
done
