// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Tests for the commands, run against a mock app from `test_support`.

mod downloads;
mod providers;
mod services;

use super::*;
use crate::test_support::TestApp;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
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

/// The arguments of one command, by the names the frontend sends them under.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The arguments a call can't leave out.
    #[serde(default)]
    required: Vec<String>,
    /// The arguments a call may leave out, which the frontend sends as `null`
    /// or not at all.
    #[serde(default)]
    optional: Vec<String>,
}

/// Every command's arguments, read from `arguments.json`. The frontend's tests
/// in `src/lib/tauri.test.ts` check its calls against the same file, so a name
/// changed on only one side fails a test instead of a call in the app.
fn arguments() -> BTreeMap<String, Arguments> {
    serde_json::from_str(include_str!("arguments.json")).expect("read arguments.json")
}

/// A command missing from `arguments.json` would skip the checks below, and a
/// renamed argument would only show up when the app calls it.
#[test]
fn every_registered_command_has_a_row_in_the_argument_table() {
    let table = arguments();
    let listed: BTreeSet<&str> = table.keys().map(String::as_str).collect();
    let registered: BTreeSet<&str> = crate::COMMAND_NAMES.iter().copied().collect();

    let unlisted: Vec<_> = registered.difference(&listed).collect();
    assert!(
        unlisted.is_empty(),
        "commands/tests/arguments.json has no row for {unlisted:?}. \
         A command that takes no arguments gets an empty row."
    );
    let unregistered: Vec<_> = listed.difference(&registered).collect();
    assert!(
        unregistered.is_empty(),
        "commands/tests/arguments.json lists {unregistered:?}, which the app doesn't register"
    );
}

/// A value of the right type for an argument, so a call is refused only for
/// the argument it leaves out.
fn sample(argument: &str) -> Value {
    match argument {
        "groupsWithSamples" | "uncategorizedGroups" | "existingCategories" => json!([]),
        "episodes" | "ids" => json!([]),
        "rangeStart" | "rangeEnd" | "duration" | "fileId" | "durationSeconds" | "limit"
        | "positionSeconds" | "newSortOrder" | "sortOrder" | "n" | "startAt" | "endAt"
        | "source" | "generation" => {
            json!(1)
        }
        "keep" => json!(true),
        "episode" | "channel" => serde_json::to_value(Channel::default()).unwrap(),
        _ => json!("x"),
    }
}

/// The frontend only learns of a renamed argument from this error, so each
/// required argument is left out in turn. A refused call never runs its
/// command.
#[test]
fn every_command_names_the_argument_a_call_left_out() {
    let app = TestApp::new();
    for (command, arguments) in arguments() {
        let required = &arguments.required;
        for missing in required {
            let given = required
                .iter()
                .filter(|argument| *argument != missing)
                .map(|argument| (argument.clone(), sample(argument)))
                .collect();

            let refused = app.invoke(&command, Value::Object(given));

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
    for (command, arguments) in arguments() {
        for wrong in &arguments.optional {
            let mut given: serde_json::Map<String, Value> = arguments
                .required
                .iter()
                .map(|argument| (argument.clone(), sample(argument)))
                .collect();
            given.insert(wrong.clone(), json!(true));

            let refused = app.invoke(&command, Value::Object(given)).unwrap_err();

            let reason = format!(
                "invalid args `{wrong}` for command `{command}`: invalid type: boolean `true`"
            );
            assert!(refused.as_str().unwrap().starts_with(&reason), "{refused}");
        }
    }
}
