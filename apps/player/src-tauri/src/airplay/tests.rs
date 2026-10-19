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
    assert_eq!(
        load(&app, channel, generation, 0).await,
        Err(tauri_plugin_mpv::airplay::UNAVAILABLE.to_string())
    );
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
    list(&app, &channel).await;
    assert_eq!(load(&app, channel, first, 0).await, Err(STALE.to_string()));
}
