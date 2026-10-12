// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Tests for the commands, run against a mock app from `test_support`.

mod downloads;
mod providers;
mod services;

use super::*;
use crate::test_support::TestApp;
use serde_json::{json, Value};
use std::sync::MutexGuard;

/// The app's cache, for setting up what a test needs and checking what a
/// command saved.
fn cache(app: &TestApp) -> MutexGuard<'_, CacheStore> {
    app.state().inner().cache.lock().unwrap()
}

/// Where the app keeps downloaded subtitles.
fn subtitles_folder(app: &TestApp) -> std::path::PathBuf {
    app.handle()
        .path()
        .app_cache_dir()
        .unwrap()
        .join("subtitles")
}

/// Moves the app's cache into a file and returns a second connection to it,
/// so a test can break the cache in ways the app never would.
fn cache_on_disk(app: &TestApp) -> rusqlite::Connection {
    let db = app.app_dir().join("maxvideoplayer.db");
    *cache(app) = CacheStore::open(&db).unwrap();
    rusqlite::Connection::open(&db).unwrap()
}

/// Makes every save into `table` fail, the way a full disk would.
fn refuse_saves(db: &rusqlite::Connection, table: &str) {
    db.execute_batch(&format!(
        "CREATE TRIGGER refuse_{table} BEFORE INSERT ON {table}
         BEGIN SELECT RAISE(ABORT, 'no space left'); END;"
    ))
    .unwrap();
}

/// What a command says when the cache refused a save.
const SAVE_REFUSED: &str = "database error: no space left";

/// A group's name, category and place in the list.
type Placed = (String, Option<String>, i64);

/// Where each group was put, in the order the list shows them.
fn placed(entries: Vec<GroupHierarchyEntry>) -> Vec<Placed> {
    entries
        .into_iter()
        .map(|e| (e.group_name, e.super_category, e.sort_order))
        .collect()
}

/// Where each group of provider `p` was put, for one content type.
async fn groups(app: &TestApp, content_type: &str) -> Vec<Placed> {
    let entries = get_group_hierarchy(app.state(), "p".into(), content_type.into())
        .await
        .unwrap();
    placed(entries)
}

#[test]
fn non_empty_key_skips_missing_and_blank_keys() {
    assert_eq!(non_empty_key(None), None);
    assert_eq!(non_empty_key(Some(json!(""))), None);
    assert_eq!(non_empty_key(Some(json!("   "))), None);
    assert_eq!(non_empty_key(Some(json!(42))), None);
    assert_eq!(
        non_empty_key(Some(json!(" abc123 "))).as_deref(),
        Some("abc123")
    );
}

#[test]
fn trimmed_key_drops_spaces_and_blank_keys() {
    assert_eq!(trimmed_key(" abc123\n"), Some("abc123"));
    assert_eq!(trimmed_key("abc 123"), Some("abc 123"));
    assert_eq!(trimmed_key(""), None);
    assert_eq!(trimmed_key(" \t\n"), None);
}

#[test]
fn omdb_key_accepted_tells_a_bad_key_from_other_answers() {
    let found = OmdbData {
        title: "The Matrix".into(),
        year: None,
        rated: None,
        runtime: None,
        genre: None,
        director: None,
        actors: None,
        plot: None,
        poster_url: None,
        imdb_rating: None,
        rotten_tomatoes: None,
        imdb_id: None,
        imdb_votes: None,
    };
    assert_eq!(omdb_key_accepted(Ok(found)), Ok(true));
    assert_eq!(
        omdb_key_accepted(Err(OmdbError::Api("Invalid API key!".into()))),
        Ok(false)
    );
    assert_eq!(
        omdb_key_accepted(Err(OmdbError::Api("No API key provided.".into()))),
        Ok(false)
    );
    // OMDb only says this to a key it knows.
    assert_eq!(
        omdb_key_accepted(Err(OmdbError::Api("Request limit reached!".into()))),
        Ok(true)
    );
    // A reply that can't be read says nothing about the key.
    assert!(omdb_key_accepted(Err(OmdbError::Parse("not JSON".into()))).is_err());
}

#[tokio::test]
async fn a_saved_key_is_read_back_and_written_to_the_app_folder() {
    let app = TestApp::new();
    assert_eq!(get_omdb_api_key(app.handle()).await, Ok(None));

    set_omdb_api_key(app.handle(), " abc123 ".into())
        .await
        .unwrap();

    assert_eq!(
        get_omdb_api_key(app.handle()).await,
        Ok(Some("abc123".into()))
    );
    assert!(app.app_dir().join(OMDB_STORE_FILE).is_file());
}

#[tokio::test]
async fn a_new_app_starts_with_no_providers() {
    let app = TestApp::new();
    assert!(get_providers(app.state()).await.unwrap().is_empty());
}

