#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

set -euo pipefail

# Builds the ffmpeg that the app runs for downloads and recordings, from
# ffmpeg's release source, with only what copying a stream needs. The app never
# decodes or encodes with it. The few decoders below only read details such as
# the picture size while ffmpeg opens a stream, as a full build would, and the
# two encoders only decide which subtitle tracks ffmpeg keeps.
#
# Usage: ./scripts/build-ffmpeg.sh <output folder>
#
# It writes <output folder>/ffmpeg and <output folder>/BUILDINFO.txt, and builds
# for the machine it runs on. HTTPS goes through OpenSSL 3. On Linux that's the
# system's OpenSSL, which the app links too, so the build needs a C compiler,
# make, pkg-config and the OpenSSL and zlib headers, such as libssl-dev and
# zlib1g-dev on Debian. macOS has no OpenSSL of its own, so the script builds
# one and links it in. Apple's SecureTransport would need nothing extra, but
# it can't do TLS 1.3, so a server that only takes TLS 1.3 would fail. That
# OpenSSL reads no config file, and looks for certificates in /etc/ssl, where
# macOS keeps them. The build is LGPL version 3 or later, and the script fails
# if it isn't, or if the program names the folder it was built in.
#
# .github/workflows/ffmpeg-build.yml builds and tests the copies that
# scripts/fetch-ffmpeg.sh pins, and docs/development.md explains how.

# ffmpeg's configure, OpenSSL's Configure and the compiler read these from the
# environment, and pkg-config reads its own. Clearing them keeps a local
# build's flags and libraries the same as CI's.
unset CC CXX CPP AS LD AR ARFLAGS RANLIB OBJCOPY CROSS_COMPILE \
  CFLAGS CXXFLAGS OBJCFLAGS CPPFLAGS CPPDEFINES CPPINCLUDES ASFLAGS \
  LDFLAGS LDEXEFLAGS LDSOFLAGS LDLIBS LIBS \
  CPATH C_INCLUDE_PATH LIBRARY_PATH SDKROOT \
  PERL HASHBANGPERL OPENSSL_LOCAL_CONFIG_DIR \
  PKG_CONFIG_PATH PKG_CONFIG_LIBDIR PKG_CONFIG_SYSROOT_DIR

FFMPEG_VERSION=8.1.3
# FFMPEG_BUILD goes in the archive's name, so each build gets its own. Raise
# it for a new build of the same ffmpeg, such as one with a new OpenSSL, and
# set it back to 1 for a new ffmpeg. Older commits pin the archives already on
# the pre-release, so a new build never replaces one.
FFMPEG_BUILD=3
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
# OpenSSL for macOS, from its 3.5 long-term support series.
OPENSSL_VERSION=3.5.9
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
# The copies on this repo's ffmpeg-sidecar pre-release first, then the
# projects' own.
MIRROR="https://github.com/MaxMB15/Cinette/releases/download/ffmpeg-sidecar-8.1"
FFMPEG_SOURCES=(
  "$MIRROR/ffmpeg-$FFMPEG_VERSION.tar.xz"
  "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
)
OPENSSL_SOURCES=(
  "$MIRROR/openssl-$OPENSSL_VERSION.tar.gz"
  "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz"
)

# The containers the app writes, from muxer_for_container in
# crates/core/src/downloads/ffmpeg.rs, and Matroska for a stream converted for
# a Cast receiver. null takes the hardware encoder check's one frame.
MUXERS=avi,matroska,mov,mp4,mpegts,null,webm
# The app may be given HLS, MPEG-TS, MP4, MKV and the other files an Xtream
# provider serves, such as AVI, FLV and WMV, and audio-only streams such as
# radio. The app's own download tests serve WAV. RTSP, RTMP and UDP links
# from an M3U playlist fail for now, since the app passes -reconnect, which only
# HTTP takes, but the build can read them.
# rawvideo reads the hardware encoder check's blank frame.
DEMUXERS=aac,ac3,asf,avi,eac3,flac,flv,h264,hevc,hls,live_flv,matroska,mov,mp3,mpegps,mpegts,mpegvideo,ogg,rawvideo,rtp,rtsp,sdp,srt,wav,webvtt
PROTOCOLS=crypto,data,file,http,httpproxy,https,pipe,rtmp,rtmps,rtp,tcp,tls,udp
PARSERS=aac,aac_latm,ac3,av1,dca,dvbsub,dvdsub,flac,h264,hevc,mpeg4video,mpegaudio,mpegvideo,opus,vorbis,vp8,vp9,vvc
BSFS=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,mpeg4_unpack_bframes,null,setts,vp9_superframe,vvc_mp4toannexb
# Converting a stream for a Cast receiver decodes the audio it can't play,
# DTS and Opus among it.
DECODERS=aac,aac_latm,ac3,ass,dca,dvbsub,dvdsub,eac3,h264,hevc,movtext,mp2,mp3,mpeg2video,mpeg4,opus,rawvideo,subrip,webvtt
# Without -map, ffmpeg only keeps a subtitle track when it has an encoder for
# the container's own subtitle format, ASS for Matroska and WebVTT for WebM.
# The app copies the track, so neither runs. Converting turns audio a receiver
# can't play into AAC.
ENCODERS=aac,ass,webvtt
# Converting audio runs a filter graph with the format and resampling
# filters that turn any layout into stereo. ffmpeg always builds in the
# buffers at each end of a graph.
FILTERS=aformat,anull,aresample,format,null

