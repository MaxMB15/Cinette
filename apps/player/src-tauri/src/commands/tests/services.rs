// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The online services, subtitles, skip times, sorting groups with Gemini and
//! Linux package updates.
//!
//! No test here reaches a real service. A lookup is answered from the cache
//! or stops before its request is sent, and what a service would send back is
//! handed straight to the code that keeps it.

use super::*;
use mvp_core::ai::gemini::{parse_assignment_response, parse_categorization_response};
use mvp_core::http::test_server;
use mvp_core::iptv::mdblist::MdbListError;
use mvp_core::iptv::omdb::parse_omdb_response;
use mvp_core::iptv::opensubtitles::{SubtitleEntry, SubtitleSearchResult};
use mvp_core::iptv::skip_segments::{Fit, SegmentKind, SkipError};
use mvp_core::iptv::whatson::WhatsonError;
use serde_json::Value;
use std::time::Duration;
use tauri::Listener;

/// The Matrix, which every lookup here is for.
const MOVIE: &str = "tt0133093";

/// A line break can't go in a request header, so a request with this key
/// fails before it's sent. It must only be used where the key goes in a
/// header, since OMDb and MDBList put theirs in the address, where it would
/// be sent.
const UNSENDABLE_KEY: &str = "not\na key";

/// The length of the video being played, 45 minutes.
const LENGTH: f64 = 2700.0;

/// Saves an API key the way the Settings page does.
fn add_key(app: &TestApp, name: &str, key: &str) {
    save_key(&app.handle(), OMDB_STORE_FILE, name, key).unwrap();
}

/// What OMDb sends back for The Matrix.
fn the_matrix() -> OmdbData {
    parse_omdb_response(json!({
        "Response": "True",
        "Title": "The Matrix",
        "Year": "1999",
        "imdbID": MOVIE,
        "imdbRating": "8.7",
    }))
    .unwrap()
}

/// MDBList's ratings for [`MOVIE`].
fn mdblist_ratings() -> MdbListData {
    MdbListData {
        imdb_id: Some(MOVIE.into()),
        imdb_rating: Some(8.7),
        mdblist_score: Some(90),
        ..Default::default()
    }
}

/// What's On's ratings for [`MOVIE`].
fn whatson_ratings() -> WhatsonData {
    WhatsonData {
        imdb_id: Some(MOVIE.into()),
        item_type: Some("movie".into()),
        imdb_rating: Some(8.7),
        ..Default::default()
    }
}

/// One English subtitle file, number 42.
fn subtitles_found() -> SubtitleSearchResult {
    SubtitleSearchResult {
        entries: vec![SubtitleEntry {
            file_id: 42,
            language_code: "en".into(),
            format: "srt".into(),
            ..Default::default()
        }],
        languages: vec!["en".into()],
    }
}

/// A segment whose source doesn't say what length its times are for.
fn segment(kind: SegmentKind, start: f64, end: f64, source: SegmentSource) -> SkipSegment {
    SkipSegment {
        kind,
        start,
        end,
        source,
        fit: Fit::Unchecked,
        confidence: None,
        offset: None,
        auto_from: None,
        auto_to: None,
    }
}

/// A source's times with no post-credits scene.
fn times(segments: Vec<SkipSegment>) -> SourceTimes {
    SourceTimes {
        segments,
        post_credits: None,
    }
}

/// Caches an intro from SkipDB for The Matrix at [`LENGTH`], and an intro
/// and the credits from IntroDB.
fn cache_skip_times(app: &TestApp) {
    let query = SkipQuery::new(MOVIE, None, None, LENGTH).unwrap();
    let skipdb = times(vec![segment(
        SegmentKind::Intro,
        60.0,
        120.0,
        SegmentSource::SkipDb,
    )]);
    let introdb = times(vec![
        segment(SegmentKind::Intro, 50.0, 110.0, SegmentSource::IntroDb),
        segment(SegmentKind::Credits, 2500.0, 2700.0, SegmentSource::IntroDb),
    ]);
    let store = cache(app);
    store
        .save_skip_segments_cache(&query.cache_key(SegmentSource::SkipDb), &skipdb)
        .unwrap();
    store
        .save_skip_segments_cache(&query.cache_key(SegmentSource::IntroDb), &introdb)
        .unwrap();
}

/// Each segment's kind, times and source.
fn shown(segments: &[SkipSegment]) -> Vec<(SegmentKind, f64, f64, SegmentSource)> {
    segments
        .iter()
        .map(|s| (s.kind, s.start, s.end, s.source))
        .collect()
}

/// Each service's name in its key commands, with the file and the name its
/// key is saved under. Those can't change without losing the keys users have
/// already saved.
const SAVED_KEYS: &[(&str, &str, &str)] = &[
    ("omdb", "settings.json", "omdb_api_key"),
    ("mdblist", "settings.json", "mdblist_api_key"),
    ("opensubtitles", "settings.json", "opensubtitles_api_key"),
    ("gemini", "gemini.json", "apiKey"),
];

/// What the store file `file` in the app folder holds under `name`.
fn saved_in_file(app: &TestApp, file: &str, name: &str) -> Value {
    let text = std::fs::read_to_string(app.app_dir().join(file)).unwrap();
    serde_json::from_str::<Value>(&text).unwrap()[name].clone()
}

/// A day in seconds.
const DAY: i64 = 24 * 60 * 60;

/// Makes every lookup cached in `table` look `age` seconds old.
fn age_cached(db: &rusqlite::Connection, table: &str, age: i64) {
    let fetched_at = chrono::Utc::now().timestamp() - age;
    let sql = format!("UPDATE {table} SET fetched_at = ?1");
    db.execute(&sql, [fetched_at]).unwrap();
}

#[test]
fn each_service_keeps_its_own_key_without_the_spaces_a_paste_brings() {
    let app = TestApp::new();
    for (service, _, _) in SAVED_KEYS {
        let get = format!("get_{service}_api_key");
        assert_eq!(app.invoke(&get, json!({})), Ok(Value::Null));
        let set = format!("set_{service}_api_key");
        let pasted = format!(" {service}-key\n");
        assert_eq!(app.invoke(&set, json!({ "key": pasted })), Ok(Value::Null));
    }

    for (service, file, name) in SAVED_KEYS {
        let kept = json!(format!("{service}-key"));
        let get = format!("get_{service}_api_key");
        assert_eq!(app.invoke(&get, json!({})), Ok(kept.clone()));
        assert_eq!(saved_in_file(&app, file, name), kept);
    }
}

