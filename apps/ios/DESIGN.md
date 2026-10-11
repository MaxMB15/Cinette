# iOS and iPadOS design spec

**First written:** 2026-04-18
**Revised:** 2026-10-11
**Status:** pending approval
**Platforms:** iOS and iPadOS 17 or later, on iPhone and iPad

## Summary

The iOS app is the desktop app built for one more target. It shares the React
frontend, `mvp-core` and the Rust side of `tauri-plugin-mpv`. Every stream plays
through mpv, using the LGPL build of [MPVKit](https://github.com/mpvkit/MPVKit).
Builds go to TestFlight first and the App Store after that.

The work is split into six milestones, listed in section 4.

## What changed since the first draft

The April draft played HLS and MP4 with AVPlayer and everything else with mpv,
and planned a separate App Store build with mpv removed. It assumed mpv couldn't
go on the App Store. It can. MPVKit's default product builds mpv with
`-Dgpl=false` and FFmpeg without `--enable-gpl`, so the whole player is LGPL.
The App Store accepts LGPL code. VLC is the best known case, back on the store
since 2013 after libVLC moved to the LGPL.

That changes most of the plan:

- mpv is the only engine. AVPlayer can't play `.ts` live streams, which is the
  Xtream default, or `.mkv` episodes, and mpv plays both.
- There's one build. The App Store build, the remux bridge and the "use the
  sideload build" message are gone.
- mpv draws straight into a Metal layer. The OpenGL ES and software render
  routes from the first draft are dropped. The POC already uses the Metal path.
- AVPlayer comes back later, only for picture in picture and AirPlay. See
  "Later: AVPlayer" in section 1.
- No sideloading and no `.ipa` on GitHub releases. The paid Apple developer
  account used for macOS signing also covers TestFlight.
- The plugin keeps the name `tauri-plugin-mpv` until AVPlayer arrives.

## Decisions

| Decision     | Choice                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| App          | A Tauri 2 iOS target in `apps/desktop`, not a separate app               |
| Player       | mpv only, from MPVKit's LGPL `MPVKit` product                            |
| Who runs mpv | Rust, through `libmpv2` in `tauri-plugin-mpv`, same as desktop           |
| Native code  | A small Swift part of `tauri-plugin-mpv` for UIKit and the audio session |
| PiP, AirPlay | Later, through AVPlayer on HLS streams                                   |
| Devices      | iPhone and iPad, iOS 17.5 or later                                       |
| Layouts      | Phone, tablet portrait and desktop, picked by width                      |
| Distribution | TestFlight, then the App Store. No `.ipa` on GitHub                      |
| Price        | Not decided. Must be settled before milestone 5                          |

## Progress

As of 2026-10-10 the app builds for the iOS simulator and plays streams there.
That covers most of milestone 2 and part of milestones 3 and 4:

- The iOS target lives in `apps/desktop`, with `gen/apple` checked in.
- Rust drives mpv through the Metal path in section 1. The Swift package runs
  the view, the audio session, Now Playing and the lock screen controls.
- Everything in section 2 is off on iOS.
- Layouts are picked by width as in section 3. On the phone, live channels use
  compact rows and the player has fewer controls. The tablet layout is still
  the desktop sidebar.
- CI builds for the simulator on pull requests. A manual workflow builds for
  the App Store and uploads to TestFlight, but it hasn't run yet.
- The app needs iOS 17.5, has a privacy manifest, and declares that it only
  uses exempt encryption. `THIRD_PARTY_NOTICES.md` lists MPVKit's libraries.

Still open:

- Playback on a physical iPhone and iPad, the rest of milestone 1. Milestone 2
  went ahead in `apps/desktop` instead of `poc/`, because the simulator showed
  that the Rust-driven path works.
- Background audio, Now Playing and the lock screen controls are written but
  untested.
- The phone tab bar from section 3 waits until the phone layout has been used
  on a device. The phone still shows the desktop's Channels, Player, Playlists
  and Settings items.
- Sheets on the tablet and phone, the first TestFlight upload, and milestone 5.

## 1. Playback

### How video reaches the screen

A UIView backed by a `CAMetalLayer` sits under the web view, and the web view is
transparent where the video shows. That's the same idea as the `NSOpenGLView`
under the WKWebView on macOS.

Rust passes the layer pointer to mpv as `wid` before `mpv_initialize`, with these
options:

```
vo=gpu-next
gpu-api=vulkan
gpu-context=moltenvk
hwdec=videotoolbox
```

mpv renders into the layer on its own thread. There's no render context and no
`CADisplayLink`, so iOS doesn't use `renderer.rs` the way macOS and Linux do.
The POC in `poc/` uses exactly this setup.

The view is created on the first load and reused for every stream after that.
Stopping only hides it.

MPVKit builds mpv without Lua, so the `ytdl` and `osc` options don't exist on
iOS. Setting either one fails `mpv_initialize` with
`MPV_ERROR_OPTION_NOT_FOUND`, so the iOS option list leaves both out.

### What Rust does

`src/ios.rs` in `tauri-plugin-mpv` asks Swift for the view and passes its layer
to mpv. Everything else is shared with desktop:

- `engine.rs` for load, play, pause, seek, volume and tracks. iOS adds a
  relative seek for the lock screen's skip buttons, and a way to turn video
  output off in the background.
- `reconnect.rs` for stalls and dropped connections.
- The `plugin:mpv|*` commands, so `src/lib/tauri.ts` and `useMpv` work unchanged
  and the React player controls draw over the video.

### What Swift does

A Swift package in `crates/tauri-plugin-mpv/ios/`, registered as the plugin's
iOS side, does the work that has to happen in UIKit:

- Creates the Metal view and hands its layer to Rust.
- Moves and resizes the view when `set_bounds` and `set_visible` arrive, and when
  the device rotates or the app enters Split View.
- Keeps the layer's drawable size in step with the view. MoltenVK sets it to
  1x1 when it tears a swapchain down, and mpv sizes the next swapchain from it,
  so the layer ignores sizes that small.
- Sets the `AVAudioSession` category to playback, so audio keeps going on the
  lock screen. `Info.plist` gets `UIBackgroundModes: audio`.
- Fills `MPNowPlayingInfoCenter` and handles the play, pause and seek remote
  commands.
- Turns off the idle timer during playback. `idle_inhibit.rs` only covers macOS
  and Linux.
- Sets `vid=no` when the app goes to the background and `vid=auto` when it
  returns. iOS kills apps that use Metal in the background.

Rust and Swift talk through plain C functions. Rust calls the `mvp_ios_*`
functions the package exports. Swift calls back through two C callbacks that
Rust registers at startup, one for the app moving to and from the background
and one for lock screen commands.

MPVKit comes in through Swift Package Manager in the Xcode project's
`project.yml`, pinned to exactly 1.1.0-n9.0.2. The final Xcode link resolves the
`mpv_*` symbols that `libmpv2` calls.

The POC's Objective-C bridge and its native control bar don't carry over. The
React controls replace them.

### Later: AVPlayer

AVPlayer is the only way to get picture in picture and AirPlay video on iOS,
and it only plays HLS and MP4. When that work starts:

- Rename the plugin to `tauri-plugin-player` and put both engines behind a
  `PlayerEngine` trait.
- Use AVPlayer only when the stream is HLS. Many Xtream providers list `m3u8` in
  `allowed_output_formats`, so live channels can switch from `.ts` to HLS.
- Keep mpv for everything else. Picture in picture won't work on `.ts`, and the
  UI should say so.

## 2. What's off on iOS

| Feature                | Why                                                      | How                                                                 |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Downloads              | iOS can't run the ffmpeg sidecar                         | Hidden until milestone 6, and the download commands return an error |
| Updater                | The App Store updates the app                            | Desktop-only plugin, `useUpdateChecker` skips iOS                   |
| Support popup and card | Apple requires in-app purchase for tips to the developer | Hidden on iOS                                                       |
| Separate player window | iOS has one window                                       | No fallback. If the Metal view fails, show an error                 |
| `process` plugin       | Only used to relaunch after an update                    | Desktop-only dependency                                             |
| ffmpeg sidecar         | iOS apps can't run other programs                        | No sidecar lookup on mobile, and its permission is desktop only     |

The `shell` plugin stays in the iOS build so the downloads code compiles
unchanged. Nothing calls it on iOS.

Rust uses `#[cfg(desktop)]` and target-specific dependencies in `Cargo.toml`.
Permissions for the desktop-only plugins and the sidecar live in
`capabilities/desktop.json`, which only applies on macOS, Linux and Windows.
React checks `isMobilePlatform()` from `src/lib/platform.ts`.

### Later: downloads

Downloads come back in an update after the first App Store release, which is
milestone 6. They keep the desktop's queue, records and Downloads tab. Only the
part that runs ffmpeg changes.

**Getting the file.** On iOS, `start_process` in `downloads/manager.rs` uses one
of two ways instead of the ffmpeg sidecar:

- Plain files, which covers most Xtream movies and episodes. Rust streams the
  file to the `.part` path with `reqwest`, and resumes with a range request
  after a dropped connection or a pause.
- HLS and `.ts` streams. A C function, `mvp_remux`, copies the stream into a
  file with the FFmpeg libraries already inside MPVKit, so the app doesn't
  grow. In about 150 lines it does what `ffmpeg -c copy` does on desktop. It
  opens the URL with the same reconnect options, adds each input stream to the
  output, copies packets to the end and closes the file. It picks the muxer
  with `muxer_for_container` and sets `+faststart` for MP4 and MOV.

A background URLSession download would keep going after the app closes, but
App Transport Security blocks plain HTTP in URLSession, and many providers only
serve HTTP. `reqwest` and FFmpeg open their own sockets, the same as mpv, so ATS
can stay strict.

`mvp_remux` lives in the app target in `gen/apple`, next to MPVKit. It includes
MPVKit's FFmpeg headers and links in the same Xcode step that resolves libmpv's
symbols. Rust calls it on a worker thread. It reports progress through a
callback, using the time of the last packet over the stream's length, and stops
when its interrupt callback sees the cancel flag.

MPVKit `1.1.0-n9.0.2` has the mp4, mov, matroska, webm and mpegts muxers and
the http, https, tls and hls protocols. It has no avi muxer, so on iOS
`muxer_for_container` maps avi to matroska.

**In the background on iOS 26 and later.** Tapping Download submits a
`BGContinuedProcessingTaskRequest`. iOS then keeps the work going after the
user leaves the app and shows its progress in a Live Activity.

- One task covers the whole queue. Its identifier is
  `com.maxvideoplayer.app.downloads.` plus a queue ID, and `Info.ios.plist`
  lists `com.maxvideoplayer.app.downloads.*` under
  `BGTaskSchedulerPermittedIdentifiers`. iOS doesn't accept a handler for the
  wildcard, so the app registers one for the exact identifier just before it
  submits the request.
- The request uses the `.fail` strategy. With the default, iOS can queue the
  task and start it later. With `.fail` the app knows at once, and keeps the
  work in the foreground with the note below.
- The title names the current item and the subtitle says how many are left,
  such as "2 of 5". `updateTitle(_:subtitle:)` changes them as the queue moves.
- Rust sends progress to Swift, which updates the task's `progress`. iOS ends a
  task that looks stalled, so it has to keep moving.
- The task needs only the default resources, which are background CPU and
  network. It doesn't ask for the GPU.
- The request has to come from the app in the foreground, so only a tap on
  Download submits it.
- When the task expires, because the user stopped it from the Live Activity or
  iOS ended it, the downloads pause. A plain file keeps its `.part` and
  resumes. A stream copy starts over. The queue picks up again the next time
  the app opens.

**Before iOS 26.** Nothing keeps this kind of work running in the background.
Downloads run while the app is open, and pause when it goes to the background
after a short `beginBackgroundTask` to close the files cleanly. The Downloads
tab and the download button say "Keep Max Video Player open until your
downloads finish."

**Storage.** Downloads stay private to the app. They go in
`Library/Application Support/Downloads` in the app's container, not in
`Documents`, and the app doesn't set `UIFileSharingEnabled` or
`LSSupportsOpeningDocumentsInPlace`. So they don't show up in the Files app or
in Finder's file sharing. The folder has `isExcludedFromBackup` set, which
covers every file in it, because downloads are large and can be fetched again,
and Apple asks apps to keep that kind of file out of iCloud backups. The download folder setting stays hidden on
iOS. A download plays offline through mpv and uses the same resume points as
the stream. Deleting the app deletes its downloads.

### Later: recordings and retention

Desktop doesn't have these yet either. Its downloads cover movies and episodes
only, and keep each file until the user deletes it. The shared parts go in
`mvp-core`, and desktop gets both features first. iOS then adds only the parts
that differ, in milestone 6.

**Fixes to make first.** Two gaps in today's download code already affect
desktop, and recordings would make both worse.

- Nothing recovers at launch. A record left `downloading` when the app quit
  stays that way, and the queue counts it as running for good, so it holds one
  of the download slots until the user deletes it. At launch the app should put
  those records back in the queue, or keep what a recording got and mark it
  finished.
- A file with no record stays on disk. At launch the app should delete files in
  the downloads folder that no record points to. This matters more on iOS,
  where the Files app can't see the folder, so the space would never come back.

**One record per recording.** The download code keeps one record per channel.
Queuing a download deletes the channel's finished and failed records,
`prune_redundant_downloads` keeps one row per channel at launch, and
`resolve_local_download` plays a channel's finished download in place of the
stream. If a recording used the live channel's ID, the second recording would
delete the first, and tapping the channel would play an old recording instead
of live TV. So each recording uses its own ID as its channel ID, and a new
`source_channel_id` field points at the live channel. The file name has the
channel name and the start time, such as `City News 2026-10-12 20.00.ts`, so
recordings of one channel don't overwrite each other. The Downloads tab gets a
Recordings section next to movies and series.

**Recording a live channel.** A recording is a download of a live channel
between a start and an end time, with a new `DownloadKind::Recording`. It uses
the same queue, records and Downloads tab, and the same stream copy, with these
differences:

- It always writes MPEG-TS. A `.ts` file that stops halfway still plays, so a
  recording that gets cut off keeps what it recorded.
- The app stops it by the clock. ffmpeg's `-t` counts media time, so a gap
  while the stream reconnects would push the end later. On desktop the app
  sends `q` to ffmpeg's standard input at the end time, which closes the file
  cleanly. On iOS `mvp_remux` stops when its interrupt callback sees that the
  end time has passed.
- A recording that fails or is stopped early keeps its file. Downloads delete
  the partial file today, both when ffmpeg fails and when the user stops one.
- It skips the HEAD request that downloads use for the file size, since a live
  stream has none. Progress is the time recorded over the length.

There are three ways to start one:

- Record now, from the player or the channel's info pane. It records until the
  current program ends, going by the guide, or for an hour when the channel has
  no guide. The user can stop it sooner.
- Record a program, from a program later in the guide. The guide gives the
  start and end, and the app adds a margin, 2 minutes before and 5 after, since
  channels rarely run on time. The margins are settings.
- Record a time range, for channels without a guide. The user picks the start
  and the length.

Recording every episode of a show is left for later.

**Scheduling.** A scheduled recording is a record with a start time and the
status `scheduled`. The statuses also gain `recording` and `missed`. A timer in
Rust checks the clock every 30 seconds and when the computer wakes, and starts
any recording that's due. One long sleep until the start time would run late,
because Rust's timers don't count time the computer spends asleep and don't
follow clock changes. If the app wasn't running at the start time, it checks
when it next opens. If the program is still on, it records the rest. If it has
ended, the record is marked missed.

With the margins, two programs in a row on one channel overlap by 7 minutes,
which would take two connections. So when a recording on a channel is due while
another recording of that channel is still running, the app extends the running
one to the later end time. The two programs end up in one file.

**Connections.** Recordings don't wait for a free download slot, because
starting late loses the beginning. A running recording has the status
`recording`, which the queue doesn't count against its limit. Many providers
allow only one or two connections at a time, watching a channel takes one, and
the default of three downloads at once is already past that. So when a
recording starts, the app puts that provider's running downloads back in the
queue, and they start again when it ends. Scheduling warns when two recordings
overlap. Xtream reports the account's limit as `max_connections` from
`player_api.php`, which the app doesn't read yet. Reading it would let the
warning use the real limit, and let downloads keep running when the account
has room.

On desktop, the app has to be running at the start time. It doesn't wake a
sleeping computer. While a recording runs, the app keeps the computer from
going to sleep.

On iOS, a recording can't start on its own while the app is in the background.
The iOS 26 task can only be submitted from the foreground in response to
something the user does, and iOS has no other way to start long network work
at a set time. So:

- Scheduling a recording also schedules a local notification for its start,
  such as "The news starts at 20:00. Open Max Video Player to record it."
  Tapping it opens the app on the recording, with a Record button. Tapping
  Record starts the recording, and on iOS 26 also submits the background task,
  so it goes on after the user leaves the app. A tap on a button in the app is
  clearly the user's action. Opening from a notification alone may not count.
- If the app is open at the start time, the recording starts by itself, and a
  banner offers the same Record button to keep it going in the background.
- If the user opens the app late, the same screen offers to record the rest of
  the program.
- The app asks for notification permission the first time the user schedules a
  recording, not at launch.
- Before iOS 26, a recording runs only while the app is open, the same as a
  download, and shows the same note.

Many Xtream providers keep a few days of past programs, shown by `tv_archive`
on the channel. Downloading a missed program from that archive would cover
recordings the phone couldn't start. That's a possible follow-up.

**Retention.** One setting, "Delete downloads after", with Never, 7, 14, 30 and
90 days. It covers downloads and recordings, and the default is Never. The
count starts when the download or recording finished, and starts over each time
it's played, so something the user is still watching stays. Each item in the
Downloads tab shows when it will be deleted, such as "Deletes in 3 days", and
has a Keep option that excludes it.

The app checks when it starts and every hour while it runs. On iOS it also
checks when the app comes back to the foreground. It deletes the file and the
record, the same as the Delete button. It skips a file that's playing, and
anything queued, scheduled, downloading or recording. When a change to the
setting would delete files right away, the app asks first, for example "This
deletes 4 downloads now."

**What goes where.** `mvp-core` gets the recording fields and statuses on
`DownloadRecord`, the overlap check, and the function that picks expired items
from the records, the setting and the time. They're plain functions with unit
tests. The database gets columns for the start and end times, the source
channel, Keep and the last play, added with `ALTER TABLE ... ADD COLUMN` like
the other migrations in `store.rs`, and `upsert_download` writes them.
`row_to_download` reads a kind it doesn't know as a movie, so it learns
`recording` in the same change. Desktop adds the launch recovery, the timer,
stopping ffmpeg through standard input and keeping the computer awake. iOS
adds the notification, the end time in `mvp_remux` and the background task.

## 3. Layouts

An iPhone always gets the phone layout. An iPad picks a layout by window width,
so Split View and Stage Manager work:

| Width               | Layout          |
| ------------------- | --------------- |
| 1024 points or more | Desktop         |
| 744 to 1023 points  | Tablet portrait |
| Under 744 points    | Phone           |

`layoutModeFor` in `src/lib/platform.ts` picks the layout, and `usePlatform`
checks again on every resize. A device counts as an iPhone when the short side
of its screen is under 744 points.

**Desktop.** The same React tree as macOS, on an iPad in landscape.

**Tablet portrait.** The sidebar shrinks to an icon rail, and the info drawers
open as sheets from the bottom.

**Phone.** A new shell around the same hooks and state:

- A tab bar with Live, Movies, Series, Favorites and Settings. History goes in
  Favorites.
- Channel cards with the logo, name and the program on now.
- An info button that opens a sheet with that channel's schedule. There's no
  cross-channel guide on the phone.
- A full screen player with the React controls on top.

On every layout, tap targets are at least 44 points and a long press replaces
right-click.

## 4. Milestones

**1. Playback on real devices.** In `poc/`, drive mpv from Rust instead of the
Objective-C bridge and play a `.ts` live channel, an HLS stream and an `.mkv`
episode on an iPhone and an iPad. Measure `.ipa` size, time to first frame and
battery drain over an hour. Nothing else starts until this works.

**2. iOS target in `apps/desktop`.**

- Run `tauri ios init` and commit `gen/apple` with MPVKit in `project.yml`.
- Add `tauri.ios.conf.json`: no `externalBin`, no updater artifacts, minimum
  iOS 17.5.
- Put the parts in section 2 behind `#[cfg(desktop)]`.
- Write the Swift package and the real `ios.rs`.
- Add a CI job that builds for the simulator on every PR.

**3. Layouts.** The phone and tablet portrait layouts from section 3.

**4. TestFlight beta.**

- Sign and upload from a workflow that runs by hand, with an approval in the
  `macos-signing` environment. It signs with an Apple Distribution
  certificate, or with cloud-managed certificates if the App Store Connect API
  key has the Admin role. The same key uploads the build.
- Add an iOS section to `THIRD_PARTY_NOTICES.md` for MPVKit's libraries and link
  it from Settings > About. Besides mpv and FFmpeg, MPVKit `1.1.0-n9.0.2`
  brings OpenSSL, GnuTLS, Nettle, GMP, libass, FreeType, FriBidi, HarfBuzz,
  MoltenVK, shaderc, Little CMS, libplacebo, libdovi, libunibreak, dav1d,
  uavs3d, uchardet and libbluray.
- Fill in the App Store privacy details. The app collects no data.

**5. App Store release.**

- Decide the price, and add StoreKit if it isn't free.
- Write review notes with a legal test stream, since reviewers can't use a
  real provider.
- Take screenshots that show no real channels or logos.
- Have a lawyer check the licensing in section 5.

**6. Downloads, recordings and retention.** An update after the App Store
release, following "Later: downloads" and "Later: recordings and retention" in
section 2. Desktop gets the launch fixes, recordings and retention before this. Test the
background task on an iPhone with iOS 26 and the in-app note on one with an
earlier version. Test a scheduled recording with the app open, in the
background, and closed, where the notification opens the app and Record starts
it.

**Later:** AVPlayer for picture in picture and AirPlay, M3U file import from
Files, iCloud sync for favorites and history, and iPad keyboard shortcuts.

## 5. Licensing on the App Store

The App Store's terms add restrictions that GPLv3 forbids, so a third party
can't put GPL code on the store. The copyright owner can, because the owner
isn't bound by their own license. The CLA gives the owner the rights needed to
ship contributions too.

That only works if nobody else's GPL code is in the iOS build:

- Use the `MPVKit` product, never `MPVKit-GPL`.
- Add no other GPL dependencies. A CI check on the iOS build's libraries
  enforces this.

The LGPL requires that users can relink the app with a changed library. The
full source is public, so anyone can rebuild it. Code written only for the App
Store build stays public for the same reason.

## 6. Risks

1. **Playback on a device is unconfirmed.** Streams play in the simulator, but
   not yet on hardware, where the GPU and VideoToolbox decoding differ.
   Milestone 1 settles this.
2. **Linking.** Settled in the simulator. The app crate dropped its `cdylib`,
   which can't link for iOS because libmpv only shows up at the Xcode link.
   `libmpv2` links against MPVKit `1.1.0-n9.0.2` there.
3. **Resizing.** The Metal layer has to follow rotation, Split View and the
   React layout without a frame of the wrong size. MPVKit's MoltenVK context
   only reads the layer's size when the video reconfigures
   ([MPVKit#3](https://github.com/mpvkit/MPVKit/issues/3)). Until MPVKit fixes
   that, `ios.rs` changes `video-aspect-override` by a few parts per million
   after each resize, which makes mpv reconfigure.
4. **Battery and heat.** Vulkan through MoltenVK may cost more power than
   AVPlayer. Milestone 1 measures it.
5. **Transparent web view.** Tauri's iOS web view has to show the Metal view
   through it without breaking touch input. This works in the simulator.
6. **App Review.** IPTV apps get extra scrutiny. The app ships with no content
   and no provider, and the review notes have to say so.
7. **Tauri mobile.** Tauri's iOS support is younger than its desktop support.
   Expect plugin and build issues.
8. **App Transport Security.** It only applies to URLSession and the web view.
   mpv and `reqwest` open their own sockets. `Info.ios.plist` allows only
   `NSAllowsArbitraryLoadsInWebContent`, for HTTP channel logos, and
   `NSAllowsLocalNetworking`. It sets `NSAllowsArbitraryLoads` to false
   outright, because the CLI merges it over the macOS `Info.plist`, which
   allows everything. HTTP logos load in the simulator. Check this on a
   device.
9. **Downloads and App Review.** Guideline 5.2.3 bars apps that save media from
   third-party sources without the source's permission. Recordings of live
   channels fall under it too. The app only downloads and records from the
   provider the user added, and the review notes for milestone 6 will say so,
   but a reviewer may still reject it. Downloads ship in their own update so a
   rejection can't hold up the first release. If Apple rejects them, that
   update goes out with downloads and recordings still hidden.

## 7. Success criteria

- An iPhone plays a `.ts` live channel, an HLS stream and an `.mkv` episode,
  with the React controls over the video.
- Audio keeps playing on the lock screen, and the lock screen controls work.
- iPad in landscape looks like the macOS app.
- The phone layout scrolls through 500 or more channels without dropped frames.
- The iOS build contains no GPL code from anyone but the owner.
- One workflow run and one approval produce a TestFlight build.

## Not in scope

- Android and Fire TV, which need their own spec.
- tvOS, which needs a focus-based UI.
- Mac Catalyst. The native macOS app already exists.
- Swift rewrites of anything React already does.

## Open questions

- **Price.** Free, paid, or free with a purchase. Decide before milestone 5.
- **iCloud sync.** Whether to sync favorites and history, and whether through
  CloudKit or something else.
