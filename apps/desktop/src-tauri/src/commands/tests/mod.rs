// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Tests for the commands, run against a mock app from `test_support`.

mod downloads;
mod providers;
mod services;

use super::*;
use crate::test_support::TestApp;
use serde_json::json;
use std::sync::MutexGuard;

/// The app's cache, for setting up what a test needs and checking what a
/// command saved.
fn cache(app: &TestApp) -> MutexGuard<'_, CacheStore> {
    app.state().inner().cache.lock().unwrap()
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
