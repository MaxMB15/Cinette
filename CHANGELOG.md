# Changelog

All notable changes to Max Video Player are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Max Video Player is now licensed under the GNU General Public License version 3. Its additional terms require modified versions to credit the original on their About screen and to use their own name and icon. Releases up to 0.5.3 stay under the PolyForm Noncommercial License 1.0.0. See NOTICE and TRADEMARKS.md (#75).
- Pull requests now need the contributor agreement in CLA.md (#75).
- With no OMDb key set, the app no longer asks whatson-api for ratings, even for titles whose details it saved earlier (#92).
- Without an OMDb API key, the movie and series info sheets say that a key adds the plot, cast and ratings, and link to the key field in Settings (#96).
- The channel, movie and series info panes close when you drag them down, and grow to full height when you drag them up (#91).
- The start screen shows the app icon in place of the blue play badge (#95).

### Added

- Settings > About shows the copyright and license, with links to the license, additional terms, third-party notices and source code of the version you're running (#75).
- THIRD_PARTY_NOTICES.md lists the licenses of mpv, FFmpeg and every library bundled in the macOS app. The app now includes it, along with LICENSE, NOTICE and TRADEMARKS.md (#75).
- M3U playlists can mark an entry as a movie or series with a `tvg-type` attribute, for entries whose URLs don't say which it is (#92).
- A privacy policy in docs/privacy.md, linked from Settings > About, and a demo playlist of free test streams and Blender films in docs/demo (#92).
- Skip back and skip forward buttons beside play and pause. Settings > Playback sets how far each one jumps, from 5 to 60 seconds, and the arrow keys, J and L and the lock screen on iPhone and iPad use the same lengths (#90).
- On phones and tablets, play and pause and the skip buttons sit in the middle of the video. A double-tap on the left or right side skips back or forward, and each further tap there skips again (#90).
- The player shows a spinner while a stream opens, so a slow server no longer looks like a black screen. If the stream never starts, the player says so and offers Retry (#97).
- Settings > Downloads > Delete downloads after. It deletes finished downloads 7, 14, 30 or 90 days after they were downloaded or last played. Keep on a download holds on to it. The Downloads tab, the movie and series pages and the download history show when each download goes. Downloads that came due while the app was closed go an hour after it opens, which leaves time to keep or play them (#100).

### Fixed

- The app could lose track of whether its window was in full screen after the green button or the View menu on macOS, or after a second change made while the first was still animating. The sidebar then stayed hidden after leaving full screen or showed in it, and the full screen button and Escape acted on the wrong state. The app now follows the window's own state, and checks it again a second after its own changes in case macOS turned one down (#113).
- Holding down a player shortcut now acts once, except for seeking and volume, which still repeat. A held F or Space flipped back and forth, and a held Escape left full screen and then the player (#113).
- The dot on the seek bar sometimes sat apart from the end of the colored part, mostly when a video started. It also jumped back for a moment after a seek, and stopped following playback after you moved it with the arrow keys. Clicking the seek bar no longer turns off the player's keyboard shortcuts (#111).
- Closing the player in full screen left the window in full screen, and the player came back in full screen the next time it opened. Closing the player now leaves full screen, unless the window was already in full screen when the player opened (#96, #113).
- A movie or episode that kept playing after you closed the player didn't save where you were, so it resumed from the moment you closed the player (#88).
- A failed guide download, or one that comes back empty or as an error page, no longer wipes the TV guide you already had (#105).
- Error messages and logs no longer show your API keys, Xtream login or the login in a playlist link (#105).
- Testing a wrong OpenSubtitles key says the key is invalid instead of showing a request error (#105).
- Xtream logins that contain & or + now load (#105).
- The Gemini key is sent in a request header instead of the request URL (#105).
- Spaces or a line break pasted around an API key no longer make the key fail (#105).
- Online lookups and Xtream logins give up after a timeout instead of waiting forever on a server that stopped responding (#105).
- Large playlists on a slow connection no longer fail after 10 minutes while they are still downloading (#105).
- Refreshing two M3U playlists at the same time no longer mixes up their downloads (#105).
- The player's logs no longer show the login in a stream's link when a channel starts, buffers or reconnects (#106).
- Removing a playlist or provider left its watch history, saved positions, episode lists, guide data and category layout behind. Cached Xtream episode lists hold the provider's login, so the login stayed too (#92).
- Clear All Caches left cached episode lists, guide data and downloaded subtitles behind (#92).
- A removed download stayed on the Downloads tab until the app restarted (#100).
- Removing a download whose file can't be deleted now keeps it in the list and says which file and why. Removing a season or series carries on with the other episodes. Before, the download left the list but its file stayed on disk (#100).
- Holding a subtitle delay button keeps stepping the delay again (#104).
- Settings says when the update check fails, instead of showing the app as up to date (#104).
- Clear all in recently played clears that row's whole history, and dismissing a show removes every episode you watched, including ones older than the row lists. Each row now loads its own type, so a run of live channels no longer pushes movies and series out of their rows (#104).
- A provider whose playlist or guide refresh fails waits longer before each new try instead of trying every minute, which for Xtream meant a login a minute. A slow refresh is no longer started a second time while it runs (#104).
- The splash screen and the donation prompt work when the browser storage is blocked, and the splash screen finishes even when a startup step fails (#104).
- Pressing Enter on a group's pin button pins the group instead of opening it, and Enter on a channel row's favorite button no longer starts the channel (#104).
- Watch history rows play from the keyboard and show their delete button on focus. Screen readers now find the favorite button on movie and series posters, and name the subtitle picker buttons and the group pin button. Enter or Space steps the subtitle delay (#104).
- Downloads that were running when the app quit now start again at the next launch, and queued downloads start too. Before, each interrupted download held one of the download slots until it was stopped or deleted, and the queue sat idle until another download was added. Quitting the app now stops its downloads. Before, they kept running in the background after the app closed. A download whose ffmpeg can't start now shows as failed, and the next one in line takes its place (#99).
- Opening the app while it's already running now brings its window to the front. Before, a second copy started, and both could run the same downloads. On Linux this needs a D-Bus session bus. Without one, the app logs a warning and a second copy still opens (#99).
- Two downloads with the same title now save to separate files, numbered like "Dune (2).mkv". Before, they wrote to the same file, and a file already in the folder with that name was replaced (#99).
- A queued download whose playlist entry turned into another title after a refresh now fails and asks you to download it again. Before, it could save the other title under the first one's name (#99).

## [0.5.3] - 2026-10-09

### Added

- A short disclaimer under Add Provider on the Playlists page, with a link to the full disclaimer (#73).

### Changed

- The macOS app is signed with a Developer ID certificate and notarized by Apple, so it opens without a Gatekeeper warning (#67, #70).
- Release downloads no longer have the version in their file names, so links to the latest release always get the newest version.

### Fixed

- The Hardware decoding and Default volume settings had no effect. Hardware decoding now applies from the next video, and new sessions start at the default volume (#69).
- The download folder and the number of downloads that run at once reset when the app restarted (#69).

## [0.5.2] - 2026-10-09

If you are on 0.5.0 or 0.5.1 on macOS, download 0.5.2 manually from the releases page. Those builds crash before they can check for updates, so they cannot update themselves.

### Fixed

- The crash at launch on macOS in 0.5.0 and 0.5.1, caused by duplicate LC_RPATH entries in the bundled libmpv and a bundled SDL library that required SDL3 (#65).

### Changed

- macOS 15 (Sequoia) on Apple Silicon is now the declared minimum. Earlier versions declared macOS 10.15 but needed macOS 15, and 0.5.0 and 0.5.1 needed macOS 26.4 (#65).

## [0.5.1] - 2026-10-09

- Maintenance release. This is a rebuild of 0.5.0 with no code changes, and the macOS build still crashes at launch. Use 0.5.2 instead.

## [0.5.0] - 2026-10-09

The macOS build of this version crashes at launch and needs macOS 26.4, although it declares an older minimum. Use 0.5.2 instead.

### Added

- Offline downloads for movies and series episodes, with download controls on cards, info panels, the series drawer (per episode and per season) and the player (#63).
- A Downloads tab and a Downloads filter (#63).
- Settings for the download folder and the number of downloads that run at once, and a download history view (#63).
- A retry option for failed downloads (#63).
- Offline episode lists for downloaded series (#63).
- A prompt to resume partially watched movies and episodes (#63).
- A source picker in the player controls and info panels. Switching sources keeps your position (#63).
- Keyboard shortcuts: K to play or pause, F or double-click for fullscreen, M to mute, J and L to seek (with Shift for 30 seconds), 0 to 9 to jump through the video, Home to restart, N and P for the next and previous episode, S for subtitles, I for info, and ? to list all shortcuts (#63).
- On-screen feedback when seeking and changing the volume (#63).
- A message for searches with no results, with a button to clear the search (#63).

### Changed

- The app's visible name is now "Max Video Player" (#63).
- Switching tabs keeps your search text (#63).
- Leaving the player returns to the tab you came from (#63).
- Episodes play directly from History (#63).
- The app remembers the volume between sessions, and unmuting restores the previous volume (#63).
- Xtream shows split across several series are merged into one, with duplicate episodes listed as extra sources (#63).

### Fixed

- The startup screen reporting failed playlist and EPG refreshes as done (#63).

### Removed

- The channel list inside the player, opened with the C key (#63).

## [0.4.9] - 2026-05-25

### Added

- Automatic reconnection after network outages, resuming playback where it stopped (#62).
- A connection status overlay that shows connection issues, a lost connection with the attempt count, an unavailable stream with a Retry button, and a restored connection (#62).

## [0.4.8] - 2026-04-18

### Changed

- On Linux X11 sessions, video now plays in a separate window. It still plays inside the app on Wayland (#61).

### Fixed

- A black screen in the AppImage on Wayland (#61).
- Video corruption when resizing the window on Linux (#61).
- A crash and a screen flash when stopping playback on Linux (#61).
- Player keyboard controls not working until the player was clicked (#61).
- The startup screen closing before channels finished loading (#61).
- Audio being turned off by a system or user mpv config on Linux. The app now ignores mpv.conf (#61).

## [0.4.7] - 2026-04-08

### Changed

- The .deb and .rpm packages now depend on the audio and subtitle libraries, and in-app .deb updates install any that are missing (#60).

### Fixed

- Missing audio on Linux when the system libmpv had no audio output. The AppImage now includes its own libmpv with audio support (#60).

## [0.4.6] - 2026-04-07

### Added

- Keep the display awake during playback on macOS and Linux (#58).

### Fixed

- Video hidden behind a black screen on some Linux desktops, such as Pop!_OS with COSMIC (#58).

## [0.4.5] - 2026-04-06

- Maintenance release.

## [0.4.4] - 2026-04-06

### Fixed

- In-app updates for .deb installs failing because the downloaded package was deleted before installation (#55).

## [0.4.3] - 2026-04-05

### Fixed

- A transparent flash when playback starts (#52).
- A black screen in the AppImage (#52).
- Crashes on Linux systems with software-only graphics, such as llvmpipe. The app now uses software rendering there (#52).

## [0.4.2] - 2026-04-04

### Added

- In-app updates for .deb and .rpm installs on Linux, which ask for your password to install (#47).

### Changed

- The Linux packages now depend on EGL (#48).

### Fixed

- A crash on Linux when EGL is unavailable. Video now opens in a separate player window instead (#48).

## [0.4.1] - 2026-04-03

### Added

- Category browsing for channel groups, with breadcrumbs (#44).
- A pinned groups row and a Recently Played row (#44).
- Manage Categories, for creating, renaming, deleting and resetting categories (#44).
- Optional automatic group categorization using a Gemini API key set in Settings (#44).

### Fixed

- Movie and series grids not fitting the window width after a resize (#44).

## [0.4.0] - 2026-04-03

### Fixed

- A crash when opening a stream in Linux Wayland sessions (#39, #40).

## [0.3.8] - 2026-03-27

### Changed

- Ratings and posters come from the Whatson API, which needs no API key, instead of MDBList (#30).

### Fixed

- Channel logos and posters served over HTTP not loading on macOS (#30).
- Broken images when a channel logo or poster fails to load. A placeholder is shown instead (#30).

### Removed

- The MDBList API key setting (#30).

## [0.3.7] - 2026-03-24

- Maintenance release.

## [0.3.6] - 2026-03-24

### Changed

- Settings always shows the Check for Updates button (#21).

### Fixed

- The startup screen getting stuck on the update check (#21, #24).

## [0.3.5] - 2026-03-24

- Same code as 0.3.4. There is no separate download for this version.

## [0.3.4] - 2026-03-24

### Added

- A button in Settings to check for and install updates (#18).

### Fixed

- Settings showing a fixed version number instead of the installed version (#18).
- Failed update installs not showing an error (#18).

## [0.3.3] - 2026-03-24

### Added

- Linux downloads (.deb, .rpm and AppImage) on each release (#15).

## [0.3.2] - 2026-03-24

This version was not published. Its changes first shipped in 0.3.3.

### Added

- Linux support, with video playing inside the app on X11 and Wayland (#5, #8).
- .deb, .rpm and AppImage packages and automatic updates on Linux (#8).

## [0.3.1] - 2026-03-20

- Maintenance release.

## [0.3.0] - 2026-03-20

This version was not published. Its changes first shipped in 0.3.1.

### Added

- A startup screen that shows playlist, EPG and update progress (#1, #3).
- An optional support prompt, shown at most once every 30 days, and a Support card in Settings (#1, #3).
- An update check every 2 hours while the app is running.

### Fixed

- Scheduled playlist and EPG refreshes being skipped or delayed. Overdue providers now refresh at startup instead of after 60 seconds.

## [0.2.2] - 2026-03-16

- Maintenance release.

## [0.2.1] - 2026-03-16

This version was not published. Its changes first shipped in 0.2.2.

### Fixed

- The update check never running because the app lacked the permissions it needed.

## [0.2.0] - 2026-03-16

### Added

- Video playback inside the app on macOS (Apple Silicon), powered by mpv.
- Support for M3U playlists and Xtream Codes accounts.
- Browsing for live channels, movies and series, with search and group filters.
- A source picker for movies available from more than one source.
- A series view with seasons and episodes, episode navigation and autoplay of the next episode.
- A program guide (EPG) for live channels, with a timeline, the full schedule in the info panel, automatic EPG URL detection and scheduled refreshes.
- Favorites and a Favorites tab.
- A History tab.
- Ratings from OMDb and MDBList, using optional API keys.
- Subtitle search through OpenSubtitles, with position and delay controls.
- A banner that announces new versions.

[Unreleased]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MaxMB15/MaxVideoPlayer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MaxMB15/MaxVideoPlayer/releases/tag/v0.2.0