#[test]
fn a_blank_key_removes_the_saved_one() {
    let app = TestApp::new();
    for (service, file, name) in SAVED_KEYS {
        let set = format!("set_{service}_api_key");
        app.invoke(&set, json!({ "key": "abc123" })).unwrap();

        assert_eq!(app.invoke(&set, json!({ "key": " \t\n" })), Ok(Value::Null));

        let get = format!("get_{service}_api_key");
        assert_eq!(app.invoke(&get, json!({})), Ok(Value::Null));
        assert_eq!(saved_in_file(&app, file, name), Value::Null);
    }
}

/// A key a header can't carry is no real key, so Gemini is never asked.
#[test]
fn a_gemini_key_that_cannot_be_sent_is_turned_down() {
    let app = TestApp::new();
    let checked = app.invoke("test_gemini_api_key", json!({ "key": UNSENDABLE_KEY }));
    assert_eq!(checked, Ok(json!(false)));
}

/// OpenSubtitles only turns a key down when its own answer says so, and a
/// check that never went out says nothing about the key.
#[test]
fn an_opensubtitles_key_check_that_cannot_be_sent_is_an_error() {
    let app = TestApp::new();
    let failed = app
        .invoke(
            "test_opensubtitles_api_key",
            json!({ "key": UNSENDABLE_KEY }),
        )
        .unwrap_err();
    let failed = failed.as_str().unwrap();
    assert!(failed.starts_with("HTTP request failed:"), "{failed}");
}

#[tokio::test]
async fn omdb_is_not_asked_without_a_key() {
    let app = TestApp::new();
    let lookup = || {
        fetch_omdb_data(
            app.handle(),
            app.state(),
            "ch-1".into(),
            "The Matrix".into(),
            "movie".into(),
        )
    };
    assert_eq!(lookup().await, Ok(None));

    add_key(&app, OMDB_API_KEY, "   ");

    assert_eq!(lookup().await, Ok(None));
}

#[tokio::test]
async fn omdb_details_are_kept_for_the_channel_and_read_back_without_asking_again() {
    let app = TestApp::new();
    let kept = keep_omdb_data(&app.state(), "ch-1", "The Matrix", Ok(the_matrix()));
    assert_eq!(kept, Ok(Some(the_matrix())));

    let lookup = |channel_id: &str| {
        fetch_omdb_data(
            app.handle(),
            app.state(),
            channel_id.into(),
            "The Matrix".into(),
            "movie".into(),
        )
    };
    assert_eq!(lookup("ch-1").await, Ok(Some(the_matrix())));
    // Details are kept by channel, so another channel showing the same title
    // isn't answered from them.
    assert_eq!(lookup("ch-2").await, Ok(None));
}

/// OMDb's details for a title hardly change, so they're used for 30 days.
#[tokio::test]
async fn omdb_details_are_used_for_a_month() {
    let app = TestApp::new();
    let db = cache_on_disk(&app);
    keep_omdb_data(&app.state(), "ch-1", "The Matrix", Ok(the_matrix())).unwrap();
    let lookup = || {
        fetch_omdb_data(
            app.handle(),
            app.state(),
            "ch-1".into(),
            "The Matrix".into(),
            "movie".into(),
        )
    };

    age_cached(&db, "omdb_cache", 29 * DAY);
    assert_eq!(lookup().await, Ok(Some(the_matrix())));

    // Older details would be looked up again, which needs a key.
    age_cached(&db, "omdb_cache", 31 * DAY);
    assert_eq!(lookup().await, Ok(None));
}

#[tokio::test]
async fn a_failed_omdb_lookup_is_an_error_and_is_not_kept() {
    let app = TestApp::new();
    let not_found = parse_omdb_response(json!({
        "Response": "False",
        "Error": "Movie not found!",
    }))
    .unwrap_err();

    let kept = keep_omdb_data(&app.state(), "ch-1", "Nothing", Err(not_found));

    assert_eq!(kept, Err("OMDB API error: Movie not found!".to_string()));
    let cached = cache(&app).get_omdb_cache("ch-1", OMDB_CACHE_TTL).unwrap();
    assert_eq!(cached, None);
}

#[tokio::test]
async fn mdblist_is_not_asked_without_a_key() {
    let app = TestApp::new();
    let lookup = || fetch_mdblist_data(app.handle(), app.state(), MOVIE.into(), "movie".into());
    assert_eq!(lookup().await, Ok(None));

    add_key(&app, MDBLIST_API_KEY, "   ");

    assert_eq!(lookup().await, Ok(None));
}

#[tokio::test]
async fn mdblist_ratings_are_kept_and_read_back_without_asking_again() {
    let app = TestApp::new();
    let kept = keep_mdblist_data(&app.state(), MOVIE, Ok(mdblist_ratings()));
    assert_eq!(kept, Ok(Some(mdblist_ratings())));

    let cached = fetch_mdblist_data(app.handle(), app.state(), MOVIE.into(), "movie".into()).await;

    assert_eq!(cached, Ok(Some(mdblist_ratings())));
}

#[tokio::test]
async fn a_failed_mdblist_lookup_is_an_error_and_is_not_kept() {
    let app = TestApp::new();
    let refused = MdbListError::Api("Invalid API key".into());

    let kept = keep_mdblist_data(&app.state(), MOVIE, Err(refused));

    assert_eq!(kept, Err("MDBList API error: Invalid API key".to_string()));
    let cached = cache(&app)
        .get_mdblist_cache(MOVIE, MDBLIST_CACHE_TTL)
        .unwrap();
    assert_eq!(cached, None);
}

#[tokio::test]
async fn whatson_is_not_asked_without_an_omdb_key() {
    let app = TestApp::new();
    let lookup = || fetch_whatson_data(app.handle(), app.state(), MOVIE.into(), "movie".into());
    assert_eq!(lookup().await, Ok(None));

    add_key(&app, OMDB_API_KEY, "   ");

    assert_eq!(lookup().await, Ok(None));
}