/// The arguments each command can't run without, by the names the frontend
/// sends them under. Commands that only take the app or its state are left
/// out, since a call can't leave anything out.
const REQUIRED_ARGUMENTS: &[(&str, &[&str])] = &[
    ("load_m3u_playlist", &["name", "url"]),
    ("load_m3u_file", &["name", "path"]),
    (
        "load_xtream_provider",
        &["name", "url", "username", "password"],
    ),
    ("remove_provider", &["id"]),
    ("toggle_favorite", &["channelId"]),
    ("refresh_provider", &["id"]),
    ("update_provider", &["id", "name", "url"]),
    ("get_xtream_series_episodes", &["channelId"]),
    ("refresh_epg", &["providerId"]),
    (
        "get_epg_programmes",
        &["channelId", "rangeStart", "rangeEnd"],
    ),
    ("detect_epg_url", &["id"]),
    ("set_epg_url", &["providerId"]),
    ("get_epg_for_live_channels", &["rangeStart", "rangeEnd"]),
    ("search_epg_programmes", &["query", "rangeStart"]),
    ("fetch_omdb_data", &["channelId", "title", "contentType"]),
    ("fetch_mdblist_data", &["imdbId", "mediaType"]),
    ("fetch_whatson_data", &["imdbId", "mediaType"]),
    ("get_skip_segments", &["imdbId", "duration"]),
    ("search_subtitles", &["imdbId"]),
    ("download_subtitle", &["fileId"]),
    (
        "record_play_start",
        &["channelId", "channelName", "contentType"],
    ),
    ("record_play_end", &["channelId", "durationSeconds"]),
    ("get_watch_history", &["limit"]),
    ("delete_history_entry", &["channelId"]),
    ("delete_history_series", &["seriesTitle"]),
    ("clear_watch_history_of_type", &["contentType"]),
    (
        "save_playback_position",
        &["contentKey", "positionSeconds", "durationSeconds"],
    ),
    ("get_playback_position", &["contentKey"]),
    ("delete_playback_position", &["contentKey"]),
    ("read_subtitle_file", &["path"]),
    ("get_group_hierarchy", &["providerId", "contentType"]),
    (
        "reorder_group_hierarchy_entry",
        &["providerId", "contentType", "groupName", "newSortOrder"],
    ),
    (
        "update_group_hierarchy_entry",
        &["providerId", "contentType", "groupName", "newSortOrder"],
    ),
    ("delete_group_hierarchy", &["providerId", "contentType"]),
    (
        "pin_group",
        &["providerId", "contentType", "groupName", "sortOrder"],
    ),
    ("unpin_group", &["providerId", "contentType", "groupName"]),
    ("get_pinned_groups", &["providerId", "contentType"]),
    (
        "categorize_provider",
        &["providerId", "contentType", "apiKey", "groupsWithSamples"],
    ),
    (
        "fix_uncategorized_groups",
        &[
            "providerId",
            "contentType",
            "apiKey",
            "uncategorizedGroups",
            "existingCategories",
        ],
    ),
    (
        "rename_super_category",
        &["providerId", "contentType", "oldName", "newName"],
    ),
    (
        "delete_super_category",
        &["providerId", "contentType", "categoryName"],
    ),
];

/// The arguments a call may leave out, which the frontend sends as `null` or
/// not at all.
const OPTIONAL_ARGUMENTS: &[(&str, &[&str])] = &[
    ("update_provider", &["username", "password"]),
    ("set_epg_url", &["epgUrl"]),
    ("get_skip_segments", &["season", "episode"]),
    ("search_subtitles", &["season", "episode"]),
    ("record_play_start", &["channelLogo"]),
    ("get_watch_history", &["contentType"]),
    ("update_group_hierarchy_entry", &["newSuperCategory"]),
];

/// A value of the right type for an argument, so a call is refused only for
/// the argument it leaves out.
fn sample(argument: &str) -> Value {
    match argument {
        "groupsWithSamples" | "uncategorizedGroups" | "existingCategories" => json!([]),
        "rangeStart" | "rangeEnd" | "duration" | "fileId" | "durationSeconds" | "limit"
        | "positionSeconds" | "newSortOrder" | "sortOrder" => json!(1),
        _ => json!("x"),
    }
}

/// The frontend only learns of a renamed argument from this error, so each
/// required argument is left out in turn. A refused call never runs its
/// command.
#[test]
fn every_command_names_the_argument_a_call_left_out() {
    let app = TestApp::new();
    for (command, required) in REQUIRED_ARGUMENTS {
        for missing in *required {
            let given = required
                .iter()
                .filter(|argument| *argument != missing)
                .map(|argument| (argument.to_string(), sample(argument)))
                .collect();

            let refused = app.invoke(command, Value::Object(given));

            let reason = format!("command {command} missing required key {missing}");
            let expected = format!("invalid args `{missing}` for command `{command}`: {reason}");
            assert_eq!(refused, Err(json!(expected)));
        }
    }
}

/// An argument a call may leave out is still refused when it has the wrong
/// type, instead of the command running as if it was left out.
#[test]
fn every_command_names_an_optional_argument_of_the_wrong_type() {
    let app = TestApp::new();
    for (command, optional) in OPTIONAL_ARGUMENTS {
        let (_, required) = REQUIRED_ARGUMENTS
            .iter()
            .find(|(name, _)| name == command)
            .unwrap();
        for wrong in *optional {
            let mut given: serde_json::Map<String, Value> = required
                .iter()
                .map(|argument| (argument.to_string(), sample(argument)))
                .collect();
            given.insert(wrong.to_string(), json!(true));

            let refused = app.invoke(command, Value::Object(given)).unwrap_err();

            let reason = format!(
                "invalid args `{wrong}` for command `{command}`: invalid type: boolean `true`"
            );
            assert!(refused.as_str().unwrap().starts_with(&reason), "{refused}");
        }
    }
}
