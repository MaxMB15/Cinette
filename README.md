<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Max Video Player icon">

# Max Video Player

A fast desktop IPTV player for macOS and Linux.<br>
Add your M3U playlist or Xtream Codes account and watch live TV, movies and series in one app.

[![Latest release](https://img.shields.io/github/v/release/MaxMB15/MaxVideoPlayer?label=release)](https://github.com/MaxMB15/MaxVideoPlayer/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/MaxMB15/MaxVideoPlayer/total)](https://github.com/MaxMB15/MaxVideoPlayer/releases)
[![Build](https://github.com/MaxMB15/MaxVideoPlayer/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/MaxMB15/MaxVideoPlayer/actions/workflows/build.yml)
[![Coverage](https://MaxMB15.github.io/MaxVideoPlayer/coverage/badge.svg)](https://MaxMB15.github.io/MaxVideoPlayer/coverage/)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue)](LICENSE)

[Download](#download) · [Features](#features) · [Getting started](#getting-started) · [FAQ](#faq) · [Contributing](CONTRIBUTING.md) · [Disclaimer](#disclaimer)

<br>

<img src="docs/images/channels.jpg" alt="The live TV tab: recently played channels, category filters, and a programme guide timeline for each channel">

</div>

## Download

| Platform | Download | Requirements |
| --- | --- | --- |
| **macOS** | [**Apple Silicon (.dmg)**](https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/MaxVideoPlayer_aarch64.dmg) | macOS 15 Sequoia or later on an M-series Mac |
| **Linux** | [**AppImage**](https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/MaxVideoPlayer_amd64.AppImage) · [Debian / Ubuntu (.deb)](https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/MaxVideoPlayer_amd64.deb) · [Fedora (.rpm)](https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/MaxVideoPlayer_x86_64.rpm) | x86_64 |
| Windows | Planned | |
| iOS, iPadOS | Planned | |
| Android, Fire TV | Planned | |

These links always point at the newest version. Older versions and release notes are on the [releases page](https://github.com/MaxMB15/MaxVideoPlayer/releases), and the [changelog](CHANGELOG.md) lists what changed in each one. Once installed, the app updates itself.

There's no version for Intel Macs or for macOS 14 and earlier. Older releases claimed to support them, but their bundled libraries needed macOS 15 on Apple Silicon too.

### Installing

**macOS.** Open the DMG and drag Max Video Player into Applications.

<details>
<summary>macOS says the app "can't be opened" or "is damaged"</summary>

<br>

Releases that aren't notarized by Apple are blocked by Gatekeeper the first time you open them. To open the app anyway:

1. Try to open Max Video Player once and close the warning.
2. Open System Settings → Privacy & Security, scroll down, and click **Open Anyway** next to the message about Max Video Player.
3. Confirm with your password or Touch ID.

If macOS says the app is damaged, run this in Terminal and open it again:

```bash
xattr -dr com.apple.quarantine "/Applications/Max Video Player.app"
```

</details>

**Linux AppImage.** It includes libmpv, so there's nothing else to install:

```bash
chmod +x MaxVideoPlayer_amd64.AppImage
./MaxVideoPlayer_amd64.AppImage
```

**Debian and Ubuntu.** `sudo apt install ./MaxVideoPlayer_amd64.deb` installs the app and the libraries it needs, including libmpv.

**Fedora.** `sudo dnf install ./MaxVideoPlayer_x86_64.rpm`

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
- Keyboard shortcuts for playback; press <kbd>?</kbd> in the player to see them
- Subtitles from OpenSubtitles, with timing and position adjustment
- Keeps your screen awake while you watch

**More**

- Download movies, episodes or whole seasons to watch offline
- Record a live channel now, a program from the guide or any time range (macOS and Linux)
- Plot, cast and ratings for movies and series from OMDb
- Optional category sorting with Google Gemini
- Automatic updates, checked at launch and every two hours

OpenSubtitles, OMDb and Gemini each need a free API key, which you add in Settings.

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

Max Video Player doesn't come with any channels or content. You need a playlist from a provider you're allowed to use.

<p align="center">
  <img src="docs/images/playlists.jpg" width="49%" alt="The playlists page: the form for adding an M3U or Xtream Codes provider, and two providers already added">
  <img src="docs/images/settings.jpg" width="49%" alt="Settings: hardware decoding, default volume, and the Gemini and OMDb API key fields">
</p>

## FAQ

<details>
<summary>Does Max Video Player collect any data?</summary>

<br>

No. There are no accounts, analytics or telemetry. The app connects to the providers you add, to GitHub to check for updates, and to OMDb, OpenSubtitles or Google Gemini only if you add a key for them. When OMDb finds a title, the app also fetches extra ratings for it from [whatson-api](https://whatson-api.onrender.com). Your playlists, favorites and history stay in a database on your computer.

</details>

<details>
<summary>Where does the app keep its data?</summary>

<br>

In `~/Library/Application Support/com.maxvideoplayer.app` on macOS and `~/.local/share/com.maxvideoplayer.app` on Linux. Downloads go to the `downloads` folder inside it.

</details>

<details>
<summary>A stream won't play</summary>

<br>

Check whether the same URL plays in [mpv](https://mpv.io) or VLC. If it does, [open a bug report](https://github.com/MaxMB15/MaxVideoPlayer/issues/new?template=bug_report.yml) with your OS and app version. Leave out your playlist URL and login details.

</details>

<details>
<summary>The app updated and now won't open (macOS, version 0.5.0 or 0.5.1)</summary>

<br>

Versions 0.5.0 and 0.5.1 crash at launch, before they can check for updates. Download the [latest version](https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/MaxVideoPlayer_aarch64.dmg) and install it over the old one. Your playlists and settings are kept.

</details>

## Contributing

Bug reports, ideas and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and [docs/development.md](docs/development.md) to build the app from source. Report security issues privately as described in [SECURITY.md](SECURITY.md).

If you find the app useful, you can [buy me a coffee](https://buymeacoffee.com/MaxMB15).

## Disclaimer

Max Video Player is only a player. It doesn't include, host, sell or link to any channels, playlists or streams. You add your own sources, and the author has no control over, and no knowledge of, what you add or watch.

The app is meant for content you have the legal right to watch, such as a service you subscribe to legally or streams you own. It isn't meant for pirated or otherwise illegally obtained content, and the author doesn't support using it that way.

You're responsible for what you play with it and for following the copyright and broadcasting laws where you live.

The app is provided as is, without warranty of any kind. As far as the law allows, the author and contributors aren't liable for any claim, damage or other loss arising from the app, from how anyone uses it, or from any content played with it. The [license](LICENSE) has the full terms, and [NOTICE](NOTICE) has the full legal notice.

## License

Max Video Player is free software. Anyone can use it for any purpose, and you can study, change and share the code under the [GNU General Public License version 3](LICENSE). Anything you distribute that's based on it has to use the same license and come with its source code.

The license has a few [additional terms](NOTICE), which section 7 of the GPL allows:

- Modified versions have to keep the credit "Based on Max Video Player by Max Boksem" on their About screen.
- Modified versions need their own name and icon. The license grants no trademark rights in the Max Video Player name or logo. See [TRADEMARKS.md](TRADEMARKS.md).
- The author's name can't be used to promote another product without permission.

If you need other terms, for example to ship it in a closed-source product, a commercial license is available. Get in touch through [github.com/MaxMB15](https://github.com/MaxMB15).

Releases up to and including 0.5.3 were published under the PolyForm Noncommercial License 1.0.0.

It's an independent project and isn't affiliated with Max, Warner Bros. Discovery, or any product with a similar name.

Built with [Tauri](https://tauri.app), [mpv](https://mpv.io), [FFmpeg](https://ffmpeg.org) and [React](https://react.dev). [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists their licenses and where to get their source code.