#[tokio::test]
async fn whatson_ratings_are_kept_and_read_back_without_asking_again() {
    let app = TestApp::new();
    let kept = keep_whatson_data(&app.state(), MOVIE, Ok(whatson_ratings()));
    assert_eq!(kept, Ok(Some(whatson_ratings())));

    let cached = fetch_whatson_data(app.handle(), app.state(), MOVIE.into(), "movie".into()).await;

    assert_eq!(cached, Ok(Some(whatson_ratings())));
}

/// Ratings change as people vote, so MDBList's and whatson's are used for
/// 7 days.
#[tokio::test]
async fn ratings_are_used_for_a_week() {
    let app = TestApp::new();
    let db = cache_on_disk(&app);
    keep_mdblist_data(&app.state(), MOVIE, Ok(mdblist_ratings())).unwrap();
    keep_whatson_data(&app.state(), MOVIE, Ok(whatson_ratings())).unwrap();
    let mdblist = || fetch_mdblist_data(app.handle(), app.state(), MOVIE.into(), "movie".into());
    let whatson = || fetch_whatson_data(app.handle(), app.state(), MOVIE.into(), "movie".into());
    let age = |days: i64| {
        age_cached(&db, "mdblist_cache", days * DAY);
        age_cached(&db, "whatson_cache", days * DAY);
    };

    age(6);
    assert_eq!(mdblist().await, Ok(Some(mdblist_ratings())));
    assert_eq!(whatson().await, Ok(Some(whatson_ratings())));

    // Older ratings would be looked up again, which needs a key.
    age(8);
    assert_eq!(mdblist().await, Ok(None));
    assert_eq!(whatson().await, Ok(None));
}

/// The page sends "show" for a series, and whatson files those as TV shows.
#[test]
fn whatson_looks_up_a_show_as_a_tv_show() {
    assert_eq!(whatson_item_type("show"), "tvshow");
    assert_eq!(whatson_item_type("series"), "tvshow");
    assert_eq!(whatson_item_type("movie"), "movie");
}

#[tokio::test]
async fn a_title_whatson_does_not_know_is_none_and_a_failure_is_an_error() {
    let app = TestApp::new();
    let cached = || {
        cache(&app)
            .get_whatson_cache(MOVIE, WHATSON_CACHE_TTL)
            .unwrap()
    };

    let unknown = keep_whatson_data(&app.state(), MOVIE, Err(WhatsonError::NotFound));
    assert_eq!(unknown, Ok(None));
    assert_eq!(cached(), None);

    let limited = WhatsonError::Api("rate limited".into());
    let failed = keep_whatson_data(&app.state(), MOVIE, Err(limited));
    assert_eq!(failed, Err("Whatson API error: rate limited".to_string()));
    assert_eq!(cached(), None);
}

#[tokio::test]
async fn skip_times_need_an_imdb_id_a_whole_episode_and_a_length() {
    let app = TestApp::new();
    let lookup = |imdb_id: &str, season: Option<u32>, episode: Option<u32>, duration: f64| {
        get_skip_segments(
            app.handle(),
            app.state(),
            imdb_id.into(),
            season,
            episode,
            duration,
        )
    };
    let refused = |message: &str| Err(message.to_string());

    assert_eq!(
        lookup("matrix", None, None, LENGTH).await,
        refused("not an IMDb ID: matrix")
    );
    assert_eq!(
        lookup(MOVIE, Some(0), Some(1), LENGTH).await,
        refused("seasons and episodes start at 1")
    );
    assert_eq!(
        lookup(MOVIE, Some(1), None, LENGTH).await,
        refused("an episode needs both a season and an episode number")
    );
    assert_eq!(
        lookup(MOVIE, None, None, 0.0).await,
        refused("bad length: 0")
    );
}

#[tokio::test]
async fn without_an_omdb_key_only_cached_skip_times_are_used() {
    let app = TestApp::new();
    let lookup = |duration: f64| {
        get_skip_segments(
            app.handle(),
            app.state(),
            MOVIE.into(),
            None,
            None,
            duration,
        )
    };
    assert_eq!(lookup(LENGTH).await, Ok(vec![]));

    cache_skip_times(&app);

    // SkipDB's intro wins over IntroDB's, which only adds the credits.
    let found = lookup(LENGTH).await.unwrap();
    assert_eq!(
        shown(&found),
        [
            (SegmentKind::Intro, 60.0, 120.0, SegmentSource::SkipDb),
            (SegmentKind::Credits, 2500.0, 2700.0, SegmentSource::IntroDb),
        ]
    );
    // SkipDB's times are kept for the length they were looked up for, so a
    // longer cut only gets IntroDB's.
    let longer = lookup(3000.0).await.unwrap();
    assert_eq!(
        shown(&longer),
        [
            (SegmentKind::Intro, 50.0, 110.0, SegmentSource::IntroDb),
            (SegmentKind::Credits, 2500.0, 2700.0, SegmentSource::IntroDb),
        ]
    );
}

#[tokio::test]
async fn with_an_omdb_key_cached_skip_times_are_used_without_asking_again() {
    let app = TestApp::new();
    cache_skip_times(&app);
    let lookup = || get_skip_segments(app.handle(), app.state(), MOVIE.into(), None, None, LENGTH);
    let both = [
        (SegmentKind::Intro, 60.0, 120.0, SegmentSource::SkipDb),
        (SegmentKind::Credits, 2500.0, 2700.0, SegmentSource::IntroDb),
    ];
    // Both databases' times come from the cache, which is what keeps the
    // lookup below from going online.
    assert_eq!(shown(&lookup().await.unwrap()), both);

    add_key(&app, OMDB_API_KEY, "omdb-key");

    assert_eq!(shown(&lookup().await.unwrap()), both);
}

/// Times added to the skip databases should show up by the next day, so
/// cached ones are used for a day.
#[tokio::test]
async fn cached_skip_times_are_used_for_a_day() {
    let app = TestApp::new();
    let db = cache_on_disk(&app);
    cache_skip_times(&app);
    let lookup = || get_skip_segments(app.handle(), app.state(), MOVIE.into(), None, None, LENGTH);
    let hour = DAY / 24;

    age_cached(&db, "skip_segments_cache", 23 * hour);
    assert_eq!(
        shown(&lookup().await.unwrap()),
        [
            (SegmentKind::Intro, 60.0, 120.0, SegmentSource::SkipDb),
            (SegmentKind::Credits, 2500.0, 2700.0, SegmentSource::IntroDb),
        ]
    );

    // Older times would be looked up again, which needs an OMDb key.
    age_cached(&db, "skip_segments_cache", 25 * hour);
    assert_eq!(lookup().await, Ok(vec![]));
}

