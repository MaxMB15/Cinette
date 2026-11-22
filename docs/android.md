# Android and Android TV

The Android app is the desktop app built with Tauri's mobile tooling, like the
[iOS app](ios.md). It lives in `apps/player` and shares the React frontend and the
Rust crates. It's aimed at Android TV and Google TV, and later at Fire TV, which runs
Fire OS 7 and 8 (Android 9 and 11). Phones aren't the target yet.

Video plays through libmpv, as on desktop and iOS, built with FFmpeg for Android by
`scripts/build-libmpv.sh android`. On a TV the app has its own layout, driven by the
remote. See [The TV remote](#the-tv-remote).

## How it differs from desktop

- The app builds for 64-bit ARM (`aarch64`, `arm64-v8a`) and 32-bit ARM (`armv7`,
  `armeabi-v7a`). Many Fire TV sticks are 32-bit.
- It needs Android 9 (API 28) or later, since Fire OS 7 is Android 9. That's
  `minSdk` in `gen/android/app/build.gradle.kts`. `minSdkVersion` in
  `src-tauri/tauri.android.conf.json` says the same, for when
  `pnpm tauri android init` writes the project again.
- mpv draws with `vo=gpu` on OpenGL ES into the `Surface` of a `SurfaceView` under the
  transparent web view, and decodes with MediaCodec. See [Video](#video).
- HTTPS uses rustls, not OpenSSL. See [TLS](#tls).
- The updater, relaunch and downloads are off, as on iOS. Android can't run the ffmpeg
  binary that downloads use, so `tauri.android.conf.json` leaves it out of the
  bundle.
- Plain HTTP is allowed, because many IPTV servers only speak HTTP.
- Android sets no `TMPDIR`, so Rust's `std::env::temp_dir()` would be
  `/data/local/tmp`, which apps can't write. `MainActivity` points it at the app's
  cache folder before the Rust library loads.

## Building

You need:

- JDK 17 or later. CI uses Temurin 21.
- The Android SDK, with the platform the Gradle project's `compileSdk` names (now
  37) and its build tools. Gradle installs a missing platform when the SDK's
  licenses are accepted. Set `ANDROID_HOME` to the SDK folder.
- NDK r30 (`30.0.16248370`), which CI uses: `sdkmanager "ndk;30.0.16248370"`. Set
  `NDK_HOME` to `$ANDROID_HOME/ndk/30.0.16248370`.
- The Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi`.
- For libmpv: meson 1.3 or later, ninja, pkg-config, make, Python 3, curl and git.
  On Ubuntu, `sudo apt-get install meson ninja-build pkg-config`. On a Mac,
  `brew install meson ninja pkg-config`.
- No emulator or device to build. You need one to run the app, as
  [Testing on a device](#testing-on-a-device) explains.

First build libmpv and FFmpeg, once, from the repo root:

```bash
./scripts/build-libmpv.sh android                 # both ABIs
./scripts/build-libmpv.sh android arm64-v8a       # or just one
```

That takes about 20 minutes per ABI. It downloads the pinned sources into
`libs/android-build/`, checks their SHA-256, and puts the libraries in
`libs/android/<ABI>/`, which Gradle packs into the APK. Once that's done,
`libs/android-build/` can go: it takes a few gigabytes. Run the script again after
changing it.

Then, from `apps/player/`:

```bash
. ../../scripts/android-env.sh
pnpm tauri android build --debug --target aarch64 --target armv7 --apk
```

`android-env.sh` sets what bindgen needs on armv7, where libmpv2-sys generates its
mpv bindings, since the ones it comes with are only right for 64-bit targets.

The APK is `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
Leave out `--target` to build all four ABIs, including the x86 ones an emulator on
an Intel computer needs. `--target x86_64` builds just that one. An Apple Silicon
Mac's emulator runs `aarch64`.

A release APK or app bundle has to be signed. `app/build.gradle.kts` signs release
builds with the key that `gen/android/keystore.properties` names, when that file
exists. [amazon-appstore.md](amazon-appstore.md#signing) says how to make both. CI
doesn't build release builds.

### Google and Amazon builds

The app builds for Google's store or Amazon's. The Gradle property `store` picks
one, `google` by default. Set it in the environment around the Tauri CLI:

```bash
ORG_GRADLE_PROJECT_store=amazon pnpm tauri android build --debug --target armv7 --apk
```

Both get the same Rust library, frontend and manifest. The store only goes into the
manifest as `app.cinette.STORE`, which the app reads at startup and logs. The output
has the same name either way, so copy the APK away before building the other store.

`store` is a property and not a Gradle flavor dimension, because a second dimension
renames the variant tasks, like `mergeUniversalDebugJniLibFolders`, that Tauri's
`buildSrc/.../RustPlugin.kt` and CLI expect. `RustPlugin.kt` is written again by
`pnpm tauri android init`.

Fire TV sticks run 32-bit userspace even on 64-bit chips, so `armv7` is the target
for them. CI's Android workflow builds both stores and checks the store in each
manifest.

### Lint

`pnpm tauri android build` prints Rust warnings but doesn't fail on them. Run Clippy
for both targets the way CI does. `android-env.sh` also points crates that bundle C
code, such as SQLite and aws-lc, at the NDK's clang:

```bash
. scripts/android-env.sh
cargo clippy --workspace --target aarch64-linux-android --all-targets -- -D warnings
cargo clippy --workspace --target armv7-linux-androideabi --all-targets -- -D warnings
```

The tests run on the computer, not on Android: `pnpm test` and `cargo test`.

## Testing on a device

Install the APK with adb, from the Android SDK's `platform-tools` or Homebrew's
`android-platform-tools`:

```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell monkey -p app.cinette 1        # opens the app
adb logcat -s RustStdoutStderr:V         # the app's log lines
adb exec-out screencap -p > screen.png   # a screenshot
```

- **Google TV or Android TV:** turn on Developer options (Settings, System, About,
  then select Android TV OS build seven times). Then turn on USB or network
  debugging, and run `adb connect <ip>` for a device on the network.
- **Fire TV:** Settings, My Fire TV, About, then select the device name seven times.
  Then turn on ADB debugging in Developer options, and run `adb connect <ip>`.
- **Emulator:** Android Studio's device manager can make an Android TV or Google TV
  emulator. On an Apple Silicon Mac it runs `arm64-v8a` images.

The arrow keys on a TV remote come through as D-pad events. You can send them with
`adb shell input keyevent`, such as `DPAD_DOWN`, `DPAD_CENTER` and `BACK`.

## The Gradle project

`pnpm tauri android init` made `src-tauri/gen/android`, which is checked in, like
`gen/apple`. The build regenerates some files in it, and the project's own
`.gitignore` files leave those out. Changes made by hand:

- `app/build.gradle.kts`: `minSdk` 28, plain HTTP allowed in release builds too,
  Java 17, the `rustls-platform-verifier` dependency, `libs/android` as a
  folder of native libraries, and the `store` property.
- `build.gradle.kts`: rustls' Maven repository, for the `org.rustls` group only.
- `app/src/main/res/xml/network_security_config.xml`: allows plain HTTP and trusts
  the user's CAs.
- `app/proguard-rules.pro`: keeps the verifier's classes, which only JNI calls.
- `app/src/main/res/mipmap-*`: the app icon from `src-tauri/icons/android`, which
  `pnpm tauri icon` writes. Copy it over after changing the icon.
- `app/src/main/res/drawable-xhdpi/banner.png`, `drawable-xxxhdpi/banner.png`, and
  the manifest's `android:banner`, activity `android:icon` and `uses-feature` lines:
  the TV launcher banner.
- `app/src/main/java/app/cinette/MainActivity.kt`: hands Back to the page.
- The manifest's `app.cinette.STORE` meta-data, from the `store` property.

Running `pnpm tauri android init` again overwrites these. Check the diff afterwards.

## Video

The Kotlin half of `tauri-plugin-mpv` is `crates/tauri-plugin-mpv/android`, and the
Rust half is `src/android.rs`.

- `MpvPlugin.kt` puts a `SurfaceView` under the web view, which it makes transparent.
  The view stays hidden, with no surface, until a load shows it.
- The view reports its surface to Rust through `MpvNative.surfaceChanged`. mpv gets
  it as `wid`, a JNI global reference, with `gpu-context=android`, and runs its own
  draw loop.
- When the same surface only changes size, as on a rotation or a new frame for the
  player, mpv only gets `android-surface-size`. A new `wid` would rebuild its video
  output and make a live stream buffer again. Each callback brings a new JNI
  reference, so the JVM's `IsSameObject` tells whether it's the same surface.
- Android destroys the surface whenever the view hides or the app goes to the
  background. Before `surfaceDestroyed` returns, Rust sets `vo=null` and `wid=0` on
  the playing mpv. When a surface comes back, mpv gets it and `vo=gpu` again. That's
  how mpv-android does it.
- The surface callback runs on the UI thread, and only takes a lock of its own, with
  an mpv client handle of its own. A load can hold `MpvState`'s locks while it waits
  for the UI thread, so the callback never takes them.
- At startup, Rust hands the JVM to libavcodec with `av_jni_set_java_vm`, which
  MediaCodec and AudioTrack need. That's why FFmpeg is built as shared libraries.
- While a stream plays, the window has `FLAG_KEEP_SCREEN_ON`, which also keeps a TV's
  screensaver away.
- Playback pauses when the app stops, as on Home, through `MpvNative.pause`, which
  uses the surface callback's client. Nothing plays in the background: there's no
  media notification to control it from, and Fire TV's test criteria ask for that.
- It also pauses when the HDMI output goes (`ACTION_HDMI_AUDIO_PLUG`), as when the TV
  turns off, and stays paused when it comes back. Fire TV's test criteria ask for that
  too.

The libraries come from `scripts/lib/libmpv-android.sh`. It follows
[mpv-android's build scripts](https://github.com/mpv-android/mpv-android/tree/master/buildscripts)
with fewer dependencies: mbedtls for FFmpeg's HTTPS, freetype, fribidi, harfbuzz,
libass and libplacebo. There's no Lua, so no on-screen controller, as in the other
builds. libass has no system font provider on Android, and mpv reads every file in
its fonts folder when it starts, so at startup the plugin copies one system font,
Roboto where there is one, into the app's cache and gives mpv that folder.

## The TV remote

On a TV, `getPlatform()` in `lib/platform.ts` returns `tv` and the app uses
`TvLayout`. `android_device.rs` asks Android's package manager for the TV features
(`android.software.leanback`, `android.hardware.type.television` or
`amazon.hardware.fire_tv`) and passes the answer to the page in an init script, as
`window.__CINETTE_TV__`, so it's known on the first render. Other Android devices are
`android` and get the phone, tablet or desktop layout by size, as iOS does.

The TV has its own screens in `components/tv/`, made for a remote with arrows, OK and
Back. They aren't the desktop pages made larger.

- **Screens:** each one is a row of lists. Up and Down move in a list, Right goes a
  level deeper, Left goes a level back, and OK acts. `TvLayout` puts a rail of sections
  beside the page, and Right from the rail always lands in the page's first column
  (`focusTvFirstColumn`). Search and Favorites split what they show into live channels,
  movies and series (`TvKinds`). `TvList` draws the lists, with the active row as its only tab stop,
  so moving back into a list lands where you left it. Each screen keeps its place in
  `TvNav.memory`, which outlives the player. Settings is lists as well
  (`TvSettingsColumns`). Its first column has two groups, each a list under its name: a
  card for each provider (`useTvProviderSections`), then the app's own sections. Up and
  Down go on from the end of one group to the next. A provider's card shows its channel
  count and a dot for whether its last refresh worked, and its rows sit under a summary
  with its live channels, movies and series (`get_content_counts`). A text entry opens
  an on-screen keyboard that's part of the page (`TvTextEntry`, `TvKeyboard`). The system keyboard only comes up when OK is
  pressed on the field above the letters (`TvField`).
- **D-pad:** the arrows reach the page as arrow keys. `useTvRemote` moves focus to the
  nearest control in the arrow's direction (`lib/tv-focus.ts`, which scores with
  `lib/spatial-nav.ts`), inside the open dialog if there is one. Text fields keep Left
  and Right while the caret can move that way, and sliders keep their own axis. A
  focused element that holds controls, like a notice, is entered from the side the press
  comes from. A held arrow speeds up a one-column list, whose active row then shows how
  far along it is (`rowsPerPress` in `lib/tv-grid.ts`).
- **Center:** it's Enter, so it presses the focused control. A held OK counts as one
  press. With nothing focused, OK goes to the screen's start.
- **Player:** the video always fills the screen, so there's no full screen button, and
  no volume slider or shortcut list either. `lib/tv-player-keys.ts` says what each key
  does while the focus is on the video.
  - Down shows the row of buttons (`TvControls`, built by `tv-buttons.ts`), and Down
    again shows the tray under it: source, autoplay, audio, speed, and Download or
    Record, which stay disabled until the TV has storage. Up shows the same row under
    the details of what's playing (`TvNowPlaying`). Down from the details, or from the
    row, hides them again. The tray's options open a list (`TvPickPanel`).
  - OK plays or pauses. In a movie or episode, Left and Right seek, and Menu or Info
    opens the details and episodes.
  - On a live channel, Left and Right seek in what mpv holds. `useLiveSeek` works out
    where the broadcast is from when the stream reached it, and OK goes live while the
    bar shows. If what's held doesn't reach live, the channel opens again. Settings >
    Live rewind sets how much mpv keeps behind the position, through
    `demuxer-max-back-bytes`. Menu opens the channel list, and only the remote's channel
    keys change the channel.
  - The video keeps the focus while the skip prompt shows, so OK skips and Left or Right
    still seek. Up from the buttons reaches the prompt's other buttons, such as Undo.
  - A stream that fails doesn't take the focus. OK on the video tries it again.
  - When a video ends with nothing to play next, the player goes back to where it was
    opened from, since mpv holds the last frame and Play can't restart it. While another
    device controls the TV, the player stays and that device chooses what's next.
- **Back:** `MainActivity.kt` hands it to `window.__cinetteBack`, which sends Escape to
  the focused element (`lib/tv-back.ts`). Escape closes the top layer: a dialog, a player
  panel, then the player itself. On a screen it walks left through the columns to the
  rail. On the rail it goes to Live TV, and from there the app closes. Only the TV layout
  sets `__cinetteBack`. Without it, on phones and tablets, Back goes back in the page's
  history as in other Tauri apps, and closes the app when there's none.
- **Other keys:** play/pause, play, pause, fast forward, rewind, next and previous work
  in the player. Channel Up and Down, or Page Up and Down, page through a list. In the
  player they change the channel or the episode. Guide opens the channel list, and Info
  shows what's playing. Menu is the key with three lines on a Fire TV remote.
- **Size:** `html.tv` in `globals.css` sets the root font size to a 64th of the screen's
  width, so a 16:9 screen is always 64 by 36 `rem`. It uses the width because the system's
  keyboard can take away height, which would shrink everything while it's open. Screens are
  laid out in `rem`, and the `tv:` variant restyles a shared component for a TV with classes
  alone.
- **Edges:** some TVs crop about 2.5% off each edge. The rail's icons start 1.75 `rem` in,
  a page's content ends 2 `rem` before the right edge, and panels and the player's controls
  keep at least 1.75 `rem` too. Lists can run past the bottom edge, since they scroll.
- **Focus:** a focused row is solid white with dark text (`.tv-cursor`). A list's active
  row is lightly tinted while the focus is elsewhere. The TV turns `backdrop-filter` off,
  and its screens use no scaling or shadows, so text stays sharp.
- **Left out:** the TV has no Manage Categories, Gemini sorting, or donation link, on top
  of what Android leaves out everywhere. Settings shows links as text with their address,
  since opening one could send the web view away with no way back.

The launcher shows the banner, `res/drawable-xhdpi/banner.png` at 320×180 and
`res/drawable-xxxhdpi/banner.png` at 640×360, drawn from `icon.svg` with the name in
DejaVu Sans Bold, like the Appstore's Fire TV app icon in `docs/images/amazon`. The
manifest marks the Leanback and touch screen features as not required, so the app
installs on TVs and phones.

Fire TV's launcher ignores `android:banner` for an app that didn't come from the
Appstore. It shows the launcher activity's `android:icon` instead, centered in a wide
tile, so a square icon gets grey on both sides. The Amazon build sets that icon to the
banner, through the `launcherIcon` placeholder in `app/build.gradle.kts`. The Google
build keeps the square icon there, which Google TV's apps row shows. The launcher
caches the tile, so a changed one only shows after uninstalling and installing again.

## TLS

reqwest uses the system's TLS on desktop and iOS. Android has no system OpenSSL, so
there it uses rustls with aws-lc. `crates/core/Cargo.toml` picks the feature for each
target.

rustls checks certificates through
[rustls-platform-verifier](https://github.com/rustls/rustls-platform-verifier), which
calls Android's own certificate checks. Those follow the network security config, so
CAs the user installed are trusted along with the system's.

The verifier has a Kotlin half that comes from rustls' Maven repository. It must be
the version `rustls-platform-verifier-android` has in `Cargo.lock`, and
`android_project_tests.rs` checks that `app/build.gradle.kts` names that version.
After a cargo update that changes it, change the Gradle line to match.
`src-tauri/src/android_tls.rs` hands the verifier the JVM when the app starts. If that
fails, the app stops there, since every HTTPS request would hang without it.

## Continuous integration

`.github/workflows/android.yml` runs on pull requests and pushes that touch the app,
the crates or the build setup:

1. Installs NDK r30 on Ubuntu's Android SDK.
2. Restores libmpv for Android from the Actions cache, or builds it. The cache key is
   the NDK version and the build scripts, which pin every source.
3. Builds the debug APK for `aarch64` and `armv7`.
4. Checks that the APK has the app's library, libmpv and FFmpeg for both ABIs, prints
   what `aapt2 dump badging` reports, and fails unless the minimum SDK is 28 and
   there's a TV launcher activity.
5. Runs Clippy for both targets with `-D warnings`.

Nothing is signed or uploaded.

## Licensing

The Android app ships under GPLv3, like the desktop and iOS builds. Its libmpv and
FFmpeg are built with their GPL parts, and
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md#libraries-bundled-in-the-android-app)
lists every library in the APK.
