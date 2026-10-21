// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::cache::store::PlaybackPosition;
use crate::models::playlist::Provider;
use crate::remote::transfer::chunks::{self, Assembler};
use crate::remote::transfer::matching::Miss;
use crate::remote::transfer::merge::{Tally, Unmatched, UnmatchedKind};

const NOW: i64 = 1_760_000_000;

fn provider(id: &str, kind: ProviderType, url: &str, username: Option<&str>) -> Provider {
    Provider {
        id: id.into(),
        name: id.into(),
        provider_type: kind,
        url: url.into(),
        username: username.map(Into::into),
        password: Some("made-up".into()),
        last_updated: None,
        channel_count: 0,
        epg_url: None,
    }
}

fn channel(id: &str, name: &str, content_type: &str) -> Channel {
    Channel {
        id: id.into(),
        name: name.into(),
        url: format!("http://panel.example/{id}"),
        group_title: "All".into(),
        content_type: content_type.into(),
        ..Channel::default()
    }
}

/// A device with one Xtream account, `prefix` as its provider id, holding a
/// live channel, two movies, a show and an M3U file with one channel.
fn device(prefix: &str) -> CacheStore {
    let store = CacheStore::open_in_memory().unwrap();
    store
        .upsert_provider(&provider(
            prefix,
            ProviderType::Xtream,
            "http://panel.example:8080",
            Some("viewer"),
        ))
        .unwrap();
    let id = |rest: &str| format!("{prefix}-{rest}");
    store
        .save_channels(
            prefix,
            &[
                Channel {
                    tvg_id: Some("bbc1.uk".into()),
                    group_title: "News".into(),
                    ..channel(&id("live-1"), "BBC One", "live")
                },
                channel(&id("movie-8"), "Heat", "movie"),
                channel(&id("movie-9"), "Alien", "movie"),
                Channel {
                    url: "xtream://series/42".into(),
                    group_title: "Drama".into(),
                    ..channel(&id("series-42"), "Lost", "series")
                },
            ],
        )
        .unwrap();
    store
        .upsert_provider(&provider(
            "m3u-file",
            ProviderType::M3u,
            "file:///home/me/list.m3u",
            None,
        ))
        .unwrap();
    store
        .save_channels("m3u-file", &[channel("m3u-file-ch-0", "Local", "live")])
        .unwrap();
    store
}

fn history(store: &CacheStore, channel_id: &str, name: &str, kind: &str, w: Watched) {
    store
        .conn
        .execute(
            "INSERT OR REPLACE INTO watch_history
                (channel_id, channel_name, channel_logo, content_type, first_watched_at,
                 last_watched_at, total_duration_seconds, play_count)
             VALUES (?1, ?2, 'http://user:pass@logo.example/x.png', ?3, ?4, ?5, ?6, ?7)",
            params![
                channel_id,
                name,
                kind,
                w.first_watched_at,
                w.last_watched_at,
                w.watched_seconds,
                w.play_count
            ],
        )
        .unwrap();
}

fn position(store: &CacheStore, key: &str, p: Position) {
    store
        .conn
        .execute(
            "INSERT OR REPLACE INTO playback_positions
                (content_key, position_seconds, duration_seconds, updated_at, finished)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![key, p.position, p.duration, p.updated_at, p.finished],
        )
        .unwrap();
}

fn watched(first: i64, last: i64, plays: i64, seconds: i64) -> Watched {
    Watched {
        first_watched_at: first,
        last_watched_at: last,
        play_count: plays,
        watched_seconds: seconds,
    }
}

fn at(seconds: f64, updated_at: i64) -> Position {
    Position {
        position: seconds,
        duration: 2700.0,
        updated_at,
        finished: false,
    }
}

fn done(updated_at: i64) -> Position {
    Position {
        position: 2700.0,
        finished: true,
        ..at(0.0, updated_at)
    }
}

/// Sends `from`'s history to `to` the way two devices do: a new salt, the
/// export in chunks, matched and merged on `to`.
fn transfer(from: &CacheStore, to: &CacheStore, what: What, playing: Option<&str>) -> Report {
    transfer_at(from, NOW, to, NOW, what, playing)
}