OUT="${1:-}"
if [[ -z "$OUT" ]]; then
  echo "Usage: $0 <output folder>" >&2
  exit 1
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

CONFIGURE=(
  --disable-everything
  --disable-autodetect
  --disable-doc
  --disable-debug
  --disable-ffplay
  --disable-ffprobe
  --disable-avdevice
  --disable-swscale
  --enable-version3
  --enable-small
  --enable-zlib
  "--enable-muxer=$MUXERS"
  "--enable-demuxer=$DEMUXERS"
  "--enable-protocol=$PROTOCOLS"
  "--enable-parser=$PARSERS"
  "--enable-bsf=$BSFS"
  "--enable-decoder=$DECODERS"
)
case "$(uname -s)" in
  Darwin)
    PLATFORM=macos
    JOBS="$(sysctl -n hw.ncpu)"
    # The app runs on macOS 15 and later. BUILDINFO.txt records this.
    export MACOSX_DEPLOYMENT_TARGET=15.0
    # configure always links CoreMedia and CoreVideo, which nothing here uses.
    # -dead_strip leaves out the parts of OpenSSL that ffmpeg never calls.
    CONFIGURE+=(--enable-openssl --pkg-config-flags=--static "--extra-ldflags=-Wl,-dead_strip_dylibs -Wl,-dead_strip")
    # A full video transcode for a Cast receiver runs on VideoToolbox, the
    # Mac's hardware encoder. MPEG-2 and interlaced channels need it.
    # Deinterlacing to a frame per field and turning 10-bit video into 8-bit
    # take bwdif, scale and swscale. Audio for a receiver becomes AAC with
    # Apple's encoder, aac_at, which is part of the system and ran faster
    # than ffmpeg's own in a test on a Mac.
    ENCODERS+=,aac_at,h264_videotoolbox
    FILTERS+=,bwdif,scale
    CONFIGURE+=(--enable-audiotoolbox --enable-videotoolbox --enable-swscale)
    # On an Intel Mac, --disable-x86asm saves needing nasm, as on Linux below.
    if [[ "$(uname -m)" == x86_64 ]]; then
      CONFIGURE+=(--disable-x86asm)
    fi
    # libSystem and zlib.
    # libSystem, zlib, and the frameworks AudioToolbox and VideoToolbox need.
    ALLOWED_LIBS='^(/usr/lib/libSystem\.B\.dylib|/usr/lib/libz\.1\.dylib|/System/Library/Frameworks/(AudioToolbox|CoreAudio|VideoToolbox|CoreMedia|CoreVideo|CoreFoundation|CoreServices)\.framework/Versions/A/[A-Za-z]+)$'
    ;;
  Linux)
    PLATFORM=linux
    JOBS="$(nproc)"
    # --disable-x86asm saves needing nasm. Only the decoders have assembly, and
    # they read a few frames at most. --gc-sections leaves out the functions
    # that nothing calls, as -dead_strip does on macOS.
    CONFIGURE+=(--enable-openssl --toolchain=hardened --disable-x86asm
      "--extra-cflags=-ffunction-sections -fdata-sections" "--extra-ldflags=-Wl,--gc-sections")
    # glibc, OpenSSL and zlib. On some CPUs the program also names glibc's
    # loader, such as ld-linux-aarch64.so.1.
    ALLOWED_LIBS='^((libc|libm|libssl|libcrypto|libz)\.so\.[0-9]+|ld-linux-[a-z0-9_-]+\.so\.[0-9]+)$'
    ;;
  *) echo "build-ffmpeg.sh builds on macOS and Linux only" >&2; exit 1 ;;
