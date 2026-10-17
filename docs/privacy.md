# Privacy policy

Last updated October 17, 2026. This policy covers Cinette, formerly called Max Video Player, on macOS, Linux, iPhone and iPad.

The developer of Cinette receives no data from the app. The app has no accounts, ads or analytics, and no server of its own. Your data stays on your device. The app sends data only to the services listed under "Who the app talks to", and only when you use a feature that needs one.

## What stays on your device

The app keeps these in its own storage on your device:

- The playlists and providers you add, including Xtream Codes usernames and passwords
- Your favorites, watch history and where you stopped in each movie or episode
- Your settings, and any API keys you enter for OMDb, OpenSubtitles or Google Gemini
- Movie and series details, skip times, episode lists and program guide data it downloaded, so it doesn't fetch them again
- Subtitle files you download
- On iPhone and iPad, a log of what the app did, for troubleshooting. Before it logs a line, the app takes out logins, passwords, API keys and tokens, and shortens stream and other web addresses so they keep only the server and, at most, a stream ID or file type. The log stays on the device unless you copy it off yourself. The same lines go to the device's system log, which iOS keeps for a limited time and clears on its own.
- On macOS and Linux, videos you download, in the folder you pick

## Deleting your data

The developer holds no data about you, so there's nothing to ask the developer to delete. Everything is on your device, and you can delete it there.

In the app, you can remove a playlist or provider on the Playlists page. That deletes its login, channels and favorites, its guide data and category layout, and the watch history, movie and series details and episode lists of its channels. It also deletes where you stopped in its movies and episodes, unless another playlist has a movie or episode with the same title. Ratings, skip times and subtitle search results are saved by IMDb ID rather than by playlist, so they stay until you clear caches. On macOS and Linux, downloaded videos and their entries on the Downloads page stay until you delete them.

In Settings, you can clear your watch history and where you stopped. Clear All Caches deletes the downloaded movie and series details, ratings, skip times, subtitle search results, guide data, episode lists and subtitle files. It keeps your playlists, favorites and history.

On iPhone and iPad, deleting the app deletes all of its data from the device. Copies in your iCloud or computer backups stay until those backups are replaced.

On macOS, the app's data is in `~/Library/Application Support/app.cinette`, `~/Library/WebKit/app.cinette` and `~/Library/Caches/app.cinette`. On Linux, it's in `~/.local/share/app.cinette`, with cached files under `~/.cache`. Before 0.8.0, these folders were named `com.maxvideoplayer.app`, and the first launch of 0.8.0 renames them. Deleting these folders deletes the data. Downloads stay where you saved them until you delete them.

## Who the app talks to

The app connects to these, and only when it needs them:

- The playlist, guide and stream addresses you add, to load your channels and play them. Channel logos load from the addresses in your playlist.
- OMDb, for movie and series details, if you add an OMDb key. When you open or play a movie or series, the app sends its title. When OMDb finds it, the app sends its IMDb ID to whatson-api at whatson-api.onrender.com for more ratings. Posters load from the image addresses these services return.
- SkipDB at api.skipdb.tv and IntroDB at api.introdb.app, for the times of intros, recaps and credits, if you add an OMDb key. When you play a movie or episode that OMDb found, the app sends its IMDb ID to both, with the season and episode for a series. SkipDB also gets the length of the video, to check the times against it.
- OpenSubtitles, to find and download subtitles, if you add a key. It sends the IMDb ID, and the season and episode for a series.
- Google Gemini, if you add a key, when you test the key or use one of the AI actions in Manage Categories, which are Re-categorize All, Assign All with AI and Find & Add Groups. An AI action sends your group and category names, and a few channel, movie or series names from each group. It doesn't send what you watch.
- GitHub, on macOS and Linux only, to check for a new version when the app starts and every two hours after that, and to download it.

Each of these sees your IP address and what the app sends it, and handles that under its own terms and privacy policy:

- OMDb, in its terms at https://www.omdbapi.com/legal.htm
- OpenSubtitles, at https://www.opensubtitles.com/en/privacy
- Google, at https://policies.google.com/privacy
- GitHub, at https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement

whatson-api is a free hobby service hosted on onrender.com, and it has no privacy policy. SkipDB and IntroDB are free databases that people fill in, and neither has a privacy policy.

To stop the app from contacting OMDb, OpenSubtitles or Gemini, remove its key in Settings. Without an OMDb key, the app doesn't contact whatson-api, SkipDB or IntroDB either. Setting both skip choices in Settings > Playback to Off also stops it from contacting SkipDB and IntroDB. Posters of titles it already looked up can still load from their image addresses until you clear caches.

## Crash reports on iPhone and iPad

The app has no crash reporting of its own. If you turned on Share With App Developers in the Analytics & Improvements settings, Apple may share crash reports for this app with the developer. That's Apple's setting, under Apple's privacy policy.

## Children

The app isn't aimed at children and doesn't collect data from anyone.

## Changes

If this policy changes, the new version will be on this page with a new date.

## Contact

Open an issue at https://github.com/MaxMB15/Cinette/issues. Issues are public, so don't include logins, playlist or stream addresses, or API keys, including in logs or screenshots.
