# Architecture

Max Video Player is a [Tauri 2](https://tauri.app) app. The interface is React and
TypeScript in a system webview. Playlist parsing, storage and downloads are Rust, and
video plays through libmpv, drawn into the same window underneath the webview.

## Repository layout

```
MaxVideoPlayer/
├── apps/
│   ├── desktop/
│   │   ├── src/                  React frontend
│   │   │   ├── components/       UI by area: channels, player, playlist, settings, downloads, ui
│   │   │   ├── hooks/            useChannels, useMpv, useDownloads, useUpdateChecker, ...
│   │   │   └── lib/tauri.ts      every invoke() call to the backend
│   │   └── src-tauri/            Tauri app: commands, download manager, bundle config
│   ├── ios/                      iOS design notes and the first proof of concept
│   └── android/                  Android plans (not built yet)
├── crates/
│   ├── core/                     mvp-core: platform-independent logic
│   └── tauri-plugin-mpv/         Tauri plugin that embeds libmpv
├── scripts/                      libmpv build and bundling, ffmpeg, release and signing helpers
└── libs/                         libmpv builds (generated, not in git)
```

## Frontend

- `main.tsx` mounts `App.tsx`, which sets up the routes: `/` (channels, movies,
  series and the other tabs), `/player`, `/playlists` and `/settings`.
- `useChannels` provides all provider and channel state through a React context that
  the whole app reads.
- `useMpv` polls the player state from Rust every second and listens for `mpv://`
  events such as buffering and reconnecting.
- `lib/tauri.ts` is the only file that calls `invoke()`. Player commands use the
  `plugin:mpv|<command>` namespace; everything else uses the bare command name.
- Components are in the shadcn style (`components/ui/`), styled with Tailwind CSS 3.
  Long channel lists use `@tanstack/react-virtual`.

## Backend

### `crates/core` (mvp-core)

Rust with no Tauri or UI dependencies, so mobile apps can reuse it.

| Module | Responsibility |
| --- | --- |
| `iptv/m3u.rs` | M3U and M3U+ parsing, sorting entries into live, movies and series |
| `iptv/xtream.rs` | Xtream Codes API client |
| `iptv/epg.rs` | XMLTV programme guide parsing |
| `iptv/omdb.rs`, `whatson.rs`, `opensubtitles.rs`, `mdblist.rs` | Metadata and subtitle services |
| `ai/gemini.rs` | Optional category sorting with Google Gemini |
| `cache/store.rs` | SQLite storage (bundled `rusqlite`): providers, channels, EPG, watch history, playback positions, downloads and metadata caches |
| `downloads/` | Download model, file paths and ffmpeg invocation |
| `models/` | `Channel`, `Playlist` and related types |

### `apps/desktop/src-tauri`

The app itself. `lib.rs` opens the database in the app data folder and registers the
plugins, and `commands.rs` exposes the core features to the frontend as Tauri commands.
`downloads/` queues downloads and runs the bundled ffmpeg sidecar.

### `crates/tauri-plugin-mpv`

| File | Responsibility |
| --- | --- |
| `engine.rs` | `MpvEngine`, the libmpv instance: load, play, pause, seek, volume. No platform code. |
| `renderer.rs` | The `PlatformRenderer` trait (`attach`, `resize`, `detach`) each platform implements |
| `macos.rs`, `linux.rs`, `ios.rs` | The embedded renderers |
| `mpv.rs` | `MpvState`, the managed state that picks the renderer and falls back to a separate window |
| `reconnect.rs` | Detects stalls and dropped connections and reloads the stream |
| `idle_inhibit.rs` | Keeps the display awake during playback |
| `commands.rs` | The `plugin:mpv|*` commands |

## Video rendering

`MpvState::load()` first tries to draw video inside the app window. If that fails, it
emits `mpv://render-fallback` to the frontend and opens a separate mpv window with
mpv's own controls instead.

### macOS

`MacosGlRenderer` adds an `NSOpenGLView` with an OpenGL 3.2 Core context below the
webview and gives libmpv an OpenGL render context for it. Decoding uses VideoToolbox.

Every AppKit and OpenGL call has to run on the main thread, through
`dispatch::Queue::main().exec_sync()` or `exec_async()`. Raw pointers cross the
dispatch boundary as `usize` to satisfy `Send`.

Homebrew's libmpv only supports Vulkan, so the build uses libmpv compiled from source
with OpenGL enabled (`scripts/build-libmpv.sh`).

### Linux

`LinuxGlRenderer` creates a Wayland subsurface below the webview's surface and an EGL
context on it, and passes the Wayland display to libmpv. All EGL and GL calls run on
the GLib main thread. X11 sessions use the separate-window fallback.

### iOS

`IosMetalRenderer` passes a `CAMetalLayer` to libmpv as its `wid`, and mpv draws
into it with `vo=gpu-next` on Vulkan through MoltenVK. mpv runs its own draw loop, so
there's no render context to drive. The layer belongs to a view that the Swift side of
the plugin (`ios/Sources/MpvPlugin.swift`) keeps under the transparent webview. The
Swift side also runs the audio session and the lock screen controls. libmpv comes
from MPVKit through Swift Package Manager. See [ios.md](ios.md).

## Data flow

```
React component
  → src/lib/tauri.ts (invoke)
    → Tauri command (src-tauri/src/commands.rs or the mpv plugin)
      → mvp-core or MpvState
```

Going the other way, Rust sends Tauri events: `download://progress` for downloads,
and `mpv://first-frame`, `mpv://buffering` and `mpv://render-fallback` from the player.

## Storage

Everything lives in the app data folder (`com.maxvideoplayer.app` under
`~/Library/Application Support` on macOS, `~/.local/share` on Linux):

- `maxvideoplayer.db`: the SQLite database
- `settings.json`: the OMDb, MDBList and OpenSubtitles keys, the download folder and
  the number of downloads that run at once, via the Tauri store plugin
- `gemini.json`: the Gemini key
- `downloads/`: downloaded movies and series

The webview's local storage keeps some per-provider preferences, such as refresh
intervals, and the player preferences in `lib/player-prefs.ts`: `mvp_default_volume`
and `mvp_hwdec`. The volume picked in the player lasts until the app quits, in session
storage (`mvp_volume`).

## Updates

`tauri-plugin-updater` reads
`https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/latest.json` at
launch and every two hours, and `useUpdateChecker` shows a banner when there's a new
version. Updates are verified against the public key in `tauri.conf.json`. Linux
`.deb` and `.rpm` installs download the new package and install it with `pkexec`,
because the Tauri updater only handles AppImages there.