fn transfer_at(
    from: &CacheStore,
    from_now: i64,
    to: &CacheStore,
    to_now: i64,
    what: What,
    playing: Option<&str>,
) -> Report {
    let salt = Salt::generate();
    let export = from
        .export_transfer(&salt, what, playing, from_now)
        .unwrap();
    let (parts, dropped) = chunks::split(&export);
    assert_eq!(dropped, 0);
    let mut assembler = Assembler::new();
    let mut received = None;
    for part in parts {
        let bytes = serde_json::to_vec(&part).unwrap().len();
        received = assembler.push(part, bytes).unwrap();
    }
    let received = received.unwrap();
    let index = to.transfer_index(&salt).unwrap();
    let plan = merge::plan(
        &received,
        &index,
        merge::clock_offset(received.sent_at, to_now),
    );
    to.apply_transfer(&plan).unwrap()
}

/// Everything a transfer can change, to compare before and after.
fn snapshot(store: &CacheStore) -> Vec<String> {
    let mut rows = Vec::new();
    for sql in [
        "SELECT channel_id || '|' || channel_name || '|' || IFNULL(channel_logo, '') || '|' ||
                content_type || '|' || first_watched_at || '|' || last_watched_at || '|' ||
                total_duration_seconds || '|' || play_count FROM watch_history",
        "SELECT content_key || '|' || position_seconds || '|' || duration_seconds || '|' ||
                updated_at || '|' || finished FROM playback_positions",
        "SELECT id FROM channels WHERE is_favorite = 1",
        "SELECT provider_id || '|' || content_type || '|' || group_name || '|' || sort_order
         FROM pinned_groups",
    ] {
        let mut stmt = store.conn.prepare(sql).unwrap();
        let mut found: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        found.sort();
        rows.extend(found);
        rows.push("--".into());
    }
    rows
}

fn saved_position(store: &CacheStore, key: &str) -> Option<PlaybackPosition> {
    store.get_playback_position(key).unwrap()
}

#[test]
fn a_finished_position_is_kept_as_finished() {
    let store = CacheStore::open_in_memory().unwrap();
    store
        .save_playback_position("movie:heat", 600.0, 2700.0)
        .unwrap();
    store.mark_position_finished("movie:heat", 2700.0).unwrap();
    let saved = saved_position(&store, "movie:heat").unwrap();
    assert!(saved.finished);
    assert_eq!(saved.position_seconds, 2700.0);
    assert_eq!(saved.duration_seconds, 2700.0);
    // Watching it again starts a new partial position.
    store
        .save_playback_position("movie:heat", 30.0, 2700.0)
        .unwrap();
    let saved = saved_position(&store, "movie:heat").unwrap();
    assert!(!saved.finished);
    assert_eq!(saved.position_seconds, 30.0);
}

#[test]
fn a_database_from_before_gets_the_finished_column() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE playback_positions (
            content_key TEXT PRIMARY KEY, position_seconds REAL NOT NULL,
            duration_seconds REAL NOT NULL, updated_at INTEGER NOT NULL);
         INSERT INTO playback_positions VALUES ('movie:heat', 600.0, 2700.0, 5);",
    )
    .unwrap();
    let store = CacheStore { conn };
    store.init_tables().unwrap();
    assert!(!saved_position(&store, "movie:heat").unwrap().finished);
}

#[test]
fn a_partial_episode_resumes_at_its_place_on_the_other_device() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-xt-ep-42-s1-3",
        "Lost S01E04 Walkabout",
        "series",
        watched(NOW - 900, NOW - 60, 1, 840),
    );
    position(&mac, "series:lost:s1e4", at(1234.5, NOW - 60));

    let report = transfer(&mac, &tv, What::ALL, Some("xt-mac-xt-ep-42-s1-3"));

    let saved = saved_position(&tv, "series:lost:s1e4").unwrap();
    assert_eq!(saved.position_seconds, 1234.5);
    assert!(!saved.finished);
    let rows = tv.get_watch_history(10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].channel_id, "xt-tv-xt-ep-42-s1-3");
    assert_eq!(rows[0].last_watched_at, NOW - 60);
    assert_eq!(
        report.resume,
        Some(merge::Resume {
            channel_id: "xt-tv-xt-ep-42-s1-3".into(),
            name: "Lost S01E04 Walkabout".into(),
            position: Some(1234.5),
            key: Some("series:lost:s1e4".into()),
        })
    );
    assert_eq!(
        report.history,
        Tally {
            added: 1,
            ..Tally::default()
        }
    );
    assert_eq!(report.positions.added, 1);
    assert_eq!(report.unmatched_total, 0);
}

#[test]
fn copied_history_uses_the_destinations_own_name_and_logo() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    tv.conn
        .execute(
            "UPDATE channels SET name = 'BBC 1', logo_url = 'http://tv.example/bbc.png'
             WHERE id = 'xt-tv-live-1'",
            [],
        )
        .unwrap();
    history(
        &mac,
        "xt-mac-live-1",
        "BBC One",
        "live",
        watched(1, 2, 3, 4),
    );
    transfer(&mac, &tv, What::ALL, None);
    let rows = tv.get_watch_history(10).unwrap();
    assert_eq!(rows[0].channel_name, "BBC 1");
    assert_eq!(
        rows[0].channel_logo.as_deref(),
        Some("http://tv.example/bbc.png")
    );
}

