// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The formats command against loopback servers and the real bundled
//! ffmpeg, which the download tests also run.

use super::*;
use crate::downloads::test_support::video_url;
use crate::test_support::TestApp;
use mvp_core::http::test_server::{password, route, serve_once, serve_routes};
use mvp_core::streams::format::{AudioCodec, VideoCodec};
use std::time::Duration;
use tauri::Manager;

fn channel(id: &str, url: &str, content_type: &str) -> Channel {
    Channel {
        id: id.into(),
        name: "Channel".into(),
        url: url.into(),
        content_type: content_type.into(),
        ..Default::default()
    }
}

fn add_provider(app: &TestApp, provider_type: ProviderType, url: &str, channels: &[Channel]) {
    let provider = Provider {
        id: "p".into(),
        name: "P".into(),
        provider_type,
        url: url.into(),
        username: Some("user".into()),
        password: Some(password()),
        last_updated: None,
        channel_count: channels.len(),
        epg_url: None,
    };
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    cache.upsert_provider(&provider).unwrap();
    cache.save_channels("p", channels).unwrap();
}

async fn formats(
    app: &TestApp,
    channel: Channel,
    playing: Option<PlayingInfo>,
) -> Result<StreamFormats, String> {
    let handle = app.handle();
    // As mpv would report it while it plays the channel.
    let now = playing.map(|p| {
        let info = MediaInfo {
            file_format: p.file_format,
            video_codec: p.video_codec,
            audio_codec: p.audio_codec,
            interlaced: p.interlaced,
            hdr: false,
        };
        (channel.url.clone(), info)
    });
    stream_formats(
        &handle,
        &app.state(),
        &handle.state::<StreamsState>(),
        channel,
        now,
    )
    .await
}

fn playing_ts() -> PlayingInfo {
    PlayingInfo {
        file_format: Some("mpegts".into()),
        video_codec: Some("h264".into()),
        audio_codec: Some("mp2".into()),
        interlaced: true,
        hdr: false,
    }
}

/// The login part of a stream's path. Only its shape matters here, so it's
/// not the provider's password: a password in a URL to the plain-HTTP test
/// server reads to CodeQL as one sent in the clear.
const ACCOUNT: &str = "user/abc";

const PANEL_FORMATS: &str = r#"{"user_info":{"auth":1,"allowed_output_formats":["m3u8","ts"]}}"#;

#[tokio::test]
async fn xtream_live_playing_here_offers_hls_then_ts_without_asking_the_stream() {
    let app = TestApp::new();
    let (panel, requests) = serve_routes(vec![route("player_api.php", "200 OK", PANEL_FORMATS)]);
    let live = channel("p-live-7", &format!("{panel}/live/{ACCOUNT}/7.ts"), "live");
    add_provider(
        &app,
        ProviderType::Xtream,
        &panel,
        std::slice::from_ref(&live),
    );

    let result = formats(&app, live.clone(), Some(playing_ts()))
        .await
        .unwrap();
    let hls = StreamFormat {
        container: Container::HlsTs,
        video: Some(VideoCodec::H264),
        interlaced: true,
        hdr: false,
        audio: Some(AudioCodec::Mp2),
        cors: false,
    };
    assert_eq!(
        result,
        StreamFormats {
            formats: vec![
                hls,
                StreamFormat {
                    container: Container::Ts,
                    ..hls
                }
            ],
            sources: vec![0, 1],
            duration: None,
            generation: result.generation,
        }
    );
    // Only the panel's login check, never the stream.
    assert!(requests.recv().unwrap().contains("player_api.php"));
    // The second time the panel isn't asked again.
    formats(&app, live, Some(playing_ts())).await.unwrap();
    assert!(requests.recv_timeout(Duration::from_millis(200)).is_err());
}

