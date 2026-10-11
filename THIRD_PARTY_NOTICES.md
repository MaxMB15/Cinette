# Third-party notices

Max Video Player is built on other people's open source software. Each component below keeps its own license, and Max Video Player's license doesn't change it. Max Video Player's own license is in [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Getting the source code

- **Max Video Player.** Every release has a tag in this repository. Settings > About in the app links to the source for the version you're running.
- **mpv.** The macOS and Linux apps' libmpv is built from the [mpv v0.40.0 tag](https://github.com/mpv-player/mpv/tree/v0.40.0) by [scripts/build-libmpv.sh](scripts/build-libmpv.sh). The iOS app's libmpv comes from MPVKit, described [below](#libraries-bundled-in-the-ios-app).
- **FFmpeg.** Source releases are at [ffmpeg.org/download.html](https://ffmpeg.org/download.html).
- **Other libraries.** Each project in the tables below links to its home page, where its source is published. On macOS they come from [Homebrew](https://github.com/Homebrew/homebrew-core), whose formulas record the exact source archive and build options. On iOS they come from MPVKit, whose build scripts record the same.

If you received a copy of Max Video Player and can't find the source for one of its components, [open an issue](https://github.com/MaxMB15/MaxVideoPlayer/issues) and it will be provided.

## mpv

Max Video Player plays video with libmpv from [mpv](https://mpv.io), licensed under the GNU General Public License version 2 or later. Some of its files are under the GNU Lesser General Public License version 2.1 or later. The macOS app and the Linux AppImage include libmpv. The Linux `.deb` and `.rpm` packages use the libmpv package from your distribution instead. The iOS app includes a build of libmpv without mpv's GPL parts, which is licensed under the GNU Lesser General Public License version 2.1 or later.

## FFmpeg

Max Video Player includes [FFmpeg](https://ffmpeg.org) in two forms. FFmpeg is a trademark of Fabrice Bellard.

- **FFmpeg 7.1 libraries** (`libavcodec`, `libavfilter`, `libavformat`, `libavutil`, `libpostproc`, `libswresample`, `libswscale`), used by libmpv. The macOS app includes them as built by Homebrew's `ffmpeg@7` formula, with `--enable-gpl` and `--enable-version3`. That build is licensed under the GNU General Public License version 3 or later.
- **FFmpeg 9.0.2 libraries** (`libavcodec`, `libavdevice`, `libavfilter`, `libavformat`, `libavutil`, `libswresample`, `libswscale`), used by libmpv in the iOS app. They're built with `--enable-version3` and without `--enable-gpl`, so they're licensed under the GNU Lesser General Public License version 3 or later.
- **The `ffmpeg` program**, which the desktop app runs to download movies and episodes. The iOS app doesn't include it. It is a static build licensed under the GNU General Public License version 3 or later, downloaded by [scripts/fetch-ffmpeg.sh](scripts/fetch-ffmpeg.sh) from [osxexperts.net](https://www.osxexperts.net) for macOS, [johnvansickle.com](https://johnvansickle.com/ffmpeg/) for Linux and [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) for Windows builds.

## Libraries bundled in the macOS app

The macOS app includes these shared libraries in `Contents/Frameworks`, alongside libmpv and the FFmpeg libraries above. The licenses are as declared by Homebrew, written as [SPDX identifiers](https://spdx.org/licenses/).

| Project | Files | License |
| --- | --- | --- |
| [aom](https://aomedia.googlesource.com/aom) | `libaom` | BSD-2-Clause |
| [aribb24](https://code.videolan.org/jeeb/aribb24) | `libaribb24` | LGPL-3.0-only |
| [brotli](https://github.com/google/brotli) | `libbrotlicommon`, `libbrotlidec`, `libbrotlienc` | MIT |
| [cjson](https://github.com/DaveGamble/cJSON) | `libcjson` | MIT |
| [dav1d](https://code.videolan.org/videolan/dav1d) | `libdav1d` | BSD-2-Clause |
| [fontconfig](https://wiki.freedesktop.org/www/Software/fontconfig/) | `libfontconfig` | HPND-sell-variant AND Unicode-3.0 AND MIT-Modern-Variant AND MIT AND LicenseRef-Homebrew-public-domain |
| [freetype](https://www.freetype.org/) | `libfreetype` | FTL |
| [fribidi](https://github.com/fribidi/fribidi) | `libfribidi` | GPL-2.0-or-later AND LGPL-2.1-or-later |
| [gettext](https://www.gnu.org/software/gettext/) | `libintl` | GPL-3.0-or-later AND LGPL-2.1-or-later |
| [giflib](https://giflib.sourceforge.net/) | `libgif` | MIT |
| [glib](https://docs.gtk.org/glib/) | `libglib-2` | LGPL-2.1-or-later |
| [gmp](https://gmplib.org/) | `libgmp` | LGPL-3.0-or-later OR GPL-2.0-or-later |
| [gnutls](https://gnutls.org/) | `libgnutls` | LGPL-2.1-or-later AND GPL-3.0-only |
| [graphite2](https://graphite.sil.org/) | `libgraphite2` | MIT OR MPL-2.0 OR LGPL-2.1-or-later OR GPL-2.0-or-later |
| [harfbuzz](https://github.com/harfbuzz/harfbuzz) | `libharfbuzz` | MIT |
| [highway](https://github.com/google/highway) | `libhwy` | Apache-2.0 OR BSD-3-Clause |
| [jpeg-turbo](https://www.libjpeg-turbo.org/) | `libjpeg` | IJG AND Zlib AND BSD-3-Clause |
| [jpeg-xl](https://jpeg.org/jpegxl/index.html) | `libjxl`, `libjxl_cms`, `libjxl_threads` | BSD-3-Clause |
| [lame](https://lame.sourceforge.io/) | `libmp3lame` | LGPL-2.0-or-later |
| [leptonica](http://www.leptonica.org/) | `libleptonica` | BSD-2-Clause |
| [libarchive](https://www.libarchive.org) | `libarchive` | BSD-2-Clause |
| [libass](https://github.com/libass/libass) | `libass` | ISC |
| [libb2](https://blake2.net/) | `libb2` | CC0-1.0 |
| [libbluray](https://www.videolan.org/developers/libbluray.html) | `libbluray` | LGPL-2.1-or-later |
| [libidn2](https://www.gnu.org/software/libidn/#libidn2) | `libidn2` | (GPL-2.0-or-later OR LGPL-3.0-or-later) AND (Unicode-TOU AND Unicode-DFS-2016) AND GPL-3.0-or-later AND LGPL-2.1-or-later AND FSFAP-no-warranty-disclaimer |
| [libogg](https://www.xiph.org/ogg/) | `libogg` | BSD-3-Clause |
| [libplacebo](https://code.videolan.org/videolan/libplacebo) | `libplacebo` | LGPL-2.1-or-later |
| [libpng](https://www.libpng.org/pub/png/libpng.html) | `libpng16` | libpng-2.0 |
| [librist](https://code.videolan.org/rist/) | `librist` | BSD-2-Clause |
| [libsamplerate](https://github.com/libsndfile/libsamplerate) | `libsamplerate` | BSD-2-Clause |
| [libsodium](https://libsodium.org/) | `libsodium` | ISC |
| [libsoxr](https://sourceforge.net/projects/soxr/) | `libsoxr` | LGPL-2.1-or-later |
| [libssh](https://www.libssh.org/) | `libssh` | LGPL-2.1-or-later |
| [libtasn1](https://www.gnu.org/software/libtasn1/) | `libtasn1` | LGPL-2.1-or-later |
| [libtiff](https://libtiff.gitlab.io/libtiff/) | `libtiff` | libtiff |
| [libudfread](https://code.videolan.org/videolan/libudfread) | `libudfread` | LGPL-2.1-or-later |
| [libunibreak](https://github.com/adah1972/libunibreak) | `libunibreak` | Zlib |
| [libunistring](https://www.gnu.org/software/libunistring/) | `libunistring` | GPL-2.0-or-later OR LGPL-3.0-or-later |
| [libvidstab](https://github.com/georgmartius/vid.stab) | `libvidstab` | GPL-2.0-or-later |
| [libvmaf](https://github.com/Netflix/vmaf) | `libvmaf` | BSD-2-Clause-Patent |
| [libvorbis](https://xiph.org/vorbis/) | `libvorbis`, `libvorbisenc` | BSD-3-Clause |
| [libvpx](https://www.webmproject.org/code/) | `libvpx` | BSD-3-Clause |
| [libx11](https://www.x.org/) | `libX11` | MIT |
| [libxau](https://www.x.org/) | `libXau` | MIT |
| [libxcb](https://www.x.org/) | `libxcb` | MIT |
| [libxdmcp](https://www.x.org/) | `libXdmcp` | MIT |
| [little-cms2](https://www.littlecms.com/) | `liblcms2` | MIT |
| [lz4](https://lz4.github.io/lz4/) | `liblz4` | BSD-2-Clause |
| [mbedtls](https://www.trustedfirmware.org/projects/mbed-tls/) | `libmbedcrypto` | Apache-2.0 |
| [mpg123](https://www.mpg123.de/) | `libmpg123` | LGPL-2.1-only |
| [nettle](https://www.lysator.liu.se/~nisse/nettle/) | `libhogweed`, `libnettle` | GPL-2.0-or-later OR LGPL-3.0-or-later |
| [opencore-amr](https://opencore-amr.sourceforge.net/) | `libopencore-amrnb`, `libopencore-amrwb` | Apache-2.0 |
| [openjpeg](https://www.openjpeg.org/) | `libopenjp2` | BSD-2-Clause |
| [openssl@3](https://openssl-library.org) | `libcrypto`, `libssl` | Apache-2.0 |
| [opus](https://www.opus-codec.org/) | `libopus` | BSD-3-Clause |
| [p11-kit](https://p11-glue.github.io/p11-glue/p11-kit.html) | `libp11-kit` | BSD-3-Clause |
| [pcre2](https://www.pcre.org/) | `libpcre2-8` | BSD-3-Clause |
| [rav1e](https://github.com/xiph/rav1e) | `librav1e` | BSD-2-Clause |
| [rubberband](https://breakfastquay.com/rubberband/) | `librubberband` | GPL-2.0-or-later |
| [shaderc](https://github.com/google/shaderc) | `libshaderc_shared` | Apache-2.0 |
| [snappy](https://google.github.io/snappy/) | `libsnappy` | BSD-3-Clause |
| [speex](https://speex.org/) | `libspeex` | BSD-3-Clause |
| [srt](https://www.srtalliance.org/) | `libsrt` | MPL-2.0 |
| [svt-av1](https://gitlab.com/AOMediaCodec/SVT-AV1) | `libSvtAv1Enc` | BSD-3-Clause |
| [tesseract](https://tesseract-ocr.github.io/) | `libtesseract` | Apache-2.0 |
| [theora](https://www.theora.org/) | `libtheoradec`, `libtheoraenc` | BSD-3-Clause |
| [vulkan-loader](https://github.com/KhronosGroup/Vulkan-Loader) | `libvulkan` | Apache-2.0 |
| [webp](https://developers.google.com/speed/webp/) | `libsharpyuv`, `libwebp`, `libwebpmux` | BSD-3-Clause |
| [x264](https://www.videolan.org/developers/x264.html) | `libx264` | GPL-2.0-or-later |
| [x265](https://github.com/Multicorewareinc/x265) | `libx265` | GPL-2.0-or-later |
| [xvid](https://labs.xvid.com/) | `libxvidcore` | GPL-2.0-or-later |
| [xz](https://tukaani.org/xz/) | `liblzma` | 0BSD AND GPL-2.0-or-later |
| [zeromq](https://zeromq.org/) | `libzmq` | MPL-2.0 |
| [zimg](https://github.com/sekrit-twc/zimg) | `libzimg` | WTFPL |
| [zstd](https://facebook.github.io/zstd/) | `libzstd` | (BSD-3-Clause OR GPL-2.0-only) AND BSD-2-Clause AND MIT |

## Libraries bundled in the Linux AppImage

The AppImage includes libmpv, built from source as above, and the shared libraries it needs from the Ubuntu packages on the build machine, including Ubuntu's FFmpeg libraries. Their licenses are recorded in each package's copyright file, and Ubuntu publishes their source at [launchpad.net/ubuntu](https://launchpad.net/ubuntu).

## Libraries bundled in the iOS app

The iOS app gets libmpv, the FFmpeg libraries and the libraries below from release 1.1.0-n9.0.2 of [MPVKit](https://github.com/mpvkit/MPVKit), through its LGPL `MPVKit` product. MPVKit's `MPVKit-GPL` product isn't used. MPVKit builds them all as static libraries, so they're linked into the app's executable. MPVKit's [build scripts](https://github.com/mpvkit/MPVKit/tree/1.1.0-n9.0.2/Sources/BuildScripts) list the source and options for each one.

| Project | MPVKit target | License |
| --- | --- | --- |
| [dav1d](https://code.videolan.org/videolan/dav1d) | `Libdav1d` | BSD-2-Clause |
| [freetype](https://www.freetype.org/) | `Libfreetype` | FTL |
| [fribidi](https://github.com/fribidi/fribidi) | `Libfribidi` | LGPL-2.1-or-later |
| [gmp](https://gmplib.org/) | `gmp` | LGPL-3.0-or-later OR GPL-2.0-or-later |
| [gnutls](https://gnutls.org/) | `gnutls` | LGPL-2.1-or-later |
| [harfbuzz](https://github.com/harfbuzz/harfbuzz) | `Libharfbuzz` | MIT |
| [libass](https://github.com/libass/libass) | `Libass` | ISC |
| [libbluray](https://www.videolan.org/developers/libbluray.html) | `Libbluray` | LGPL-2.1-or-later |
| [libdovi](https://github.com/quietvoid/dovi_tool) | `Libdovi` | MIT |
| [libplacebo](https://code.videolan.org/videolan/libplacebo) | `Libplacebo` | LGPL-2.1-or-later |
| [libunibreak](https://github.com/adah1972/libunibreak) | `Libunibreak` | Zlib |
| [little-cms2](https://www.littlecms.com/) | `lcms2` | MIT |
| [MoltenVK](https://github.com/KhronosGroup/MoltenVK) | `MoltenVK` | Apache-2.0 |
| [nettle](https://www.lysator.liu.se/~nisse/nettle/) | `nettle`, `hogweed` | LGPL-3.0-or-later OR GPL-2.0-or-later |
| [openssl](https://openssl-library.org) | `Libcrypto`, `Libssl` | Apache-2.0 |
| [shaderc](https://github.com/google/shaderc) | `Libshaderc_combined` | Apache-2.0 |
| [uavs3d](https://github.com/uavs3/uavs3d) | `Libuavs3d` | BSD-3-Clause |
| [uchardet](https://www.freedesktop.org/wiki/Software/uchardet/) | `Libuchardet` | MPL-1.1 OR GPL-2.0-or-later OR LGPL-2.1-or-later |

`Libshaderc_combined` also contains [glslang](https://github.com/KhronosGroup/glslang) and [SPIRV-Tools](https://github.com/KhronosGroup/SPIRV-Tools), each under its own license.

## Rust crates and npm packages

Max Video Player is built with [Tauri](https://tauri.app), [React](https://react.dev) and many other Rust crates and npm packages, each under its own license. Most use the MIT, Apache-2.0 or BSD licenses. [Cargo.lock](Cargo.lock) and [apps/desktop/package-lock.json](apps/desktop/package-lock.json) list every one, with the exact version.