#[test]
fn a_repeated_transfer_changes_nothing() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(10, 20, 2, 300),
    );
    position(&mac, "movie:heat", at(300.0, 20));
    history(
        &mac,
        "xt-mac-live-1",
        "BBC One",
        "live",
        watched(5, 25, 9, 900),
    );
    mac.toggle_favorite("xt-mac-movie-9").unwrap();
    mac.pin_group("xt-mac", "live", "News", 0).unwrap();

    let first = transfer(&mac, &tv, What::ALL, None);
    assert_eq!(first.history.added, 2);
    assert_eq!(first.positions.added, 1);
    assert_eq!(first.favorites.added, 1);
    assert_eq!(first.pins.added, 1);
    let after_first = snapshot(&tv);

    let second = transfer(&mac, &tv, What::ALL, None);
    assert_eq!(snapshot(&tv), after_first);
    assert_eq!(
        second.history,
        Tally {
            unchanged: 2,
            ..Tally::default()
        }
    );
    assert_eq!(second.positions.unchanged, 1);
    assert_eq!(second.favorites.unchanged, 1);
    assert_eq!(second.pins.unchanged, 1);
}

#[test]
fn nothing_changes_on_the_source() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(10, 20, 2, 300),
    );
    history(
        &tv,
        "xt-tv-movie-9",
        "Alien",
        "movie",
        watched(10, 20, 2, 300),
    );
    let before = snapshot(&mac);
    transfer(&mac, &tv, What::ALL, None);
    assert_eq!(snapshot(&mac), before);
}

#[test]
fn unrelated_history_on_the_destination_stays() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(10, 20, 2, 300),
    );
    history(&tv, "xt-tv-movie-9", "Alien", "movie", watched(1, 2, 1, 50));
    position(&tv, "movie:alien", at(50.0, 2));
    transfer(&mac, &tv, What::ALL, None);
    assert_eq!(tv.get_watch_history(10).unwrap().len(), 2);
    assert_eq!(
        saved_position(&tv, "movie:alien").unwrap().position_seconds,
        50.0
    );
}

#[test]
fn a_rewatch_on_the_destination_keeps_its_newer_earlier_position() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(10, 100, 1, 2000),
    );
    position(&mac, "movie:heat", at(2000.0, 100));
    history(
        &tv,
        "xt-tv-movie-8",
        "Heat",
        "movie",
        watched(10, 200, 2, 2100),
    );
    position(&tv, "movie:heat", at(90.0, 200));

    let report = transfer(&mac, &tv, What::ALL, None);
    assert_eq!(
        saved_position(&tv, "movie:heat").unwrap().position_seconds,
        90.0
    );
    assert_eq!(report.positions.unchanged, 1);
    assert_eq!(report.history.unchanged, 1);
}

#[test]
fn a_newer_rewatch_on_the_source_replaces_a_later_position() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(10, 300, 3, 2100),
    );
    position(&mac, "movie:heat", at(90.0, 300));
    history(
        &tv,
        "xt-tv-movie-8",
        "Heat",
        "movie",
        watched(5, 200, 2, 2000),
    );
    position(&tv, "movie:heat", at(2000.0, 200));

    let report = transfer(&mac, &tv, What::ALL, None);
    assert_eq!(
        saved_position(&tv, "movie:heat").unwrap().position_seconds,
        90.0
    );
    assert_eq!(report.positions.updated, 1);
    assert_eq!(report.history.updated, 1);
    let row = &tv.get_watch_history(10).unwrap()[0];
    assert_eq!(
        (row.first_watched_at, row.last_watched_at, row.play_count),
        (5, 300, 3)
    );
    assert_eq!(row.total_duration_seconds, 2100);
}

#[test]
fn a_completed_episode_stops_the_other_device_offering_to_resume_it() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-xt-ep-42-s1-0",
        "Lost S01E01 Pilot",
        "series",
        watched(100, 300, 1, 2700),
    );
    position(&mac, "series:lost:s1e1", done(300));
    position(&tv, "series:lost:s1e1", at(1500.0, 200));

    let report = transfer(&mac, &tv, What::ALL, None);
    let saved = saved_position(&tv, "series:lost:s1e1").unwrap();
    assert!(saved.finished);
    assert_eq!(report.positions.updated, 1);
    assert_eq!(report.resume.unwrap().position, None);
}

