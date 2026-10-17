# Demo playlist

`playlist.m3u` is a small playlist for trying the app without an IPTV provider. App Review uses it, and so do the App Store screenshots. To add it, open Playlists in the app. Under Add Provider, choose M3U Playlist, pick URL where the app offers URL or File, and enter:

```
https://raw.githubusercontent.com/MaxMB15/MaxVideoPlayer/main/docs/demo/playlist.m3u
```

The playlist, its guide and its pictures all load from the `main` branch. A change here reaches App Review and the app only once it's merged to `main`.

The three test streams show up under Live, with a guide. The eight films show up under Movies, because their entries carry `tvg-type="movie"`. The three Caminandes episodes show up under Series as one show, because their entries carry `tvg-type="series"` and an episode code such as `S01E01` in the name.

| Entry | Served by | Terms |
| --- | --- | --- |
| Apple HLS example | Apple's HLS examples for developers | Published by Apple for testing players |
| Amazon IVS test stream | Amazon IVS's 720p test stream, listed in [Amazon's IVS player sample](https://github.com/aws-samples/amazon-ivs-player-web-sample) | Public test stream |
| Unified Streaming live test | Unified Streaming's public demo server | Public test stream |
| Big Buck Bunny (2008) | Mux's public HLS test streams | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| Elephants Dream (2006) | download.blender.org | [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/) |
| Sintel (2010) | THEOplayer's public demo content | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| Tears of Steel (2012) | Unified Streaming's public demo server | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| Hero (2018) | A copy on the Internet Archive | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Spring (2019) | A copy on the Internet Archive | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Sprite Fright (2021) | A copy on the Internet Archive | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Wing It! (2023) | A copy on the Internet Archive | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Caminandes S01E01 to S01E03 | Copies on the Internet Archive | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

The Internet Archive's page for Sprite Fright says the film is rated PG-13.

The Internet Archive and Wikimedia Commons don't agree on Gran Dillama's license. The Internet Archive's copy says CC BY 3.0, like the other two episodes, and Commons lists the film under CC BY-SA 3.0. The playlist plays it but uses none of its frames.

These servers belong to other people, and an entry can stop working when they move things. Akamai's live test stream stopped working, and the Amazon IVS stream took its place. If another one stops, swap in another public test stream or another copy of the film, and check that it allows anyone to play it.

## Pictures

Each film's picture is a still from the film, kept in `images/` as a JPEG 960 pixels wide. The app shows movies in wide cards, so a still fits better than a poster. The playlist loads them from this repo, so the app doesn't depend on Wikimedia's servers to show them. All three Caminandes episodes use the same still, which the app also shows for the series.

## Guide

`guide.xml` is a made-up XMLTV guide for the three test streams. Each stream shows the same test picture all day, so the guide splits each day into a few blocks whose titles and descriptions say what the stream shows. The playlist's `x-tvg-url` points at it, and each live entry's `tvg-id` matches a channel in it.

It covers 15 October 2026 to 31 December 2027, in UTC. `scripts/demo-guide.py` writes it and gives the same file on every run. To change the dates or the programs, edit `START`, `END` or `CHANNELS` in the script, then run it from the repo root and commit both files:

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
- Hero, © 2018 Blender Studio, directed by Daniel Martinez Lara, [studio.blender.org](https://studio.blender.org), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), from the Internet Archive's [hero_20260106](https://archive.org/details/hero_20260106)
- Spring, © 2019 Blender Animation Studio, directed by Andy Goralczyk, [studio.blender.org](https://studio.blender.org), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), from the Internet Archive's [springopenmovie](https://archive.org/details/springopenmovie)
- Sprite Fright, © 2021 Blender Studio, [studio.blender.org](https://studio.blender.org), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), from the Internet Archive's [sprite-fright](https://archive.org/details/sprite-fright)
- Wing It!, © 2023 Blender Studio, directed by Rik Schutte, [studio.blender.org](https://studio.blender.org), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), from the Internet Archive's [wing_it](https://archive.org/details/wing_it)
- Caminandes 1: Llama Drama, © 2013 Pablo Vazquez, Beorn Leonard and Francesco Siddi, music and sound by Jan Morgenstern, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), from the Internet Archive's [Caminandes1LlamaDrama](https://archive.org/details/Caminandes1LlamaDrama)
- Caminandes 2: Gran Dillama, © 2013 Pablo Vazquez, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) according to the Internet Archive's [Caminandes2GranDillama](https://archive.org/details/Caminandes2GranDillama)
- Caminandes 3: Llamigos, © 2016 Blender Foundation, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), from the Internet Archive's [CaminandesLlamigos](https://archive.org/details/CaminandesLlamigos)

The stills from Wikimedia Commons, resized to 960 pixels wide and saved as JPEG:

- `big-buck-bunny.jpg` from [Big.Buck.Bunny.-.Frank.Rinky.Gimera.png](https://commons.wikimedia.org/wiki/File:Big.Buck.Bunny.-.Frank.Rinky.Gimera.png), © Blender Foundation, screenshot by Church of emacs, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- `elephants-dream.jpg` from [Elephants_Dream_s5_both.jpg](https://commons.wikimedia.org/wiki/File:Elephants_Dream_s5_both.jpg), by Ton Roosendaal et al., [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/)
- `sintel.jpg` from [Sintel-screenshot-3.jpg](https://commons.wikimedia.org/wiki/File:Sintel-screenshot-3.jpg), © Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- `tears-of-steel.jpg` from [Tears_of_Steel_frame_03_1a.jpg](https://commons.wikimedia.org/wiki/File:Tears_of_Steel_frame_03_1a.jpg), © Blender Foundation, Project Mango, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)

The other stills are frames taken from the Internet Archive copies listed above, resized to 960 pixels wide and saved as JPEG. Each is under its film's license:

- `hero.jpg` from Hero, © 2018 Blender Studio, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- `spring.jpg` from Spring, © 2019 Blender Animation Studio, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- `sprite-fright.jpg` from Sprite Fright, © 2021 Blender Studio, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- `wing-it.jpg` from Wing It!, © 2023 Blender Studio, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- `caminandes.jpg` from Caminandes 1: Llama Drama, © 2013 Pablo Vazquez, Beorn Leonard and Francesco Siddi, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
