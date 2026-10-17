<div align="center">

<img src="apps/player/src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Cinette icon">

# Cinette

A fast, private IPTV player for macOS and Linux.<br>
Add your M3U playlist or Xtream Codes account and watch live TV, movies and series in one app.<br>
It used to be called Max Video Player.

[![Latest release](https://img.shields.io/github/v/release/MaxMB15/Cinette?label=release)](https://github.com/MaxMB15/Cinette/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/MaxMB15/Cinette/total)](https://github.com/MaxMB15/Cinette/releases)
[![Build](https://github.com/MaxMB15/Cinette/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/MaxMB15/Cinette/actions/workflows/build.yml)
[![Frontend coverage](https://MaxMB15.github.io/Cinette/coverage/badge.svg)](https://MaxMB15.github.io/Cinette/coverage/)
[![Rust coverage](https://MaxMB15.github.io/Cinette/coverage/rust/badge.svg)](https://MaxMB15.github.io/Cinette/coverage/rust/)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue)](LICENSE)

[Website](https://maxmb15.github.io/Cinette/) · [Download](#download) · [Features](#features) · [Getting started](#getting-started) · [FAQ](#faq) · [Contributing](CONTRIBUTING.md) · [Disclaimer](#disclaimer)

<br>

<img src="docs/images/channels.jpg" alt="The live TV tab: recently played channels, category filters, and a programme guide timeline for each channel">

</div>

## Why Cinette

**It's fast.** The app is built in Rust with [Tauri](https://tauri.app), which uses the web view your system already has instead of shipping its own copy of Chromium the way Electron apps do. Video plays through [mpv](https://mpv.io) with your computer's hardware decoder, and mpv draws it itself instead of handing it to the web page that holds the controls. Playlists and programme guides are parsed in Rust and saved in a local database, and the app only downloads them again when they're due on the schedule you set. The channel list only draws the rows you can see, however long the playlist is.

**It collects nothing.** There are no accounts, ads, analytics or telemetry, and the developer gets no data from the app. Your playlists, logins, favorites and history stay on your computer. You don't have to take that on trust. All of the code is here for anyone to read, every release is built from it by GitHub Actions, and the [privacy policy](docs/privacy.md) lists each service the app talks to and what it sends.

**You set it up your way.** Choose how often each provider and its guide refresh. Pin, rename, reorder and create categories. Pick whether intros, recaps and credits are skipped automatically, with a button or not at all, and how far the back and forward buttons jump. Set the default volume and hardware decoding, where downloads go, how many run at once and how long they're kept, and how early recordings start and how late they run.

## Download

| Platform | Download | Requirements |
| --- | --- | --- |
| **macOS** | [**Apple Silicon (.dmg)**](https://github.com/MaxMB15/Cinette/releases/latest/download/Cinette_aarch64.dmg) · [Intel (.dmg)](https://github.com/MaxMB15/Cinette/releases/latest/download/Cinette_x64.dmg) | macOS 15 Sequoia or later |
| **Linux** | [**AppImage**](https://github.com/MaxMB15/Cinette/releases/latest/download/Cinette_amd64.AppImage) · [Debian / Ubuntu (.deb)](https://github.com/MaxMB15/Cinette/releases/latest/download/Cinette_amd64.deb) · [Fedora (.rpm)](https://github.com/MaxMB15/Cinette/releases/latest/download/Cinette_x86_64.rpm) | x86_64 |
| Windows | Planned | |
| iOS, iPadOS | Coming soon to the App Store | |
| Android, Fire TV | Planned | |

These links always point at the newest version. Older versions and release notes are on the [releases page](https://github.com/MaxMB15/Cinette/releases), and the [changelog](CHANGELOG.md) lists what changed in each one. Once installed, the app updates itself.

There's no version for macOS 14 and earlier. Releases before the Intel build only ran on macOS 15 on Apple Silicon, even the ones that claimed to support Intel Macs and older macOS. Pick the build for your Mac's chip, which **About This Mac** shows.

### Installing

**macOS.** Open the DMG and drag Cinette into Applications.

<details>
<summary>macOS says the app "can't be opened" or "is damaged"</summary>

<br>

Releases that aren't notarized by Apple are blocked by Gatekeeper the first time you open them. To open the app anyway:

1. Try to open Cinette once and close the warning.
2. Open System Settings → Privacy & Security, scroll down, and click **Open Anyway** next to the message about Cinette.
3. Confirm with your password or Touch ID.

If macOS says the app is damaged, run this in Terminal and open it again:

```bash
xattr -dr com.apple.quarantine /Applications/Cinette.app
```

</details>

**Linux AppImage.** It includes libmpv, so there's nothing else to install:

```bash
chmod +x Cinette_amd64.AppImage
./Cinette_amd64.AppImage
```

The AppImage needs glibc 2.38 or later, which Ubuntu 24.04, Debian 13 and current Fedora releases have.

**Debian and Ubuntu.** `sudo apt install ./Cinette_amd64.deb` installs the app and the libraries it needs, including libmpv. It needs Debian 12, Ubuntu 24.04 or a later release.

**Fedora.** `sudo dnf install ./Cinette_x86_64.rpm`

Both packages need WebKitGTK 2.40 or later, which all of these releases have.

Ubuntu 22.04 and releases based on it, such as Linux Mint 21 and Pop!_OS 22.04, aren't supported. Their libmpv is too old for the app, and their glibc is too old for the AppImage.

## Features

**Your playlists**

- M3U and M3U+ playlists from a URL or a file, and Xtream Codes accounts
- Several providers side by side, each refreshed on a schedule you choose
- XMLTV programme guide (EPG), shown as a timeline of what's on for each live channel

**Browsing**

- Separate tabs for live TV, movies and series, plus favorites, downloads and watch history
- Search by channel or title, and on live TV by programme name
- Pin, rename, reorder and create categories, so a playlist with thousands of channels stays manageable

**Playback**

- Plays nearly every IPTV stream format, including HLS, MPEG-TS, RTMP and RTSP, through [mpv](https://mpv.io) with hardware decoding
- Reconnects on its own when the stream or your network drops, and picks up where it left off
- Resumes movies and episodes where you stopped, with next episode and autoplay for series
- Skips intros, recaps and credits with a button or automatically, using times from [SkipDB](https://skipdb.tv) and [IntroDB](https://introdb.app)
- Keyboard shortcuts for playback; press <kbd>?</kbd> in the player to see them
- Subtitles from OpenSubtitles, with timing and position adjustment
- Keeps your screen awake while you watch

**More**

- Download movies, episodes or whole seasons to watch offline
- Record a live channel now, a program from the guide or any time range (macOS and Linux)
- Plot, cast and ratings for movies and series from OMDb
- Optional category sorting with Google Gemini
- Automatic updates

OpenSubtitles, OMDb and Gemini each need a free API key, which you add in Settings. Skip times need the OMDb key too.

<p align="center">
  <img src="docs/images/movies.jpg" width="49%" alt="The movies tab: a poster grid with genre filters, favorites and download status">
  <img src="docs/images/movie-details.jpg" width="49%" alt="A movie's details: poster, rating, cast, plot, source picker, and Play and Download buttons">
  <img src="docs/images/series.jpg" width="49%" alt="The series tab: recently played shows and a grid of series with favorite and download buttons">
  <img src="docs/images/series-details.jpg" width="49%" alt="A series' details: rating, creator, cast, plot, a partially downloaded tag, and a download button for each season">
</p>

<p align="center"><sub>Screenshots use made-up channels and titles.</sub></p>

## Getting started

1. Open **Playlists** and add a provider: an M3U URL, an M3U file, or an Xtream Codes server with your username and password.
2. If your playlist doesn't come with a programme guide, open the provider's settings and add an EPG (XMLTV) URL.
3. Go to **Channels** and pick something to watch.

Cinette doesn't come with any channels or content. You need a playlist from a provider you're allowed to use.

<p align="center">
  <img src="docs/images/playlists.jpg" width="49%" alt="The playlists page: the form for adding an M3U or Xtream Codes provider, and two providers already added">
  <img src="docs/images/settings.jpg" width="49%" alt="Settings: hardware decoding, default volume, and the Gemini and OMDb API key fields">
</p>

## FAQ

<details>
<summary>Does Cinette collect any data?</summary>

<br>

No. There are no accounts, analytics or telemetry. The app connects to the providers you add, to GitHub to check for updates, and to OMDb, OpenSubtitles or Google Gemini only if you add a key for them. When OMDb finds a title, the app also fetches extra ratings for it from [whatson-api](https://whatson-api.onrender.com), and times to skip from SkipDB and IntroDB. Your playlists, favorites and history stay in a database on your computer.

</details>

<details>
<summary>Where does the app keep its data?</summary>

<br>

In `~/Library/Application Support/app.cinette` on macOS and `~/.local/share/app.cinette` on Linux. Downloads go to the `downloads` folder inside it. Before 0.8.0, these folders were named `com.maxvideoplayer.app`, and the first launch of 0.8.0 renames them.

</details>

<details>
<summary>Is this the app that was called Max Video Player?</summary>

<br>

Yes. Max Video Player was renamed Cinette, and updating keeps your playlists, favorites, settings and downloads. They move to the folders above.

On a Mac, an update from inside the app keeps the old file name, so the app is still called Max Video Player in Applications. You can rename it to Cinette there. If you install Cinette from the DMG instead, delete the old Max Video Player app. On Linux, installing the `cinette` package removes the `max-video-player` package.

</details>

<details>
<summary>A stream won't play</summary>

<br>

Check whether the same URL plays in [mpv](https://mpv.io) or VLC. If it does, [open a bug report](https://github.com/MaxMB15/Cinette/issues/new?template=bug_report.yml) with your OS and app version. Leave out your playlist URL and login details.

</details>

<details>
<summary>The app updated and now won't open (macOS, version 0.5.0 or 0.5.1)</summary>

<br>

Versions 0.5.0 and 0.5.1 crash at launch, before they can check for updates. Download the [latest version](https://github.com/MaxMB15/Cinette/releases/latest/download/Cinette_aarch64.dmg), drag it into Applications and delete the old Max Video Player app. Your playlists and settings are kept.

</details>

## Contributing

Bug reports, ideas and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and [docs/development.md](docs/development.md) to build the app from source. Report security issues privately as described in [SECURITY.md](SECURITY.md).

If you find the app useful, you can [buy me a coffee](https://buymeacoffee.com/MaxMB15).

## Privacy

The app sends nothing to the developer. The [privacy policy](docs/privacy.md) lists what it keeps on your device, which services it connects to and what it sends them.

## Disclaimer

Cinette is only a player. It doesn't include, host, sell or link to any channels, playlists or streams. You add your own sources, and the author has no control over, and no knowledge of, what you add or watch.

The app is meant for content you have the legal right to watch, such as a service you subscribe to legally or streams you own. It isn't meant for pirated or otherwise illegally obtained content, and the author doesn't support using it that way.

You're responsible for what you play with it and for following the copyright and broadcasting laws where you live.

The app is provided as is, without warranty of any kind. As far as the law allows, the author and contributors aren't liable for any claim, damage or other loss arising from the app, from how anyone uses it, or from any content played with it. The [license](LICENSE) has the full terms, and [NOTICE](NOTICE) has the full legal notice.

## License

Cinette is free software. Anyone can use it for any purpose, and you can study, change and share the code under the [GNU General Public License version 3](LICENSE). Anything you distribute that's based on it has to use the same license and come with its source code.

The license has a few [additional terms](NOTICE), which section 7 of the GPL allows:

- Modified versions have to keep the credit "Based on Cinette by Max Boksem" on their About screen.
- Modified versions need their own name and icon. The license grants no trademark rights in the Cinette or Max Video Player names or logos. See [TRADEMARKS.md](TRADEMARKS.md).
- The author's name and the names Cinette and Max Video Player can't be used to endorse or promote another product without permission. Accurate statements such as "based on Cinette" don't need it.

If you need other terms, for example to ship it in a closed-source product, a commercial license is available. Get in touch through [github.com/MaxMB15](https://github.com/MaxMB15).

Releases up to and including 0.5.3 were published under the PolyForm Noncommercial License 1.0.0.

Under either name, it's an independent project and isn't affiliated with MaxPlayer, Max, Warner Bros. Discovery, or any product with a similar name.

Built with [Tauri](https://tauri.app), [mpv](https://mpv.io), [FFmpeg](https://ffmpeg.org) and [React](https://react.dev). [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists their licenses and where to get their source code.
