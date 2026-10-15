# Development

How to build Max Video Player from source, run it, and test it. For how the code fits
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

The desktop app builds on macOS (Apple Silicon) and Linux (x86_64). Windows isn't
supported yet. For the iPhone and iPad app, see [ios.md](ios.md).

### macOS

Homebrew's `mpv` is built for Vulkan only, and the embedded player needs OpenGL, so
libmpv is built from source:

```bash
# ffmpeg@7, because mpv 0.40 uses APIs that ffmpeg 8 removed
brew install meson ninja pkg-config ffmpeg@7 libass libplacebo dylibbundler
export PKG_CONFIG_PATH="$(brew --prefix ffmpeg@7)/lib/pkgconfig:$PKG_CONFIG_PATH"

./scripts/build-libmpv.sh macos
```

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

It downloads a static ffmpeg to `apps/player/src-tauri/binaries/` as
`max-video-player-ffmpeg-<target>`, where the target is your Rust target triple. The
Linux packages install it in `/usr/bin`, so it has its own name rather than `ffmpeg`.
If your `binaries/` folder still has an older `ffmpeg-<target>`, run the script again.

The script pins one build for each platform by the SHA-256 of its archive.

| Platform | ffmpeg | Built by |
| --- | --- | --- |
| macOS, Apple Silicon | 8.1.2 | [Martin Riedl](https://ffmpeg.martin-riedl.de) |
| Linux, x86_64 | 8.1.3 | [BtbN](https://github.com/BtbN/FFmpeg-Builds) |
| Windows, x86_64 | 8.1.3 | [BtbN](https://github.com/BtbN/FFmpeg-Builds) |

It downloads each archive from this repository's `ffmpeg-sidecar-8.1` pre-release
first and from the builder second. It installs the archive only when the hash
matches, and fails otherwise. The pre-release keeps a copy because BtbN deletes most
of its builds after a few weeks. It also holds the ffmpeg source the builds come from.
Its tag doesn't start with `v`, so it never starts an app release, and it's never
marked as the latest release, which the updater reads.

Each Monday, `.github/workflows/ffmpeg-update-check.yml` compares the pinned versions
with ffmpeg's release tags. It opens an issue called "ffmpeg <version> is out" for the
newest fix release in a series the script pins, such as 8.1.4, and for ffmpeg's newest
release when it's newer than every pin, such as 9.0.2. A release in between gets no
issue, such as 9.0.2 once 9.1 is out. The issue lists each platform's pin and the
newest release in its series. It never opens two issues with the same title, so
closing one skips that release.

To move to a new ffmpeg:

1. Download each platform's new build into an empty folder of its own, and check it
   against the builder's checksums. Martin Riedl puts a `.sha256` file next to each
   download, and each BtbN release has a `checksums.sha256`. Martin Riedl only builds
   the newest series, so macOS can trail the other platforms by a patch release.
2. Check that the app's downloads still work with it. The app runs ffmpeg with the
   arguments from `crates/core/src/downloads/ffmpeg.rs`. It reads the `-progress`
   lines for the download's progress, the exit code, and the last line ffmpeg writes
   to stderr, which it shows as the error. A recording also checks every stderr line
   for known errors, such as `404 Not Found` and `Connection refused`, and shows the
   last one it finds in place of the last line. `StreamError::classify` in
   `crates/core/src/downloads/recording.rs` lists them, and they decide whether a
   recording tries again and which error it shows, so check that ffmpeg still writes
   those words. Copy an HLS stream and an MP4 file to MP4, MKV and MPEG-TS, record a
   few seconds of a live stream, and try an HTTPS stream. Check that the progress moves
   and that a failed download shows a useful error.
3. Upload the archives under the names the script's `FILE` lines give them, with the
   ffmpeg source they come from. For a release, that's the tarball and its `.asc`
   signature from ffmpeg.org. For a build of a release branch, add a snapshot of that
   commit too. A new series gets a new pre-release, made with
   `gh release create ffmpeg-sidecar-<series> --prerelease --latest=false`. A new
   build in the same series goes up with `gh release upload ffmpeg-sidecar-<series>`.
4. Update `FFMPEG_VERSION`, `FILE`, `UPSTREAM` and `SHA256` for each platform in the
   script, and `MIRROR` for a new series. Update the FFmpeg section of
   `THIRD_PARTY_NOTICES.md`, then open a pull request.

ffmpeg 9.0 checks TLS certificates by default, and 8.1 doesn't. The static macOS 9.0
build finds no certificate store, so every HTTPS download fails, even from a server
with a valid certificate. Setting `SSL_CERT_FILE` for the sidecar fixes that. A server
with a bad certificate still fails, because the HLS demuxer doesn't pass `-tls_verify 0`
on to its requests for variant playlists and segments. mpv doesn't check certificates
by default, so such a stream plays but can't be downloaded. Before the sidecar moves to
9.x, the app needs to handle that, and someone needs to decide whether downloads should
check certificates. The `ffmpeg-sidecar-9.0.2` pre-release holds 9.0.2 builds for that
move.

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
pnpm test                 # Rust core tests, then frontend tests
pnpm test:core            # cargo test -p mvp-core
pnpm test:desktop         # Vitest
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

CI publishes the [frontend report](https://MaxMB15.github.io/MaxVideoPlayer/coverage/)
and the [Rust report](https://MaxMB15.github.io/MaxVideoPlayer/coverage/rust/) for
`main` to GitHub Pages. Both come from Linux runs.

CI runs Clippy with warnings as errors on macOS, on Linux and for the iOS simulator,
so each platform's own code is checked. The Linux job also fails when Rust line
coverage drops below 80%. CI uses the latest stable Rust, so a new release can add a
lint that fails code nobody changed. Run `rustup update stable` to see the same lints
locally.

A Husky pre-commit hook runs Prettier and ESLint on the staged files through
lint-staged, then runs the tests.

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

Stryker leaves out the changes that only touch class names, which are everything in a
`className` attribute and in the arguments of `cn()` and `cva()`. The tests run in
jsdom, which doesn't load Tailwind's CSS, so a test could only compare class strings.
[`stryker.class-names.mjs`](../apps/player/stryker.class-names.mjs) does that, and
those changes get no warning.

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
  table of each file's uncovered changed lines, and each one gets an annotation.
- Stryker mutates the changed lines of the frontend, and a change that no test catches
  fails the job, as [Mutation testing](#mutation-testing) explains.
- cargo-mutants mutates the changed lines of each crate, and a change that no test
  catches fails the job unless a skip comment covers it. A change that runs past the
  timeout counts as caught, and one that doesn't build doesn't count. The run is split
  into shards of about 100 changes for `mvp-core`, 55 for the plugin and 45 for the app,
  at most eight a crate, so a shard takes about 12 minutes plus its build.

The lines that count are in the `.ts` and `.tsx` files in `apps/player/src` and in the
`.rs` files in each crate's `src` folder. Tests don't count. That's `*.test.ts` and
`*.test.tsx` files, `src/test`, `.d.ts` files, `tests.rs`, `*_tests.rs`, files in a
`tests` folder, `#[cfg(test)]` modules and `#[test]` functions. Docs, workflows,
scripts and anything else outside those folders don't count either.

[`scripts/changed-code-exclude.toml`](../scripts/changed-code-exclude.toml) leaves out
the code that no test in CI can run, and each entry says why. That's the macOS, iOS
and Linux renderers, mpv's OpenGL render context, the app's entry points and logging
setup, loading a stream into a real window, and the calls that keep the display awake.
An entry names files with globs, and can name only some functions in a Rust file. A
frontend file listed there is also left out of the Stryker check. The cargo-mutants
check reads `.cargo/mutants.toml` instead. Keep the list short, and add only code that
CI can't run. The plan job warns about an entry that matches nothing.

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
branch left `origin/dev`, so fetch first. Each part needs its tools. Rust coverage needs
cargo-llvm-cov and the llvm-tools component from [Tests and checks](#tests-and-checks),
and Rust mutation testing needs cargo-mutants. The plugin and the app need libmpv,
which the script finds in `libs/<os>` or in `MPV_LIB_DIR`. A worktree without `libs/`
can point `MPV_LIB_DIR` at the main checkout's. The app also needs the ffmpeg sidecar,
and the script builds the frontend when `apps/player/dist` is missing. cargo-mutants
runs in a copy of the repo that leaves out what git ignores, so the app's mutants only
run with `--in-place`, which changes your own files one at a time. That only runs in a
linked worktree with every `.rs` change committed.

## Production build

```bash
cd apps/player && pnpm tauri build
```

On macOS, `scripts/bundle-libmpv.sh` runs as Tauri's `beforeBundleCommand`. It copies
libmpv and its Homebrew dependencies into the app with `dylibbundler`, removes
duplicate `LC_RPATH` entries, and fails if any bundled library needs a newer macOS
than `minimumSystemVersion`. A local build uses your Mac's Homebrew libraries, so it
may only run on your macOS version; release builds run on a macOS 15 runner.

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

## Code style

- TypeScript and React use arrow functions everywhere, never `function`
  declarations. `export default function` is the one exception.
- Prettier formats `apps/**`; run `pnpm format`.
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
