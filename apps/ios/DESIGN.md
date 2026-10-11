# iOS and iPadOS design spec

**First written:** 2026-04-18
**Revised:** 2026-10-10
**Status:** pending approval
**Platforms:** iOS and iPadOS 17 or later, on iPhone and iPad

## Summary

The iOS app is the desktop app built for one more target. It shares the React
frontend, `mvp-core` and the Rust side of `tauri-plugin-mpv`. Every stream plays
through mpv, using the LGPL build of [MPVKit](https://github.com/mpvkit/MPVKit).
Builds go to TestFlight first and the App Store after that.

The work is split into five milestones, listed in section 4.

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

| Feature                | Why                                                                                              | How                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Downloads              | iOS can't run the ffmpeg sidecar, and App Review rejects apps that save media from other sources | The download commands return an error, and the tab, buttons and settings are hidden |
| Updater                | The App Store updates the app                                                                    | Desktop-only plugin, `useUpdateChecker` skips iOS                                   |
| Support popup and card | Apple requires in-app purchase for tips to the developer                                         | Hidden on iOS                                                                       |
| Separate player window | iOS has one window                                                                               | No fallback. If the Metal view fails, show an error                                 |
| `process` plugin       | Only used to relaunch after an update                                                            | Desktop-only dependency                                                             |
| ffmpeg sidecar         | iOS apps can't run other programs                                                                | No sidecar lookup on mobile, and its permission is desktop only                     |

The `shell` plugin stays in the iOS build so the downloads code compiles
unchanged. Nothing calls it on iOS.

Rust uses `#[cfg(desktop)]` and target-specific dependencies in `Cargo.toml`.
Permissions for the desktop-only plugins and the sidecar live in
`capabilities/desktop.json`, which only applies on macOS, Linux and Windows.
React checks `isMobilePlatform()` from `src/lib/platform.ts`.

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

**Later:** AVPlayer for picture in picture and AirPlay, M3U file import from
Files, iCloud sync for favorites and history, iPad keyboard shortcuts, and
downloads if Apple's rules allow them.

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
- Downloads on iOS, for now.
- Swift rewrites of anything React already does.

## Open questions

- **Price.** Free, paid, or free with a purchase. Decide before milestone 5.
- **iCloud sync.** Whether to sync favorites and history, and whether through
  CloudKit or something else.
