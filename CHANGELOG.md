# Changelog

All notable changes to Cinette, formerly called Max Video Player, are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- On iPhone and iPad, the player has an AirPlay button when an AirPlay TV is in reach. It sends the channel, movie or episode that's playing to the TV, which plays it straight from your provider, and a movie or episode carries on from where it was. Streams the TV can't play as they are, such as MKV files and most raw MPEG-TS channels, stay on the iPhone and Cinette says why (#323).
- AirPlay now also sends streams the TV can't play as they are, such as MKV files, most raw MPEG-TS channels, and MP2, Dolby Digital or DTS audio. The iPhone or iPad converts them while they play and asks first, since it has to stay on Wi-Fi for that, though it can lock (#329).
- On macOS, the player has an AirPlay button too. Pick a TV in the AirPlay menu and the channel, movie or episode plays there, from where it was. The Mac converts what the TV can't play as it is, with the bundled ffmpeg, and stays awake while it does. The Mac's own sound stays here, so Play here just stops AirPlay. If no TV takes the video, it plays on the Mac again from where it was (#338).
- On macOS and Linux, the player has a Cast button when a Google Cast device, such as a Chromecast or a TV with Chromecast built in, is on the network. It lists each device with how the item playing would get there: straight from your provider, or converted by this computer, which then has to stay on, and Cinette asks first. Casting stops the item here and carries a movie or episode on from where it was. While it casts, the player shows where it plays, with play, pause, seek, volume, the previous and next episode, stop and play here. Another channel, movie or episode picked meanwhile plays on the same device, after asking when this computer would start converting it. If the connection is lost, Cinette says so. When macOS keeps Cinette off the local network, or a VPN is on that may block it, the Cast and Devices lists say so. Settings > Google Cast > Stream through this computer sends everything you cast through this computer, so the TV never gets your provider's link and the stream uses this computer's connection and VPN.
- The player answers a keyboard's media keys. Play/pause, play and pause work as you'd expect, fast forward and rewind skip by the lengths set in Settings, and next and previous change the episode (#312).
- On macOS and Linux, one Cinette can control another on the same network. Choose Devices in the sidebar and pick the other device; it plays there, and this one shows what's playing, with play, pause, stop and that device's channels, movies and series to choose from. Under Only when allowed, the default, the other device asks first, and both screens show the same code so you can tell your own request from someone else's. Settings > Remote control sets whether others can find this device, who may control it (Always allow, Only when allowed, Never allow), its name, lists the devices controlling it, each with Disconnect, and can give this device a new identity, which ends every session. macOS asks once whether Cinette may use the local network; if that was refused, the device list says where to allow it. Nothing leaves your network, and no stream address, login or playlist setting is sent to the other device (#317, #318, #319, #321, #322).
- While one Cinette controls another, it can send that device its providers, so a TV with nothing set up gets the same playlists. Choose Send providers in the bar at the top and pick them. The other device always asks first, even under Always allow, and shows the same code. Each provider, with its login, is saved there as that device's own and loads as if added by hand; one it already has is skipped, and one with a name it already uses gets this device's name after it. Playlists that are files on this device and API keys aren't sent.
- While one Cinette controls another, Transfer history copies watch history, the places you stopped in movies and episodes, favorites and pinned groups from one device to the other, either way. The other device always asks first and shows the same code. Items are matched by the provider's own ids when both devices use the same account, and otherwise by channel guide ids, IMDb ids or titles; anything that doesn't match exactly is listed and left out rather than swapped for something else. The newer viewing wins, nothing is deleted on either device, and doing it twice changes nothing. Afterwards the device that received it offers to continue what the other one was watching, at the same place.
- A movie or episode watched to the end now counts as watched, rather than being forgotten, so a history transfer carries that too. It still isn't offered to resume.

### Changed

- The channel list scrolls and searches with far less work. While you scroll, only the rows redraw, not the tabs and category filters around them, and typing a search no longer redraws every category. The app is now built with the React Compiler, which skips redrawing what hasn't changed (#307).
- Going back to a tab, opening a movie's or a show's details again and opening a channel's schedule again show what the app already loaded, instead of asking for it again. A guide refresh, a new playlist or an edit still loads what it changed (#308, #310, #311, #313, #314, #315).

### Fixed

- A subtitle file you picked while a stream was still opening, or while it reconnected, could fail to show, even though the player kept it as picked. The player now adds it as soon as the stream has opened (#340).

## [0.8.0] - 2026-10-17

### Added

- The project has a website at https://maxmb15.github.io/Cinette/. It shows what the app does and links each download of the latest release with its size (#288).

### Changed

- Max Video Player is now called Cinette. Updating keeps your playlists, favorites, settings and downloads. On a Mac, an update from inside the app keeps the old file name in Applications, and you can rename the app there. The installers' names now start with `Cinette_`, and on Linux the `cinette` package replaces the `max-video-player` package (#293).
- The project moved to https://github.com/MaxMB15/Cinette. Links to github.com/MaxMB15/MaxVideoPlayer still work, and so do updates from older versions (#294).
- Cinette has a new icon, and the website uses it too (#295).
- The app's identifier is now `app.cinette`, so its folders have new names, such as `~/Library/Application Support/app.cinette` on macOS and `~/.local/share/app.cinette` on Linux. The first launch moves your playlists, favorites, settings, downloads and player preferences there from the old `com.maxvideoplayer.app` folders, so an older version opened afterwards starts empty. macOS may ask again to let the app find devices on your local network (#296).
- The demo playlist in `docs/demo` has a made-up guide for its live test streams. Its pictures now load from this repo, and Amazon's IVS test stream replaces Akamai's, which no longer plays (#289).

### Fixed

- After you added a playlist or an Xtream account, the Live tab showed no TV guide for it until you switched tabs, restarted the app or a few hours went by. The app now downloads the guide as soon as you add one, and the channel list shows it once it's in. The list now also shows a guide that refreshes at startup, on its schedule or with Refresh EPG in a playlist's settings, without switching tabs. Refresh EPG also puts off the next automatic refresh of that guide by a full interval (#290).

## [0.7.0] - 2026-10-17

### Added

- Max Video Player now runs on Intel Macs with macOS 15 Sequoia or later. Each release has a DMG for Apple Silicon and one for Intel, and the app updates itself on both (#287).

### Changed

- Settings and Manage Categories now say what the app sends to Google Gemini. When you use an AI action in Manage Categories, the app sends Google Gemini your group and category names and a few channel, movie or series names from each group (#256).
- The log now says which mpv version the app runs and, on Linux, which libmpv file it loaded. On Linux, the error the player shows when mpv fails to start names that file too, since a libmpv from somewhere else is the usual cause (#260).
- Downloads and recordings on macOS and Linux now use ffmpeg 8.1, up from 7.0 on macOS and 7.0.2 on Linux. It has fixes in the code that reads HLS, MPEG-TS and MP4 streams. It's now built with only what downloads and recordings need, so it takes up 8 MB on macOS, down from 49 MB, and 4 MB on Linux, down from 80 MB. It's licensed under the LGPL rather than the GPL. It can't download DASH streams, whose links end in `.mpd`. The earlier macOS build couldn't either, but the Linux one could (#276, #284).

### Fixed

- On macOS, the player kept the video view and its graphics context from every channel it played, so memory use grew each time you switched channels. It now frees them (#251).
- The subtitles the app draws itself, whose position and size you can change, misread some subtitle files. In an SRT file, text after a blank line inside a subtitle never showed. Two subtitles with only a line of spaces or tabs between them, or with no blank line at all, showed as one, with the second one's number and times in the text. A file with extra carriage returns at the end of each line showed nothing. A subtitle with position values after its end time, such as `X1:100`, or WebVTT settings such as `align:start`, never showed. A time without hours, which WebVTT files use, showed the subtitle from the start of the video or not at all. All of these now show at their own times. The app now reads times the way mpv does, so a timing line without milliseconds, or a WebVTT time with a comma before the milliseconds, no longer starts a subtitle, and `00:00:01,5` starts at 1.005 seconds rather than 1.5. In an SRT file, such a timing line shows as text in the subtitle before it, as it does in mpv, and so does text after the last subtitle, like a credit at the end of the file (#267).
- A subtitle file with many `<` signs on one line, and no `>` after them, froze the app while it loaded. A line of 100,000 of them took about 4 seconds. Such a line now takes under a millisecond (#270).
- With an OMDb key set, the info for many movies and series with titles in another writing system, such as Russian, Greek, Arabic or Japanese, and for some titles with accented letters, stayed on "Loading info…". It now finishes loading (#259).
- On iPhone and iPad, the app's log could still show part of an Xtream login from a stream's link. That happened when the user name or the password had a `?` or `#` and then a space, or when a catch-up link had a space in the password. On macOS and Linux, an error from a download or a recording could also show the password when the link had no user name, or the user name when it had no password. In these cases the log and the errors now hide the whole login (#258).
- When you left the player while a video played on and came back to it from the sidebar, the subtitles you picked were gone, and subtitles still loading for the next episode never showed. They now come back with the place, size, font and delay you gave them, and the next episode's subtitles finish loading. Subtitles you pick just before the next episode starts no longer show over it (#269, #282).
- The subtitles the app draws could start and end up to a second late, and could skip a short subtitle altogether, since the app reads the video's position once a second. They now start and end on time, also right after a seek or a reconnect. A delay such as +1.5s in the subtitle picker now shows them later, as mpv does with the same delay. It used to show them earlier (#269, #279).
- When the app can't show the video itself, as on Linux with X11, mpv plays it in a window of its own. That window had no controls and ignored the keyboard. It now takes mpv's keys, such as Space to pause and the arrow keys to seek. On Linux it also has mpv's own controls, which show when you move the mouse over it. Closing the window, or pressing `q` there, now stops playback and takes the app back to the channel list (#277).
- The player page wasn't allowed to send mpv the subtitles you picked, so mpv never showed them. When mpv plays the video in a window of its own, as on Linux with X11, the subtitles showed on the player page, away from the video, and never in that window. They now show in the window, with the delay you set, also when you pick them as the video starts. They stay when the stream reconnects, when you press Retry or when you switch to another source of the same movie or episode. A subtitle file the app can't read itself, such as one that isn't UTF-8, failed to load or showed nothing. mpv now shows it. A subtitle track that came with the stream, and that mpv showed on its own, no longer shows under the subtitles you pick (#269, #277, #281, #283).
- When a stream failed to open and yt-dlp was installed, mpv could pass the stream's link, login included, to yt-dlp. mpv no longer uses yt-dlp (#277).
- If you left the player right after picking a movie, episode or channel, before it began to load, it could start anyway. The player then showed what played before it, with the episode list of the episode you picked. A movie or episode with a saved resume point also paused what was playing for a prompt you never saw. Leaving the player now stops the start, and what was playing keeps playing (#278).
- Picking None in the subtitle list while a subtitle still downloaded didn't stop that download, so the subtitle showed up anyway. When the next episode started, a subtitle you picked while its subtitles still loaded on their own was replaced by those once they arrived. What you picked last now stays (#280).

## [0.6.1] - 2026-10-13

### Changed

- Some icons have newer drawings. Play has rounded corners, the pause bars are wider, the skip icons are bigger, and the favorites heart and the settings gear have new shapes (#223).
- Some colors are a little more vivid, such as the green checks on the start screen and the Live, Movie and Series badges (#236).
- The Linux .deb and .rpm now require WebKitGTK 2.40 or later, which the app's styles need. Every release they support already has it (#242).
- While the TV guide loads, a channel still waiting for its programs shows an empty bar rather than "no epg" (#243).

### Fixed

- Some programs in the TV guide had no title or description. One with a bare `&` or an HTML entity such as `&nbsp;` came out blank, and so did one wrapped in CDATA. These now show, with an HTML entity left as written. A channel whose guide ID has an `&`, which the guide writes as `&amp;`, showed no programs at all (#220).
- With autoplay on, pausing an episode in its last 5 seconds started the next one. Pressing Next episode there and then cancelling its resume prompt left the episode paused. The player now goes on to the next episode only when it sees one play to its end (#218).
- Removing an entry from the History tab loaded the whole list again, so a spinner took its place and the list scrolled back to the top. Now only that entry goes (#230).
- On the Live tab, clearing the search just after typing could leave programs from the guide search showing above the channels (#230).
- After the app started, the TV guide showed 3 hours however wide the window was, and the movie and series posters were sized for an 800 pixel wide list. Opening the Channels page while a new playlist was still loading did the same. It lasted until you resized the window, switched tabs or left the page. The list now measures itself as soon as the channels show (#235).
- On a window wide enough for more than 6 hours of TV guide, programs near its left and right edges were missing. The guide now loads everything it shows (#235).
- The TV guide now shows the lines it was meant to have. The channel list has a faint line at every half hour beside its hour lines, and each channel's programs have lines at every hour and half hour and a thin light edge along the top (#236).
- On phones and tablets, the remove buttons in Recently played, History and the pinned groups only showed on hover, which a touch screen doesn't have. They're always shown there now. The unpin button on a pinned group also shows when you reach it with the Tab key, like the other two (#236).
- While the Channels page stayed open, the TV guide stayed on the hours from when the page opened, until you resized the window or left the page. After a while it showed programs that had already ended, and the red line for now only moved when something else on the page changed. The guide now moves along with the clock and loads more programs as it goes (#237).
- The Favorites tab showed no TV guide for its live channels until you'd opened the Live tab. It now loads the guide itself, only for its own live channels (#237, #243).
- With a 12-hour clock, some times in the TV guide wrapped onto two lines, with the AM or PM under the time. That happened to every start time in the schedule in the player's info drawer, and to the time labels near the right edge of a guide timeline. They stay on one line now (#238).
- The Linux .deb installed on Ubuntu 22.04, and then the app wouldn't start because 22.04's libmpv is too old for it. The .deb now requires the newer libmpv that Debian 12 and Ubuntu 24.04 have, so it won't install on 22.04 (#242).
- With the Linux .deb on Debian 12 or Ubuntu 24.04, whose libmpv is older than mpv 0.38, resuming a movie or episode where you left off failed with an error. So did reconnecting after a stream dropped, and the Retry button once a stream had played for more than a second. They now work with these older versions of mpv too (#245).

### Removed

- The Platform card in Settings, which showed the platform and the layout (#239).

## [0.6.0] - 2026-10-12

### Changed

- Max Video Player is now licensed under the GNU General Public License version 3. Its additional terms require modified versions to credit the original on their About screen and to use their own name and icon. Releases up to 0.5.3 stay under the PolyForm Noncommercial License 1.0.0. See NOTICE and TRADEMARKS.md (#75).
- Pull requests now need the contributor agreement in CLA.md (#75).
- With no OMDb key set, the app no longer asks whatson-api for ratings, even for titles whose details it saved earlier (#92).
- Without an OMDb API key, the movie and series info sheets say that a key adds the plot, cast and ratings, and link to the key field in Settings (#96).
- The channel, movie and series info panes close when you drag them down, and grow to full height when you drag them up (#91).
- The start screen shows the app icon in place of the blue play badge (#95).
- The OpenSubtitles key field shows up once an OMDb or OpenSubtitles key is saved, not as soon as an OMDb key is typed, and then stays until you leave Settings (#120).
- Downloading a movie or episode that has already finished hands back the finished download instead of downloading it again. If its file was deleted, it downloads again (#107).

### Added

- Settings > About shows the copyright and license, with links to the license, additional terms, third-party notices and source code of the version you're running (#75).
- THIRD_PARTY_NOTICES.md lists the licenses of mpv, FFmpeg and every library bundled in the macOS app. The app now includes it, along with LICENSE, NOTICE and TRADEMARKS.md (#75).
- M3U playlists can mark an entry as a movie or series with a `tvg-type` attribute, for entries whose URLs don't say which it is (#92).
- A privacy policy in docs/privacy.md, linked from Settings > About, and a demo playlist of free test streams and Blender films in docs/demo (#92).
- Skip back and skip forward buttons beside play and pause. Settings > Playback sets how far each one jumps, from 5 to 60 seconds, and the arrow keys, J and L and the lock screen on iPhone and iPad use the same lengths (#90).
- On phones and tablets, play and pause and the skip buttons sit in the middle of the video. A double-tap on the left or right side skips back or forward, and each further tap there skips again (#90).
- The player shows a spinner while a stream opens, so a slow server no longer looks like a black screen. If the stream never starts, the player says so and offers Retry (#97).
- The player can skip intros, recaps, credits and previews of the next episode. Settings > Playback sets intros and recaps, and credits and previews, each to a Skip button, Automatic or Off. Automatic skips once playback reaches the part, and shows Undo for a few seconds. At the end credits, with autoplay on, it counts down to the next episode instead. Enter skips too. The times come from SkipDB and IntroDB and need an OMDb key. The player checks them against the length of the video. It drops times made for a much longer or shorter cut, and shows the button instead of skipping when it can't be sure the times fit (#112).
- Settings > Downloads > Delete downloads after. It deletes finished downloads 7, 14, 30 or 90 days after they were downloaded or last played. Keep on a download holds on to it. The Downloads tab, the movie and series pages and the download history show when each download goes. Downloads that came due while the app was closed go an hour after it opens, which leaves time to keep or play them (#100).
- Recordings of live channels on macOS and Linux. In the player's info drawer, record the channel now, record a program from the guide or record a time range of up to 12 hours. A program's recording starts 2 minutes early and runs 5 minutes over, which you can change in Settings > Downloads. The app has to stay open, with the computer awake, while it records. Recordings are MPEG-TS files in a recordings folder inside the download folder. The Downloads tab lists them with their size as it grows and buttons to cancel, stop, play or delete, and Delete downloads after removes finished recordings too unless you keep them. While a recording runs, other downloads from the same provider wait, since many providers allow one stream at a time. A recording whose stream fails tries again up to 3 times. A stopped recording keeps what it recorded, and so does one that was running when the app quit. If its program is still on at the next launch, the rest is recorded too (#109).

### Fixed

- Channels went missing from M3U playlists that put lines such as `#EXTVLCOPT` or `#EXTGRP` between a channel and its link. They show up now. The app numbers channels by their place in the playlist, so in such a playlist the first refresh can move favorites, downloads, saved movie details and recently played channels to a different channel, once (#126).
- A TV guide failed to load when a program's time had a letter such as é in the wrong place. Now the rest of the guide loads (#126).
- On Linux with Wayland, on desktops where the app draws its own title bar, such as COSMIC on Pop!_OS, the video slid out of place when the window went full screen or was maximized. It sat lower and further right by the size of the title bar and the window's shadow, and its edges were cut off. The video now moves with the page (#119).
- A download of an HLS movie showed the wrong progress. The app took the size of the movie's playlist, a few hundred bytes, as the size of the movie, so the bar was full from the start and the download history showed percentages in the thousands. The bar now pulses while the size is unknown, and the history shows how much has been saved (#117).
- Most downloads waited close to a minute before they finished, and an HLS download waited that long before it started. ffmpeg took the normal end of each file and playlist for a dropped connection and kept trying to reconnect (#117).
- A download from a server that can't resume one went back to the start of the movie after the connection dropped, and wrote it into the file a second time. When the server also didn't give the file's size, the end of every reply counted as a drop, so the download started over and over until you stopped it or the disk filled up. A dropped download now carries on where it stopped if the server allows it (#117).
- The Linux .deb and .rpm no longer clash with the distribution's ffmpeg package. They installed the app's own ffmpeg as `/usr/bin/ffmpeg`, so the .deb wouldn't install where ffmpeg already was, and on Fedora the rpm wouldn't install next to mpv, which pulls in ffmpeg-free. It's now `max-video-player-ffmpeg`. Upgrading removes the app's `/usr/bin/ffmpeg`, so if you ran ffmpeg from there, install your distribution's ffmpeg package. The app's web view can no longer start ffmpeg either. Only the downloads code runs it (#116).
- After Retry, or after the player reloaded a stream when the network came back, macOS drew the video at the size of the whole window, so the player showed only part of it until the player changed size. On Linux the video didn't show at all. A reloaded stream now starts where the player is (#115).
- The app could lose track of whether its window was in full screen after the green button or the View menu on macOS, or after a second change made while the first was still animating. The sidebar then stayed hidden after leaving full screen or showed in it, and the full screen button and Escape acted on the wrong state. The app now follows the window's own state, and checks it again a second after its own changes in case macOS turned one down (#113).
- Holding down a player shortcut now acts once, except for seeking and volume, which still repeat. A held F or Space flipped back and forth, and a held Escape left full screen and then the player (#113).
- The dot on the seek bar sometimes sat apart from the end of the colored part, mostly when a video started. It also jumped back for a moment after a seek, and stopped following playback after you moved it with the arrow keys. Clicking the seek bar no longer turns off the player's keyboard shortcuts (#111).
- Closing the player in full screen left the window in full screen, and the player came back in full screen the next time it opened. Closing the player now leaves full screen, unless the window was already in full screen when the player opened (#96, #113).
- A movie or episode that kept playing after you closed the player didn't save where you were, so it resumed from the moment you closed the player (#88).
- A failed guide download, or one that comes back empty or as an error page, no longer wipes the TV guide you already had. Refreshing the guide by hand says when it came back empty (#105).
- Error messages and logs no longer show your API keys, Xtream login or the login in a playlist link (#105).
- Testing a wrong OpenSubtitles key says the key is invalid instead of showing a request error (#105).
- Xtream logins that contain &, +, # or ? now load and play. Channels loaded before keep their old links until you refresh the playlist (#105).
- The Gemini key is sent in a request header instead of the request URL (#105).
- Spaces or a line break pasted around an API key no longer make the key fail (#105).
- Online lookups and Xtream logins give up after a timeout instead of waiting forever on a server that stopped responding (#105).
- Large playlists on a slow connection no longer fail after 10 minutes while they are still downloading (#105).
- Refreshing two M3U playlists at the same time no longer mixes up their downloads (#105).
- Favorites, watch history, downloads and movie details stay with the right Xtream channel when the provider adds or reorders channels. Before, they could move to a different channel, and a downloaded movie could play in place of the one you picked (#107).
- Refreshing an Xtream provider while its live, movie or series list fails to load keeps the channels you had from that list instead of removing them (#107).
- The player's logs no longer show the login in a stream's link when a channel starts, buffers or reconnects (#106).
- On Linux with Wayland, starting a video could crash the app on some desktops, and on computers without hardware video decoding the picture could stay black. Playback on Wayland now uses mpv's copy-back hardware decoding, which avoids both. X11 keeps zero-copy decoding. When OpenGL runs on the CPU, such as in a virtual machine without 3D acceleration or without a working graphics driver, the player now uses cheaper scaling, which makes a black picture there much less likely (#110).
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
- Removing a provider now asks you to confirm first (#103).
- A failed provider refresh now shows its error on the provider card (#103).
- Re-categorize All in Manage Categories now sends Gemini sample titles from the content type on screen only (#103).
- Escape now closes the playlist settings and download history dialogs (#103).
- Confirmation prompts, like removing a provider or a download, now take keyboard focus and close with Escape, and the player behind no longer acts on keys pressed in them or takes focus from them when the next episode starts. They no longer get cut off inside a sheet either (#103).
- A Stop or Remove download prompt left open in the player no longer acts on the next episode's download (#103).
- Screen readers now name the provider form fields and the clear file button, and say which option of each toggle is on and which group is picked in Manage Categories (#103).
- The playlist file drop zone now opens with the keyboard (#103).
- After you play a download, the channel list goes back to the Downloads tab instead of the live channels (#114).
- A search with a space before or after it no longer comes up empty (#114).
- Counts of one are no longer plural, as in "1 movies" or "1 groups" (#114).
- A rating with no votes no longer shows a stray 0 beside it (#114).
- Screen readers name the search bar's clear button and the icon buttons in Manage Categories, and say which category or provider card a button is on (#114).
- Test next to the OMDb key now checks the key in the field. Before, it checked the saved key, so a new key failed until it was saved (#120).
- When a key can't be checked because the service can't be reached or has a fault of its own, Settings now says so instead of calling the key invalid. A Gemini key over its rate limit no longer shows as invalid either (#120).
- A saved API key can now be removed. Clearing the field turns Save into Remove. Before, Save stayed off while the field was blank (#120).
- Clearing the simultaneous downloads field to type a new number no longer sets it to 1 straight away. A number outside 1 to 10 is fixed once you leave the field or press Enter. Typing 10 could leave 1 saved, because the two saves raced. They now go one at a time (#120).
- Settings now says when it can't read a saved API key, and keeps Save on so the key can still be replaced or removed. It no longer replaces a key you started typing before the saved one loaded (#120).
- Enter in an API key field saves the key. Screen readers name each key field and its Save, Test and show buttons, and read out whether a save or check worked (#120).

## [0.5.3] - 2026-10-09

This version was not published. Its changes first shipped in 0.6.0.

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

[Unreleased]: https://github.com/MaxMB15/Cinette/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/MaxMB15/Cinette/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/MaxMB15/Cinette/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/MaxMB15/Cinette/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/MaxMB15/Cinette/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/MaxMB15/Cinette/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/MaxMB15/Cinette/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/MaxMB15/Cinette/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/MaxMB15/Cinette/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/MaxMB15/Cinette/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/MaxMB15/Cinette/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/MaxMB15/Cinette/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/MaxMB15/Cinette/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/MaxMB15/Cinette/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/MaxMB15/Cinette/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/MaxMB15/Cinette/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/MaxMB15/Cinette/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/MaxMB15/Cinette/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/MaxMB15/Cinette/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/MaxMB15/Cinette/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/MaxMB15/Cinette/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/MaxMB15/Cinette/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/MaxMB15/Cinette/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/MaxMB15/Cinette/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/MaxMB15/Cinette/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/MaxMB15/Cinette/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/MaxMB15/Cinette/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MaxMB15/Cinette/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/MaxMB15/Cinette/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MaxMB15/Cinette/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MaxMB15/Cinette/releases/tag/v0.2.0
