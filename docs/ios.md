# iOS and iPadOS

The iPhone and iPad app is the desktop app built with Tauri's mobile tooling. It
lives in `apps/player` and shares the React frontend and the Rust crates. Video plays
through libmpv from [MPVKit](https://github.com/mpvkit/MPVKit) release
`1.1.0-n9.0.2`, so live `.ts` channels, HLS and `.mkv` files all play the same way
they do on desktop. The app needs iOS or iPadOS 17.5 and ships through TestFlight and
then the App Store.

How the iOS pieces fit together is in [architecture.md](architecture.md#ios).

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
- Audio keeps playing on the lock screen, which shows the channel name and logo.

## Building

You need:

- Xcode 26. App Store uploads need the iOS 26 SDK.
- The Rust targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
- Node.js and pnpm, as in [development.md](development.md#prerequisites), and
  `pnpm install` at the repository root

You don't need `scripts/build-libmpv.sh` or the ffmpeg sidecar. Swift Package Manager
downloads MPVKit on the first build.

To build for the simulator and start the app:

```bash
cd apps/player
pnpm tauri ios build --debug --target aarch64-sim

xcrun simctl boot "iPhone 17 Pro"    # skip if a simulator is already running
open -a Simulator
xcrun simctl install booted "src-tauri/gen/apple/build/arm64-sim/Max Video Player.app"
xcrun simctl launch booted com.maxvideoplayer.app
```

Before building for the simulator again, move or delete
`src-tauri/gen/apple/build/arm64-sim`. The CLI fails when the app from the last build
is still there.

Always build through `pnpm tauri ios build`. The Xcode project's "Build Rust Code"
step asks the Tauri CLI that started the build for its options, so a plain
`xcodebuild` run stops there with `ConnectionRefused`.

### On your own iPhone or iPad

On the device, turn on Developer Mode in Settings → Privacy & Security, and connect
it to the Mac with a cable. Then build, install and start the app:

```bash
cd apps/player
pnpm tauri ios build --debug --target aarch64 --export-method debugging

xcrun devicectl list devices    # note the device's identifier
xcrun devicectl device install app --device <identifier> \
  "src-tauri/gen/apple/build/arm64/Max Video Player.ipa"
xcrun devicectl device process launch --device <identifier> com.maxvideoplayer.app
```

The build bundles the frontend, so the app runs without the Mac once it's installed.
As with the simulator, move or delete `src-tauri/gen/apple/build/arm64` and
`src-tauri/gen/apple/build/max-video-player_iOS.xcarchive` before the next build.

The project signs automatically with team `3MLC4VWP96`, the maintainer's. A debug
build uses the team's wildcard development profile, so it doesn't register
`com.maxvideoplayer.app` on the developer portal. TestFlight still needs the step
under [Register the app](#1-register-the-app).

If you're not on that team, open the project with `pnpm tauri ios open`, select the
`max-video-player_iOS` target, open Signing & Capabilities, and pick your own team.
Change the bundle identifier too, because `com.maxvideoplayer.app` belongs to the
maintainer's team. Don't commit either change.

The first time the app loads a playlist or stream from a local address such as
`192.168.1.20`, iOS asks to let it find devices on the local network. If you decline,
turn it back on in Settings → Privacy & Security → Local Network. A VPN such as
Tailscale, on the phone or the Mac, can keep the phone from reaching the Mac's local
address at all. Turn it off while testing against a server on the Mac.

#### With the dev server

To have the frontend reload as you edit it, run the dev server instead:

1. Start it and open the project in Xcode:

   ```bash
   cd apps/player
   pnpm tauri ios dev --open --host
   ```

   Pick the Mac's Wi-Fi address if it asks. Keep the command running, because the
   app loads its pages from it and Xcode's "Build Rust Code" step talks to it.
2. In Xcode, choose the device as the run destination and click Run.

The phone and the Mac have to be on the same network for this one.

## The Xcode project

`apps/player/src-tauri/gen/apple` is checked in. XcodeGen generates
`max-video-player.xcodeproj` from `project.yml`, which sets the MPVKit version, the
Info.plist keys and the linked frameworks. Keep MPVKit on its LGPL product. The App
Store build can't contain anyone else's GPL code.

After you edit `project.yml`:

```bash
cd apps/player/src-tauri/gen/apple
rm -rf Externals    # the next build recreates it
xcodegen generate --spec project.yml
git diff
```

XcodeGen adds any `libapp.a` it finds under `Externals/` to the project, which is why
that folder goes first. It also rewrites `max-video-player_iOS/Info.plist` and drops
the quotes around `DEVELOPMENT_TEAM`, so undo those parts of the diff unless you meant
to change them.

A build writes the app version from `tauri.conf.json` into `Info.plist`. The release
bump sets the same version in `project.yml` and `Info.plist`, so neither a build nor
XcodeGen changes it. A build with `--build-number` or a `bundle.iOS.bundleVersion`
override writes that number into `Info.plist`. Don't commit it.

### App icon

The icons in `src-tauri/icons/ios` and in `Assets.xcassets/AppIcon.appiconset` are
made from the 1024 px image in `src-tauri/icons/icon.icns`, so the iOS app has the
same icon as the macOS app. They have no alpha channel, because App Store Connect
rejects a 1024 px icon that has one.

`pnpm tauri icon` writes both of those folders as well as the desktop icons, so
running it replaces these files. Restore them with git afterward unless you meant to
change the iOS icon.

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

### App Transport Security

App Transport Security only covers URLSession and the web view. mpv and `reqwest`
open their own connections, so streams and API calls over plain HTTP aren't affected.
`apps/player/src-tauri/Info.ios.plist` turns on `NSAllowsArbitraryLoadsInWebContent`,
so channel logos served over HTTP still load, and `NSAllowsLocalNetworking`, which
lets the web view reach local addresses. It sets `NSAllowsArbitraryLoads` to `false`
on purpose. The Tauri CLI merges this file over the macOS `Info.plist`, which allows
all loads, so leaving the key out would turn App Transport Security off on iOS too,
and App Review asks for a reason when an app does that. HTTP logos load in the
simulator but haven't been checked on a device yet.

## Logs

On iOS the Rust logs go to the system log under the subsystem
`com.maxvideoplayer.app`, category `rust`. Debug builds also send Tauri's own
messages there, under the category `app`. The Swift plugin uses `NSLog`, which has
no subsystem, so its messages only carry the app's process name. To watch them all
live, open Console on the Mac, select the device and click Start. Then type
`Max Video Player` in the search field and pick Process from the menu that appears.
Searching for `subsystem:com.maxvideoplayer.app category:rust` shows only the Rust
lines. Console hides Rust's DEBUG lines until you turn on Include Info Messages in
the Action menu, and TRACE lines until you turn on Include Debug Messages. Xcode's
debug console shows everything when Xcode started the app.

Before a line reaches either log, the Rust side takes out logins, passwords, API keys
and tokens, and shortens every address. An address keeps its server, and keeps the
end of its path only when that's a stream ID or a well-known name such as
`index.m3u8` or `get.php`. So a stream address looks like
`http://host:8080/…/12345.ts`. Any other file name is cut down to its extension, as
in `https://cdn.example.com/….m3u8`, and queries become `?…`. A Rust panic goes
through the same steps and reaches both logs too. The Swift plugin only logs audio
session errors, which carry no addresses.

The app also writes the Rust logs to `Library/Caches/Logs/app.log` in its container.
When the file reaches 5 MB it becomes `app.log.1` and a new `app.log` starts, so the
newest lines are always kept. At launch the last run's `app.log` becomes
`app.previous.log`. To copy a file to the Mac:

```bash
xcrun devicectl device copy from --device <identifier> \
  --domain-type appDataContainer --domain-identifier com.maxvideoplayer.app \
  --source Library/Caches/Logs/app.log --destination app.log
```

This only works for a build signed for development, such as one that Xcode or
`tauri ios dev` installed. iOS doesn't let `devicectl` into the container of a
TestFlight or App Store build, so use Console for those.

## Continuous integration

| Workflow | Runs on | What it does |
| --- | --- | --- |
| [iOS](../.github/workflows/ios.yml) | Pushes and pull requests to `main` and `dev` that touch the app | A debug build for the simulator. Nothing is signed. |
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

## Licensing

The App Store's terms add restrictions that GPLv3 forbids, so a third party can't
put GPL code on the store. The copyright owner can, because the owner isn't bound
by their own license, and the [contributor agreement](../CLA.md) gives the owner
the rights to ship contributions too.

That only holds while nobody else's GPL code is in the iOS build:

- Use the `MPVKit` product, never `MPVKit-GPL`.
- Add no other GPL dependencies.

The LGPL requires that users can relink the app with a changed library. The full
source is public, so anyone can rebuild it.
