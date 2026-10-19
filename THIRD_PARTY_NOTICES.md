# Third-party notices

Cinette is built on other people's open source software. Each component below keeps its own license, and Cinette's license doesn't change it. Cinette's own license is in [LICENSE](LICENSE) and [NOTICE](NOTICE). The [LICENSES](LICENSES) folder has the texts of the GNU Lesser General Public License version 3, which adds to the GNU General Public License version 3 in LICENSE, and the Apache License 2.0. The apps include all of these files.

## Getting the source code

- **Cinette.** Every release has a tag in this repository. Settings > About in the app links to the source for the version you're running.
- **mpv.** The macOS and Linux apps' libmpv is built from the [mpv v0.40.0 tag](https://github.com/mpv-player/mpv/tree/v0.40.0) by [scripts/build-libmpv.sh](scripts/build-libmpv.sh). The iOS app's libmpv comes from MPVKit, described [below](#libraries-bundled-in-the-ios-app). The Android app's libmpv is built from the mpv v0.41.0 tag, as described [below](#libraries-bundled-in-the-android-app).
- **FFmpeg.** The `ffmpeg` program in the macOS and Linux apps is built from the FFmpeg 8.1.3 release source by [scripts/build-ffmpeg.sh](scripts/build-ffmpeg.sh). The [ffmpeg-sidecar-8.1](https://github.com/MaxMB15/Cinette/releases/tag/ffmpeg-sidecar-8.1) pre-release has that source, the OpenSSL source the macOS build links in, and the FFmpeg source of the Windows build. Other FFmpeg source releases are at [ffmpeg.org/download.html](https://ffmpeg.org/download.html).
- **Other libraries.** Each project in the tables below links to its home page, where its source is published. In the Apple Silicon Mac app they come from [Homebrew](https://github.com/Homebrew/homebrew-core), whose formulas record the exact source archive and build options. In the Intel Mac app they come from [MacPorts](https://github.com/macports/macports-ports), whose Portfiles record the same. On iOS they come from MPVKit, whose build scripts record the same.

If you received a copy of Cinette and can't find the source for one of its components, [open an issue](https://github.com/MaxMB15/Cinette/issues) and it will be provided.

## mpv

Cinette plays video with libmpv from [mpv](https://mpv.io), licensed under the GNU General Public License version 2 or later. Some of its files are under the GNU Lesser General Public License version 2.1 or later. The macOS app and the Linux AppImage include libmpv. The Linux `.deb` and `.rpm` packages use the libmpv package from your distribution instead. The iOS app includes a build of libmpv without mpv's GPL parts, which is licensed under the GNU Lesser General Public License version 2.1 or later. The Android app includes libmpv 0.41.0 with its GPL parts, licensed under the GNU General Public License version 2 or later.

## FFmpeg

Cinette includes [FFmpeg](https://ffmpeg.org) in two forms. FFmpeg is a trademark of Fabrice Bellard.

- **FFmpeg 7.1 libraries** (`libavcodec`, `libavfilter`, `libavformat`, `libavutil`, `libpostproc`, `libswresample`, `libswscale`), used by libmpv. The Apple Silicon Mac app includes them as built by Homebrew's `ffmpeg@7` formula, with `--enable-gpl` and `--enable-version3`. That build is licensed under the GNU General Public License version 3 or later. The Intel Mac app includes FFmpeg 7.1.5 as built by MacPorts' `ffmpeg7` port with its default `gpl2` variant, which uses `--enable-gpl` without `--enable-version3`. That build is licensed under the GNU General Public License version 2 or later.
- **FFmpeg 9.0.2 libraries** (`libavcodec`, `libavdevice`, `libavfilter`, `libavformat`, `libavutil`, `libswresample`, `libswscale`), used by libmpv in the iOS app. They're built with `--enable-version3` and without `--enable-gpl`, so they're licensed under the GNU Lesser General Public License version 3 or later.
- **FFmpeg 8.1.3 libraries** (`libavcodec`, `libavfilter`, `libavformat`, `libavutil`, `libswresample`, `libswscale`), used by libmpv in the Android app. They're built from FFmpeg's release source with `--enable-gpl` and `--enable-version3`, so they're licensed under the GNU General Public License version 3 or later.
- **The `ffmpeg` program**, which the desktop app runs to download movies and episodes. The iOS app doesn't include it. On macOS and Linux it is FFmpeg 8.1.3, built by [scripts/build-ffmpeg.sh](scripts/build-ffmpeg.sh) from FFmpeg's release source with only the parts downloads use. That build is licensed under the GNU Lesser General Public License version 3 or later. The macOS builds include [OpenSSL](https://openssl-library.org) 3.5.9, licensed under Apache-2.0, for HTTPS. On Linux, the `.deb` and `.rpm` packages use your system's OpenSSL 3 and zlib libraries for it, and the AppImage uses your system's zlib and the OpenSSL 3 from Ubuntu that the AppImage includes. Each build's archive has a `BUILDINFO.txt` with the options it was built with. On Windows, [scripts/fetch-ffmpeg.sh](scripts/fetch-ffmpeg.sh) pins a static build of FFmpeg 8.1.3 by [BtbN](https://github.com/BtbN/FFmpeg-Builds), from the `release/8.1` branch at commit `29e619e767`. It is licensed under the GNU General Public License version 3 or later, and includes other libraries linked into the program, such as x264 and x265. It uses Windows' own Schannel for HTTPS. BtbN's [FFmpeg-Builds at commit `6c9aec5fc9`](https://github.com/BtbN/FFmpeg-Builds/tree/6c9aec5fc9a72ec3abedd1fa84db141fa18cf52b) lists each library and where its source came from. The builds, and the FFmpeg and OpenSSL source code they come from, are on the [ffmpeg-sidecar-8.1](https://github.com/MaxMB15/Cinette/releases/tag/ffmpeg-sidecar-8.1) pre-release.

## Libraries bundled in the macOS app

The macOS app includes these shared libraries in `Contents/Frameworks`, alongside libmpv and the FFmpeg libraries above. The Apple Silicon and Intel apps get them from different package managers, so the Mac column says which app has each one. The licenses are as declared by Homebrew, written as [SPDX identifiers](https://spdx.org/licenses/).

| Project | Files | Mac | License |
| --- | --- | --- | --- |
| [aom](https://aomedia.googlesource.com/aom) | `libaom` | Both | BSD-2-Clause |
| [aribb24](https://code.videolan.org/jeeb/aribb24) | `libaribb24` | Apple Silicon | LGPL-3.0-only |
| [brotli](https://github.com/google/brotli) | `libbrotlicommon`, `libbrotlidec`, `libbrotlienc` | Both | MIT |
| [bzip2](https://sourceware.org/bzip2/) | `libbz2` | Intel | bzip2-1.0.6 |
| [cairo](https://cairographics.org/) | `libcairo`, `libcairo-gobject` | Intel | LGPL-2.1-only OR MPL-1.1 |
| [cjson](https://github.com/DaveGamble/cJSON) | `libcjson` | Apple Silicon | MIT |
| [dav1d](https://code.videolan.org/videolan/dav1d) | `libdav1d` | Both | BSD-2-Clause |
| [expat](https://libexpat.github.io/) | `libexpat` | Intel | MIT |
| [fontconfig](https://wiki.freedesktop.org/www/Software/fontconfig/) | `libfontconfig` | Both | HPND-sell-variant AND Unicode-3.0 AND MIT-Modern-Variant AND MIT AND LicenseRef-Homebrew-public-domain |
| [freetype](https://www.freetype.org/) | `libfreetype` | Both | FTL |
| [fribidi](https://github.com/fribidi/fribidi) | `libfribidi` | Both | GPL-2.0-or-later AND LGPL-2.1-or-later |
| [gdk-pixbuf](https://gtk.org) | `libgdk_pixbuf-2` | Intel | LGPL-2.1-or-later |
| [gettext](https://www.gnu.org/software/gettext/) | `libintl` | Both | GPL-3.0-or-later AND LGPL-2.1-or-later |
| [giflib](https://giflib.sourceforge.net/) | `libgif` | Apple Silicon | MIT |
| [glib](https://docs.gtk.org/glib/) | `libglib-2`, and on Intel `libgio-2`, `libgmodule-2`, `libgobject-2` | Both | LGPL-2.1-or-later |
| [gmp](https://gmplib.org/) | `libgmp` | Both | LGPL-3.0-or-later OR GPL-2.0-or-later |
| [gnutls](https://gnutls.org/) | `libgnutls` | Both | LGPL-2.1-or-later AND GPL-3.0-only |
| [graphite2](https://graphite.sil.org/) | `libgraphite2` | Both | MIT OR MPL-2.0 OR LGPL-2.1-or-later OR GPL-2.0-or-later |
| [harfbuzz](https://github.com/harfbuzz/harfbuzz) | `libharfbuzz` | Both | MIT |
| [highway](https://github.com/google/highway) | `libhwy` | Apple Silicon | Apache-2.0 OR BSD-3-Clause |
| [icu4c](https://icu.unicode.org/home) | `libicudata`, `libicuuc` | Intel | Unicode-3.0 |
| [jpeg-turbo](https://www.libjpeg-turbo.org/) | `libjpeg` | Both | IJG AND Zlib AND BSD-3-Clause |
| [jpeg-xl](https://jpeg.org/jpegxl/index.html) | `libjxl`, `libjxl_cms`, `libjxl_threads` | Apple Silicon | BSD-3-Clause |
| [lame](https://lame.sourceforge.io/) | `libmp3lame` | Both | LGPL-2.0-or-later |
| [leptonica](http://www.leptonica.org/) | `libleptonica` | Apple Silicon | BSD-2-Clause |
| [libarchive](https://www.libarchive.org) | `libarchive` | Apple Silicon | BSD-2-Clause |
| [libass](https://github.com/libass/libass) | `libass` | Both | ISC |
| [libb2](https://blake2.net/) | `libb2` | Apple Silicon | CC0-1.0 |
| [libbluray](https://www.videolan.org/developers/libbluray.html) | `libbluray` | Both | LGPL-2.1-or-later |
| [libffi](https://sourceware.org/libffi/) | `libffi` | Intel | MIT |
| [libiconv](https://www.gnu.org/software/libiconv/) | `libiconv` | Intel | GPL-3.0-or-later AND LGPL-2.0-or-later |
| [libidn2](https://www.gnu.org/software/libidn/#libidn2) | `libidn2` | Both | (GPL-2.0-or-later OR LGPL-3.0-or-later) AND (Unicode-TOU AND Unicode-DFS-2016) AND GPL-3.0-or-later AND LGPL-2.1-or-later AND FSFAP-no-warranty-disclaimer |
| [libmodplug](https://modplug-xmms.sourceforge.net/) | `libmodplug` | Intel | LicenseRef-Homebrew-public-domain |
| [libogg](https://www.xiph.org/ogg/) | `libogg` | Both | BSD-3-Clause |
| [libplacebo](https://code.videolan.org/videolan/libplacebo) | `libplacebo` | Both | LGPL-2.1-or-later |
| [libpng](https://www.libpng.org/pub/png/libpng.html) | `libpng16` | Both | libpng-2.0 |
| [librist](https://code.videolan.org/rist/) | `librist` | Apple Silicon | BSD-2-Clause |
| [librsvg](https://wiki.gnome.org/Projects/LibRsvg) | `librsvg-2` | Intel | LGPL-2.1-or-later |
| [libsamplerate](https://github.com/libsndfile/libsamplerate) | `libsamplerate` | Apple Silicon | BSD-2-Clause |
| [libsodium](https://libsodium.org/) | `libsodium` | Apple Silicon | ISC |
| [libsoxr](https://sourceforge.net/projects/soxr/) | `libsoxr` | Both | LGPL-2.1-or-later |
| [libssh](https://www.libssh.org/) | `libssh` | Apple Silicon | LGPL-2.1-or-later |
| [libtasn1](https://www.gnu.org/software/libtasn1/) | `libtasn1` | Both | LGPL-2.1-or-later |
| [libtiff](https://libtiff.gitlab.io/libtiff/) | `libtiff` | Apple Silicon | libtiff |
| [libudfread](https://code.videolan.org/videolan/libudfread) | `libudfread` | Apple Silicon | LGPL-2.1-or-later |
| [libunibreak](https://github.com/adah1972/libunibreak) | `libunibreak` | Apple Silicon | Zlib |
| [libunistring](https://www.gnu.org/software/libunistring/) | `libunistring` | Both | GPL-2.0-or-later OR LGPL-3.0-or-later |
| [libvidstab](https://github.com/georgmartius/vid.stab) | `libvidstab` | Both | GPL-2.0-or-later |
| [libvmaf](https://github.com/Netflix/vmaf) | `libvmaf` | Both | BSD-2-Clause-Patent |
| [libvorbis](https://xiph.org/vorbis/) | `libvorbis`, `libvorbisenc` | Both | BSD-3-Clause |
| [libvpx](https://www.webmproject.org/code/) | `libvpx` | Both | BSD-3-Clause |
| [libx11](https://www.x.org/) | `libX11`, and on Intel `libX11-xcb` | Both | MIT |
| [libxau](https://www.x.org/) | `libXau` | Both | MIT |
| [libxcb](https://www.x.org/) | `libxcb`, and on Intel `libxcb-render` | Both | MIT |
| [libxdmcp](https://www.x.org/) | `libXdmcp` | Both | MIT |
| [libxml2](http://xmlsoft.org/) | `libxml2` | Intel | MIT |
| [little-cms2](https://www.littlecms.com/) | `liblcms2` | Both | MIT |
| [lz4](https://lz4.github.io/lz4/) | `liblz4` | Apple Silicon | BSD-2-Clause |
| [mbedtls](https://www.trustedfirmware.org/projects/mbed-tls/) | `libmbedcrypto` | Apple Silicon | Apache-2.0 |
| [mpg123](https://www.mpg123.de/) | `libmpg123` | Both | LGPL-2.1-only |
| [nettle](https://www.lysator.liu.se/~nisse/nettle/) | `libhogweed`, `libnettle` | Both | GPL-2.0-or-later OR LGPL-3.0-or-later |
| [opencore-amr](https://opencore-amr.sourceforge.net/) | `libopencore-amrnb`, `libopencore-amrwb` | Apple Silicon | Apache-2.0 |
| [openjpeg](https://www.openjpeg.org/) | `libopenjp2` | Both | BSD-2-Clause |
| [openssl@3](https://openssl-library.org) | `libcrypto`, `libssl` | Apple Silicon | Apache-2.0 |
| [opus](https://www.opus-codec.org/) | `libopus` | Both | BSD-3-Clause |
| [p11-kit](https://p11-glue.github.io/p11-glue/p11-kit.html) | `libp11-kit` | Both | BSD-3-Clause |
| [pango](https://www.gtk.org/docs/architecture/pango) | `libpango-1`, `libpangocairo-1`, `libpangoft2-1` | Intel | LGPL-2.0-or-later |
| [pcre2](https://www.pcre.org/) | `libpcre2-8` | Both | BSD-3-Clause |
| [pixman](https://cairographics.org/) | `libpixman-1` | Intel | MIT |
| [rav1e](https://github.com/xiph/rav1e) | `librav1e` | Apple Silicon | BSD-2-Clause |
| [rubberband](https://breakfastquay.com/rubberband/) | `librubberband` | Apple Silicon | GPL-2.0-or-later |
| [shaderc](https://github.com/google/shaderc) | `libshaderc_shared` | Apple Silicon | Apache-2.0 |
| [snappy](https://google.github.io/snappy/) | `libsnappy` | Apple Silicon | BSD-3-Clause |
| [speex](https://speex.org/) | `libspeex` | Both | BSD-3-Clause |
| [srt](https://www.srtalliance.org/) | `libsrt` | Apple Silicon | MPL-2.0 |
| [svt-av1](https://gitlab.com/AOMediaCodec/SVT-AV1) | `libSvtAv1Enc` | Both | BSD-3-Clause |
| [tesseract](https://tesseract-ocr.github.io/) | `libtesseract` | Apple Silicon | Apache-2.0 |
| [theora](https://www.theora.org/) | `libtheoradec`, `libtheoraenc` | Both | BSD-3-Clause |
| [vulkan-loader](https://github.com/KhronosGroup/Vulkan-Loader) | `libvulkan` | Apple Silicon | Apache-2.0 |
| [webp](https://developers.google.com/speed/webp/) | `libsharpyuv`, `libwebp`, `libwebpmux` | Both | BSD-3-Clause |
| [x264](https://www.videolan.org/developers/x264.html) | `libx264` | Both | GPL-2.0-or-later |
| [x265](https://github.com/Multicorewareinc/x265) | `libx265` | Both | GPL-2.0-or-later |
| [xvid](https://labs.xvid.com/) | `libxvidcore` | Both | GPL-2.0-or-later |
| [xz](https://tukaani.org/xz/) | `liblzma` | Both | 0BSD AND GPL-2.0-or-later |
| [zeromq](https://zeromq.org/) | `libzmq` | Apple Silicon | MPL-2.0 |
| [zimg](https://github.com/sekrit-twc/zimg) | `libzimg` | Both | WTFPL |
| [zlib](https://zlib.net/) | `libz` | Intel | Zlib |
| [zstd](https://facebook.github.io/zstd/) | `libzstd` | Both | (BSD-3-Clause OR GPL-2.0-only) AND BSD-2-Clause AND MIT |
| [zvbi](https://github.com/zapping-vbi/zvbi) | `libzvbi` | Intel | GPL-2.0-or-later |

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

## Libraries bundled in the Android app

[scripts/build-libmpv.sh android](scripts/lib/libmpv-android.sh) builds libmpv, the FFmpeg libraries and the libraries below from their release sources, pinned by version and SHA-256, and libplacebo from its git tag. FFmpeg and libmpv are shared libraries in the APK, and the others are linked into libmpv. The script lists every option they're built with.

| Project | Version | License |
| --- | --- | --- |
| [freetype](https://www.freetype.org/) | 2.14.1 | FTL |
| [fribidi](https://github.com/fribidi/fribidi) | 1.0.17 | LGPL-2.1-or-later |
| [harfbuzz](https://github.com/harfbuzz/harfbuzz) | 14.6.0 | MIT |
| [libass](https://github.com/libass/libass) | 0.17.5 | ISC |
| [libplacebo](https://code.videolan.org/videolan/libplacebo) | 7.360.1 | LGPL-2.1-or-later |
| [mbedtls](https://www.trustedfirmware.org/projects/mbed-tls/) | 3.6.7 | Apache-2.0 |
| [LLVM libc++](https://libcxx.llvm.org/), from the Android NDK | r30 | Apache-2.0 WITH LLVM-exception |

The Android app also includes Android libraries from Google, such as AndroidX and Material Components, which are licensed under Apache-2.0, and the Kotlin half of [rustls-platform-verifier](https://github.com/rustls/rustls-platform-verifier), licensed under Apache-2.0 or MIT.

## Skip times

The times the player offers to skip come from two online databases.

- Contains information from [SkipDB](https://skipdb.tv), which is made available here under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- Intro data provided by [IntroDB](https://introdb.app).

## Rust crates and npm packages

Cinette is built with [Tauri](https://tauri.app), [React](https://react.dev) and many other Rust crates and npm packages, each under its own license. Most use the MIT, Apache-2.0 or BSD licenses. [Cargo.lock](Cargo.lock) and [pnpm-lock.yaml](pnpm-lock.yaml) list every one, with the exact version.