#[tokio::test]
async fn an_unreadable_cached_skip_time_is_passed_over() {
    let app = TestApp::new();
    let db = cache_on_disk(&app);
    cache_skip_times(&app);
    let query = SkipQuery::new(MOVIE, None, None, LENGTH).unwrap();
    let skipdb = query.cache_key(SegmentSource::SkipDb);
    db.execute(
        "UPDATE skip_segments_cache SET data_json = 'not json' WHERE cache_key = ?1",
        [&skipdb],
    )
    .unwrap();

    let found = get_skip_segments(app.handle(), app.state(), MOVIE.into(), None, None, LENGTH)
        .await
        .unwrap();

    // Without an OMDb key SkipDB isn't asked again, so IntroDB's times are all
    // there is.
    assert_eq!(
        shown(&found),
        [
            (SegmentKind::Intro, 50.0, 110.0, SegmentSource::IntroDb),
            (SegmentKind::Credits, 2500.0, 2700.0, SegmentSource::IntroDb),
        ]
    );
}

#[tokio::test]
async fn skip_times_that_came_back_are_kept_and_a_failed_lookup_is_not() {
    let app = TestApp::new();
    let query = SkipQuery::new(MOVIE, Some(1), Some(2), LENGTH).unwrap();
    let skipdb = query.cache_key(SegmentSource::SkipDb);
    let introdb = query.cache_key(SegmentSource::IntroDb);
    let credits = times(vec![segment(
        SegmentKind::Credits,
        2500.0,
        2700.0,
        SegmentSource::IntroDb,
    )]);
    let cached = |key: &str| {
        cache(&app)
            .get_skip_segments_cache(key, SKIP_SEGMENTS_CACHE_TTL)
            .unwrap()
    };

    let kept = keep_skip_times(&app.state(), &introdb, Ok(credits.clone()));
    assert_eq!(kept, Ok(Some(credits.clone())));
    assert_eq!(cached(&introdb), Some(credits));

    let unavailable = SkipError::Status("SkipDB", 503);
    let failed = keep_skip_times(&app.state(), &skipdb, Err(unavailable));
    assert_eq!(failed, Err("SkipDB returned HTTP 503".to_string()));
    assert_eq!(cached(&skipdb), None);
}

#[tokio::test]
async fn subtitles_are_not_searched_for_without_a_key() {
    let app = TestApp::new();

    let found = search_subtitles(app.handle(), app.state(), MOVIE.into(), None, None).await;

    assert_eq!(found, Ok(None));
}

#[tokio::test]
async fn a_subtitle_search_is_kept_for_that_movie_or_episode_only() {
    let app = TestApp::new();
    let kept = keep_subtitle_search(&app.state(), MOVIE, Some(1), Some(2), Ok(subtitles_found()));
    assert_eq!(kept, Ok(Some(subtitles_found())));

    let search = |season: Option<u32>, episode: Option<u32>| {
        search_subtitles(app.handle(), app.state(), MOVIE.into(), season, episode)
    };
    assert_eq!(search(Some(1), Some(2)).await, Ok(Some(subtitles_found())));
    assert_eq!(search(Some(1), Some(3)).await, Ok(None));
    assert_eq!(search(None, None).await, Ok(None));
}

#[tokio::test]
async fn a_failed_subtitle_search_is_an_error_and_is_not_kept() {
    let app = TestApp::new();
    add_key(&app, OPENSUBTITLES_API_KEY, UNSENDABLE_KEY);

    let err = search_subtitles(app.handle(), app.state(), MOVIE.into(), None, None)
        .await
        .unwrap_err();

    assert!(err.starts_with("HTTP request failed:"), "{err}");
    let cached = cache(&app)
        .get_opensubtitles_search_cache(MOVIE, None, None, SEARCH_CACHE_TTL_SECS)
        .unwrap();
    assert_eq!(cached, None);
}

#[tokio::test]
async fn a_subtitle_already_downloaded_is_used_without_asking_again() {
    let app = TestApp::new();
    let download = |file_id: i64| download_subtitle(app.handle(), file_id);
    assert_eq!(
        download(42).await,
        Err("No OpenSubtitles API key configured".to_string())
    );
    add_key(&app, OPENSUBTITLES_API_KEY, UNSENDABLE_KEY);
    let folder = subtitles_folder(&app);
    std::fs::create_dir_all(&folder).unwrap();
    let saved = folder.join("42.vtt");
    std::fs::write(&saved, "WEBVTT\n").unwrap();

    assert_eq!(download(42).await, Ok(saved.to_string_lossy().into_owned()));
    // A file that isn't there has to be asked for.
    let err = download(43).await.unwrap_err();
    assert!(err.starts_with("HTTP request failed:"), "{err}");
}

