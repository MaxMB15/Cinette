# iOS and iPadOS

The iPhone and iPad app is the desktop app built with Tauri's mobile tooling. It
lives in `apps/desktop` and shares the React frontend and the Rust crates. Video plays
through libmpv from [MPVKit](https://github.com/mpvkit/MPVKit) release
`1.1.0-n9.0.2`, so live `.ts` channels, HLS and `.mkv` files all play the same way
they do on desktop. The app needs iOS or iPadOS 17.5 and ships through TestFlight and
then the App Store.

The plan behind the port is in [`apps/ios/DESIGN.md`](../apps/ios/DESIGN.md).

## How it differs from desktop

- mpv draws with `vo=gpu-next` on Vulkan through MoltenVK, into a `CAMetalLayer`
  under the transparent webview. The renderer is `crates/tauri-plugin-mpv/src/ios.rs`,
  and the UIKit side is `crates/tauri-plugin-mpv/ios/Sources/MpvPlugin.swift`.
- The updater, relaunch and downloads are off. The App Store updates the app, and
  iOS can't run the ffmpeg binary that downloads use.
- The donation prompt and support links are hidden, because App Store rules don't
  allow them.
- An iPhone always gets the phone layout. An iPad picks the phone, tablet or desktop
  layout by window width, so Split View and rotation switch between them.
- Audio keeps playing on the lock screen, which shows the channel name.

## Building

You need:

- Xcode 26. App Store uploads need the iOS 26 SDK.
- The Rust targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
- Node.js 20 or later, and `npm install` at the repository root

You don't need `scripts/build-libmpv.sh` or the ffmpeg sidecar. Swift Package Manager
downloads MPVKit on the first build.

To build for the simulator and start the app:

```bash
cd apps/desktop
npx tauri ios build --debug --target aarch64-sim

xcrun simctl boot "iPhone 17 Pro"    # skip if a simulator is already running
open -a Simulator
xcrun simctl install booted "src-tauri/gen/apple/build/arm64-sim/Max Video Player.app"
xcrun simctl launch booted com.maxvideoplayer.app
```

Before building for the simulator again, move or delete
`src-tauri/gen/apple/build/arm64-sim`. The CLI fails when the app from the last build
is still there.

Always build through `npx tauri ios build`. The Xcode project's "Build Rust Code"
step asks the Tauri CLI that started the build for its options, so a plain
`xcodebuild` run stops there with `ConnectionRefused`.

### On your own iPhone or iPad

The app hasn't run on a physical device yet, so treat this as the first test.

1. On the device, turn on Developer Mode in Settings → Privacy & Security, and
   connect it to the Mac with a cable.
2. Start the dev server and open the project in Xcode:

   ```bash
   cd apps/desktop
   npx tauri ios dev --open --host
   ```

   Pick the Mac's Wi-Fi address if it asks. Keep the command running, because the
   app loads its pages from it and Xcode's "Build Rust Code" step talks to it.
3. In Xcode, choose the device as the run destination and click Run. The project
   signs automatically with team `3MLC4VWP96`. The first time, Xcode registers
   `com.maxvideoplayer.app` and makes a development profile for it.

The phone and the Mac have to be on the same network. TestFlight builds don't need
the Mac, as described below.

## The Xcode project

`apps/desktop/src-tauri/gen/apple` is checked in. XcodeGen generates
`max-video-player.xcodeproj` from `project.yml`, which sets the MPVKit version, the
Info.plist keys and the linked frameworks. Keep MPVKit on its LGPL product. The App
Store build can't contain anyone else's GPL code.

After you edit `project.yml`:

```bash
cd apps/desktop/src-tauri/gen/apple
rm -rf Externals    # the next build recreates it
xcodegen generate --spec project.yml
git diff
```

XcodeGen adds any `libapp.a` it finds under `Externals/` to the project, which is why
that folder goes first. It also rewrites `max-video-player_iOS/Info.plist` and drops
the quotes around `DEVELOPMENT_TEAM`, so undo those parts of the diff unless you meant
to change them.

A build with `--build-number` or a `bundle.iOS.bundleVersion` override writes that
number into `Info.plist`. Don't commit it.

### Privacy manifest

`max-video-player_iOS/PrivacyInfo.xcprivacy` says the app doesn't track anyone or
collect data, and gives Apple's reasons for the APIs that need one. The calls come
from code linked into the app binary, such as the Rust standard library, SQLite and
mpv:

| Category | Reason | Why |
| --- | --- | --- |
| File timestamp | `C617.1` | `stat` and similar calls on files inside the app container |
| Disk space | `E174.1` | `statfs` to check for free space before writing files |
| System boot time | `35F9.1` | `mach_absolute_time` to measure elapsed time |
| User defaults | `CA92.1` | Settings the app reads and writes for itself |

If App Store Connect emails an `ITMS-91053` warning about a missing reason after an
upload, add the category it names.

## Continuous integration

| Workflow | Runs on | What it does |
| --- | --- | --- |
| [iOS](../.github/workflows/ios.yml) | Pushes to `feature/ios-poc`, and pull requests to `dev` and `feature/ios-poc` that touch the app | A debug build for the simulator. Nothing is signed. |
| [iOS TestFlight](../.github/workflows/ios-testflight.yml) | Manual | A release build for devices, signed for the App Store and uploaded to TestFlight |

The TestFlight workflow uses the `macos-signing` environment, so a reviewer approves
each run, and it only runs from `dev`, `main` or a `v*` tag. Its first job checks the
ref again before the signing job starts, and checks who started the run. The users
listed in the `RELEASE_ALLOWED_ACTORS` variable can, or the repository owner when it
isn't set, as for the release workflows. Setting the variable replaces the owner, so
list the owner in it too. Re-running all jobs runs that check again for whoever
starts the rerun. Re-running only the signing job skips it, so the signing job then
refuses anyone but the person who started the run.

The version comes from `tauri.conf.json` as usual. The build number is the
workflow's run number, which goes up with every run as TestFlight requires. It
doesn't use `--build-number`, because that appends a fourth number to the version
and App Store Connect rejects it.

To run it, open Actions → **iOS TestFlight** → **Run workflow**, pick `dev` or
`main`, and approve the deployment when it asks. The same works from a terminal:

```bash
gh workflow run ios-testflight.yml --ref dev
```

GitHub only accepts manual runs of a workflow that's on the default branch, so
neither works until this file reaches `main`. The build shows up in App Store
Connect under TestFlight a few minutes after the upload, once Apple has processed it.

## TestFlight setup

This is done once. You need the Apple Developer Program membership that signs the
macOS app, and the Account Holder or Admin role.

### 1. Register the app

1. On [developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list),
   click **+**, choose **App IDs** and then **App**, and register the explicit bundle
   ID `com.maxvideoplayer.app`. The app doesn't need any capabilities.
2. In [App Store Connect → Apps](https://appstoreconnect.apple.com/apps), click **+** →
   **New App**. Choose iOS, pick the bundle ID, and enter a name and an SKU. The name
   has to be unique on the App Store.

### 2. Choose how CI signs

The workflow signs one of two ways. It picks the first one when its three secrets
are set.

**With a certificate and profile.** You manage the files, and they last a year.

1. Xcode → Settings → Accounts → select your team → Manage Certificates → **+** →
   **Apple Distribution**.
2. In Keychain Access, find "Apple Distribution: …" under My Certificates, export it
   with its private key as a `.p12`, and set a password.
3. On [developer.apple.com → Profiles](https://developer.apple.com/account/resources/profiles/list),
   click **+**, choose **App Store Connect** under Distribution, pick
   `com.maxvideoplayer.app` and the certificate, and download the profile.
4. Add three secrets to the `macos-signing` environment:

   | Secret | Value |
   | --- | --- |
   | `IOS_CERTIFICATE` | `base64 -i distribution.p12 \| pbcopy` |
   | `IOS_CERTIFICATE_PASSWORD` | The `.p12` password |
   | `IOS_MOBILE_PROVISION` | `base64 -i profile.mobileprovision \| pbcopy` |

**Through the API key.** Without those secrets, Xcode creates and uses cloud-managed
certificates itself. This needs the App Store Connect API key to be a team key with
the Admin role. This way hasn't been tried yet.

### 3. Check the API key

The upload uses the same API key as macOS notarization: `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER` and `APPLE_API_PRIVATE_KEY` in the `macos-signing` environment.
See [macos-signing.md](macos-signing.md). Its role has to allow uploading builds,
and signing through the key needs Admin.

### 4. Answer App Store Connect's questions

- **Export compliance.** `Info.plist` sets `ITSAppUsesNonExemptEncryption` to
  `false`, because the app only uses encryption for HTTPS and other TLS connections.
  App Store Connect then doesn't ask about it for each build.
- **App Privacy.** Answer **Data Not Collected**. This is required before
  submitting to the App Store, and it matches the privacy manifest. The app has no
  server and no analytics. Requests for metadata, subtitles and category sorting go
  straight from the device to those services, with the user's own keys where one is
  needed.