#[tokio::test]
async fn hls_checked_once_remembers_its_servers_cors_answer() {
    let app = TestApp::new();
    let media = "#EXTM3U\n#EXTINF:4.0,\ns.ts\n";
    let cors = "200 OK\r\nAccess-Control-Allow-Origin: *";
    let (server, _) = serve_routes(vec![
        route("player_api.php", "200 OK", PANEL_FORMATS),
        route(".m3u8", cors, media),
        route("/s.ts", cors, "ab"),
    ]);
    let url = format!("{server}/live/{ACCOUNT}/7.m3u8");
    let live = channel("p-live-7", &url, "live");
    add_provider(
        &app,
        ProviderType::Xtream,
        &server,
        std::slice::from_ref(&live),
    );
    let handle = app.handle();
    let streams = handle.state::<StreamsState>();
    lock(&streams.cors).insert(origin_for_log(&url), true);

    let playing = PlayingInfo {
        file_format: Some("hls".into()),
        ..playing_ts()
    };
    let result = formats(&app, live, Some(playing)).await.unwrap();
    assert_eq!(result.formats[0].container, Container::HlsTs);
    assert!(result.formats[0].cors);
    assert!(!result.formats[1].cors);
}

#[tokio::test]
async fn probes_a_film_with_the_bundled_ffmpeg() {
    let app = TestApp::new();
    let film = channel("m-1", &video_url("film"), "movie");
    let result = formats(&app, film, None).await.unwrap();
    assert_eq!(result.sources, vec![0]);
    let format = result.formats[0];
    // The test server sends WAV audio, whatever the name says.
    assert_eq!(format.container, Container::Other);
    assert_eq!(format.video, None);
    assert_eq!(format.audio, Some(AudioCodec::Other));
    assert!(result.duration.is_some_and(|d| d > 0.0));
}

#[tokio::test]
async fn a_refused_stream_says_so_and_an_unreachable_one_offers_nothing() {
    let app = TestApp::new();
    let url = format!("{}/movie/{ACCOUNT}/1.mkv", serve_once("403 Forbidden", ""));
    let err = formats(&app, channel("m-1", &url, "movie"), None)
        .await
        .unwrap_err();
    assert_eq!(err, REFUSED);

    let url = format!("{}/1.mkv", serve_once("404 Not Found", ""));
    let result = formats(&app, channel("m-2", &url, "movie"), None)
        .await
        .unwrap();
    assert_eq!(
        result,
        StreamFormats {
            formats: vec![],
            sources: vec![],
            duration: None,
            generation: result.generation,
        }
    );
}

#[tokio::test]
async fn a_refused_or_broken_playlist_is_checked_without_mpv() {
    let app = TestApp::new();
    let playing = PlayingInfo {
        file_format: Some("hls".into()),
        ..playing_ts()
    };
    // A playlist mpv played but that now refuses the check.
    let (server, _) = serve_routes(vec![route(".m3u8", "403 Forbidden", "")]);
    let url = format!("{server}/live.m3u8");
    let err = get_hls(&app, &url).await.unwrap_err();
    assert_eq!(err, REFUSED);
    // And one that isn't a playlist after all is dropped.
    let (server, _) = serve_routes(vec![route(".m3u8", "200 OK", "not a playlist")]);
    let url = format!("{server}/live.m3u8");
    let result = get_hls(&app, &url).await.unwrap();
    assert!(result.formats.is_empty());
    // mpv's answer alone is enough while it plays.
    let result = formats(&app, channel("c", &url, "live"), Some(playing))
        .await
        .unwrap();
    assert_eq!(result.sources, vec![0]);
}

/// The formats of an HLS channel that nothing plays, after its probe. The
/// probe of these servers would fail, so this runs the HLS step with what
/// a probe would have found.
async fn get_hls(app: &TestApp, url: &str) -> Result<StreamFormats, String> {
    let handle = app.handle();
    let streams = handle.state::<StreamsState>();
    let probed = Probed {
        container: Container::HlsTs,
        video: Some(VideoCodec::H264),
        interlaced: false,
        hdr: false,
        audio: Some(AudioCodec::Aac),
        audio_tracks: vec![],
        duration: None,
    };
    check_hls(&streams, &[url.to_string()], format_of(&probed), 0, false).await
}

#[tokio::test]
async fn a_panel_that_cant_be_asked_keeps_the_channels_own_url() {
    let app = TestApp::new();
    let (panel, requests) = serve_routes(vec![route(
        "player_api.php",
        "500 Internal Server Error",
        "",
    )]);
    let live = channel("p-live-7", &format!("{panel}/live/{ACCOUNT}/7.ts"), "live");
    add_provider(
        &app,
        ProviderType::Xtream,
        &panel,
        std::slice::from_ref(&live),
    );
    let result = formats(&app, live.clone(), Some(playing_ts()))
        .await
        .unwrap();
    assert_eq!(result.sources, vec![0]);
    assert_eq!(result.formats[0].container, Container::Ts);
    // It isn't asked again in this run, so the list of URLs stays the same.
    let again = formats(&app, live, Some(playing_ts())).await.unwrap();
    assert_eq!(again.sources, vec![0]);
    assert_eq!(requests.try_iter().count(), 1);
}

