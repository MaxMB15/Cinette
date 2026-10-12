// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Tests for the commands, run against a mock app from `test_support`.

mod downloads;
mod providers;
mod services;

use super::*;
use crate::test_support::TestApp;
use serde_json::json;

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
