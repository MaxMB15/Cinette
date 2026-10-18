# Development

How to build Cinette from source, run it, and test it. For how the code fits
together, see [architecture.md](architecture.md). For cutting a release, see
[releasing.md](releasing.md).

## Prerequisites

- [Rust](https://rustup.rs), the latest stable release
- [Node.js](https://nodejs.org) 24, or 22.22.1 or a later 22.x release
- [pnpm](https://pnpm.io/installation), at the version that `packageManager` in
  `package.json` names. Run `corepack enable pnpm`, and Corepack then runs that
  version. Node 24.12 or later, or 22.22.1 or later on 22.x, comes with a Corepack
  that can start pnpm 12. On an older Node 24, run `npm i -g corepack@latest` first.
  `pmOnFail` in `pnpm-workspace.yaml` turns off pnpm's own version switching, so a
  pnpm 11 or later installed another way runs as its own version and doesn't warn.
  Use Corepack.
- The platform dependencies below

The desktop app builds on macOS (Apple Silicon and Intel) and Linux (x86_64). Windows
isn't supported yet. For the iPhone and iPad app, see [ios.md](ios.md).

### macOS

Homebrew's `mpv` is built for Vulkan only, and the embedded player needs OpenGL, so
libmpv is built from source. On Apple Silicon its libraries come from Homebrew:

```bash
# ffmpeg@7, because mpv 0.40 uses APIs that ffmpeg 8 removed
brew install meson ninja pkg-config ffmpeg@7 libass libplacebo dylibbundler
export PKG_CONFIG_PATH="$(brew --prefix ffmpeg@7)/lib/pkgconfig:$PKG_CONFIG_PATH"

./scripts/build-libmpv.sh macos
```

Homebrew no longer builds bottles for Intel Macs, so on an Intel Mac they come from
[MacPorts](https://www.macports.org/install.php) instead, as in CI. Install MacPorts,
then:

```bash
# ffmpeg7 keeps its files in a folder of its own
sudo port install meson ninja pkgconfig ffmpeg7 libass libplacebo dylibbundler
export PKG_CONFIG_PATH="/opt/local/libexec/ffmpeg7/lib/pkgconfig:$PKG_CONFIG_PATH"

./scripts/build-libmpv.sh macos
```

If you also have Homebrew, put `/opt/local/bin` before `/usr/local/bin` in your
`PATH`, so meson and pkg-config come from MacPorts. The script stops when libmpv
links libraries from both. `bundle-libmpv.sh` keeps one copy of each file name, so
code built against one package manager's library could get the other's.

The script clones mpv into `libs/mpv-src/` and writes `libs/macos/libmpv.dylib`. The
first run takes a few minutes; later runs reuse the clone.

### Linux (Ubuntu and Debian)

```bash
sudo apt-get update
sudo apt-get install -y \
  libmpv-dev libegl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \
  libayatana-appindicator3-dev \
  libssl-dev pkg-config librsvg2-dev \
  patchelf
```

The system `libmpv-dev` is enough for development on Debian 12, Ubuntu 24.04 and
later. Ubuntu 22.04 has mpv 0.34, which the app can't use. To build libmpv from
source instead, as the AppImage does:

```bash
sudo apt-get install meson ninja-build \
  libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libavfilter-dev \
  libass-dev libdrm-dev libluajit-5.1-dev

./scripts/build-libmpv.sh linux
export LD_LIBRARY_PATH="$(pwd)/libs/linux:$LD_LIBRARY_PATH"
```

### The ffmpeg sidecar

Offline downloads run a bundled `ffmpeg` binary, and Tauri won't build the app until
it exists. Fetch it once:

```bash
./scripts/fetch-ffmpeg.sh
```

It downloads ffmpeg to `apps/player/src-tauri/binaries/` as
`max-video-player-ffmpeg-<target>`, where the target is your Rust target triple. The
Linux packages install it in `/usr/bin`, so it has its own name rather than `ffmpeg`.
If your `binaries/` folder still has an older `ffmpeg-<target>`, run the script again.

The script pins one build for each platform by the SHA-256 of its archive.

| Platform | ffmpeg | Built by | License |
| --- | --- | --- | --- |
| macOS, Apple Silicon | 8.1.3 | `scripts/build-ffmpeg.sh` | LGPL version 3 or later |
| macOS, Intel | 8.1.3 | `scripts/build-ffmpeg.sh` | LGPL version 3 or later |
| Linux, x86_64 | 8.1.3 | `scripts/build-ffmpeg.sh` | LGPL version 3 or later |
| Windows, x86_64 | 8.1.3 | [BtbN](https://github.com/BtbN/FFmpeg-Builds) | GPL version 3 or later |

`scripts/build-ffmpeg.sh` builds ffmpeg from its release source with only what the
app's downloads and recordings use. They copy a stream from HLS, MPEG-TS, MP4, MKV
and the other files an Xtream provider serves, such as AVI, FLV and WMV, or from a
radio station, into MP4, MOV, MKV, MPEG-TS, AVI or WebM. The build can also read
RTSP, RTMP and UDP links, but the app can't download them yet. It passes
`-reconnect`, which only HTTP takes, so ffmpeg stops with `Option reconnect not
found`. The app never decodes or encodes with ffmpeg, so the build has a few
decoders, which only read details such as the picture size, and only the ASS and
WebVTT encoders, which decide which subtitle tracks ffmpeg keeps. It can't read
DASH, which would need libxml2.

HTTPS goes through OpenSSL 3. The macOS build has OpenSSL 3.5 built in. The Linux
build uses the system's OpenSSL and zlib, except in the AppImage, which carries
Ubuntu 24.04's OpenSSL 3.0, and the sidecar uses that. The script fails if the build
would be anything but LGPL, would leave out a component it asks for, would link any
other library, or would name the folder it was built in. The macOS build is 7.8 MB,
where Martin Riedl's full build was 66 MB, and the Linux build is 4.1 MB, where
BtbN's was 172 MB.

`.github/workflows/ffmpeg-build.yml` builds macOS on GitHub's macos-15 runner for
Apple Silicon and its macos-15-intel runner for Intel. It builds Linux in Debian 12,
so the Linux build runs on Debian 12, Ubuntu 24.04 and later. It runs on pull
requests to `dev` that change the ffmpeg scripts or the workflow, and by hand.
Each build job runs `scripts/test-ffmpeg-sidecar.py` on its build. The test makes
short test files with a full ffmpeg and serves them on 127.0.0.1
over HTTP, over HTTPS, from a server that only takes TLS 1.3 and from one that
only takes TLS 1.2. It runs the build with the app's download and recording
arguments, checks the exit code and the error text the app looks for, and reads
back what the build wrote. MP4 and MOV files must have their index before the
media, as `-movflags +faststart` asks. The build reads its own files back unless
`--reader` names another ffmpeg. The test never uses a login. It needs a Python
whose `ssl` module has TLS 1.3, which macOS's own `/usr/bin/python3` lacks. Each
build job then uploads an archive of its build, with the archive's SHA-256 and the
build's size in the job summary. When the pre-release already has an archive with
the same name, the job fails unless that archive came from the same source and
options, which the archive's `BUILDINFO.txt` lists. On Linux it must also come
from the same Debian release with the same newest glibc symbol, since those set the
oldest Linux the build runs on.

The workflow's `pinned` jobs fetch the archives that `fetch-ffmpeg.sh` pins, on
macos-15, macos-15-intel and Ubuntu 24.04, and run the same test on them, with
Ubuntu's ffmpeg reading the files back on Linux. They fail when `fetch-ffmpeg.sh`
doesn't name the build that `build-ffmpeg.sh` makes.

The script downloads each archive from this repository's `ffmpeg-sidecar-8.1`
pre-release, and the Windows one from BtbN when that fails. It installs the
archive only when the hash matches. The pre-release also holds the ffmpeg and
OpenSSL release tarballs the builds come from, with their signatures, and
`ffmpeg-29e619e767.tar.gz`, ffmpeg's source at the commit BtbN's Windows build
comes from, which has no signature. Its tag doesn't start with `v`, so it never
starts an app release, and it's never marked as the latest release, which the
updater reads.

On macOS and Linux, when no archive matches, or when no build is pinned for your
machine, such as Linux on ARM, the script builds ffmpeg with `build-ffmpeg.sh` in
its place. In GitHub Actions it says so in a warning. The
build takes a few minutes and needs a C compiler, `make`, `pkg-config`, `curl`,
`tar`, `strip` and `strings`. A Mac also needs `otool` and `perl`. The Command Line
Tools and macOS have all of them except `pkg-config`. Linux also needs `xz`,
`readelf` and the OpenSSL and zlib headers, such as `xz-utils`, `binutils`,
`libssl-dev` and `zlib1g-dev` on Debian. `build-ffmpeg.sh` ignores `CFLAGS`,
`LDFLAGS`, `LIBRARY_PATH`, `PKG_CONFIG_PATH` and the like from your environment,
so on Linux the OpenSSL and zlib packages must be where pkg-config and the compiler
look by default. On an Intel Mac the build leaves out ffmpeg's x86 assembly, which
would need nasm. The release workflow, the Build & Bundle jobs, the mutation tests
and the Changed code checks set `FFMPEG_PINNED_ONLY=1`, which makes the script fail
instead. A release only ships a pinned build, since a Linux build made on the runner
would need the runner's newer glibc. Build & Bundle fails a pull request whose pinned
archive doesn't download or doesn't match its hash, so the release can't find that
out after its tag is pushed.

Each Monday, `.github/workflows/ffmpeg-update-check.yml` compares the pinned versions
with ffmpeg's release tags. It opens an issue called "ffmpeg <version> is out" for the
newest fix release in a series the script pins, such as 8.1.4, and for ffmpeg's newest
release when it's newer than every pin, such as 9.0.2. A release in between gets no
issue, such as 9.0.2 once 9.1 is out. The issue lists each platform's pin and the
newest release in its series. It never opens two issues with the same title, so
closing one skips that release. Nothing watches OpenSSL. For an OpenSSL security
release, raise `FFMPEG_BUILD` and follow the steps below. The macOS build links
OpenSSL in, and the Linux build gets a new archive too, since the two share the
build number.

To move to a new ffmpeg:

1. Download the release tarball and its `.asc` signature from ffmpeg.org, and check
   the signature. Set `FFMPEG_VERSION` and `FFMPEG_SHA256` in `build-ffmpeg.sh`,
   with `FFMPEG_BUILD` back at 1, and `FFMPEG_VERSION` for macOS and Linux in
   `fetch-ffmpeg.sh`. The workflow fails when the two scripts name different
   versions. For a new series, also set `MIRROR` in both scripts. For OpenSSL,
   check its tarball against the keys at openssl-library.org and set
   `OPENSSL_VERSION` and `OPENSSL_SHA256`. When the build changes but ffmpeg
   doesn't, such as for a new OpenSSL, new configure options, a new macOS target
   or a new Debian release for Linux, raise `FFMPEG_BUILD`, which goes in the
   archive's name. The macOS and Linux builds share it, so both get new archives.
2. Open a pull request. The ffmpeg build workflow builds and tests both platforms.
   To try a build yourself, run `./scripts/build-ffmpeg.sh <folder>`, then
   `python3 scripts/test-ffmpeg-sidecar.py media <a full ffmpeg> <media folder>`
   and `python3 scripts/test-ffmpeg-sidecar.py test <folder>/ffmpeg <media folder>`,
   with `--reader <a full ffmpeg>` to read the files back with a full ffmpeg. The
   workflow's `pinned` jobs fail until step 5 pins the new archives, and so does
   Build & Bundle when the ffmpeg version changed.
3. Check that the app's downloads still work with it. Copy the build into
   `binaries/` under the sidecar's name, and run
   `cargo test -p max-video-player --lib downloads`, whose tests run the sidecar.
   The app runs ffmpeg with the arguments from `crates/core/src/downloads/ffmpeg.rs`.
   It reads the `-progress` lines for the download's progress, the exit code, and
   the last line ffmpeg writes to stderr, which it shows as the error. A recording
   also checks every stderr line for known errors, such as `404 Not Found` and
   `Connection refused`, and shows the last one it finds in place of the last line.
   `StreamError::classify` in `crates/core/src/downloads/recording.rs` lists them,
   and they decide whether a recording tries again and which error it shows, so
   check that ffmpeg still writes those words. A stream the app needs that the
   build can't read needs its demuxer, protocol or parser added in
   `build-ffmpeg.sh`, and a case in the test. `cargo test -p mvp-core` fails when
   the build leaves out a muxer that `muxer_for_container` picks.
4. Download the workflow's `ffmpeg-macos-arm64`, `ffmpeg-macos-x86_64` and
   `ffmpeg-linux-x86_64` artifacts and upload the archives to the pre-release for
   the series, where `<series>` is the first two numbers of the version, such as
   8.1. A new series gets a new pre-release, made with
   `gh release create ffmpeg-sidecar-<series> --prerelease --latest=false`, and
   needs the ffmpeg and OpenSSL tarballs and their `.asc` signatures too. A new
   build in the same series goes up with `gh release upload ffmpeg-sidecar-<series>`,
   with whichever tarball and `.asc` changed. Never replace an archive that's
   already there, because older commits pin it.
5. Set each archive's `FILE` and `SHA256` in `fetch-ffmpeg.sh`, and check that the
   Build & Bundle jobs and the `pinned` jobs pass with them. For Windows, download
   BtbN's new build and check it against the `checksums.sha256` of its release.
   Upload it to the pre-release with a `.tar.gz` of ffmpeg's source at the commit
   in the build's name, as `ffmpeg-<commit>.tar.gz`, and set `FFMPEG_VERSION`,
   `FILE`, `UPSTREAM` and `SHA256`. Update the FFmpeg section of
   `THIRD_PARTY_NOTICES.md`.

ffmpeg 9.0 checks TLS certificates by default, and 8.1 doesn't. Martin Riedl's static
macOS 9.0 build finds no certificate store, so every HTTPS download fails, even from a
server with a valid certificate. The macOS build from `build-ffmpeg.sh` looks for
certificates in `/etc/ssl/cert.pem`, where macOS keeps them. The Linux `.deb` and
`.rpm` use the system's OpenSSL, which knows where its certificates are. The
AppImage's OpenSSL, from Ubuntu, looks in `/usr/lib/ssl`, which only Debian, Ubuntu
and the systems built on them have, so on Fedora or Arch it would find none. None of
this has been tried with 9.0. A server with a bad certificate would fail even if the
app passed `-tls_verify 0`, because the HLS demuxer doesn't pass it on to its requests for
variant playlists and segments. mpv doesn't check certificates by default, so such a
stream plays but can't be downloaded. Before the sidecar moves to 9.x, the app needs
to handle that, and someone needs to decide whether downloads should check
certificates. The `ffmpeg-sidecar-9.0.2` pre-release holds Martin Riedl's and BtbN's
9.0.2 builds.

## Running the app

```bash
pnpm install

# macOS: point the binary at the libmpv you built
export DYLD_LIBRARY_PATH="$(pwd)/libs/macos:$DYLD_LIBRARY_PATH"

pnpm dev:desktop
```

This starts Vite and the Tauri app with hot reload for the frontend. Rust changes
rebuild and restart the app.

`pnpm dev:desktop:web` runs only the frontend in a browser. Anything that calls
the Rust backend won't work there, but it's quick for layout work.

`pnpm install` doesn't run dependencies' install scripts. If a new dependency has one,
the install stops until the package is listed under `allowBuilds` in
`pnpm-workspace.yaml`, with `true` to run its script or `false` to skip it.

pnpm only installs versions that have been on the registry for at least three days,
as `minimumReleaseAge` in `pnpm-workspace.yaml` sets. `pnpm add` and `pnpm update`
pick the newest version that's old enough. When none fits the range, they stop with
an error, or in a terminal ask whether to take the newer version anyway. The check
also covers every version already in `pnpm-lock.yaml`, so a lockfile that names a
newer one fails `pnpm install`, in CI as well. A version is let through once it's
listed as `name@version` under `minimumReleaseAgeExclude`, which is what approving
it in the terminal does. Dependabot's security pull requests skip the seven-day
`cooldown` in `.github/dependabot.yml`. When one brings a version under three days
old, its CI install fails. Re-run the job once that version is three days old, or add
each version the error names, as `name@version`, to `minimumReleaseAgeExclude` on
that pull request's branch.

If you installed the packages with npm before the switch to pnpm, delete the
top-level `node_modules` before the first `pnpm install`. pnpm doesn't remove the
packages that npm put there, and they can hide a missing dependency that CI then
catches.

The app lived in `apps/desktop` before it moved to `apps/player`. A checkout from
before the move keeps the files git ignores in `apps/desktop`, such as
`node_modules`, `dist` and the ffmpeg sidecar. Move `apps/desktop/src-tauri/binaries`
to `apps/player/src-tauri/` or run `./scripts/fetch-ffmpeg.sh` again, then delete
`apps/desktop` and run `pnpm install`. `.gitignore` lists the old folder, so git
won't offer to add what's left in it.

## Tests and checks

```bash
pnpm test                 # Rust core tests, then the app's and the website's tests
pnpm test:core            # cargo test -p mvp-core
pnpm test:desktop         # Vitest
pnpm test:site            # Vitest for the website, see Website
pnpm lint                 # ESLint
pnpm format:check         # Prettier
cargo check               # the whole Rust workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm check:changed        # coverage and mutation testing of your changes, see Changed code
```

For a frontend coverage report, run `pnpm --filter ./apps/player test:coverage`
and open `apps/player/coverage/index.html`.

Rust coverage needs [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov) and
LLVM's tools. Install them once:

```bash
rustup component add llvm-tools
cargo install cargo-llvm-cov --locked
```

Then run the tests and open the report:

```bash
cargo llvm-cov --workspace --open
```

The plugin and app tests load libmpv, so set the library path from the setup steps
above first. The app's tests also need the [ffmpeg sidecar](#the-ffmpeg-sidecar)
and a built frontend in `apps/player/dist`, which `pnpm build:desktop` makes.
The Rust figure depends on the platform, because `macos.rs` and `linux.rs` in the
mpv plugin each build only on their own system.

CI publishes the [frontend report](https://MaxMB15.github.io/Cinette/coverage/)
and the [Rust report](https://MaxMB15.github.io/Cinette/coverage/rust/) for
`main` to GitHub Pages. Both come from Linux runs.

CI runs Clippy with warnings as errors on macOS, on Linux and for the iOS simulator,
so each platform's own code is checked. The Linux job also fails when Rust line
coverage drops below 80%. CI uses the latest stable Rust, so a new release can add a
lint that fails code nobody changed. Run `rustup update stable` to see the same lints
locally.

A Husky pre-commit hook runs Prettier and ESLint on the staged files through
lint-staged, then runs the tests.

### Counting renders and backend calls

`pnpm perf`, run from `apps/player`, measures a few flows through the whole app
against a made-up backend in `src/test/perf-backend.ts`: opening the app, scrolling
the channel list, typing a search, opening the Movies tab and a movie's details, and
starting a channel. For each flow it prints, as Markdown tables, the commits, the
renders per component and the backend calls per command. Set `PERF_OUT` to a file
path to save them as JSON too. The flows are in `src/dev/flows.perf.test.tsx`, and
`pnpm test` leaves them out.

They render without StrictMode, as the shipped app does, with real timers and a fixed
clock. The counts are the same from run to run, except that the player flow can gain
one render of the player, which depends on when its timers fire.

A dev build counts the same things in the real app. Run this in the web inspector's
console, then reload:

```js
localStorage.setItem("cinette-perf", "1");
```

Then `cinettePerf.print()` prints the counts since the page loaded or since the last
`cinettePerf.reset()`, and `cinettePerf.report()` returns them. Remove the key to stop.
StrictMode runs each effect twice in a dev build, so some backend calls count twice
there. A production build leaves the counters out.

The render counter reads React's fiber tree the way React DevTools does, through a
`<Profiler>` around the app (`src/dev/render-counts.ts`). A React upgrade could change
what it reads.

### Mutation testing

Coverage shows which lines the tests run, not whether the tests check what those
lines do. [cargo-mutants](https://mutants.rs) looks for that gap in the Rust crates.
It makes one small change at a time, such as returning a default value or turning `<`
into `<=`, and runs the crate's tests against each change. A change that every test
still passes is missed, and points at code that no test checks.

Install cargo-mutants once, at the version CI uses, then test the lines you changed
since your branch left `dev`. A new file only shows up in the diff once git knows about
it, so `git add` it first.

```bash
cargo install cargo-mutants --version 27.1.0 --locked
mkdir -p target
git diff --merge-base origin/dev -- crates apps/player/src-tauri > target/rust.diff
cargo mutants -p mvp-core --in-diff target/rust.diff
```

That tests the changes in `mvp-core`. The diff has every crate's changes, so add
`-p tauri-plugin-mpv` or `-p max-video-player` to test theirs, with the setup below.

The results go to `mutants.out/`, which git ignores. `missed.txt` lists the changes
no test caught, and `diff/` holds each change as a patch. Testing a whole crate takes
hours on one machine, and `--shard 0/4` through `--shard 3/4` split it into four runs.

The plugin, `-p tauri-plugin-mpv`, and the app, `-p max-video-player`, need what their
tests need. That's libmpv on the library path, and for the app the built frontend in
`apps/player/dist` and the ffmpeg sidecar. Git ignores both, so they stay out of the
copy that cargo-mutants builds in. Test the app with `--in-place`, which changes your
own files one at a time and puts each back. A run that's stopped partway can leave a
change behind, so commit your work first.

[`.cargo/mutants.toml`](../.cargo/mutants.toml) leaves out code the tests can't
reach. That's the loopback server the tests use, the functions that call a real web
service, code that Linux doesn't build, such as the plugin's macOS and iOS renderers,
the app's entry point and logging setup, and code that needs a window, a Wayland
display or D-Bus. Each entry says why. To test the macOS renderer on a Mac, leave the
config out and name the file, since the other exclusions go with the config.

```bash
cargo mutants --no-config --gitignore true -f crates/tauri-plugin-mpv/src/macos.rs
```

The [Changed code](#changed-code) workflow tests the lines a pull request changes in
each crate, and fails on a missed change. The Mutation testing workflow tests every
crate on `dev` each Monday, in four shards for `mvp-core` and the plugin and eight for
the app. A missed change doesn't fail that run. Only an error does, such as a build
that breaks. Its report job lists the missed changes by file.

[StrykerJS](https://stryker-mutator.io) does the same for the frontend helpers in
`apps/player/src/lib`. It changes one thing at a time, such as a condition or a
string, and runs only the Vitest tests that reached that code in a first run without
changes. Testing all of `src/lib` takes about 15 minutes on a 10-core Mac. From
`apps/player`, test it all or name the lines you changed:

```bash
pnpm test:mutation
pnpm exec stryker run --mutate "src/lib/format.ts:20-31"
```

`--mutate` takes file names, each with an optional range of lines after a colon. It
replaces the list in `stryker.config.mjs`, so leave out the test files. The reports go
to `apps/player/reports/mutation/`, which git ignores, and `index.html` there shows
each change in its file. `vitest.stryker.config.ts` works around a bug in Stryker's
Vitest runner, and its comment says when it can go.

The [Changed code](#changed-code) workflow runs Stryker on the lines a pull request
changes in any `.ts` or `.tsx` file in `apps/player/src`. The Frontend mutation testing
workflow runs it on all of `src/lib` on `dev` each Monday. Stryker only makes the
changes that lie wholly inside those lines,
so changing one line of a call that runs over three tests only what's on that line. On
a pull request, a change that no test catches fails the job, and an annotation on its
line says what the change was. Add a test that fails on it. A change that does the same
thing as the code can't fail any test. The line before it then gets a comment that
names the mutator and says why:

```ts
// Stryker disable next-line StringLiteral: Date.parse gives NaN for both "" and the text Stryker puts in, so this returns 0 either way.
const ms = Date.parse(value ?? "");
```

The comment turns off every change of that kind that starts on the next line of code,
even one that runs over several lines, so name only the mutators that no test can
catch. Put it alone on its line. In JSX, put it on its own line inside the braces of
the expression it covers:

```tsx
{
	// Stryker disable next-line ConditionalExpression: <why no test can catch it>
	open && <Panel />
}
```

The job fails for any other Stryker comment in a
changed file, since one with no reason, with `all` for the mutators, or one that covers
more than the next line could hide a change that a test should catch. It also fails
when no test loads any of the changed files, unless their changed lines have nothing to
change, like a change to types alone. A comment that turns off a change on a changed
line gets a warning, so check that its reason still holds. The summary lists the
changes that Stryker ignored.

Stryker leaves out the changes that only touch class names. Those are everything in a
`className` attribute, or in one whose name ends in `ClassName` like `labelClassName`,
and in the arguments of `cn()` and `cva()`. They're also the arguments of a variant
function like `buttonVariants`, which is a `const` in the same file set to what `cva()`
returns. The tests run in jsdom, which doesn't load Tailwind's CSS, so a test could only
compare class strings.
[`stryker.class-names.mjs`](../apps/player/stryker.class-names.mjs) does that, and
those changes get no warning. So the job fails for a comment that gives its reason,
"Only changes class names.", as its own.

`--mutate` can't take a file name with a comma, a glob
character, a quote or a backslash, so the job fails for a changed file with such a
name. Rename it. Git counts lines by LF alone, and Stryker also ends a line at a U+2028,
a U+2029 or a CR that no LF follows, so the two number the lines differently in a file
with one of those. The job fails for a changed file with one. Write a U+2028 or a U+2029
as an escape like `\u2028`, and replace each CR that no LF follows with an LF.

A pull request that changes the Stryker or Vitest setup, the files in `src/test`, or the
versions of Vitest, Vite, jsdom, Testing Library or Stryker gets a run of all of
`src/lib`, plus the changed lines in other files. That run still fails only on the
lines the pull request changes, or on `date.ts` when it changes none. A change to the
Changed code workflow, `scripts/changed-code.py` or `scripts/stryker-summary.py` alone
only runs `date.ts`. The Monday run lists the changes that survive and fails only on an
error.

### Changed code

The [Changed code](../.github/workflows/changed-code.yml) workflow checks the lines
that a pull request into `dev` adds or changes. Its last job, also named Changed code,
fails when any other job in it failed or was cancelled, so a branch rule only needs to
require that one. It runs three checks.

- Tests must run at least 80% of the changed lines, counted apart for the frontend and
  for Rust. Only lines that the coverage tool can run count, so a comment, a blank line
  or a type doesn't. A line counts as covered when any code on it runs, so a function
  written on one line counts once its file loads, and only the mutation check shows
  whether a test calls it. Vitest measures the frontend, and cargo-llvm-cov measures
  Rust on Linux. A pull request with no lines to count passes. The job summary has a
  table of each file's uncovered changed lines, and each one gets an annotation. Vitest
  lists every frontend file a test could load, so a changed frontend file missing from
  its report fails the check. A Rust file can be missing, since Linux doesn't build the
  macOS and iOS code, but a Rust report with no data for any file fails.
- Stryker mutates the changed lines of the frontend, and a change that no test catches
  fails the job, as [Mutation testing](#mutation-testing) explains.
- cargo-mutants mutates the changed lines of each crate, and a change that no test
  catches fails the job unless a skip comment covers it. A change that runs past the
  timeout counts as caught, and one that doesn't build doesn't count. The run is split
  into shards of about 100 changes for `mvp-core`, 55 for the plugin and 45 for the app,
  at most eight a crate, so a shard takes about 12 minutes plus its build. A shard
  fails when it writes no results, results with no changes in them, or results the
  check can't read.

The lines that count are in the `.ts` and `.tsx` files in `apps/player/src` and in the
`.rs` files in each crate's `src` folder. Tests don't count. That's `*.test.ts` and
`*.test.tsx` files, `src/test`, `.d.ts` files, modules declared with `#[cfg(test)]` or
`#[cfg(all(test, ...))]`, in their own file or inline, the modules they declare, and
`#[test]` and `#[tokio::test]` functions. A Rust file named `tests.rs` counts like any
other until a module declares it that way, and so does a file a test module names with a
`#[path]` that the check can't follow. Docs, workflows, scripts and anything else outside
those folders don't count either.

[`scripts/changed-code-exclude.toml`](../scripts/changed-code-exclude.toml) leaves out
the code that no test in CI can run, and each entry says why. That's the macOS, iOS
and Linux renderers, mpv's OpenGL render context, the app's entry points and logging
setup, loading a stream into a real window, and the calls that keep the display awake.
An entry names files with globs, and can name only some functions in a Rust file. A
frontend file listed there is also left out of the Stryker check. The cargo-mutants
check reads `.cargo/mutants.toml` instead. Keep the list short, and add only code that
CI can't run. The plan job warns about an entry that matches nothing. It also warns,
and lists it in its summary, when a pull request adds or widens an entry so that it
leaves out files or functions that the base commit's copy counts.

An entry's functions match any function with that name, or a name the glob matches,
anywhere in its files, so a new function with the same name, or one a glob catches,
drops out too. The plan job warns about the changed lines that a function entry leaves
out, naming the function and the entry. When other changed Rust lines count, the Rust
coverage summary lists them too. When none do, the Rust coverage job doesn't run, and
the plan job's warning is the only place they show.

The plan job also warns when a pull request adds, removes or changes a setting in
`.cargo/mutants.toml`. Settings like `exclude_re` and `examine_re` decide which
changes cargo-mutants makes, and ones like `timeout_multiplier` can turn a missed
change into a timeout, which counts as caught. An entry taken out of `exclude_re` or
`exclude_globs` gets no warning, since cargo-mutants then makes more changes, and
nor does a change to comments or spacing. It warns the same way about a
`#[mutants::skip]` that a pull request adds to a crate's code, or about a changed line
in one, even when the attribute is split across lines or broken up by a comment.
Either can hide a missed change in this pull request and every later one.

A missed Rust change that does the same thing as the code can't fail any test. A
comment then names the change's genre and says why, alone on the line before the
change's line:

```rust
// mutants: skip BinaryOperator: <why no test can catch it>
```

The genres are `FnValue`, `BinaryOperator`, `UnaryOperator`, `MatchArm`,
`MatchArmGuard` and `StructField`, and the error for a missed change names its genre
and the line to put the comment on. One comment can name several genres, separated by
commas. An `FnValue` change replaces a whole function body, so its comment goes on any
line from the one before the function's doc comment and attributes to the one before
`fn`. cargo-mutants still runs a change that a comment covers, and the check prints a
warning for it, so a reviewer can check that the reason still holds. Code that no test
can reach at all, such as a call to a real web service, belongs in
`.cargo/mutants.toml`.

Run the same checks on your own machine from the repo root:

```bash
pnpm check:changed                     # coverage and mutation testing
pnpm check:changed --no-mutation       # coverage only
pnpm check:changed --base origin/main  # compare with where the branch left main
```

It compares the working tree, untracked files included, with the commit where the
branch left `origin/dev`, so fetch first. The scripts need Python 3.11 or later as
`python3`. The one macOS ships in `/usr/bin` is 3.9, so use one from Homebrew or
python.org. Each part needs its tools. Rust coverage needs cargo-llvm-cov and the
llvm-tools component from [Tests and checks](#tests-and-checks), and Rust mutation
testing needs cargo-mutants when the change adds lines to a `.rs` file. The plugin and
the app need libmpv, which the script finds in `libs/<os>` or in `MPV_LIB_DIR`. A
worktree without `libs/` can point `MPV_LIB_DIR` at the main checkout's. The app also
needs the ffmpeg sidecar, and the script builds the frontend when `apps/player/dist` is
missing. cargo-mutants runs in a copy of the repo that leaves out what git ignores, so
the app's mutants only run with `--in-place`, which changes your own files one at a
time. That only runs in a linked worktree with every `.rs` change committed. A mutant
can make the app's tests write `movies`, `recordings` and `series` folders into
`apps/player/src-tauri`, and the script deletes the ones that weren't there before it
started.

## Production build

```bash
cd apps/player && pnpm tauri build
```

On macOS, `scripts/bundle-libmpv.sh` runs as Tauri's `beforeBundleCommand`. It copies
libmpv and its Homebrew or MacPorts dependencies into the app with `dylibbundler`,
removes duplicate `LC_RPATH` entries, and fails if any bundled library needs a newer
macOS than `minimumSystemVersion`. A local build uses your Mac's Homebrew or MacPorts
libraries, so it may only run on your macOS version; release builds run on macOS 15
runners.

In CI, `scripts/smoke-test-macos-app.sh` checks the built app on the runner. Every
binary in it must have code for the runner's CPU and must not link a library from
Homebrew, MacPorts or `/usr/local`. Then it starts the app for 20 seconds and fails
if the app quits. It also fails if, at the end, the app has libmpv loaded from
outside the app or has any file from those folders mapped into memory, such as a
library, a plugin or a cache. Run it on your own build with
`./scripts/smoke-test-macos-app.sh target/release/bundle/macos/Cinette.app`. It
starts the app, which opens your own playlists. Quit Cinette first. The
app runs one copy at a time, so the test's copy would hand over to yours and quit.

On Linux, `scripts/bundle-libmpv-linux.sh` copies `libmpv.so` and its dependencies
into the AppImage. The `.deb` and `.rpm` declare libmpv as a package dependency
instead. The app links against `libmpv.so.2`, which the `libmpv2` package has on
Debian 12, Ubuntu 24.04 and later, and `mpv-libs` has on Fedora. Ubuntu 22.04 only
has `libmpv1`, with mpv 0.34's `libmpv.so.1`, so the `.deb` doesn't install there.

The `.deb` and `.rpm` also require WebKitGTK 2.40 or later, the first version that
supports all the CSS in the app's styles. Tailwind 4's breakpoints like `sm:` use
range media queries such as `(width >= 40rem)`, which WebKitGTK 2.38 ignores, and
2.40 is also the first to turn on `@property` and the `lh` unit. Tauri copies each `rpm.depends`
entry into the package as a bare name, so the `.rpm` gives the version inside an
RPM boolean dependency, `(webkit2gtk4.1 >= 2.40)`.

The AppImage bundles libmpv, WebKitGTK and most of the libraries they use from the
machine that built it, which is Ubuntu 24.04 for releases. It leaves out glibc and
`libstdc++`, which come from the user's system. The bundled libraries need glibc
2.38 and the `libstdc++` of GCC 13.2 (`GLIBCXX_3.4.32`), so the AppImage doesn't
start on Ubuntu 22.04 or Debian 12.

The output lands in `target/release/bundle/`. To sign the macOS build with a
Developer ID, see [macos-signing.md](macos-signing.md).

## Website

The [website](https://maxmb15.github.io/Cinette/) lives in `site/`. It's one
page with the README's content and a link to each file of the latest release with
its size. Vite and Tailwind build it, as they do the app, from plain TypeScript
without React.

```bash
pnpm dev:site                            # the page with hot reload
pnpm build:site                          # checks the types, then builds site/dist
SITE_RELEASE_FIXTURE=1 pnpm build:site   # the same with a made-up release, offline
pnpm --filter ./site preview             # serves site/dist
pnpm test:site                           # Vitest
pnpm test:site:mutation                  # StrykerJS on site/src/lib
```

`tsc -b` checks `src` with `tsconfig.app.json`, and the Vite and Vitest configs with
`tsconfig.node.json`. The release plugin is in the Vite config.

The build asks GitHub's releases API for the latest release. `site/src/lib/release.ts`
reads its version, date, files, sizes and SHA-256 checksums, and `render.ts` puts
them into `index.html`. A file the release doesn't have is left out, so the page
never links a missing file. Each link names the release's tag, as in
`releases/download/v0.7.0/<name>`, so it fetches the file whose size and checksum
the page shows, even when a later deploy fails and the page stays on an older
release. When the request fails to connect, gets no answer within 30 seconds or
gets a 5xx from GitHub, the build waits and tries again, three tries in all.
After that, or after any other error answer, the build fails rather than make a
page without sizes. `pnpm dev:site` shows the error and asks GitHub again on the
next page load.
`SITE_RELEASE_FIXTURE=1` builds with the made-up release in
`site/fixtures/release.json` instead, as the tests and pull request builds do. A
`GITHUB_TOKEN` in the environment raises the API's rate limit.

Open the built page through a web server, since a browser won't load its
stylesheet on a `file://` page. The page uses the app icon from
`apps/player/src-tauri/icons/` and the screenshots in `docs/images/`. The build
copies them into `site/dist/assets`. An `<img>` file under 4 KiB goes into the page
as a data URI instead, as the icons in the header and the hero do. The favicon is
always copied. "App icon" in [the iOS guide](ios.md#app-icon) explains how the
icons are made.

The [Website](../.github/workflows/site.yml) workflow tests and builds the site on
pull requests. Pushes to `main` that change it, releases and manual runs from `main`
build it with the latest release and copy `site/dist` onto the `gh-pages` branch,
which GitHub Pages serves. A release builds the site on `main` rather than the one
in its tag, so publishing never brings back an older page. A pre-release starts
nothing until it's changed to a full release. The copy keeps the coverage reports
and every other file already there. The built files have no hash in their names, so
each deploy replaces the last one's. A file the site stops using stays on the branch
until someone deletes it. CI doesn't run Stryker on the site, so run
`pnpm test:site:mutation` after changing `site/src/lib`.

## Code style

- TypeScript and React use arrow functions everywhere, never `function`
  declarations. `export default function` is the one exception.
- Prettier formats `apps/**` and `site/**`; run `pnpm format`.
- All `invoke()` calls to the Rust backend live in `apps/player/src/lib/tauri.ts`.
- On macOS, AppKit and OpenGL calls must run on the main thread. See
  [architecture.md](architecture.md#macos).

## Branches and pull requests

- Branch from `dev` and open pull requests against `dev`. `main` only receives `dev`
  when a release is cut.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
  `feat:`, `fix(linux):`, `ci:`, `docs:` and so on.
- CI builds macOS and Linux on pull requests that touch platform code, and runs the
  tests on every pull request. It also checks that the tests cover and catch changes to
  the lines a pull request changes. See [Changed code](#changed-code).

## Continuous integration

| Workflow | Runs on | What it does |
| --- | --- | --- |
| [Build & Bundle](../.github/workflows/build.yml) | Pushes and pull requests to `main`, `dev` and `release-*`; manual runs | Lint, Clippy, formatting, tests, coverage, and macOS and Linux builds uploaded as artifacts. Rust line coverage below 80% fails the Linux job. The plugin's tests also run against the system libmpv of Debian 12 and Ubuntu 24.04, which the .deb uses. Pull requests build only the platforms their changes affect. The `ci-status` job fails when any other job failed or was cancelled. A manual run builds a signed macOS app. |
| [Changed code](../.github/workflows/changed-code.yml) | Pull requests to `dev` | Checks the lines a pull request changes. Tests must run at least 80% of them, for the frontend and for Rust each, and every change that Stryker and cargo-mutants make to them must fail a test, unless a comment with a reason skips it. The last job, Changed code, fails when any other job failed or was cancelled. See [Changed code](#changed-code). |
| [Mutation testing](../.github/workflows/mutants.yml) | Mondays, manual runs | Runs cargo-mutants on `mvp-core`, the mpv plugin and the app. A manual run tests one crate or all three, split into shards, and adds up each crate's results. Every Monday, the schedule starts one for all three on `dev`. A missed change is reported and fails nothing. Only an error, such as a build that breaks, fails a run. |
| [Frontend mutation testing](../.github/workflows/mutants-frontend.yml) | Mondays, manual runs | Runs StrykerJS on all of the frontend helpers in `src/lib`. Every Monday, the schedule starts a run on `dev`. It reports the changes that survive and fails only on an error. |
| [Website](../.github/workflows/site.yml) | Pull requests to `main` and `dev` and pushes to `main` that change the site, full releases, manual runs | Tests and builds the website. Pull requests use a made-up release. Pushes to `main`, releases and manual runs from `main` build `main`'s site with the latest release and publish it to GitHub Pages. A pre-release starts it only once it's changed to a full release. See [Website](#website). |
| [iOS](../.github/workflows/ios.yml) | Pushes and pull requests to `main` and `dev` that touch the app | A debug build for the iOS simulator, and Clippy for the iOS target |
| [iOS TestFlight](../.github/workflows/ios-testflight.yml) | Manual | Builds the iOS app for devices and uploads it to TestFlight. See [ios.md](ios.md). |
| [Release](../.github/workflows/release.yml) | Tags `v*` | Builds and uploads the release. See [releasing.md](releasing.md). |
| [Release — one-click pipeline](../.github/workflows/release-pipeline.yml) | Manual | Merges `dev` into `main`, bumps the version and pushes the tag. |
| [Release — bump version (PR)](../.github/workflows/release-bump.yml), [Release — push tag](../.github/workflows/release-tag.yml) | Manual | The same release in two steps, for when `main` requires pull requests. |

The workflows pin each action to a commit, with its version in a comment. Dependabot
opens pull requests against `dev` each week for npm packages, crates and actions,
once a release is a week old. Minor and patch updates come grouped by ecosystem, and
each major update comes alone. Tauri is the exception. Its npm packages and its crates
each come in one pull request, majors included, and the Tauri CLI won't build while
the two differ by a minor version. Combine the two into one pull request before
merging. Dependabot reads [`dependabot.yml`](../.github/dependabot.yml) from `main`,
so a change to it takes effect after the next release.