#[tokio::test]
async fn m3u_channels_and_episodes_keep_their_own_url() {
    let app = TestApp::new();
    // Nothing is fetched while it plays, and nothing answers there anyway.
    let base = mvp_core::http::test_server::refused_url();
    let url = &format!("{base}/live/u/p/7.ts");
    let live = channel("p-ch-0", url, "live");
    add_provider(
        &app,
        ProviderType::M3u,
        &format!("{base}/list.m3u"),
        std::slice::from_ref(&live),
    );
    let result = formats(&app, live, Some(playing_ts())).await.unwrap();
    assert_eq!(result.sources, vec![0]);
    // An episode isn't in the cache, so it has no provider.
    let episode = channel(
        "xt-ep-1-s1-0",
        &format!("{base}/series/u/p/9.mkv"),
        "series",
    );
    let result = formats(&app, episode, Some(playing_ts())).await.unwrap();
    assert_eq!(result.sources, vec![0]);
}

#[tokio::test]
async fn only_xtream_live_asks_the_panel_for_its_formats() {
    let app = TestApp::new();
    let (panel, requests) = serve_routes(vec![route("player_api.php", "200 OK", PANEL_FORMATS)]);
    let film = channel(
        "p-movie-9",
        &format!("{panel}/movie/{ACCOUNT}/9.mkv"),
        "movie",
    );
    add_provider(
        &app,
        ProviderType::Xtream,
        &panel,
        std::slice::from_ref(&film),
    );
    let result = formats(&app, film, Some(playing_ts())).await.unwrap();
    assert_eq!(result.sources, vec![0]);
    assert!(requests.recv_timeout(Duration::from_millis(200)).is_err());
}

#[tokio::test]
async fn probes_the_first_url_when_the_channels_own_isnt_offered() {
    let app = TestApp::new();
    let only_hls = r#"{"user_info":{"auth":1,"allowed_output_formats":["m3u8"]}}"#;
    let (panel, requests) = serve_routes(vec![
        route("player_api.php", "200 OK", only_hls),
        route("/7.m3u8", "403 Forbidden", ""),
    ]);
    let live = channel("p-live-7", &format!("{panel}/live/{ACCOUNT}/7.ts"), "live");
    add_provider(
        &app,
        ProviderType::Xtream,
        &panel,
        std::slice::from_ref(&live),
    );
    assert_eq!(formats(&app, live, None).await.unwrap_err(), REFUSED);
    assert!(requests.recv().unwrap().contains("player_api.php"));
    assert!(requests.recv().unwrap().contains("/7.m3u8"));
}

fn mpv_info(file_format: Option<&str>) -> MediaInfo {
    MediaInfo {
        file_format: file_format.map(String::from),
        video_codec: Some("h264".into()),
        audio_codec: Some("aac".into()),
        interlaced: false,
        hdr: false,
    }
}

