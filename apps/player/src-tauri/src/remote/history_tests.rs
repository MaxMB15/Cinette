// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use mvp_core::models::playlist::{Provider, ProviderType};

/// A device with one Xtream account, under `prefix`, and one movie.
fn device(prefix: &str) -> Mutex<CacheStore> {
    let store = CacheStore::open_in_memory().unwrap();
    store
        .upsert_provider(&Provider {
            id: prefix.into(),
            name: "Home".into(),
            provider_type: ProviderType::Xtream,
            url: "http://panel.example:8080".into(),
            username: Some("viewer".into()),
            password: Some("made-up".into()),
            last_updated: None,
            channel_count: 1,
            epg_url: None,
        })
        .unwrap();
    store
        .save_channels(
            prefix,
            &[Channel {
                id: format!("{prefix}-movie-8"),
                name: "Heat".into(),
                url: "http://panel.example/movie/8.mkv".into(),
                group_title: "Films".into(),
                content_type: "movie".into(),
                ..Channel::default()
            }],
        )
        .unwrap();
    Mutex::new(store)
}

#[test]
fn a_movie_watched_here_resumes_there() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    {
        let mac = mac.lock().unwrap();
        mac.record_play_start("xt-mac-movie-8", "Heat", None, "movie")
            .unwrap();
        mac.save_playback_position("movie:heat", 1234.0, 6000.0)
            .unwrap();
    }
    assert_eq!(
        counts(&mac, What::ALL).unwrap(),
        Counts {
            history: 1,
            positions: 1,
            favorites: 0,
            pins: 0,
        }
    );
    let salt = Salt::generate();
    let sent = export(&mac, &salt, What::ALL, Some("xt-mac-movie-8")).unwrap();
    let imported = import(&tv, &salt, &sent).unwrap();
    assert_eq!(imported.report.history.added, 1);
    assert_eq!(imported.report.positions.added, 1);
    assert_eq!(imported.channel.unwrap().id, "xt-tv-movie-8");
    assert_eq!(imported.report.resume.unwrap().position, Some(1234.0));
    let saved = tv
        .lock()
        .unwrap()
        .get_playback_position("movie:heat")
        .unwrap()
        .unwrap();
    assert_eq!(saved.position_seconds, 1234.0);
}

#[test]
fn nothing_to_continue_leaves_out_the_channel() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    let salt = Salt::generate();
    let sent = export(&mac, &salt, What::ALL, None).unwrap();
    let imported = import(&tv, &salt, &sent).unwrap();
    assert_eq!(imported.channel, None);
    assert_eq!(
        serde_json::to_value(&imported).unwrap()["channel"],
        serde_json::Value::Null
    );
}

#[test]
fn a_broken_cache_fails_without_writing() {
    let mac = device("xt-mac");
    crate::test_support::poison(&mac);
    assert_eq!(counts(&mac, What::ALL), Err(ErrorCode::Failed));
    let salt = Salt::generate();
    assert_eq!(
        export(&mac, &salt, What::ALL, None).unwrap_err(),
        ErrorCode::Failed
    );
    assert_eq!(
        import(&mac, &salt, &Export::default()).unwrap_err(),
        ErrorCode::Failed
    );
}
