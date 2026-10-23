// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use serde_json::json;

fn player_state(extra: serde_json::Value) -> PlayerState {
    let mut value = json!({
        "status": "playing",
        "item": {
            "id": "p1-live-7",
            "name": "News",
            "contentType": "live",
            "group": "UK",
            "logoUrl": "http://iptv.example/logo.png"
        },
        "position": 12.5,
        "duration": 0,
        "volume": 80,
        "subtitleId": null,
        "audioId": null,
        "error": null
    });
    for (k, v) in extra.as_object().unwrap() {
        value[k] = v.clone();
    }
    serde_json::from_value(value).unwrap()
}

#[test]
fn the_player_state_becomes_a_snapshot_without_provider_logos() {
    let snapshot = player_state(json!({})).into_snapshot(&["iptv.example".into()], |_| None);
    let item = snapshot.item.unwrap();
    assert_eq!(item.id, "p1-live-7");
    assert_eq!(item.name, "News");
    assert_eq!(item.group, "UK");
    assert_eq!(item.logo, None);
    assert_eq!(snapshot.status, PlaybackStatus::Playing);
    assert_eq!(snapshot.position, 12.5);
    assert_eq!(snapshot.volume, Some(80));

    let kept = player_state(json!({})).into_snapshot(&[], |_| None);
    assert_eq!(
        kept.item.unwrap().logo.as_deref(),
        Some("http://iptv.example/logo.png")
    );
}

#[test]
fn numbers_that_are_not_numbers_or_out_of_range_are_cleaned() {
    // JSON has no NaN, so check the conversion directly.
    let mut state = player_state(json!({ "volume": 140.4, "position": -3 }));
    state.duration = f64::NAN;
    let snapshot = state.into_snapshot(&[], |_| None);
    assert_eq!(snapshot.volume, Some(100));
    assert_eq!(snapshot.position, 0.0);
    assert_eq!(snapshot.duration, 0.0);

    let mut state = player_state(json!({ "volume": 49.5 }));
    state.position = f64::INFINITY;
    let snapshot = state.into_snapshot(&[], |_| None);
    assert_eq!(snapshot.volume, Some(50));
    assert_eq!(snapshot.position, 0.0);

    let mut state = player_state(json!({ "volume": -2 }));
    assert_eq!(state.clone().into_snapshot(&[], |_| None).volume, Some(0));
    state.volume = Some(f64::NAN);
    assert_eq!(state.clone().into_snapshot(&[], |_| None).volume, None);
    state.volume = None;
    assert_eq!(state.into_snapshot(&[], |_| None).volume, None);
}

#[test]
fn nothing_playing_has_no_item() {
    let snapshot = player_state(json!({ "item": null, "status": "idle" })).into_snapshot(&[], |_| None);
    assert_eq!(snapshot.item, None);
    assert_eq!(snapshot.status, PlaybackStatus::Idle);
}

#[test]
fn outcomes_map_to_error_codes() {
    let parse = |s: &str| serde_json::from_value::<CommandOutcome>(json!(s)).unwrap();
    assert_eq!(parse("ok").into_result(), Ok(()));
    assert_eq!(parse("staleItem").into_result(), Err(ErrorCode::StaleItem));
    assert_eq!(
        parse("unsupported").into_result(),
        Err(ErrorCode::Unsupported)
    );
    assert_eq!(parse("notFound").into_result(), Err(ErrorCode::NotFound));
    assert_eq!(parse("failed").into_result(), Err(ErrorCode::Failed));
}

#[test]
fn a_blank_name_means_the_default() {
    let input = |name: Option<&str>| RemoteSettingsInput {
        discoverable: false,
        remote_control: ControlMode::Never,
        device_name: name.map(str::to_owned),
    };
    let s = input(Some("  Den TV ")).into_settings();
    assert_eq!(s.device_name.as_deref(), Some("Den TV"));
    assert!(!s.discoverable);
    assert_eq!(s.remote_control, ControlMode::Never);
    assert_eq!(input(Some("  \n ")).into_settings().device_name, None);
    assert_eq!(input(None).into_settings().device_name, None);
}

