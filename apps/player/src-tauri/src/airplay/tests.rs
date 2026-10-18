// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::test_support::TestApp;
use mvp_core::models::playlist::{Provider, ProviderType};
use tauri::Manager;

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

async fn load(app: &TestApp, channel: Channel, source: usize) -> Result<(), String> {
    let handle = app.handle();
    airplay_load(
        handle.clone(),
        app.state(),
        handle.state::<StreamsState>(),
        channel,
        source,
        Some(30.0),
    )
    .await
}

#[tokio::test]
async fn hands_the_resolved_url_to_the_plugin() {
    let app = TestApp::new();
    let channel = add_m3u_channel(&app);
    // The URL resolved, and the plugin says AirPlay isn't on this computer.
    assert_eq!(
        load(&app, channel, 0).await,
        Err(tauri_plugin_mpv::airplay::UNAVAILABLE.to_string())
    );
}

#[tokio::test]
async fn refuses_a_format_the_item_no_longer_has() {
    let app = TestApp::new();
    let channel = add_m3u_channel(&app);
    assert_eq!(
        load(&app, channel, 1).await,
        Err("That stream format is no longer offered".to_string())
    );
}
