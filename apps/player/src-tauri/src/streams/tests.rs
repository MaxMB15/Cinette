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
    get_stream_formats(
        handle.clone(),
        app.state(),
        handle.state::<StreamsState>(),
        channel,
        playing,
    )
    .await
}

fn playing_ts() -> PlayingInfo {
    PlayingInfo {
        file_format: Some("mpegts".into()),
        video_codec: Some("h264".into()),
        audio_codec: Some("mp2".into()),
        interlaced: true,
    }
}

const PANEL_FORMATS: &str = r#"{"user_info":{"auth":1,"allowed_output_formats":["m3u8","ts"]}}"#;

#[tokio::test]
async fn xtream_live_playing_here_offers_hls_then_ts_without_asking_the_stream() {
    let app = TestApp::new();
    let (panel, requests) = serve_routes(vec![route("player_api.php", "200 OK", PANEL_FORMATS)]);
    let live = channel(
        "p-live-7",
        &format!("{panel}/live/user/{}/7.ts", password()),
        "live",
    );
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
    let url = format!("{server}/live/user/{}/7.m3u8", password());
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
    let url = format!(
        "{}/movie/user/{}/1.mkv",
        serve_once("403 Forbidden", ""),
        password()
    );
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
            duration: None
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
        audio: Some(AudioCodec::Aac),
        duration: None,
    };
    check_hls(&streams, &[url.to_string()], format_of(&probed), 0, false).await
}

#[tokio::test]
async fn a_panel_that_cant_be_asked_keeps_the_channels_own_url() {
    let app = TestApp::new();
    let (panel, _) = serve_routes(vec![route(
        "player_api.php",
        "500 Internal Server Error",
        "",
    )]);
    let live = channel(
        "p-live-7",
        &format!("{panel}/live/user/{}/7.ts", password()),
        "live",
    );
    add_provider(
        &app,
        ProviderType::Xtream,
        &panel,
        std::slice::from_ref(&live),
    );
    let result = formats(&app, live, Some(playing_ts())).await.unwrap();
    assert_eq!(result.sources, vec![0]);
    assert_eq!(result.formats[0].container, Container::Ts);
    // It's asked again next time, since the answer wasn't kept.
    let handle = app.handle();
    assert!(lock(&handle.state::<StreamsState>().output_formats).is_empty());
}

#[tokio::test]
async fn m3u_channels_and_episodes_keep_their_own_url() {
    let app = TestApp::new();
    let url = "http://srv.invalid/live/u/p/7.ts";
    let live = channel("p-ch-0", url, "live");
    add_provider(
        &app,
        ProviderType::M3u,
        "http://srv.invalid/list.m3u",
        std::slice::from_ref(&live),
    );
    let result = formats(&app, live, Some(playing_ts())).await.unwrap();
    assert_eq!(result.sources, vec![0]);
    // An episode isn't in the cache, so it has no provider.
    let episode = channel(
        "xt-ep-1-s1-0",
        "http://srv.invalid/series/u/p/9.mkv",
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
        &format!("{panel}/movie/user/{}/9.mkv", password()),
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
    let live = channel(
        "p-live-7",
        &format!("{panel}/live/user/{}/7.ts", password()),
        "live",
    );
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
