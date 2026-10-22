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
- `app/src/main/res/drawable-xhdpi/banner.png` and the manifest's `android:banner`
  and `uses-feature` lines: the TV launcher banner.
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

- **D-pad:** the arrows reach the page as arrow keys. `useTvRemote` moves focus to the
  nearest control in the arrow's direction (`lib/tv-focus.ts`, which scores with
  `lib/spatial-nav.ts`), inside the open dialog if there is one. Text fields keep Left
  and Right for the caret, and sliders keep their own axis. A focused element that
  holds controls, like the player, is entered from the side the press comes from.
- **Center:** it's Enter, so it presses the focused control. In the player it skips an
  intro when the skip button shows, and otherwise plays or pauses.
- **Player:** Left and Right seek, as on desktop. Up and Down move focus into the
  controls, since the TV has its own volume, and once a control has focus the arrows
  move between controls. Any key shows the controls and keeps them up. When they hide
  with a control focused, the player takes focus back, so Left and Right seek again.
  While the subtitle settings are open, the arrows move the subtitles instead. That
  listener is on the document, so it takes the key before `useTvRemote` on the window.
- **Back:** `MainActivity.kt` hands it to `window.__cinetteBack`, which sends Escape to
  the focused element (`lib/tv-back.ts`). Escape already closes the top layer: a
  dialog, a player panel, full screen, then the player itself. When nothing takes
  it, Back goes to the home page, and on the home page the app closes. Only the TV
  layout sets `__cinetteBack`. Without it, on phones and tablets, Back goes back in
  the page's history as in other Tauri apps, and closes the app when there's none.
- **Media keys:** play/pause, play, pause, fast forward, rewind, next and previous
  work in the player.
- **Size:** `html.tv` in `globals.css` makes every `rem` an eighth larger, and gives
  the focused element a thick ring.

The launcher shows `res/drawable-xhdpi/banner.png`, 320×180, drawn from `icon.svg`
with the name in DejaVu Sans Bold. The manifest marks the Leanback and touch screen
features as not required, so the app installs on TVs and phones.

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