#[test]
fn a_destination_clock_ten_minutes_ahead_doesnt_win_every_conflict() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    // The Mac watched again at its own NOW. The TV, whose clock is 600 s
    // ahead, saved its position 300 s before that by the Mac's clock.
    position(&mac, "movie:heat", at(100.0, NOW));
    position(&tv, "movie:heat", at(2000.0, NOW + 300));
    transfer_at(&mac, NOW, &tv, NOW + 600, What::ALL, None);
    let saved = saved_position(&tv, "movie:heat").unwrap();
    assert_eq!(saved.position_seconds, 100.0);
    assert_eq!(saved.updated_at, NOW + 600);
}

#[test]
fn content_the_destination_doesnt_have_is_reported_not_substituted() {
    let mac = device("xt-mac");
    let tv = CacheStore::open_in_memory().unwrap();
    tv.upsert_provider(&provider(
        "m3u-tv",
        ProviderType::M3u,
        "http://other.example/list.m3u",
        None,
    ))
    .unwrap();
    tv.save_channels(
        "m3u-tv",
        &[
            channel("m3u-tv-ch-0", "Heat 2", "movie"),
            channel("m3u-tv-ch-1", "Alien", "movie"),
            channel("m3u-tv-ch-2", "ALIEN", "movie"),
        ],
    )
    .unwrap();
    history(&mac, "xt-mac-movie-8", "Heat", "movie", watched(1, 2, 1, 1));
    mac.toggle_favorite("xt-mac-movie-9").unwrap();
    mac.toggle_favorite("m3u-file-ch-0").unwrap();
    mac.pin_group("xt-mac", "live", "News", 0).unwrap();

    let report = transfer(&mac, &tv, What::ALL, None);
    assert_eq!(
        report.unmatched,
        vec![
            Unmatched {
                name: "Heat".into(),
                kind: UnmatchedKind::Movie,
                reason: Miss::Missing,
            },
            Unmatched {
                name: "Alien".into(),
                kind: UnmatchedKind::Movie,
                reason: Miss::Ambiguous,
            },
            Unmatched {
                name: "Local".into(),
                kind: UnmatchedKind::Live,
                reason: Miss::Missing,
            },
            Unmatched {
                name: "News".into(),
                kind: UnmatchedKind::PinnedGroup,
                reason: Miss::Missing,
            },
        ]
    );
    assert_eq!(report.unmatched_total, 4);
    assert!(tv.get_watch_history(10).unwrap().is_empty());
    assert_eq!(snapshot(&tv)[1], "--");
}

#[test]
fn a_failed_write_leaves_the_destination_as_it_was() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(10, 20, 2, 300),
    );
    position(&mac, "movie:heat", at(300.0, 20));
    mac.toggle_favorite("xt-mac-movie-9").unwrap();
    mac.pin_group("xt-mac", "live", "News", 0).unwrap();
    tv.conn
        .execute_batch(
            "CREATE TRIGGER no_pins BEFORE INSERT ON pinned_groups
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .unwrap();
    let before = snapshot(&tv);

    let salt = Salt::generate();
    let export = mac.export_transfer(&salt, What::ALL, None, NOW).unwrap();
    let plan = merge::plan(&export, &tv.transfer_index(&salt).unwrap(), 0);
    assert!(tv.apply_transfer(&plan).is_err());
    assert_eq!(snapshot(&tv), before);
}

#[test]
fn pins_go_after_the_destinations_own_in_the_sources_order() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    for (n, group) in ["Drama", "News"].into_iter().enumerate() {
        let content_type = if group == "News" { "live" } else { "series" };
        mac.pin_group("xt-mac", content_type, group, n as i64)
            .unwrap();
    }
    tv.save_channels(
        "xt-tv",
        &[
            Channel {
                group_title: "Sport".into(),
                ..channel("xt-tv-live-2", "Sky Sports", "live")
            },
            Channel {
                tvg_id: Some("bbc1.uk".into()),
                group_title: "News".into(),
                ..channel("xt-tv-live-1", "BBC One", "live")
            },
            Channel {
                group_title: "UK".into(),
                ..channel("xt-tv-live-3", "ITV", "live")
            },
        ],
    )
    .unwrap();
    tv.pin_group("xt-tv", "live", "Sport", 4).unwrap();
    mac.pin_group("xt-mac", "live", "UK", 7).unwrap();
    mac.save_channels(
        "xt-mac",
        &[
            Channel {
                group_title: "News".into(),
                ..channel("xt-mac-live-1", "BBC One", "live")
            },
            Channel {
                group_title: "UK".into(),
                ..channel("xt-mac-live-3", "ITV", "live")
            },
        ],
    )
    .unwrap();

    transfer(&mac, &tv, What::ALL, None);
    let pins: Vec<(String, i64)> = tv
        .get_pinned_groups("xt-tv", "live")
        .unwrap()
        .into_iter()
        .map(|p| (p.group_name, p.sort_order))
        .collect();
    assert_eq!(
        pins,
        [("Sport".into(), 4), ("News".into(), 5), ("UK".into(), 6)]
    );
}

