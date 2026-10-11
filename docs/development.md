# Development

How to build Max Video Player from source, run it, and test it. For how the code fits
together, see [architecture.md](architecture.md). For cutting a release, see
[releasing.md](releasing.md).

## Prerequisites

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 20 or later
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

The system `libmpv-dev` is enough for development. To build libmpv from source
instead, as the AppImage does:

```bash
sudo apt-get install meson ninja-build \
  libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libavfilter-dev \
  libass-dev libdrm-dev

./scripts/build-libmpv.sh linux
export LD_LIBRARY_PATH="$(pwd)/libs/linux:$LD_LIBRARY_PATH"
```

### The ffmpeg sidecar

Offline downloads run a bundled `ffmpeg` binary, and Tauri won't build the app until
it exists. Fetch it once:

```bash
./scripts/fetch-ffmpeg.sh
```

It downloads a static ffmpeg to `apps/desktop/src-tauri/binaries/`, named for your
Rust target.

## Running the app

```bash
npm install

# macOS: point the binary at the libmpv you built
export DYLD_LIBRARY_PATH="$(pwd)/libs/macos:$DYLD_LIBRARY_PATH"

npm run dev:desktop
```

This starts Vite and the Tauri app with hot reload for the frontend. Rust changes
rebuild and restart the app.

`npm run dev:desktop:web` runs only the frontend in a browser. Anything that calls
the Rust backend won't work there, but it's quick for layout work.

## Tests and checks

```bash
npm test                  # Rust core tests, then frontend tests
npm run test:core         # cargo test -p mvp-core
npm run test:desktop      # Vitest
npm run lint              # ESLint
npm run format:check      # Prettier
cargo check               # the whole Rust workspace
```

For a coverage report, run `npm run test:coverage --workspace=apps/desktop` and open
`apps/desktop/coverage/index.html`. CI publishes the report for `main` to
[GitHub Pages](https://MaxMB15.github.io/MaxVideoPlayer/coverage/).

A Husky pre-commit hook formats, lints and tests before each commit.

## Production build

```bash
cd apps/desktop && npx tauri build
```

On macOS, `scripts/bundle-libmpv.sh` runs as Tauri's `beforeBundleCommand`. It copies
libmpv and its Homebrew dependencies into the app with `dylibbundler`, removes
duplicate `LC_RPATH` entries, and fails if any bundled library needs a newer macOS
than `minimumSystemVersion`. A local build uses your Mac's Homebrew libraries, so it
may only run on your macOS version; release builds run on a macOS 15 runner.

On Linux, `scripts/bundle-libmpv-linux.sh` copies `libmpv.so` and its dependencies
into the AppImage. The `.deb` and `.rpm` declare libmpv as a package dependency
instead.

The output lands in `target/release/bundle/`. To sign the macOS build with a
Developer ID, see [macos-signing.md](macos-signing.md).

## Code style

- TypeScript and React use arrow functions everywhere, never `function`
  declarations. `export default function` is the one exception.
- Prettier formats `apps/**`; run `npm run format`.
- All `invoke()` calls to the Rust backend live in `apps/desktop/src/lib/tauri.ts`.
- On macOS, AppKit and OpenGL calls must run on the main thread. See
  [architecture.md](architecture.md#macos).

## Branches and pull requests

- Branch from `dev` and open pull requests against `dev`. `main` only receives `dev`
  when a release is cut.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
  `feat:`, `fix(linux):`, `ci:`, `docs:` and so on.
- CI builds macOS and Linux on pull requests that touch platform code, and runs the
  tests on every pull request.

## Continuous integration

| Workflow | Runs on | What it does |
| --- | --- | --- |
| [Build & Bundle](../.github/workflows/build.yml) | Pushes and pull requests to `main`, `dev` and `release-*`; manual runs | Tests, coverage, and macOS and Linux builds uploaded as artifacts. A manual run builds a signed macOS app. |
| [iOS](../.github/workflows/ios.yml) | Pushes to `feature/ios-poc`, and pull requests to `dev` and `feature/ios-poc` that touch the app | A debug build for the iOS simulator |
| [iOS TestFlight](../.github/workflows/ios-testflight.yml) | Manual | Builds the iOS app for devices and uploads it to TestFlight. See [ios.md](ios.md). |
| [Release](../.github/workflows/release.yml) | Tags `v*` | Builds and uploads the release. See [releasing.md](releasing.md). |
| [Release — one-click pipeline](../.github/workflows/release-pipeline.yml) | Manual | Merges `dev` into `main`, bumps the version and pushes the tag. |
| [Release — bump version (PR)](../.github/workflows/release-bump.yml), [Release — push tag](../.github/workflows/release-tag.yml) | Manual | The same release in two steps, for when `main` requires pull requests. |