#[test]
fn trusts_mpv_only_about_this_item_once_it_has_opened() {
    let ts = "http://panel/live/u/SECRET/7.ts".to_string();
    let hls = "http://panel/live/u/SECRET/7.m3u8".to_string();
    let urls = vec![hls.clone(), ts.clone()];
    // Nothing loaded, or another item.
    assert_eq!(playing_info(None, &urls, &ts), Ok(None));
    let other = (
        "http://panel/live/u/SECRET/8.ts".to_string(),
        mpv_info(Some("mpegts")),
    );
    assert_eq!(playing_info(Some(other), &urls, &ts), Ok(None));
    // This item, still opening.
    let opening = (ts.clone(), mpv_info(None));
    assert_eq!(
        playing_info(Some(opening), &urls, &ts),
        Err(NOT_READY.to_string())
    );
    // This item, by its own URL or another of its URLs.
    for url in [ts.clone(), hls] {
        let playing = playing_info(Some((url, mpv_info(Some("mpegts")))), &urls, &ts)
            .unwrap()
            .unwrap();
        assert_eq!(
            playing,
            PlayingInfo {
                file_format: Some("mpegts".into()),
                video_codec: Some("h264".into()),
                audio_codec: Some("aac".into()),
                interlaced: false,
                hdr: false,
            }
        );
    }
    let interlaced = MediaInfo {
        interlaced: true,
        hdr: false,
        ..mpv_info(Some("mpegts"))
    };
    assert!(
        playing_info(Some((ts.clone(), interlaced)), &urls, &ts)
            .unwrap()
            .unwrap()
            .interlaced
    );
    // The channel's own URL counts even when it isn't among the URLs.
    assert!(
        playing_info(Some((ts.clone(), mpv_info(Some("mpegts")))), &[], &ts)
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn a_load_names_its_url_by_the_generation_it_was_listed_in() {
    let app = TestApp::new();
    let (panel, _) = serve_routes(vec![route("player_api.php", "200 OK", PANEL_FORMATS)]);
    let ts = format!("{panel}/live/{ACCOUNT}/7.ts");
    let live = channel("p-live-7", &ts, "live");
    add_provider(
        &app,
        ProviderType::Xtream,
        &panel,
        std::slice::from_ref(&live),
    );
    let first = formats(&app, live.clone(), Some(playing_ts()))
        .await
        .unwrap();
    let handle = app.handle();
    let streams = handle.state::<StreamsState>();
    assert_eq!(
        streams.url("p-live-7", first.generation, first.sources[1]),
        Ok(ts.clone())
    );
    // Listing it again, as for a second receiver, keeps its generation.
    let again = formats(&app, live.clone(), Some(playing_ts()))
        .await
        .unwrap();
    assert_eq!(again.generation, first.generation);
    // A list that changed makes the older one stale.
    let moved_ts = format!("{panel}/live/{ACCOUNT}/8.ts");
    let mut moved = live;
    moved.url = moved_ts.clone();
    let second = formats(&app, moved, Some(playing_ts())).await.unwrap();
    assert!(second.generation > first.generation);
    assert_eq!(
        streams.url("p-live-7", first.generation, 1),
        Err(STALE.to_string())
    );
    assert_eq!(streams.url("p-live-7", second.generation, 1), Ok(moved_ts));
    assert_eq!(
        streams.url("p-live-7", second.generation, 2),
        Err(STALE.to_string())
    );
    assert_eq!(
        streams.url("p-live-8", second.generation, 0),
        Err(STALE.to_string())
    );
}

#[tokio::test]
async fn an_item_mpv_is_still_opening_isnt_routed_yet() {
    let app = TestApp::new();
    let url = mvp_core::http::test_server::refused_url() + "/1.mkv";
    let film = channel("m-1", &url, "movie");
    let handle = app.handle();
    let opening = Some((url, mpv_info(None)));
    let result = stream_formats(
        &handle,
        &app.state(),
        &handle.state::<StreamsState>(),
        film,
        opening,
    )
    .await;
    assert_eq!(result, Err(NOT_READY.to_string()));
}

#[tokio::test]
async fn the_command_probes_what_mpv_doesnt_play() {
    let app = TestApp::new();
    let film = channel("m-1", &video_url("formats-command"), "movie");
    let result = app
        .invoke("get_stream_formats", serde_json::json!({ "channel": film }))
        .unwrap();
    assert_eq!(result["formats"][0]["container"], "other");
    assert!(result["duration"].as_f64().is_some());
    assert!(result["generation"].as_u64().unwrap() > 0);
}

/// Whether an ffmpeg with `url` among its arguments runs.
#[cfg(desktop)]
fn ffmpeg_runs_for(url: &str) -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", url])
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(desktop)]
#[tokio::test]
async fn a_probe_that_runs_too_long_stops_its_ffmpeg() {
    // A server that sends a byte every half second, so ffmpeg keeps waiting.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                use std::io::Write;
                let head = "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n\r\n";
                if stream.write_all(head.as_bytes()).is_err() {
                    return;
                }
                while stream.write_all(&[0x47]).is_ok() {
                    std::thread::sleep(Duration::from_millis(500));
                }
            });
        }
    });
    let url = format!("http://{address}/live/u/SECRET/slow.ts");
    let app = TestApp::new();
    let probed = probe_within(&app.handle(), &url, Duration::from_secs(2)).await;
    assert_eq!(probed.err(), Some(ProbeError::Unreachable));
    for _ in 0..50 {
        if !ffmpeg_runs_for(&url) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the probe's ffmpeg still runs");
}
