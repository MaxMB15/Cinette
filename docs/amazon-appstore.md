# Amazon Appstore

How to put the Fire TV app on the Amazon Appstore. This page has the listing text,
the images, the answers to the console's questions and a checklist. Nothing has been
submitted. Steps marked **(console)** happen in the Amazon Developer Console, under the
developer's account, and only the account owner can do them.

The app is the Android TV app built for Amazon's store, as
[android.md](android.md#google-and-amazon-builds) explains:
`ORG_GRADLE_PROJECT_store=amazon`. It runs on Fire TVs with Fire OS 7 (Android 9) and
Fire OS 8 (Android 11). Fire TVs on Vega OS can't run Android apps.

## Before submitting

### Licensing

Read this before anything else.

- Amazon's [Developer Services Agreement](https://developer.amazon.com/support/legal/da),
  under "Prohibited Actions", says you may not submit software under a license that
  would make Amazon disclose or license anything combined with it, and names open
  source licenses as the example. Amazon always wraps the submitted app in its own
  code.
- Cinette is GPL-3.0. The developer owns its code, so their own license doesn't bind
  them, as for the App Store (see [ios.md](ios.md#licensing)).
- The Android build also contains other people's GPL code: FFmpeg built with
  `--enable-gpl` and mpv built with `-Dgpl=true` (`scripts/lib/libmpv-android.sh`,
  and [android.md](android.md#licensing)). The iOS build avoids that with LGPL builds
  of both.
- VLC, which is GPL, has been on the Fire TV Appstore. That's a precedent, not an
  answer.

How the clause applies is a legal question, and the decision to submit is the
developer's.

### Signing

Amazon removes the app's signature and signs it with a key of its own, one per
developer account. So:

- An Appstore install and an APK signed with another key can't update each other.
  Someone who sideloaded a GitHub APK has to uninstall it first.
- The upload still has to be signed. Any key works, since Amazon strips the
  signature. The same key as the Google Play upload key is fine.

Make the key once, and keep it and its passwords out of the repo and backed up:

```bash
keytool -genkeypair -v -keystore ~/cinette-upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Then create `apps/player/src-tauri/gen/android/keystore.properties`, which
`.gitignore` already keeps out of the repo:

```properties
storeFile=/absolute/path/to/cinette-upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

A relative `storeFile` is relative to `gen/android`. `app/build.gradle.kts` signs
release builds with it when the file exists, and leaves them unsigned when it
doesn't. CI doesn't build release builds.

### Building

From `apps/player/`, with libmpv built for both ABIs (see [android.md](android.md)):

```bash
. ../../scripts/android-env.sh
ORG_GRADLE_PROJECT_store=amazon pnpm tauri android build --aab --target aarch64 --target armv7
ORG_GRADLE_PROJECT_store=amazon pnpm tauri android build --apk --target aarch64 --target armv7
```

- The app bundle (`.aab`) is what goes to the Appstore. Amazon splits it per device.
  Upload one binary for every device: each Fire TV can only be given one, and Amazon
  doesn't pick by ABI the way Play does.
- The universal APK is for Live App Testing, or a sideload test.
- Keep both ABIs. Every Fire OS 7 and 8 device but one runs 32-bit `armeabi-v7a`
  userspace, and Amazon says never to drop 32-bit. A few devices take only 64-bit
  apps.
- The versionCode comes from the app's version, as for Play, so each release has a
  new one.
- The console warns above 50 MB. That's a warning, not a limit; the limit is 2.5 GB.

## The listing

### Text

All plain text, in English, with no prices, emoji or capitals for emphasis.

**Title:** Cinette

**Short description** (Fire TV shows the first 200 characters; this is 170):

> A fast, private player for your own IPTV service. Add an M3U playlist or Xtream
> Codes login and watch live TV, movies and series. Cinette provides no channels or
> content.

**Long description** (up to 4,000 characters, shown on amazon.com, not on Fire TV):

> Cinette is a player for IPTV services you already have. Add an M3U playlist or an
> Xtream Codes login from your provider, and watch its live channels, movies and series
> with a programme guide, all from the remote.
>
> Cinette provides no channels, movies, series or other content, and isn't linked to
> any provider. You need a playlist or login from a service you're allowed to use.
>
> It plays almost any stream your provider sends, including HLS, MPEG-TS, MP4 and MKV,
> with the Fire TV's hardware decoder. It remembers where you stopped in each movie and
> episode, keeps your favorites and history, and lets you pin, rename and reorder
> categories.
>
> It collects nothing. There are no accounts, ads, analytics or tracking, and the
> developer gets no data from the app. Your playlists, logins and history stay on the
> Fire TV.
>
> With Cinette on a computer or phone on the same network, you can pick the Fire TV in
> Devices and control what it plays. The Fire TV shows a code and asks before another
> device can take control.
>
> Optional: with your own free API keys, Cinette can show movie and series details from
> OMDb, skip intros and credits, and find subtitles on OpenSubtitles.
>
> Cinette is free and open source under the GPL-3.0 license.

**Feature bullets** (3 to 5):

- Plays your own M3U playlists and Xtream Codes logins: live TV, movies and series
- Programme guide, favorites, history and resume, all on the remote
- Hardware-decoded playback of HLS, MPEG-TS, MP4, MKV and more
- No accounts, ads or tracking; your data stays on the device
- Free and open source

**Keywords:** IPTV, M3U, Xtream Codes, EPG, live TV, player

Don't name or show any IPTV provider, and don't describe channels the app "has".
Amazon's policy bans apps that offer pirated content or link to it, and blocks such
apps on devices.

### Images

In [`images/amazon/`](images/amazon/), made from `src-tauri/icons/icon.svg`:

| File | Console field | Size |
|---|---|---|
| `icon-114.png` | Small icon | 114x114 |
| `icon-512.png` | Large icon | 512x512 |
| `fire-tv-icon-1280x720.png` | Fire TV app icon | 1280x720, no transparency, lockup inside the 882x448 safe area |
| `fire-tv-background-1920x1080.png` | Fire TV background | 1920x1080, the mark on the right, outside the 1214x830 safe area's text side |

Still to make: **3 to 10 screenshots at 1920x1080**, taken on a Fire TV with the demo
playlist so no real provider shows:

```bash
adb exec-out screencap -p > home.png
```

Take the channel list with the guide, a movie's details, the player, and Settings.
Without Fire TV screenshots, the listing falls back to phone ones, which this app
doesn't have.

## The console's questions (console)

- **Apply Amazon DRM?** No. DRM would limit who can run a copy, which GPLv3 doesn't
  allow.
- **Device support:** Fire TV devices on Fire OS 7 and 8. The manifest declares the
  touchscreen not required, which Amazon needs to class the app as compatible with
  Fire TV. Leave out tablets and Echo Show unless they've been tested. Fire OS 5 and 6
  devices are left out by minSdk 28.
- **Content rating questionnaire:** no violence, sexual content, profanity, drugs,
  gambling or horror in the app itself; no ads; no in-app purchases; no location; no
  user-generated content shared with others; no chat. The app has a web view that only
  shows its own pages. The content comes from the user's own provider, which the app
  doesn't supply.
- **Target audience:** not children. Leave the COPPA questions at "no".
- **User data privacy:**
  - Does the app collect or transfer user data? **No.** The developer receives nothing.
    The app talks to services the user sets up, from the device: their IPTV server,
    and OMDb, OpenSubtitles and Gemini only with keys the user enters. These are the
    same answers as Apple's Data Not Collected.
  - Since 2025 the privacy questionnaire is required for every new app and update.
    Answer it the same way.
  - Privacy policy URL: https://github.com/MaxMB15/Cinette/blob/main/docs/privacy.md
- **Testing instructions:** Amazon doesn't publish an app it can't test. Give the
  reviewers the [demo playlist](demo/README.md), which App Review uses too: public
  test streams with a guide, and four Creative Commons films. Write: "Cinette is a
  player for the user's own IPTV playlist and provides no content. To test, open
  Playlists. Under Add Provider, choose M3U Playlist, then URL, and enter
  https://raw.githubusercontent.com/MaxMB15/Cinette/main/docs/demo/playlist.m3u".
  The guide in `docs/demo/guide.xml` runs out on 2028-01-01.
- **In-app purchases, ads, login:** none.

## Fire TV test criteria

Amazon tests every app against its
[Fire TV test criteria](https://developer.amazon.com/docs/app-testing/test-criteria.html).
What Cinette does for the ones that apply:

- [ ] The remote reaches every control, with a visible focus ring, and nothing traps
  focus (2.11 to 2.13). See the TV remote in [android.md](android.md#the-tv-remote).
- [ ] No touch-only controls (2.12).
- [ ] Back goes back, never loops, and closes the app from home (group 4).
- [ ] Play/pause, rewind and fast forward work in the player, and do nothing elsewhere
  (group 4).
- [ ] Home pauses playback and the app keeps its place (`onStop`).
- [ ] Losing HDMI pauses playback, and it stays paused (2.19).
- [ ] The screen stays on while video plays, and the screensaver can start while it's
  paused (3.14).
- [ ] The app closes within 2 seconds of Home.
- [ ] External links don't break the app (2.14). A Fire TV has no browser unless Silk is
  installed.
- [ ] Flash writes stay under 50 MB an hour in the foreground (2.6). Downloads and
  recordings are off on Android, and mpv buffers in memory.
- [ ] Layout fills the screen at 960x540 CSS pixels and keeps the outer 5% clear.

## Checklist

1. [ ] Decide on the licensing question above. **(developer)**
2. [ ] Create an Amazon Developer account, if there isn't one. **(console)**
3. [ ] Make the upload key and `keystore.properties`. **(developer)**
4. [ ] Build the Amazon AAB and universal APK.
5. [ ] Install the APK on a Fire TV and go through the test criteria above.
6. [ ] Take the screenshots on the Fire TV.
7. [ ] Create the app in the console, with the package name `app.cinette`. **(console)**
8. [ ] Fill in the listing text and upload the images. **(console)**
9. [ ] Upload the AAB, answer No to Amazon DRM, and check the device list. **(console)**
10. [ ] Answer the content rating, target audience and privacy questions. **(console)**
11. [ ] Run a Live App Testing round, and install the Amazon-signed build on a Fire TV
    from the Appstore. **(console)**
12. [ ] Add the testing instructions and submit. **(console)**