#[test]
fn a_pin_on_a_type_with_no_pins_starts_at_zero() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    mac.pin_group("xt-mac", "series", "Drama", 3).unwrap();
    transfer(&mac, &tv, What::ALL, None);
    let pins = tv.get_pinned_groups("xt-tv", "series").unwrap();
    assert_eq!(pins.len(), 1);
    assert_eq!(pins[0].sort_order, 0);
}

#[test]
fn a_transfer_copies_only_what_was_picked() {
    let mac = device("xt-mac");
    let tv = device("xt-tv");
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(10, 20, 2, 300),
    );
    mac.toggle_favorite("xt-mac-movie-9").unwrap();
    mac.pin_group("xt-mac", "live", "News", 0).unwrap();
    let report = transfer(
        &mac,
        &tv,
        What {
            favorites: true,
            ..What::default()
        },
        None,
    );
    assert_eq!(report.favorites.added, 1);
    assert_eq!(report.history, Tally::default());
    assert_eq!(report.pins, Tally::default());
    assert_eq!(report.resume, None);
    assert!(tv.get_watch_history(10).unwrap().is_empty());
}

#[test]
fn the_export_carries_references_and_never_ids_logins_or_logos() {
    let mac = device("xt-mac");
    history(
        &mac,
        "xt-mac-live-1",
        "BBC One",
        "live",
        watched(1, 50, 3, 60),
    );
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(1, 40, 1, 60),
    );
    history(
        &mac,
        "xt-mac-xt-ep-42-s1-0",
        "Lost S01E01 Pilot",
        "series",
        watched(1, 30, 1, 60),
    );
    position(&mac, "movie:heat", at(300.0, 40));
    position(&mac, "series:lost:s1e1", done(30));
    position(&mac, "series:lost:s2e5", at(10.0, 20));
    position(&mac, "movie:old one", at(5.0, 10));
    position(&mac, "garbage", at(5.0, 10));
    mac.save_omdb_cache(
        "xt-mac-movie-8",
        &serde_json::from_value(serde_json::json!({
            "title": "Heat", "imdbId": "tt0113277"
        }))
        .unwrap(),
    )
    .unwrap();
    mac.toggle_favorite("xt-mac-live-1").unwrap();
    mac.toggle_favorite("xt-mac-series-42").unwrap();
    mac.toggle_favorite("m3u-file-ch-0").unwrap();
    mac.pin_group("xt-mac", "live", "News", 0).unwrap();
    mac.pin_group("m3u-file", "live", "All", 0).unwrap();

    let salt = Salt::generate();
    let export = mac.export_transfer(&salt, What::ALL, None, NOW).unwrap();
    let account = refs::account_tag(
        &salt,
        &provider(
            "x",
            ProviderType::Xtream,
            "http://panel.example:8080",
            Some("viewer"),
        ),
    );
    let xt = |kind, name: &str, panel: &str| ItemRef {
        account: account.clone(),
        panel_id: Some(panel.into()),
        ..ItemRef::named(kind, name)
    };
    let refs: Vec<(ItemRef, bool, bool, bool)> = export
        .items
        .iter()
        .map(|i| {
            (
                i.reference.clone(),
                i.watched.is_some(),
                i.position.is_some(),
                i.favorite,
            )
        })
        .collect();
    assert_eq!(
        refs,
        vec![
            (
                ItemRef {
                    tvg_id: Some("bbc1.uk".into()),
                    ..xt(ItemKind::Live, "BBC One", "live-1")
                },
                true,
                false,
                true
            ),
            (
                ItemRef {
                    imdb: Some("tt0113277".into()),
                    ..xt(ItemKind::Movie, "Heat", "movie-8")
                },
                true,
                true,
                false
            ),
            (
                ItemRef {
                    series: Some("Lost".into()),
                    season: Some(1),
                    episode: Some(1),
                    ..xt(ItemKind::Episode, "Lost S01E01 Pilot", "xt-ep-42-s1-0")
                },
                true,
                true,
                false
            ),
            (
                xt(ItemKind::Series, "Lost", "series-42"),
                false,
                false,
                true
            ),
            (ItemRef::named(ItemKind::Live, "Local"), false, false, true),
            (
                ItemRef {
                    series: Some("lost".into()),
                    season: Some(2),
                    episode: Some(5),
                    ..ItemRef::named(ItemKind::Episode, "lost S02E05")
                },
                false,
                true,
                false
            ),
            (
                ItemRef::named(ItemKind::Movie, "old one"),
                false,
                true,
                false
            ),
        ]
    );
    assert!(export.items[2].position.unwrap().finished);
    assert_eq!(
        export.pins,
        vec![Pin {
            account: account.clone().unwrap(),
            content_type: "live".into(),
            group: "News".into(),
        }]
    );
    assert_eq!(export.sent_at, NOW);
    assert_eq!(export.current.as_ref().unwrap().name, "BBC One");

    let json = serde_json::to_string(&chunks::split(&export).0).unwrap();
    for secret in [
        "made-up",
        "viewer",
        "panel.example",
        "xt-mac",
        "logo.example",
        "file://",
    ] {
        assert!(!json.contains(secret), "the export carries something it mustn't");
    }
}