#[tokio::test]
async fn what_came_back_is_still_shown_when_it_cannot_be_kept() {
    let app = TestApp::new();
    let db = cache_on_disk(&app);
    let tables = [
        "omdb_cache",
        "mdblist_cache",
        "whatson_cache",
        "skip_segments_cache",
        "opensubtitles_search_cache",
    ];
    for table in tables {
        refuse_saves(&db, table);
    }
    let state = app.state();
    let key = SkipQuery::new(MOVIE, None, None, LENGTH)
        .unwrap()
        .cache_key(SegmentSource::IntroDb);
    let credits = times(vec![segment(
        SegmentKind::Credits,
        2500.0,
        2700.0,
        SegmentSource::IntroDb,
    )]);

    let omdb = keep_omdb_data(&state, "ch-1", "The Matrix", Ok(the_matrix()));
    let mdblist = keep_mdblist_data(&state, MOVIE, Ok(mdblist_ratings()));
    let whatson = keep_whatson_data(&state, MOVIE, Ok(whatson_ratings()));
    let skip = keep_skip_times(&state, &key, Ok(credits.clone()));
    let subtitles = keep_subtitle_search(&state, MOVIE, None, None, Ok(subtitles_found()));

    assert_eq!(omdb, Ok(Some(the_matrix())));
    assert_eq!(mdblist, Ok(Some(mdblist_ratings())));
    assert_eq!(whatson, Ok(Some(whatson_ratings())));
    assert_eq!(skip, Ok(Some(credits)));
    assert_eq!(subtitles, Ok(Some(subtitles_found())));
    let cache = cache(&app);
    assert_eq!(cache.get_omdb_cache("ch-1", OMDB_CACHE_TTL).unwrap(), None);
    assert_eq!(
        cache.get_mdblist_cache(MOVIE, MDBLIST_CACHE_TTL).unwrap(),
        None
    );
    assert_eq!(
        cache.get_whatson_cache(MOVIE, WHATSON_CACHE_TTL).unwrap(),
        None
    );
    let skip_cached = cache.get_skip_segments_cache(&key, SKIP_SEGMENTS_CACHE_TTL);
    assert_eq!(skip_cached.unwrap(), None);
    let subtitles_cached =
        cache.get_opensubtitles_search_cache(MOVIE, None, None, SEARCH_CACHE_TTL_SECS);
    assert_eq!(subtitles_cached.unwrap(), None);
}

#[tokio::test]
async fn an_unreadable_cached_lookup_is_an_error() {
    let app = TestApp::new();
    let db = cache_on_disk(&app);
    let state = app.state();
    keep_omdb_data(&state, "ch-1", "The Matrix", Ok(the_matrix())).unwrap();
    keep_mdblist_data(&state, MOVIE, Ok(mdblist_ratings())).unwrap();
    keep_whatson_data(&state, MOVIE, Ok(whatson_ratings())).unwrap();
    keep_subtitle_search(&state, MOVIE, None, None, Ok(subtitles_found())).unwrap();
    for table in [
        "omdb_cache",
        "mdblist_cache",
        "whatson_cache",
        "opensubtitles_search_cache",
    ] {
        let garble = format!("UPDATE {table} SET data_json = 'not json'");
        db.execute(&garble, []).unwrap();
    }

    let omdb = fetch_omdb_data(
        app.handle(),
        app.state(),
        "ch-1".into(),
        "The Matrix".into(),
        "movie".into(),
    )
    .await;
    let mdblist = fetch_mdblist_data(app.handle(), app.state(), MOVIE.into(), "movie".into()).await;
    let whatson = fetch_whatson_data(app.handle(), app.state(), MOVIE.into(), "movie".into()).await;
    let subtitles = search_subtitles(app.handle(), app.state(), MOVIE.into(), None, None).await;

    let unreadable = "serialization error: expected ident at line 1 column 2";
    assert_eq!(omdb.unwrap_err(), unreadable);
    assert_eq!(mdblist.unwrap_err(), unreadable);
    assert_eq!(whatson.unwrap_err(), unreadable);
    assert_eq!(subtitles.unwrap_err(), unreadable);
}

#[tokio::test]
async fn sorting_groups_with_a_key_that_cannot_be_sent_fails_and_keeps_the_groups() {
    let app = TestApp::new();
    cache(&app)
        .save_group_hierarchy("p", "live", "News", Some("Info"), 10, false)
        .unwrap();
    let samples = || vec![("Sport".to_string(), vec!["Match of the Day".to_string()])];

    let sorted = categorize_provider(
        app.state(),
        "p".into(),
        "live".into(),
        UNSENDABLE_KEY.into(),
        samples(),
    )
    .await;
    let fixed = fix_uncategorized_groups(
        app.state(),
        "p".into(),
        "live".into(),
        UNSENDABLE_KEY.into(),
        samples(),
        vec!["Info".into()],
    )
    .await;

    let unsent = "API error: builder error";
    let sorted = sorted.map(placed);
    assert_eq!(sorted, Err(format!("Categorization failed: {unsent}")));
    let fixed = fixed.map(placed);
    assert_eq!(fixed, Err(format!("Fix uncategorized failed: {unsent}")));
    let kept = [("News".to_string(), Some("Info".to_string()), 10)];
    assert_eq!(groups(&app, "live").await, kept);
}

#[tokio::test]
async fn sorting_groups_replaces_them_and_puts_the_ones_left_out_last() {
    let app = TestApp::new();
    cache(&app)
        .save_group_hierarchy("p", "live", "Old", None, 0, false)
        .unwrap();
    let answer = json!({
        "type": "hierarchical",
        "categories": [{"name": "Info", "groups": ["News", "Weather"]}],
        "ungrouped": ["Sport"],
    });
    let known = ["News", "Weather", "Sport", "Music"];
    let sorting = parse_categorization_response(&answer, &known).unwrap();

    let saved = save_categorization(&app.state(), "p", "live", &sorting).unwrap();

    let info = Some("Info".to_string());
    let expected = [
        ("News".to_string(), info.clone(), 0),
        ("Weather".to_string(), info, 100),
        ("Sport".to_string(), None, 200),
        ("Music".to_string(), None, 300),
    ];
    assert_eq!(placed(saved), expected);
    assert_eq!(groups(&app, "live").await, expected);
}

#[tokio::test]
async fn groups_left_out_of_every_category_are_listed_from_the_top() {
    let app = TestApp::new();
    let answer = json!({"type": "flat", "groups": []});
    let sorting = parse_categorization_response(&answer, &["Sport", "News"]).unwrap();

    let saved = save_categorization(&app.state(), "p", "movie", &sorting).unwrap();

    let expected = [
        ("Sport".to_string(), None, 0),
        ("News".to_string(), None, 100),
    ];
    assert_eq!(placed(saved), expected);
}