esac

# strip makes the program smaller, and strings, otool and readelf check it.
NEEDS=(cc make pkg-config curl tar strip strings)
if [[ "$PLATFORM" == linux ]]; then
  # GNU tar unpacks the ffmpeg tarball with xz.
  NEEDS+=(xz readelf)
else
  # OpenSSL's Configure is a Perl script.
  NEEDS+=(otool perl)
  # A Mac without the Command Line Tools still has cc, make and the rest, which
  # only offer to install them. xcrun finds the compiler that cc runs, and says
  # why when it can't.
  if ! xcode-select -p > /dev/null 2>&1 || ! xcrun -f cc > /dev/null; then
    echo "build-ffmpeg.sh needs a C compiler from the Command Line Tools or Xcode." >&2
    echo "Run xcode-select --install, or sudo xcode-select -s <folder> to pick a working one." >&2
    exit 1
  fi
fi
for tool in "${NEEDS[@]}"; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "build-ffmpeg.sh needs $tool" >&2
    exit 1
  fi
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# fetch FILE SHA256 URL... saves FILE in $WORK from the first URL that gives
# it with the pinned SHA-256, and unpacks it there.
fetch() {
  local file="$1" sha256="$2" url got
  shift 2
  for url in "$@"; do
    echo "Fetching $file from $url"
    rm -f "$WORK/$file"
    if ! curl -fL --retry 3 --retry-all-errors --retry-delay 5 "$url" -o "$WORK/$file"; then
      echo "Couldn't download $url" >&2
      continue
    fi
    got="$(sha256_of "$WORK/$file")"
    if [[ "$got" == "$sha256" ]]; then
      tar xf "$WORK/$file" -C "$WORK"
      return
    fi
    echo "The file from $url has SHA-256 $got, not the pinned $sha256" >&2
  done
  echo "No source gave the pinned $file" >&2
  exit 1
}

