# Privacy policy

Last updated October 22, 2026. This policy covers Cinette, formerly called Max Video Player, on macOS, Linux, iPhone and iPad, and on Android, including Android TV and Fire TV.

The developer of Cinette receives no data from the app. The app has no accounts, ads or analytics, and no server of its own. Your data stays on your device, unless you copy it to another of your devices yourself. The app sends data only to the services and devices listed under "Who the app talks to", and only when you use a feature that needs one. The one exception is remote control, which announces the device on your local network so your other devices running Cinette can find it, as "Remote control and transfers" explains.

## What stays on your device

The app keeps these in its own storage on your device:

- The playlists and providers you add, including Xtream Codes usernames and passwords
- Your favorites, watch history and where you stopped in each movie or episode
- Your settings, and any API keys you enter for OMDb, OpenSubtitles or Google Gemini
- For remote control, the name you give the device and a key that proves to your other devices that it's the same one. On iPhone and iPad, the key is in the Keychain and never moves to another device.
- Movie and series details, skip times, episode lists and program guide data it downloaded, so it doesn't fetch them again
- Subtitle files you download
- On iPhone and iPad, a log of what the app did, for troubleshooting. Before it logs a line, the app takes out logins, passwords, API keys and tokens, and shortens stream and other web addresses so they keep only the server and, at most, a stream ID or file type. The log stays on the device unless you copy it off yourself. The same lines go to the device's system log, which iOS keeps for a limited time and clears on its own.
- On macOS and Linux, videos you download, in the folder you pick

## Deleting your data

The developer holds no data about you, so there's nothing to ask the developer to delete. Everything is on your device, and you can delete it there.

In the app, you can remove a playlist or provider on the Playlists page. That deletes its login, channels and favorites, its guide data and category layout, and the watch history, movie and series details and episode lists of its channels. It also deletes where you stopped in its movies and episodes, unless another playlist has a movie or episode with the same title. Ratings, skip times and subtitle search results are saved by IMDb ID rather than by playlist, so they stay until you clear caches. On macOS and Linux, downloaded videos and their entries on the Downloads page stay until you delete them.

In Settings, you can clear your watch history and where you stopped. Clear All Caches deletes the downloaded movie and series details, ratings, skip times, subtitle search results, guide data, episode lists and subtitle files. It keeps your playlists, favorites and history. Reset device identity, under Remote control, replaces the device's key, so your other devices see it as a new device.

On iPhone and iPad, deleting the app deletes all of its data from the device. Copies in your iCloud or computer backups stay until those backups are replaced.

On Android, Android TV and Fire TV, uninstalling the app deletes all of its data from the device. Where the device backs up app data, as Android does to your Google account when backup is on, the backup holds a copy of the app's data, logins included, until the backup is replaced or deleted. It leaves out the remote control key.

On macOS, the app's data is in `~/Library/Application Support/app.cinette`, `~/Library/WebKit/app.cinette` and `~/Library/Caches/app.cinette`. On Linux, it's in `~/.local/share/app.cinette`, with cached files under `~/.cache`. Before 0.8.0, these folders were named `com.maxvideoplayer.app`, and the first launch of 0.8.0 renames them. Deleting these folders deletes the data. Downloads stay where you saved them until you delete them.

## Who the app talks to

The app connects to these, and only when it needs them:

- The playlist, guide and stream addresses you add, to load your channels and play them. Channel logos load from the addresses in your playlist.
- OMDb, for movie and series details, if you add an OMDb key. When you open or play a movie or series, the app sends its title. When OMDb finds it, the app sends its IMDb ID to whatson-api at whatson-api.onrender.com for more ratings. Posters load from the image addresses these services return.
- SkipDB at api.skipdb.tv and IntroDB at api.introdb.app, for the times of intros, recaps and credits, if you add an OMDb key. When you play a movie or episode that OMDb found, the app sends its IMDb ID to both, with the season and episode for a series. SkipDB also gets the length of the video, to check the times against it.
- OpenSubtitles, to find and download subtitles, if you add a key. It sends the IMDb ID, and the season and episode for a series.
- Google Gemini, if you add a key, when you test the key or use one of the AI actions in Manage Categories, which are Re-categorize All, Assign All with AI and Find & Add Groups. An AI action sends your group and category names, and a few channel, movie or series names from each group. It doesn't send what you watch.
- An AirPlay TV you pick, on iPhone, iPad and Mac. The app gives the TV the stream's address, login included, so the TV plays it straight from your provider. When the TV can't play a stream as it is, the iPhone or Mac converts it and serves it to the TV over your local network instead. Then the TV gets only an address on your device, with a random part that changes each time, and only devices on that network can reach it.
- A Google Cast device you pick, such as a Chromecast or a TV with Chromecast built in, on macOS and Linux. From the first time you open the player until the app quits, the app looks for Cast devices on your local network. When you cast, the app gives the device the stream's address, login included, so the device plays it straight from your provider. It also sends the name of what's playing, and the address of its logo when that address has no login in it. The device plays the stream in Google's Default Media Receiver, which it loads from Google. When the device can't play a stream as it is, or when you turn on Stream through this computer in Settings, the computer converts it and serves it to the device over your local network instead. Then the device gets only an address on the computer, with a random part that changes each time, and only that device can reach it.
- Your other devices running Cinette on the same local network, for remote control and to copy your history or providers from one to another. "Remote control and transfers" says what they exchange.
- GitHub, on macOS and Linux only, to check for a new version when the app starts and every two hours after that, and to download it.