#[test]
fn the_current_item_is_the_one_playing() {
    let mac = device("xt-mac");
    history(
        &mac,
        "xt-mac-live-1",
        "BBC One",
        "live",
        watched(1, 50, 3, 60),
    );
    history(
        &mac,
        "xt-mac-movie-8",
        "Heat",
        "movie",
        watched(1, 40, 1, 60),
    );
    let salt = Salt::generate();
    let current = |playing| {
        mac.export_transfer(&salt, What::ALL, playing, NOW)
            .unwrap()
            .current
            .map(|r| r.name)
    };
    assert_eq!(current(Some("xt-mac-movie-8")).as_deref(), Some("Heat"));
    assert_eq!(current(Some("xt-mac-movie-9")).as_deref(), Some("BBC One"));
    assert_eq!(current(None).as_deref(), Some("BBC One"));
    let empty = CacheStore::open_in_memory().unwrap();
    assert_eq!(
        empty
            .export_transfer(&salt, What::ALL, None, NOW)
            .unwrap()
            .current,
        None
    );
}

#[test]
fn an_m3u_episode_favorite_carries_its_show_and_numbers() {
    let mac = CacheStore::open_in_memory().unwrap();
    mac.upsert_provider(&provider(
        "m3u-a",
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    ))
    .unwrap();
    mac.save_channels(
        "m3u-a",
        &[
            Channel {
                series_title: Some("Lost".into()),
                season: Some(2),
                episode: Some(3),
                ..channel("m3u-a-ch-0", "Lost S02E03", "series")
            },
            channel("m3u-a-ch-1", "Odd", "radio"),
        ],
    )
    .unwrap();
    mac.toggle_favorite("m3u-a-ch-0").unwrap();
    mac.toggle_favorite("m3u-a-ch-1").unwrap();
    history(&mac, "m3u-a-ch-1", "Odd", "radio", watched(1, 2, 1, 1));
    let export = mac
        .export_transfer(&Salt::generate(), What::ALL, None, NOW)
        .unwrap();
    assert_eq!(export.items.len(), 1);
    let r = &export.items[0].reference;
    assert_eq!(r.kind, ItemKind::Episode);
    assert_eq!(r.series.as_deref(), Some("Lost"));
    assert_eq!((r.season, r.episode), (Some(2), Some(3)));
    assert_eq!(r.panel_id, None);
    assert!(r.account.is_some());
}

#[test]
fn an_m3u_episode_in_history_takes_its_numbers_from_its_channel() {
    let mac = CacheStore::open_in_memory().unwrap();
    mac.upsert_provider(&provider(
        "m3u-a",
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    ))
    .unwrap();
    mac.save_channels(
        "m3u-a",
        &[Channel {
            series_title: Some("Lost".into()),
            season: Some(2),
            episode: Some(3),
            ..channel("m3u-a-ch-0", "Lost - The Long Con", "series")
        }],
    )
    .unwrap();
    history(
        &mac,
        "m3u-a-ch-0",
        "Lost - The Long Con",
        "series",
        watched(1, 2, 1, 1),
    );
    history(
        &mac,
        "m3u-a-ch-9",
        "Unparsed episode",
        "series",
        watched(1, 2, 1, 1),
    );
    position(&mac, "series:lost:s2e3", at(100.0, 2));
    let export = mac
        .export_transfer(&Salt::generate(), What::ALL, None, NOW)
        .unwrap();
    let r = &export.items[0].reference;
    assert_eq!(
        (r.series.as_deref(), r.season, r.episode),
        (Some("Lost"), Some(2), Some(3))
    );
    assert!(export.items[0].position.is_some());
    let unparsed = &export.items[1].reference;
    assert_eq!(unparsed.kind, ItemKind::Episode);
    assert_eq!((unparsed.series.as_ref(), unparsed.season), (None, None));
    assert_eq!(export.items.len(), 2);
}