#[test]
fn an_episode_keeps_its_show_season_and_number() {
    let state = player_state(json!({
        "item": {
            "id": "xt-ep-9-s1-2", "name": "Pilot", "contentType": "series", "group": "Drama",
            "logoUrl": null, "seriesTitle": "The Show", "season": 1, "episode": 2
        }
    }));
    let mut asked = Vec::new();
    let item = state
        .into_snapshot(&[], |id| {
            asked.push(id.to_owned());
            Some("xt-series-9".into())
        })
        .item
        .unwrap();
    assert_eq!(item.content_type, "series");
    assert_eq!(item.series_title.as_deref(), Some("The Show"));
    assert_eq!(item.season, Some(1));
    assert_eq!(item.episode, Some(2));
    // The series it's in, so a controller can find the episodes around it.
    assert_eq!(item.series_id.as_deref(), Some("xt-series-9"));
    assert_eq!(asked, ["xt-ep-9-s1-2"]);
}

#[test]
fn only_an_episode_names_a_series() {
    let state = player_state(json!({
        "item": {
            "id": "movie-8", "name": "Heat", "contentType": "movie", "group": "Films",
            "logoUrl": null
        }
    }));
    let item = state
        .into_snapshot(&[], |_| panic!("a movie has no series"))
        .item
        .unwrap();
    assert_eq!(item.series_id, None);
}

#[test]
fn an_episode_of_no_known_series_names_none() {
    let state = player_state(json!({
        "item": {
            "id": "ch-4", "name": "Pilot S01E01", "contentType": "series", "group": "Drama",
            "logoUrl": null
        }
    }));
    assert_eq!(state.into_snapshot(&[], |_| None).item.unwrap().series_id, None);
}

#[test]
fn an_error_goes_on_as_its_code() {
    let refused = player_state(json!({ "status": "error", "error": "refused" }));
    assert_eq!(
        refused.into_snapshot(&[], |_| None).error,
        Some(PlaybackError::Refused)
    );
    let newer = player_state(json!({ "status": "error", "error": "notYetInvented" }));
    assert_eq!(newer.into_snapshot(&[], |_| None).error, Some(PlaybackError::Unknown));
}

#[test]
fn a_logo_on_the_site_the_item_streams_from_stays_home() {
    let next_to_stream = player_state(json!({ "item": {
        "id": "p1-live-7", "name": "News", "contentType": "live",
        "logoUrl": "http://img.panel.example/news.png",
        "streamHosts": ["Live.Panel.Example"]
    }}));
    assert_eq!(next_to_stream.into_snapshot(&[], |_| None).item.unwrap().logo, None);
    let elsewhere = player_state(json!({ "item": {
        "id": "p1-live-7", "name": "News", "contentType": "live",
        "logoUrl": "https://logos.example/news.png",
        "streamHosts": ["live.panel.example"]
    }}));
    assert_eq!(
        elsewhere.into_snapshot(&[], |_| None).item.unwrap().logo.as_deref(),
        Some("https://logos.example/news.png")
    );
    // Next to a provider's own server, too.
    let next_to_provider = player_state(json!({ "item": {
        "id": "p1-live-7", "name": "News", "contentType": "live",
        "logoUrl": "http://cdn.iptv.example/news.png"
    }}));
    let hosts = ["iptv.example".to_owned()];
    assert_eq!(
        next_to_provider.into_snapshot(&hosts, |_| None).item.unwrap().logo,
        None
    );
}

#[test]
fn local_network_access_isnt_refused_until_something_refuses_it() {
    // Nothing in a test run asks macOS, and Linux never refuses.
    assert!(!tauri::async_runtime::block_on(remote_local_network_denied()));
}
