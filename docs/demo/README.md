# Demo playlist

`playlist.m3u` is a small playlist for trying the app without an IPTV provider. App Review uses it. To add it, open Playlists in the app. Under Add Provider, choose M3U Playlist, pick URL where the app offers URL or File, and enter:

```
https://raw.githubusercontent.com/MaxMB15/MaxVideoPlayer/main/docs/demo/playlist.m3u
```

The playlist, its guide and its pictures all load from the `main` branch. A change here reaches App Review and the app only once it's merged to `main`.

The three test streams show up under Live, with a guide. The four films show up under Movies, because their entries carry `tvg-type="movie"`.

| Entry | Served by | Terms |
| --- | --- | --- |
| Apple HLS example | Apple's HLS examples for developers | Published by Apple for testing players |
| Amazon IVS test stream | Amazon IVS's 720p test stream, listed in [Amazon's IVS player sample](https://github.com/aws-samples/amazon-ivs-player-web-sample) | Public test stream |
| Unified Streaming live test | Unified Streaming's public demo server | Public test stream |
| Big Buck Bunny | Mux's public HLS test streams | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| Elephants Dream | download.blender.org | [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/) |
| Sintel | THEOplayer's public demo content | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| Tears of Steel | Unified Streaming's public demo server | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

These servers belong to other people, and an entry can stop working when they move things. Akamai's live test stream stopped working, and the Amazon IVS stream took its place. If another one stops, swap in another public test stream or another copy of the film, and check that it allows anyone to play it.

Blender's later films aren't in the playlist. Blender Studio's pages for Wing It and the Caminandes shorts link only to YouTube, and the other copies are personal uploads, some with the index at the end of the file. Hero and Spring share their titles with other films, so the app would show the wrong details when it has an OMDb key. The Internet Archive lists Sprite Fright as rated PG-13.

## Pictures

Each film's picture is a still from Wikimedia Commons, kept in `images/` as a JPEG 960 pixels wide. The app shows movies in wide cards, so a still fits better than a poster. The playlist loads them from this repo, so the app doesn't depend on Wikimedia's servers to show them.

## Guide

`guide.xml` is a made-up XMLTV guide for the three test streams. Apple's entry is a 10-minute on-demand clip that plays from the start and stops at its end. The other two are live streams that show the same test content all day. The guide splits each day into a few blocks whose titles and descriptions say what the entry shows. The playlist's `x-tvg-url` points at it, and each live entry's `tvg-id` matches a channel in it.

It covers 15 October 2026 to 31 December 2027, in UTC. Move `END` later and run the script again before 1 January 2028, or the live entries lose their guide.

`scripts/demo-guide.py` writes the guide and gives the same file on every run. To change the dates or the programs, edit `START`, `END` or `CHANNELS` in the script, then run it from the repo root and commit both files:

```bash
python3 -I scripts/demo-guide.py
```

It needs only Python's standard library. A test in `crates/core/src/iptv/demo_tests.rs` checks that the guide has no gaps from `START` to `END`, so change the dates there too.

## Credits

The films:

- Big Buck Bunny, © 2008 Blender Foundation, [peach.blender.org](https://peach.blender.org), licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- Elephants Dream, © 2006 Blender Foundation and Netherlands Media Art Institute, [orange.blender.org](https://orange.blender.org), licensed under [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/)
- Sintel, © 2010 Blender Foundation, [durian.blender.org](https://durian.blender.org), licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- Tears of Steel, © 2012 Blender Foundation, [mango.blender.org](https://mango.blender.org), licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)

The stills from Wikimedia Commons, resized to 960 pixels wide and saved as JPEG:

- `big-buck-bunny.jpg` from [Big.Buck.Bunny.-.Frank.Rinky.Gimera.png](https://commons.wikimedia.org/wiki/File:Big.Buck.Bunny.-.Frank.Rinky.Gimera.png), © Blender Foundation, screenshot by Church of emacs, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- `elephants-dream.jpg` from [Elephants_Dream_s5_both.jpg](https://commons.wikimedia.org/wiki/File:Elephants_Dream_s5_both.jpg), by Ton Roosendaal et al., [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/)
- `sintel.jpg` from [Sintel-screenshot-3.jpg](https://commons.wikimedia.org/wiki/File:Sintel-screenshot-3.jpg), © Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- `tears-of-steel.jpg` from [Tears_of_Steel_frame_03_1a.jpg](https://commons.wikimedia.org/wiki/File:Tears_of_Steel_frame_03_1a.jpg), © Blender Foundation, Project Mango, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