#[test]
fn the_index_has_saved_episode_lists_of_shows_still_there() {
    let tv = device("xt-tv");
    let episode = |id: &str, n: u32| Channel {
        series_title: Some("Lost".into()),
        season: Some(1),
        episode: Some(n),
        logo_url: Some("http://img.example/ep.png".into()),
        ..channel(id, &format!("Lost S01E{n:02}"), "series")
    };
    tv.save_series_episodes(
        "xt-tv-series-42",
        &[
            episode("xt-tv-xt-ep-42-s1-0", 1),
            episode("xt-tv-xt-ep-42-s1-1", 2),
        ],
    )
    .unwrap();
    tv.save_series_episodes("xt-gone-series-1", &[episode("xt-gone-xt-ep-1-s1-0", 1)])
        .unwrap();
    tv.conn
        .execute(
            "INSERT INTO series_episode_cache VALUES ('xt-tv-series-42x', 'not json', 0)",
            [],
        )
        .unwrap();
    let salt = Salt::generate();
    let index = tv.transfer_index(&salt).unwrap();
    let r = ItemRef {
        series: Some("Lost".into()),
        season: Some(1),
        episode: Some(2),
        ..ItemRef::named(ItemKind::Episode, "Lost S01E02")
    };
    let found = index.find(&r).unwrap().channel.unwrap();
    assert_eq!(found.id, "xt-tv-xt-ep-42-s1-1");
    assert_eq!(found.provider_id, "xt-tv");
    assert_eq!(found.group, "Drama");
    assert_eq!(found.logo.as_deref(), Some("http://img.example/ep.png"));
    let gone = ItemRef {
        series: Some("Lost".into()),
        season: Some(1),
        episode: Some(1),
        ..r
    };
    assert_eq!(
        index.find(&gone).unwrap().channel.unwrap().id,
        "xt-tv-xt-ep-42-s1-0"
    );
}

#[test]
fn the_index_reads_episode_numbers_from_old_names() {
    let tv = CacheStore::open_in_memory().unwrap();
    tv.upsert_provider(&provider(
        "m3u-a",
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    ))
    .unwrap();
    tv.save_channels("m3u-a", &[channel("m3u-a-ch-0", "Lost S01E05", "series")])
        .unwrap();
    let index = tv.transfer_index(&Salt::generate()).unwrap();
    let r = ItemRef {
        series: Some("Lost".into()),
        season: Some(1),
        episode: Some(5),
        ..ItemRef::named(ItemKind::Episode, "Lost S01E05")
    };
    assert_eq!(index.find(&r).unwrap().channel.unwrap().id, "m3u-a-ch-0");
}

#[test]
fn the_index_knows_imdb_ids_from_the_omdb_cache() {
    let tv = device("xt-tv");
    tv.save_omdb_cache(
        "xt-tv-movie-9",
        &serde_json::from_value(serde_json::json!({ "title": "Alien", "imdbId": "tt0078748" }))
            .unwrap(),
    )
    .unwrap();
    let index = tv.transfer_index(&Salt::generate()).unwrap();
    let r = ItemRef {
        imdb: Some("tt0078748".into()),
        ..ItemRef::named(ItemKind::Movie, "Alien (Director's Cut)")
    };
    assert_eq!(index.find(&r).unwrap().channel.unwrap().id, "xt-tv-movie-9");
}

#[test]
fn an_empty_imdb_id_in_the_cache_isnt_sent() {
    let mac = device("xt-mac");
    mac.save_omdb_cache(
        "xt-mac-movie-8",
        &serde_json::from_value(serde_json::json!({ "title": "Heat", "imdbId": "" })).unwrap(),
    )
    .unwrap();
    history(&mac, "xt-mac-movie-8", "Heat", "movie", watched(1, 2, 1, 1));
    let export = mac
        .export_transfer(&Salt::generate(), What::ALL, None, NOW)
        .unwrap();
    assert_eq!(export.items[0].reference.imdb, None);
}