Each of these sees your IP address and what the app sends it, and handles that under its own terms and privacy policy:

- OMDb, in its terms at https://www.omdbapi.com/legal.htm
- OpenSubtitles, at https://www.opensubtitles.com/en/privacy
- Google, at https://policies.google.com/privacy
- GitHub, at https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement

whatson-api is a free hobby service hosted on onrender.com, and it has no privacy policy. SkipDB and IntroDB are free databases that people fill in, and neither has a privacy policy.

To stop the app from contacting OMDb, OpenSubtitles or Gemini, remove its key in Settings. Without an OMDb key, the app doesn't contact whatson-api, SkipDB or IntroDB either. Setting both skip choices in Settings > Playback to Off also stops it from contacting SkipDB and IntroDB. Posters of titles it already looked up can still load from their image addresses until you clear caches.

## Remote control and transfers

On macOS, Linux, iPhone, iPad and Android, one device running Cinette can control another on the same local network, and copy your history or providers to it. The two devices connect straight to each other over your local network, and the connection is encrypted. No server sits between them, the developer's or anyone else's.

While Discoverable on this network is on in Settings, as it is at first, the app announces the device on your local network. The announcement gives the device's name, its type, such as Mac or iPhone, an ID made from its key, and whether it can be controlled. The name is the device type until you change it under Device name. Anyone on the same network can see the announcement, so on a shared network, such as a hotel's, others can see that a device running Cinette is there. The app starts announcing when it opens, except on iPhone and iPad, where it waits until you first open Devices or the remote control settings. On iPhone, iPad and Android, it announces only while you're using Cinette. Turning off Discoverable on this network stops the announcements and refuses new connections.

Who can control the device depends on the Remote control setting:

- Only when allowed, as it is at first, shows each new connection on this device with the other device's name and a six-digit code to compare with the code on the other screen.
- Always allow lets in any device running Cinette on the network without asking, so it suits only a network you trust.
- Never allow refuses every connection.

A device that controls another sees what the other is playing, where it is in it, its volume, and the names and languages of its subtitle and audio tracks. It also sees the names, groups and logos of the other device's channels, movies and series, and loads the logos from their addresses itself. It never gets their stream addresses, providers or logins.

Copying history or providers needs Allow on the device being controlled each time, even with Always allow:

- Transfer history copies watch history, where you stopped, favorites and pinned groups, in either direction. For each channel, movie or episode, it sends the names, and the guide ID, IMDb ID and the provider's own ID where there are ones. It also sends a code that lets the other device find the same provider. The code is made from the provider's address and username, mixed with a random value that the receiving device picks for each transfer. It never sends stream addresses, servers, usernames, passwords or logos.
- Send providers copies the providers you pick, with their addresses, usernames and passwords, and the other device saves them as its own. Until you allow it, its dialog shows only their names and types. It doesn't send guide addresses, playlists added from files, or API keys.

Neither transfer deletes anything on either device.

## Crash reports on iPhone and iPad

The app has no crash reporting of its own. If you turned on Share With App Developers in the Analytics & Improvements settings, Apple may share crash reports for this app with the developer. That's Apple's setting, under Apple's privacy policy.

## Children

The app isn't aimed at children and doesn't collect data from anyone.

## Changes

If this policy changes, the new version will be on this page with a new date.

## Contact

Open an issue at https://github.com/MaxMB15/Cinette/issues. Issues are public, so don't include logins, playlist or stream addresses, or API keys, including in logs or screenshots.