#[tokio::test]
async fn left_over_groups_are_put_in_the_categories_gemini_picked() {
    let app = TestApp::new();
    let answer =
        json!({"type": "hierarchical", "categories": [{"name": "Info", "groups": ["News"]}]});
    let sorting = parse_categorization_response(&answer, &["News", "Sport", "Music"]).unwrap();
    save_categorization(&app.state(), "p", "live", &sorting).unwrap();
    let answer = json!({"assignments": [
        {"group": "Sport", "category": "Info"},
        {"group": "Made Up", "category": "Info"},
        {"group": "Music", "category": "Not There"},
    ]});
    let assignments = parse_assignment_response(&answer, &["Sport", "Music"], &["Info"]).unwrap();

    let saved = save_assignments(&app.state(), "p", "live", &assignments).unwrap();

    // Both groups in Info are at the top, in no set order between them.
    let mut placed = placed(saved);
    placed.sort();
    let info = Some("Info".to_string());
    let expected = [
        ("Music".to_string(), None, 200),
        ("News".to_string(), info.clone(), 0),
        ("Sport".to_string(), info, 0),
    ];
    assert_eq!(placed, expected);
}

#[cfg(not(target_os = "linux"))]
#[tokio::test]
async fn package_updates_are_only_for_linux_packages() {
    let app = TestApp::new();

    let updated = package_update(app.handle()).await;

    let refused = "package_update not supported for install type: native";
    assert_eq!(updated, Err(refused.to_string()));
}

/// A release whose latest.json lists `package_url` as the Debian package.
fn release_with(package_url: &str) -> String {
    let latest = json!({
        "version": "9.9.9",
        "packages": {"linux-deb-x86_64": package_url},
    });
    test_server::serve_once("200 OK", latest.to_string())
}

/// The percent of each "package-update://progress" event, as it's emitted.
fn progress_events(app: &TestApp) -> std::sync::mpsc::Receiver<u64> {
    let (sender, progress) = std::sync::mpsc::channel();
    app.handle()
        .listen("package-update://progress", move |event| {
            let payload: Value = serde_json::from_str(event.payload()).unwrap();
            let _ = sender.send(payload["percent"].as_u64().unwrap());
        });
    progress
}

/// The percents sent so far, waiting a while for the first.
fn percents(progress: &std::sync::mpsc::Receiver<u64>) -> Vec<u64> {
    let first = progress.recv_timeout(Duration::from_secs(5)).unwrap();
    std::iter::once(first).chain(progress.try_iter()).collect()
}

#[tokio::test]
async fn a_package_is_downloaded_to_a_temp_file_that_goes_when_dropped() {
    let app = TestApp::new();
    let progress = progress_events(&app);
    let latest = release_with(&test_server::serve_once("200 OK", "package contents"));

    let path = download_package(&app.handle(), &latest, "linux-deb-x86_64", "deb")
        .await
        .unwrap();

    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("maxvideoplayer_update."), "{name}");
    assert!(name.ends_with(".deb"), "{name}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "package contents");
    let percents = percents(&progress);
    assert_eq!(percents.last(), Some(&100), "{percents:?}");
    assert!(percents.windows(2).all(|w| w[0] < w[1]), "{percents:?}");
    let file = path.to_path_buf();
    drop(path);
    assert!(!file.exists());
}

/// A package arrives in many reads, and the progress bar climbs with each one
/// that moves it to a new percent.
#[tokio::test]
async fn progress_climbs_as_a_package_downloads() {
    let app = TestApp::new();
    let progress = progress_events(&app);
    let size = 4 * 1024 * 1024;
    let latest = release_with(&test_server::serve_once("200 OK", "x".repeat(size)));

    let path = download_package(&app.handle(), &latest, "linux-deb-x86_64", "deb")
        .await
        .unwrap();

    assert_eq!(std::fs::metadata(&path).unwrap().len(), size as u64);
    let percents = percents(&progress);
    assert!(percents[0] < 100, "{percents:?}");
    assert_eq!(percents.last(), Some(&100), "{percents:?}");
    assert!(percents.windows(2).all(|w| w[0] < w[1]), "{percents:?}");
}

/// Answers one request with `body` and no `Content-Length`, ending the body by
/// closing the connection, and returns the server's base URL.
fn serve_without_length(body: &'static str) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        // The request is read first, or the client may see the connection
        // reset instead of the reply.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") && matches!(stream.read(&mut byte), Ok(1)) {
            request.push(byte[0]);
        }
        let reply = format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{body}");
        let _ = stream.write_all(reply.as_bytes());
    });
    url
}

/// With no size to count against, a package from a server that doesn't send
/// one downloads without progress events.
#[tokio::test]
async fn a_package_of_unknown_size_downloads_without_progress() {
    let app = TestApp::new();
    let progress = progress_events(&app);
    let latest = release_with(&serve_without_length("package contents"));

    let path = download_package(&app.handle(), &latest, "linux-deb-x86_64", "deb")
        .await
        .unwrap();

    assert_eq!(std::fs::read_to_string(&path).unwrap(), "package contents");
    assert_eq!(progress.try_iter().collect::<Vec<_>>(), Vec::<u64>::new());
}

#[tokio::test]
async fn a_package_missing_from_the_release_or_failing_to_download_is_an_error() {
    let app = TestApp::new();
    let download = |latest: String, pkg_key: &'static str| {
        let app = app.handle();
        async move {
            download_package(&app, &latest, pkg_key, "deb")
                .await
                .map(|_| ())
        }
    };

    let unlisted = release_with("http://example.test/never-fetched.rpm");
    assert_eq!(
        download(unlisted, "linux-rpm-x86_64").await,
        Err("No package URL found for linux-rpm-x86_64 in latest.json".to_string())
    );
    let gone = release_with(&test_server::serve_once("404 Not Found", ""));
    assert_eq!(
        download(gone, "linux-deb-x86_64").await,
        Err("Download failed with status: 404 Not Found".to_string())
    );
    // An address with no host is refused before anything is sent.
    let unsendable = release_with("unix:/package.deb");
    let err = download(unsendable, "linux-deb-x86_64").await.unwrap_err();
    assert!(err.starts_with("Download failed: "), "{err}");
}

#[tokio::test]
async fn a_release_list_that_cannot_be_read_is_an_error() {
    let app = TestApp::new();
    let download = |latest: String| {
        let app = app.handle();
        async move {
            download_package(&app, &latest, "linux-deb-x86_64", "deb")
                .await
                .map(|_| ())
        }
    };

    let garbled = test_server::serve_once("200 OK", "not json");
    let err = download(garbled).await.unwrap_err();
    assert!(err.starts_with("Failed to parse latest.json: "), "{err}");
    let err = download("unix:/latest.json".to_string()).await.unwrap_err();
    assert!(err.starts_with("Failed to fetch latest.json: "), "{err}");
}