if [[ "$PLATFORM" == macos ]]; then
  fetch "openssl-$OPENSSL_VERSION.tar.gz" "$OPENSSL_SHA256" "${OPENSSL_SOURCES[@]}"
  echo "Building OpenSSL $OPENSSL_VERSION"
  # OpenSSL keeps the folders it was configured with in the program. The
  # prefix is a folder that doesn't exist on a Mac, since nothing loads
  # modules or engines from it, and the install goes into the build folder.
  OPENSSL_PREFIX=/opt/max-video-player/openssl
  OPENSSL_ROOT="$WORK/openssl-root$OPENSSL_PREFIX"
  # Only the static libraries, with nothing loaded at run time. ffmpeg needs
  # DTLS, so that stays. BUILDINFO.txt records these options.
  OPENSSL_CONFIGURE=(no-shared no-module no-legacy no-engine no-autoload-config
    no-apps no-docs no-tests --prefix="$OPENSSL_PREFIX" --openssldir=/etc/ssl --libdir=lib)
  (
    cd "$WORK/openssl-$OPENSSL_VERSION"
    if ! ./Configure "${OPENSSL_CONFIGURE[@]}" > configure.log 2>&1; then
      tail -n 40 configure.log >&2
      exit 1
    fi
    make -j"$JOBS" build_libs > make.log 2>&1 || { tail -n 40 make.log >&2; exit 1; }
    make install_dev DESTDIR="$WORK/openssl-root" > install.log 2>&1 || { tail -n 40 install.log >&2; exit 1; }
  )
  # The .pc files name the prefix, so they point at the install instead.
  sed -i '' "s|$OPENSSL_PREFIX|$OPENSSL_ROOT|g" "$OPENSSL_ROOT"/lib/pkgconfig/*.pc
  # ffmpeg finds this OpenSSL and never one from Homebrew.
  export PKG_CONFIG_LIBDIR="$OPENSSL_ROOT/lib/pkgconfig"
fi

fetch "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256" "${FFMPEG_SOURCES[@]}"
# In the source folder, the compiler gets paths like libavcodec/bytestream.h,
# and those go into the program for its error messages.
cd "$WORK/ffmpeg-$FFMPEG_VERSION"
echo "Configuring ffmpeg $FFMPEG_VERSION for $PLATFORM: ${CONFIGURE[*]}"
# The platform may have added encoders and filters above.
CONFIGURE+=("--enable-encoder=$ENCODERS" "--enable-filter=$FILTERS")
if ! ./configure "${CONFIGURE[@]}" > configure.log 2>&1; then
  tail -n 40 configure.log >&2
  tail -n 40 ffbuild/config.log >&2 || true
  exit 1
fi
LICENSE="$(sed -n 's/^License: //p' configure.log)"
if [[ "$LICENSE" != "LGPL version 3 or later" ]]; then
  echo "The build would be ${LICENSE:-of no license configure named}, not LGPL version 3 or later" >&2
  exit 1
fi
# configure leaves out a component it doesn't know, or one that needs what the
# build lacks, with no more than a warning.
MISSING=""
check_enabled() {
  local kind="$1" name
  for name in ${2//,/ }; do
    if ! grep -q "^#define CONFIG_$(tr '[:lower:]' '[:upper:]' <<< "${name}_$kind") 1$" config_components.h; then
      MISSING+=" ${name}_$kind"
    fi
  done
}
check_enabled muxer "$MUXERS"
check_enabled demuxer "$DEMUXERS"
check_enabled protocol "$PROTOCOLS"
check_enabled parser "$PARSERS"
check_enabled bsf "$BSFS"
check_enabled decoder "$DECODERS"
check_enabled encoder "$ENCODERS"
check_enabled filter "$FILTERS"
if [[ -n "$MISSING" ]]; then
  echo "configure didn't enable:$MISSING" >&2
  exit 1
fi
make -j"$JOBS" ffmpeg > make.log 2>&1 || { tail -n 40 make.log >&2; exit 1; }
strip ffmpeg

# The build folder's random name would only say where the build ran.
if grep -a -q -F "$(basename "$WORK")" ffmpeg; then
  echo "ffmpeg names the folder it was built in, $WORK:" >&2
  strings -a ffmpeg | grep -F "$(basename "$WORK")" >&2 || true
  exit 1
fi

# A library the build wasn't meant to link would also have to ship with the app.
if [[ "$PLATFORM" == macos ]]; then
  LIBS="$(otool -L ffmpeg | tail -n +2 | awk '{print $1}')"
  GLIBC=""
else
  LIBS="$(readelf -d ffmpeg | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')"
  GLIBC="$(readelf -V ffmpeg | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -n 1)"
fi
UNEXPECTED="$(grep -vE "$ALLOWED_LIBS" <<< "$LIBS" || true)"
if [[ -n "$UNEXPECTED" ]]; then
  echo "ffmpeg links libraries it shouldn't:" >&2
  echo "$UNEXPECTED" >&2
  exit 1
fi

cp ffmpeg "$OUT/ffmpeg"
{
  echo "ffmpeg $FFMPEG_VERSION, build $FFMPEG_BUILD of scripts/build-ffmpeg.sh"
  echo "Source: ffmpeg-$FFMPEG_VERSION.tar.xz, SHA-256 $FFMPEG_SHA256"
  echo "License: $LICENSE"
  echo "Built on: $(uname -sm), $(if [[ "$PLATFORM" == macos ]]; then echo "macOS $(sw_vers -productVersion)"; else sed -n 's/^PRETTY_NAME="\(.*\)"/\1/p' /etc/os-release; fi)"
  echo "Compiler: $(cc --version | head -n 1)"
  if [[ "$PLATFORM" == macos ]]; then
    echo "OpenSSL: $OPENSSL_VERSION, linked in, from openssl-$OPENSSL_VERSION.tar.gz, SHA-256 $OPENSSL_SHA256"
    echo "OpenSSL configure: ${OPENSSL_CONFIGURE[*]}"
    echo "macOS target: $MACOSX_DEPLOYMENT_TARGET"
  else
    echo "OpenSSL headers: $(pkg-config --modversion openssl)"
    echo "Newest glibc symbol: $GLIBC"
  fi
  echo "Links:"
  sed 's/^/  /' <<< "$LIBS"
  echo "Configure: ${CONFIGURE[*]}"
} > "$OUT/BUILDINFO.txt"
cat "$OUT/BUILDINFO.txt"
echo "Built $OUT/ffmpeg ($(wc -c < "$OUT/ffmpeg" | tr -d ' ') bytes)"
