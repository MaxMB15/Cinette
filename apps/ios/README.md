# Max Video Player for iOS

The iOS and iPadOS app is a Tauri mobile build of the desktop app in
`apps/desktop`, sharing the React frontend and the Rust crates. Every stream
plays through mpv, using the LGPL build of MPVKit, and builds go to TestFlight
and then the App Store. Building it, CI and the TestFlight setup are in
[`docs/ios.md`](../../docs/ios.md). The plan is in [`DESIGN.md`](DESIGN.md).

This folder keeps the design spec and the proof of concept that came before the
port.

## Proof of concept (`poc/`)

`poc/` is a standalone Tauri 2 app (`com.maxvideoplayer.iospoc`, iOS 17+) that
was built to de-risk the two playback paths before the real port:

- **AVPlayer**: `IosVideoBridge.swift`, for HLS/MP4 streams iOS plays natively.
- **libmpv**: `IosMpvBridge.m`, using [MPVKit](https://github.com/mpvkit/MPVKit)
  through Swift Package Manager. mpv renders into a `CAMetalLayer`
  (`vo=gpu-next`, Vulkan via MoltenVK, `hwdec=videotoolbox`) inside a modal
  with native controls.

The React UI in `poc/src/App.tsx` takes a URL and calls the Rust commands
`play_url` / `play_url_mpv` (`poc/src-tauri/src/lib.rs`), which call into the
native bridges.

Status: the app builds and exports a signed `.ipa`. Playback on a physical
device has not been confirmed yet.

### Building

Requirements:

- macOS with Xcode 16+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen)
  (`brew install xcodegen`)
- Rust iOS targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
- Tauri CLI as a cargo subcommand: `cargo install tauri-cli` (the Xcode
  pre-build script runs `cargo tauri ios xcode-script`)

```bash
cd apps/ios/poc
npm install

# Simulator or connected device, with hot reload
npm run tauri ios dev

# Release build / .ipa
npm run tauri ios build
```

You can also open `src-tauri/gen/apple/mvp-ios-poc.xcodeproj` in Xcode. MPVKit is
fetched by SwiftPM on first build.

Signing uses `DEVELOPMENT_TEAM` in `src-tauri/gen/apple/project.yml`. Change it
to your own team ID, then run `xcodegen` in that directory to regenerate the
Xcode project.

### What is not in git

Everything below is build output and is recreated by the commands above:

| Path                                 | Recreated by                       |
| ------------------------------------ | ---------------------------------- |
| `node_modules/`, `dist/`             | `npm install`, `npm run build`     |
| `src-tauri/target/`                  | any cargo / Tauri build            |
| `src-tauri/gen/schemas/`             | any Tauri build                    |
| `src-tauri/gen/apple/Externals/`     | Xcode pre-build (built `libapp.a`) |
| `src-tauri/gen/apple/assets/`        | Tauri CLI (frontend bundle)        |
| `src-tauri/gen/apple/build/`         | `tauri ios build` (archive, .ipa)  |
| `src-tauri/gen/apple/**/xcuserdata/` | Xcode (per-user state)             |
| `libs/`                              | `scripts/build-all-ios.sh`         |

The POC is not part of the root Cargo workspace or npm workspace, so root
`cargo build` / `npm test` ignore it.

### `scripts/*-ios.sh`

These build FFmpeg, libass, libplacebo and libmpv for iOS by hand into `libs/`.
They were the first approach and are **not used by the current build**, which
gets prebuilt libraries from MPVKit. They are kept for reference only.

## Next steps

Milestone 2 of [`DESIGN.md`](DESIGN.md) is done. The app builds from
`apps/desktop` and plays streams in the simulator. Milestone 1 still needs a
physical iPhone and iPad, and milestone 4 needs the TestFlight setup in
[`docs/ios.md`](../../docs/ios.md#testflight-setup).
