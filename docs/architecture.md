# Architecture

Max Video Player is a [Tauri 2](https://tauri.app) app. The interface is React and
TypeScript in a system webview. Playlist parsing, storage and downloads are Rust, and
video plays through libmpv, drawn into the same window underneath the webview.

## Repository layout

```
MaxVideoPlayer/
├── apps/
│   └── desktop/
│       ├── src/                  React frontend
│       │   ├── components/       UI by area: channels, player, playlist, settings, downloads, ui
│       │   ├── hooks/            useChannels, useMpv, useDownloads, useUpdateChecker, ...
│       │   └── lib/tauri.ts      every invoke() call to the backend
│       └── src-tauri/            Tauri app: commands, download manager, bundle config
│           └── gen/apple/        Xcode project for iPhone and iPad
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
| `downloads/` | Download model, file paths, ffmpeg invocation, retention, and `recording.rs`, which names recording files and plans when each recording starts, merges, stops or is missed |
| `models/` | `Channel`, `Playlist` and related types |

### `apps/desktop/src-tauri`

The app itself. `lib.rs` opens the database in the app data folder and registers the
plugins, and `commands.rs` exposes the core features to the frontend as Tauri commands.
`downloads/` queues downloads and runs the bundled ffmpeg sidecar.

Recordings of live channels share the downloads table, with the kind `recording`.
Besides `completed` and `failed`, they have three states of their own, `scheduled`,
`recording` and `missed`. Each has its own `channel_id`, and `source_channel_id` names
the live channel. `downloads/recordings.rs` checks when a recording is due to start or
stop, and at least every 30 seconds, and acts on the plan from `mvp-core`. It records
to MPEG-TS with stream copy and stops ffmpeg by writing `q` to its stdin, so the file
is closed cleanly. ffmpeg also gets a length limit a few minutes past the end, so it
stops by itself if the app crashes. Recordings don't use download slots. When one
starts, the running downloads from its provider go back in the queue, and the scheduler
holds them until no recording of that provider runs. When two recordings from one
provider overlap only by their margins, the first stops a few seconds before the second
starts. A recording whose stream fails tries again up to 3 times, after 30 seconds, a
minute and two minutes. Errors keep the provider's address but never the stream's,
which holds the login. At launch, a recording cut off by a quit or crash keeps its file
and is marked finished, and a new recording takes the rest when at least a minute of it
is still ahead. `downloads/keep_awake.rs` keeps the computer awake while ffmpeg
records, with `caffeinate` on macOS and `systemd-inhibit` on Linux. The commands are
`schedule_recording` and `stop_recording`, and both refuse on iOS and Android.

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
context on it. All EGL and GL calls run on the GLib main thread. X11 sessions use the
separate-window fallback.

On Wayland, mpv decodes with `hwdec=auto-copy-safe`, which copies each decoded frame
back to memory before upload. Zero-copy decoding opens a VA-API display through the
compositor, and libva crashes there on some desktops. X11 keeps zero-copy `auto`.

### iOS

`IosMetalRenderer` passes a `CAMetalLayer` to libmpv as its `wid`, and mpv draws
into it with `vo=gpu-next` on Vulkan through MoltenVK. mpv runs its own draw loop, so
there's no render context to drive. The layer belongs to a view that the Swift side of
the plugin (`ios/Sources/MpvPlugin.swift`) keeps under the transparent webview. libmpv
comes from MPVKit through Swift Package Manager. Building and signing are in
[ios.md](ios.md).

`engine.rs`, `reconnect.rs` and the `plugin:mpv|*` commands are the same as on
desktop, so `lib/tauri.ts`, `useMpv` and the React player controls work unchanged.
`ios.rs` handles what only iOS needs:

- The lock screen's skip buttons, through the engine's relative seek.
- The channel logo on the lock screen. `ios.rs` downloads it with `reqwest` and hands
  the bytes to Swift, because App Transport Security blocks plain HTTP requests made
  through URLSession and most IPTV logos are on HTTP servers. `artwork.rs` decides
  when a logo downloads, shows or is dropped, and keeps the last few. It builds on
  every platform, so its tests run on desktop too.
- `vid=no` while the app is in the background, because iOS ends apps that use Metal
  there, and `vid=auto` when it comes back. Both are engine calls that only `ios.rs`
  makes.
- A small change to `video-aspect-override` after each resize. MPVKit's MoltenVK
  context reads the layer's size only when mpv reconfigures its output, and this
  makes it reconfigure.
- An option list without `ytdl` and `osc`. MPVKit builds mpv without Lua, and
  setting either option fails `mpv_initialize`.

The Swift side does the UIKit work. It creates the Metal view and moves it when React
sends new bounds, the device rotates or Split View changes the window. It sets the
audio session to playback so audio continues on the lock screen, fills in Now
Playing, handles the lock screen controls and keeps the screen awake during playback.
Rust calls the `mvp_ios_*` C functions the Swift package exports, and Swift calls
back through three C callbacks that Rust registers at startup. One reports moving to
and from the background, one passes on lock screen commands, and one tells mpv that
the video view changed size so it redraws at the new size.

#### What iOS leaves out

| Feature | Why | How |
| --- | --- | --- |
| Downloads | iOS apps can't start another program, so the ffmpeg sidecar can't run | The commands return an error, and the tab, buttons and settings are hidden |
| Updater and relaunch | The App Store updates the app | Desktop-only plugins, and `useUpdateChecker` skips mobile |
| Support prompt and links | App Store rules require in-app purchase for tips | Hidden on mobile |
| Separate player window | iOS has one window | If the Metal view fails, the player shows an error |

Rust gates these with `#[cfg(desktop)]` and target-specific dependencies.
Permissions for the desktop-only plugins are in `capabilities/desktop.json`,
which applies only on macOS, Linux and Windows. The downloads code starts the
ffmpeg sidecar from Rust, which capabilities don't govern, so no capability lets
the web view run it. The `shell` plugin stays in the iOS build so the downloads
code compiles unchanged, and nothing calls it there. React checks
`isMobilePlatform()` from `lib/platform.ts`.

#### Layouts

An iPhone always gets the phone layout. An iPad picks one by window width, so Split
View, Stage Manager and rotation switch between them:

| Window width | Layout |
| --- | --- |
| 1024 points or more | Desktop, the same as macOS |
| 744 to 1023 points | Tablet, the desktop layout without drag and drop |
| Under 744 points | Phone, with a tab bar, compact channel rows and a back button in the player |

`layoutModeFor` in `lib/platform.ts` picks the layout, and `usePlatform` checks again
on every resize. A device counts as an iPhone when the short side of its screen is
under 744 points.

## Data flow

```
React component
  → src/lib/tauri.ts (invoke)
    → Tauri command (src-tauri/src/commands.rs or the mpv plugin)
      → mvp-core or MpvState
```

Going the other way, Rust sends Tauri events: `download://progress` and
`download://removed` for downloads and recordings, and `mpv://first-frame`,
`mpv://buffering` and `mpv://render-fallback` from the player.

## Storage

Everything lives in the app data folder (`com.maxvideoplayer.app` under
`~/Library/Application Support` on macOS, `~/.local/share` on Linux):

- `maxvideoplayer.db`: the SQLite database
- `settings.json`: the OMDb, MDBList and OpenSubtitles keys, the download folder and
  the number of downloads that run at once, via the Tauri store plugin
- `gemini.json`: the Gemini key
- `downloads/`: downloaded movies and series, with recordings in `downloads/recordings/`

The webview's local storage keeps some per-provider preferences, such as refresh
intervals, and the player preferences in `lib/player-prefs.ts`: `mvp_default_volume`
and `mvp_hwdec`. The recording margins are `mvp_recording_start_early` and
`mvp_recording_end_late`, in minutes, in `lib/recordings.ts`. The volume picked in the
player lasts until the app quits, in session storage (`mvp_volume`).

## Updates

`tauri-plugin-updater` reads
`https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/latest.json` at
launch and every two hours, and `useUpdateChecker` shows a banner when there's a new
version. Updates are verified against the public key in `tauri.conf.json`. Linux
`.deb` and `.rpm` installs download the new package and install it with `pkexec`,
because the Tauri updater only handles AppImages there.