/// Stands in for pkexec, so a test sees what the installer was asked to run
/// and nothing is installed. Each run is sh reading `script`, so the script is
/// never run straight after it's written, which Linux can refuse while
/// another test's process still has it open.
#[cfg(unix)]
struct StandIn {
    dir: tempfile::TempDir,
}

#[cfg(unix)]
impl StandIn {
    /// A stand-in that logs the arguments of each run, then runs `script`.
    fn new(script: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("runs");
        let logged = format!("echo \"$@\" >> '{}'\n{script}\n", log.display());
        std::fs::write(dir.path().join("pkexec.sh"), logged).unwrap();
        Self { dir }
    }

    /// Builds each run of the stand-in, as pkexec would be built.
    fn elevated(&self) -> impl Fn() -> tokio::process::Command + '_ {
        || {
            let mut sh = tokio::process::Command::new("/bin/sh");
            sh.arg(self.dir.path().join("pkexec.sh"));
            sh
        }
    }

    /// Where the downloaded package would be. The stand-in never opens it.
    fn package(&self, extension: &str) -> std::path::PathBuf {
        self.dir.path().join(format!("update.{extension}"))
    }

    /// What each run was asked to do, one line each.
    fn runs(&self) -> Vec<String> {
        let log = std::fs::read_to_string(self.dir.path().join("runs")).unwrap_or_default();
        log.lines().map(str::to_string).collect()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_deb_is_installed_with_apt_get_so_its_dependencies_come_too() {
    let pkexec = StandIn::new("exit 0");
    let deb = pkexec.package("deb");

    let installed = install_package(pkexec.elevated(), "deb", &deb).await;

    assert_eq!(installed, Ok(()));
    let apt = format!("apt-get install -y --allow-downgrades {}", deb.display());
    assert_eq!(pkexec.runs(), [apt]);
}

#[cfg(unix)]
#[tokio::test]
async fn a_deb_is_installed_with_dpkg_where_apt_get_fails() {
    let pkexec = StandIn::new("[ \"$1\" = apt-get ] && exit 100\nexit 0");
    let deb = pkexec.package("deb");

    let installed = install_package(pkexec.elevated(), "deb", &deb).await;

    assert_eq!(installed, Ok(()));
    let apt = format!("apt-get install -y --allow-downgrades {}", deb.display());
    let dpkg = format!("dpkg -i {}", deb.display());
    assert_eq!(pkexec.runs(), [apt, dpkg]);
}

#[cfg(unix)]
#[tokio::test]
async fn an_rpm_is_upgraded_with_rpm() {
    let pkexec = StandIn::new("exit 0");
    let rpm = pkexec.package("rpm");

    let installed = install_package(pkexec.elevated(), "rpm", &rpm).await;

    assert_eq!(installed, Ok(()));
    assert_eq!(pkexec.runs(), [format!("rpm -U {}", rpm.display())]);
}

#[cfg(unix)]
#[tokio::test]
async fn an_install_that_fails_is_an_error_with_what_the_installer_said() {
    let pkexec = StandIn::new("echo \"$1 refused\" >&2\nexit 1");

    let deb = install_package(pkexec.elevated(), "deb", &pkexec.package("deb")).await;
    let rpm = install_package(pkexec.elevated(), "rpm", &pkexec.package("rpm")).await;

    // Where apt-get fails too, what dpkg said is what's shown.
    assert_eq!(deb, Err("Installation failed: dpkg refused\n".to_string()));
    assert_eq!(rpm, Err("Installation failed: rpm refused\n".to_string()));
    assert_eq!(pkexec.runs().len(), 3);
}

#[tokio::test]
async fn an_installer_that_cannot_be_started_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("pkexec");
    let elevated = || tokio::process::Command::new(&missing);
    let package = dir.path().join("update");

    for install_type in ["deb", "rpm"] {
        let installed = install_package(elevated, install_type, &package).await;

        let err = installed.unwrap_err();
        assert!(err.starts_with("Failed to run installer: "), "{err}");
    }
}

/// A release whose latest.json lists the Debian package at `deb_url` and the
/// RPM package at `rpm_url`.
#[cfg(unix)]
fn release_with_both(deb_url: &str, rpm_url: &str) -> String {
    let latest = json!({
        "version": "9.9.9",
        "packages": {"linux-deb-x86_64": deb_url, "linux-rpm-x86_64": rpm_url},
    });
    test_server::serve_once("200 OK", latest.to_string())
}

/// The temp file a run installed, from the line the stand-in logged for it.
#[cfg(unix)]
fn installed_file<'a>(run: &'a str, command: &str) -> &'a std::path::Path {
    let file = run.strip_prefix(command).unwrap_or_else(|| panic!("{run}"));
    std::path::Path::new(file)
}

#[cfg(unix)]
#[tokio::test]
async fn a_deb_install_is_updated_with_the_newest_deb() {
    let app = TestApp::new();
    let pkexec = StandIn::new("exit 0");
    let deb = test_server::serve_once("200 OK", "deb contents");
    let rpm = format!("{}/never-fetched.rpm", test_server::refused_url());
    let latest = release_with_both(&deb, &rpm);

    let updated = update_package(&app.handle(), "deb", &latest, pkexec.elevated()).await;

    assert_eq!(updated, Ok(()));
    let runs = pkexec.runs();
    assert_eq!(runs.len(), 1, "{runs:?}");
    let file = installed_file(&runs[0], "apt-get install -y --allow-downgrades ");
    assert_eq!(file.extension().unwrap(), "deb");
    // The download goes once it's installed.
    assert!(!file.exists(), "{}", file.display());
}

#[cfg(unix)]
#[tokio::test]
async fn an_rpm_install_is_updated_with_the_newest_rpm() {
    let app = TestApp::new();
    let pkexec = StandIn::new("exit 0");
    let rpm = test_server::serve_once("200 OK", "rpm contents");
    let deb = format!("{}/never-fetched.deb", test_server::refused_url());
    let latest = release_with_both(&deb, &rpm);

    let updated = update_package(&app.handle(), "rpm", &latest, pkexec.elevated()).await;

    assert_eq!(updated, Ok(()));
    let runs = pkexec.runs();
    assert_eq!(runs.len(), 1, "{runs:?}");
    let file = installed_file(&runs[0], "rpm -U ");
    assert_eq!(file.extension().unwrap(), "rpm");
    assert!(!file.exists(), "{}", file.display());
}

