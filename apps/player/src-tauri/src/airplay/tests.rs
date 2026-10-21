// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::test_support::TestApp;
use mvp_core::models::playlist::{Provider, ProviderType};
use crate::streams::{stream_formats, STALE};
use tauri::Manager;
use tauri_plugin_mpv::MediaInfo;

fn add_m3u_channel(app: &TestApp) -> Channel {
    let channel = Channel {
        id: "ch-0".into(),
        name: "Channel".into(),
        url: "http://127.0.0.1:9/live/1.ts".into(),
        content_type: "live".into(),
        ..Default::default()
    };
    let provider = Provider {
        id: "p".into(),
        name: "P".into(),
        provider_type: ProviderType::M3u,
        url: "http://127.0.0.1:9/list.m3u".into(),
        username: None,
        password: None,
        last_updated: None,
        channel_count: 1,
        epg_url: None,
    };
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    cache.upsert_provider(&provider).unwrap();
    cache
        .save_channels("p", std::slice::from_ref(&channel))
        .unwrap();
    channel
}

/// Lists `channel`'s formats as mpv plays it, so nothing is fetched, and
/// returns the list's generation.
async fn list(app: &TestApp, channel: &Channel) -> u64 {
    let handle = app.handle();
    let info = MediaInfo {
        file_format: Some("mpegts".into()),
        video_codec: Some("h264".into()),
        audio_codec: Some("aac".into()),
        interlaced: false,
        hdr: false,
    };
    let now = Some((channel.url.clone(), info));
    let listed = stream_formats(
        &handle,
        &app.state(),
        &handle.state::<StreamsState>(),
        channel.clone(),
        now,
    )
    .await
    .unwrap();
    listed.generation
}

async fn load(
    app: &TestApp,
    channel: Channel,
    generation: u64,
    source: usize,
) -> Result<(), String> {
    let handle = app.handle();
    airplay_load(
        handle.clone(),
        handle.state::<StreamsState>(),
        channel,
        generation,
        source,
        Some(30.0),
    )
    .await
}

#[tokio::test]
async fn hands_the_listed_url_to_the_plugin() {
    let app = TestApp::new();
    let channel = add_m3u_channel(&app);
    let generation = list(&app, &channel).await;
    // The URL was found, and the plugin says AirPlay isn't on this computer.
    #[cfg(not(target_os = "macos"))]
    assert_eq!(
        load(&app, channel, generation, 0).await,
        Err(tauri_plugin_mpv::airplay::UNAVAILABLE.to_string())
    );
    // A Mac has AirPlay, and the plugin starts tracking the item.
    #[cfg(target_os = "macos")]
    {
        app.handle()
            .manage(tauri_plugin_mpv::airplay::AirPlay::default());
        assert_eq!(load(&app, channel, generation, 0).await, Ok(()));
    }
}

#[tokio::test]
async fn refuses_a_format_the_list_doesnt_have() {
    let app = TestApp::new();
    let channel = add_m3u_channel(&app);
    let generation = list(&app, &channel).await;
    assert_eq!(
        load(&app, channel, generation, 1).await,
        Err(STALE.to_string())
    );
}

#[tokio::test]
async fn refuses_a_replaced_list() {
    let app = TestApp::new();
    let channel = add_m3u_channel(&app);
    let first = list(&app, &channel).await;
    // The same list again keeps its generation. One that changed replaces it.
    assert_eq!(list(&app, &channel).await, first);
    let mut moved = channel.clone();
    moved.url = format!("{}?moved", channel.url);
    list(&app, &moved).await;
    assert_eq!(load(&app, channel, first, 0).await, Err(STALE.to_string()));
}

#[tokio::test]
async fn converting_is_only_on_ios_and_macos() {
    let app = TestApp::new();
    let channel = add_m3u_channel(&app);
    let generation = list(&app, &channel).await;
    let handle = app.handle();
    let converted = airplay_load_converted(
        handle.clone(),
        handle.state::<StreamsState>(),
        channel.clone(),
        generation,
        0,
        None,
    )
    .await;
    #[cfg(not(target_os = "macos"))]
    let unconverted = Err(tauri_plugin_mpv::airplay::UNAVAILABLE.to_string());
    // A Mac converts once setup has made its conversions, which this test
    // only does at its end.
    #[cfg(target_os = "macos")]
    let unconverted = Err(crate::convert::hls::HlsError::Failed.for_player());
    assert_eq!(converted, unconverted);
    // The format is checked first, as for a direct load.
    let gone = airplay_load_converted(
        handle.clone(),
        handle.state::<StreamsState>(),
        channel,
        generation,
        3,
        None,
    )
    .await;
    assert_eq!(gone, Err(STALE.to_string()));
    assert_eq!(airplay_end_conversion().await, Ok(()));
    #[cfg(not(target_os = "macos"))]
    let support = ConverterSupport {
        convert: false,
        hardware_encoder: false,
    };
    // A Mac's is what the bundled ffmpeg can do.
    #[cfg(target_os = "macos")]
    let support = {
        let support = crate::convert::support::support(&handle).await;
        ConverterSupport {
            convert: support.convert,
            hardware_encoder: support.hardware_encoder,
        }
    };
    assert_eq!(
        airplay_converter_support(handle.clone()).await,
        Ok(support)
    );
    install(&handle);
}

#[test]
fn copies_the_audio_airplay_plays() {
    assert_eq!(AIRPLAY_AUDIO, ["aac", "mp3"]);
}