#[test]
fn a_favorite_live_channel_with_an_empty_tvg_id_sends_none() {
    let mac = CacheStore::open_in_memory().unwrap();
    mac.upsert_provider(&provider(
        "m3u-a",
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    ))
    .unwrap();
    mac.save_channels(
        "m3u-a",
        &[
            Channel {
                tvg_id: Some(String::new()),
                ..channel("m3u-a-ch-0", "Blank", "live")
            },
            Channel {
                tvg_id: Some("cnn.us".into()),
                ..channel("m3u-a-ch-1", "CNN", "live")
            },
        ],
    )
    .unwrap();
    mac.toggle_favorite("m3u-a-ch-0").unwrap();
    mac.toggle_favorite("m3u-a-ch-1").unwrap();
    let export = mac
        .export_transfer(&Salt::generate(), What::ALL, None, NOW)
        .unwrap();
    let tvg: Vec<Option<&str>> = export
        .items
        .iter()
        .map(|i| i.reference.tvg_id.as_deref())
        .collect();
    assert_eq!(tvg, [None, Some("cnn.us")]);
}

#[test]
fn the_index_keeps_stored_episode_numbers_over_the_name() {
    let tv = CacheStore::open_in_memory().unwrap();
    tv.upsert_provider(&provider(
        "m3u-a",
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    ))
    .unwrap();
    tv.save_channels(
        "m3u-a",
        &[
            // The name gives no show, season or episode.
            Channel {
                series_title: Some("Lost".into()),
                season: Some(2),
                episode: Some(3),
                ..channel("m3u-a-ch-0", "The Long Con", "series")
            },
            // The name says another episode than the stored one.
            Channel {
                series_title: Some("Lost".into()),
                season: Some(1),
                episode: Some(6),
                ..channel("m3u-a-ch-1", "Lost S01E05 part two", "series")
            },
        ],
    )
    .unwrap();
    let index = tv.transfer_index(&Salt::generate()).unwrap();
    let episode = |season, episode| ItemRef {
        series: Some("Lost".into()),
        season: Some(season),
        episode: Some(episode),
        ..ItemRef::named(ItemKind::Episode, "x")
    };
    assert_eq!(
        index.find(&episode(2, 3)).unwrap().channel.unwrap().id,
        "m3u-a-ch-0"
    );
    assert_eq!(
        index.find(&episode(1, 6)).unwrap().channel.unwrap().id,
        "m3u-a-ch-1"
    );
}

#[test]
fn a_channel_or_a_saved_episode_is_found_by_id() {
    let tv = device("xt-tv");
    let episode = Channel {
        series_title: Some("Lost".into()),
        season: Some(1),
        episode: Some(1),
        ..channel("xt-tv-xt-ep-42-s1-0", "Lost S01E01", "series")
    };
    tv.save_series_episodes("xt-tv-series-42", std::slice::from_ref(&episode))
        .unwrap();
    tv.conn
        .execute(
            "INSERT INTO series_episode_cache VALUES ('broken', 'not json', 0)",
            [],
        )
        .unwrap();
    assert_eq!(
        tv.find_channel("xt-tv-movie-8").unwrap().unwrap().name,
        "Heat"
    );
    assert_eq!(
        tv.find_channel("xt-tv-xt-ep-42-s1-0").unwrap(),
        Some(episode)
    );
    assert_eq!(tv.find_channel("xt-tv-xt-ep-42-s1-9").unwrap(), None);
}

#[test]
fn only_shows_lists_and_numbered_episodes_reach_the_index() {
    let tv = device("xt-tv");
    // A list saved under a movie's id isn't a show's.
    tv.save_series_episodes(
        "xt-tv-movie-8",
        &[Channel {
            series_title: Some("Odd".into()),
            season: Some(1),
            episode: Some(1),
            ..channel("xt-tv-xt-ep-8-s1-0", "Odd S01E01", "series")
        }],
    )
    .unwrap();
    // An entry without an episode number is no episode to match.
    tv.save_series_episodes(
        "xt-tv-series-42",
        &[Channel {
            series_title: Some("Lost".into()),
            season: Some(1),
            episode: None,
            ..channel("xt-tv-xt-ep-42-s1-9", "Lost Special", "series")
        }],
    )
    .unwrap();
    let index = tv.transfer_index(&Salt::generate()).unwrap();
    let odd = ItemRef {
        series: Some("Odd".into()),
        season: Some(1),
        episode: Some(1),
        ..ItemRef::named(ItemKind::Episode, "Odd S01E01")
    };
    assert!(index.find(&odd).is_err());
    let special = ItemRef::named(ItemKind::Series, "Lost Special");
    assert!(index.find(&special).is_err());
}