/// AppImages, the Tauri updater and the App Store update the app themselves.
#[tokio::test]
async fn other_installs_are_not_updated_with_a_package() {
    let app = TestApp::new();
    let latest = test_server::refused_url();
    let never = || -> tokio::process::Command { panic!("nothing should be installed") };

    for install_type in ["appimage", "native", "store"] {
        let updated = update_package(&app.handle(), install_type, &latest, never).await;

        let refused = format!("package_update not supported for install type: {install_type}");
        assert_eq!(updated, Err(refused));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_package_type_with_no_installer_runs_nothing() {
    let pkexec = StandIn::new("exit 0");

    let installed =
        install_package(pkexec.elevated(), "appimage", &pkexec.package("AppImage")).await;

    assert_eq!(
        installed,
        Err("Unsupported package type: appimage".to_string())
    );
    assert!(pkexec.runs().is_empty());
}

#[test]
fn the_frontend_reads_cached_details_and_ratings_by_the_names_it_uses() {
    let app = TestApp::new();
    keep_omdb_data(&app.state(), "ch-1", "The Matrix", Ok(the_matrix())).unwrap();
    keep_mdblist_data(&app.state(), MOVIE, Ok(mdblist_ratings())).unwrap();
    keep_whatson_data(&app.state(), MOVIE, Ok(whatson_ratings())).unwrap();
    let title = json!({"channelId": "ch-1", "title": "The Matrix", "contentType": "movie"});
    let ratings = json!({"imdbId": MOVIE, "mediaType": "movie"});

    let omdb = app.invoke("fetch_omdb_data", title).unwrap();
    let mdblist = app.invoke("fetch_mdblist_data", ratings.clone()).unwrap();
    let whatson = app.invoke("fetch_whatson_data", ratings).unwrap();

    assert_eq!(omdb["title"], "The Matrix");
    assert_eq!(omdb["imdbId"], MOVIE);
    assert_eq!(omdb["imdbRating"], "8.7");
    assert_eq!(mdblist["imdbRating"], 8.7);
    assert_eq!(mdblist["mdblistScore"], 90);
    assert_eq!(whatson["itemType"], "movie");
    assert_eq!(whatson["imdbRating"], 8.7);
    let other = json!({"channelId": "ch-2", "title": "Other", "contentType": "series"});
    assert_eq!(app.invoke("fetch_omdb_data", other), Ok(Value::Null));
}

#[test]
fn the_frontend_reads_skip_times_by_the_names_it_uses() {
    let app = TestApp::new();
    cache_skip_times(&app);
    let movie = json!({"imdbId": MOVIE, "season": null, "episode": null, "duration": LENGTH});

    let found = app.invoke("get_skip_segments", movie).unwrap();

    let intro = json!({
        "kind": "intro",
        "start": 60.0,
        "end": 120.0,
        "source": "skipdb",
        "fit": "unchecked",
        "confidence": null,
        "offset": null,
        "autoFrom": null,
        "autoTo": null,
    });
    assert_eq!(found[0], intro);
    assert_eq!(found[1]["source"], "introdb");
    let bad = json!({"imdbId": "matrix", "season": null, "episode": null, "duration": LENGTH});
    assert_eq!(
        app.invoke("get_skip_segments", bad),
        Err(json!("not an IMDb ID: matrix"))
    );
}

#[test]
fn the_frontend_reads_subtitles_by_the_names_it_uses() {
    let app = TestApp::new();
    keep_subtitle_search(&app.state(), MOVIE, None, None, Ok(subtitles_found())).unwrap();
    let file = json!({"fileId": 42});
    assert_eq!(
        app.invoke("download_subtitle", file.clone()),
        Err(json!("No OpenSubtitles API key configured"))
    );
    add_key(&app, OPENSUBTITLES_API_KEY, UNSENDABLE_KEY);
    let folder = subtitles_folder(&app);
    std::fs::create_dir_all(&folder).unwrap();
    let saved = folder.join("42.srt");
    std::fs::write(&saved, "1\n00:00:01,000 --> 00:00:02,000\nHi\n").unwrap();

    // A movie leaves out the season and episode.
    let found = app.invoke("search_subtitles", json!({"imdbId": MOVIE}));
    let downloaded = app.invoke("download_subtitle", file);

    let entry = json!({
        "fileId": 42,
        "languageCode": "en",
        "format": "srt",
        "releaseName": null,
        "downloadCount": null,
    });
    assert_eq!(found, Ok(json!({"entries": [entry], "languages": ["en"]})));
    assert_eq!(downloaded, Ok(json!(saved.to_string_lossy())));
}

#[test]
fn the_frontend_sorts_groups_by_the_names_it_uses() {
    let app = TestApp::new();
    let sort = json!({
        "providerId": "p",
        "contentType": "live",
        "apiKey": UNSENDABLE_KEY,
        "groupsWithSamples": [["News", ["News One"]]],
    });
    let fix = json!({
        "providerId": "p",
        "contentType": "live",
        "apiKey": UNSENDABLE_KEY,
        "uncategorizedGroups": [["Sport", ["Match of the Day"]]],
        "existingCategories": ["Info"],
    });

    // A command refuses arguments it can't read before it tries Gemini, so
    // getting as far as Gemini shows they were read.
    let sorted = app.invoke("categorize_provider", sort);
    let fixed = app.invoke("fix_uncategorized_groups", fix);

    assert_eq!(
        sorted,
        Err(json!("Categorization failed: API error: builder error"))
    );
    assert_eq!(
        fixed,
        Err(json!("Fix uncategorized failed: API error: builder error"))
    );
}

#[cfg(not(target_os = "linux"))]
#[test]
fn the_frontend_is_told_package_updates_are_for_linux_packages() {
    let app = TestApp::new();

    let updated = app.invoke("package_update", json!({}));

    let refused = "package_update not supported for install type: native";
    assert_eq!(updated, Err(json!(refused)));
}
