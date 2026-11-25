// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::test_support::{poison, TestApp};
use mvp_core::cache::store::StoredEpgProgram;
use mvp_core::models::playlist::ProviderType;
use serde_json::{json, Value};

/// A logo on a site of its own, which may go to a controller.
const LOGO: &str = "https://logos.example.org/bbc.png";
/// A logo on the provider's site, which may not.
const PANEL_LOGO: &str = "http://img.iptv.example/cnn.png";
/// A logo on the controller's own network, which its webview may not load.
const LOCAL_LOGO: &str = "http://192.168.1.20/cnn.png";

fn channel(id: &str, content_type: &str, logo: Option<&str>) -> Channel {
    Channel {
        id: id.into(),
        name: format!("{id} S01E01"),
        // A made-up login, which must never reach a controller.
        url: format!("http://iptv.example:8080/live/user1/s3cret/{id}.ts"),
        sources: vec![format!("http://backup.example/user1/s3cret/{id}.ts")],
        logo_url: logo.map(str::to_owned),
        group_title: "News".into(),
        tvg_id: Some(format!("{id}.uk")),
        content_type: content_type.into(),
        ..Channel::default()
    }
}

fn provider() -> Provider {
    Provider {
        id: "p1".into(),
        name: "Home".into(),
        provider_type: ProviderType::Xtream,
        url: "http://iptv.example:8080".into(),
        username: Some("user1".into()),
        password: Some("s3cret".into()),
        last_updated: None,
        channel_count: 3,
        epg_url: Some("http://iptv.example:8080/xmltv.php?password=s3cret".into()),
    }
}

/// An app with a provider, a channel with a logo of its own, one with a
/// logo on the provider's site, and an Xtream series.
fn app() -> TestApp {
    let app = TestApp::new();
    {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        cache.upsert_provider(&provider()).unwrap();
        cache.upsert_channel("p1", &channel("bbc", "live", Some(LOGO))).unwrap();
        cache.upsert_channel("p1", &channel("cnn", "live", Some(PANEL_LOGO))).unwrap();
        let series = Channel {
            url: format!("{SERIES_URL}42"),
            ..channel("show", "series", None)
        };
        cache.upsert_channel("p1", &series).unwrap();
    }
    app
}

/// What `answer` sends for `call`, read back as JSON, with `episodes` as
/// the series loader. It runs on a thread in a runtime, as it does in the
/// app.
fn ask_with(
    app: &TestApp,
    call: LibraryCall,
    episodes: impl FnOnce(&str) -> Result<Vec<Channel>, ErrorCode>,
) -> Result<Value, ErrorCode> {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _inside = runtime.enter();
    answer(&app.handle(), call, episodes).map(|json| serde_json::from_slice(&json).unwrap())
}

fn ask(app: &TestApp, call: LibraryCall) -> Result<Value, ErrorCode> {
    ask_with(app, call, |_| panic!("only a series call loads episodes"))
}

fn channels_in(answer: Value) -> Vec<Channel> {
    serde_json::from_value(answer).unwrap()
}

fn by_id<'a>(channels: &'a [Channel], id: &str) -> &'a Channel {
    channels.iter().find(|c| c.id == id).unwrap()
}

fn assert_no_login(answer: &Value) {
    let text = answer.to_string();
    assert!(!text.contains("user1"), "{text}");
    assert!(!text.contains("s3cret"), "{text}");
    assert!(!text.contains("iptv.example"), "{text}");
}

#[test]
fn channels_go_out_with_no_stream_url_source_or_logo_on_the_provider_site() {
    let app = app();
    let answer = ask(&app, LibraryCall::Channels).unwrap();
    assert_no_login(&answer);
    let channels = channels_in(answer);
    assert_eq!(channels.len(), 3);
    let bbc = by_id(&channels, "bbc");
    assert_eq!(bbc.url, "");
    assert!(bbc.sources.is_empty());
    assert_eq!(bbc.logo_url.as_deref(), Some(LOGO));
    assert_eq!(bbc.name, "bbc S01E01", "the rest is kept");
    assert_eq!(bbc.tvg_id.as_deref(), Some("bbc.uk"));
    assert_eq!(by_id(&channels, "cnn").logo_url, None);
    assert_eq!(by_id(&channels, "show").url, SERIES_URL);
}

#[test]
fn providers_go_out_with_no_server_login_or_guide_address() {
    let app = app();
    let answer = ask(&app, LibraryCall::Providers).unwrap();
    assert_no_login(&answer);
    let providers: Vec<Provider> = serde_json::from_value(answer).unwrap();
    let home = &providers[0];
    assert_eq!((home.id.as_str(), home.name.as_str()), ("p1", "Home"));
    assert_eq!(home.channel_count, 3);
    assert_eq!(home.url, "");
    assert_eq!((&home.username, &home.password, &home.epg_url), (&None, &None, &None));
}

#[test]
fn a_series_goes_out_as_episodes_like_channels() {
    let app = app();
    let episodes = |id: &str| {
        assert_eq!(id, "show");
        Ok(vec![
            channel("show-e1", "series", Some(LOGO)),
            channel("show-e2", "series", Some(PANEL_LOGO)),
        ])
    };
    let call = LibraryCall::SeriesEpisodes {
        series_id: "show".into(),
    };
    let answer = ask_with(&app, call, episodes).unwrap();
    assert_no_login(&answer);
    let episodes = channels_in(answer);
    assert_eq!(episodes[0].id, "show-e1");
    assert_eq!(episodes[0].url, "");
    assert!(episodes[0].sources.is_empty());
    assert_eq!(episodes[0].logo_url.as_deref(), Some(LOGO));
    assert_eq!(episodes[1].logo_url, None);

    let call = LibraryCall::SeriesEpisodes {
        series_id: "gone".into(),
    };
    let failed = ask_with(&app, call, |_| Err(ErrorCode::NotFound));
    assert_eq!(failed, Err(ErrorCode::NotFound), "a failed load is passed on");
}

#[test]
fn history_keeps_only_logos_that_may_leave() {
    let app = app();
    {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        cache.record_play_start("bbc", "BBC One", Some(LOGO), "live").unwrap();
        cache.record_play_start("cnn", "CNN", Some(PANEL_LOGO), "live").unwrap();
        cache.record_play_start("show", "Show S01E01", None, "series").unwrap();
    }
    let all = |content_type: Option<&str>| {
        let call = LibraryCall::History {
            limit: 10,
            content_type: content_type.map(str::to_owned),
        };
        let entries: Vec<WatchHistoryEntryDto> =
            serde_json::from_value(ask(&app, call).unwrap()).unwrap();
        entries
            .into_iter()
            .map(|e| (e.channel_id, e.channel_logo))
            .collect::<Vec<_>>()
    };
    let mut entries = all(None);
    entries.sort();
    assert_eq!(
        entries,
        [
            ("bbc".into(), Some(LOGO.into())),
            ("cnn".into(), None),
            ("show".into(), None),
        ]
    );
    assert_eq!(all(Some("series")), [("show".into(), None)]);
}

fn programme(channel_id: &str, title: &str, start: i64) -> StoredEpgProgram {
    StoredEpgProgram {
        channel_id: channel_id.into(),
        title: title.into(),
        description: None,
        start_time: start,
        end_time: start + 3600,
        category: None,
        provider_id: "p1".into(),
        fetched_at: 0,
    }
}

fn with_guide(app: &TestApp) {
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    let programmes = [
        programme("bbc.uk", "News at Ten", 1000),
        programme("cnn.uk", "World News", 2000),
        programme("bbc.uk", "Film", 5000),
    ];
    cache.save_epg_programmes("p1", &programmes).unwrap();
}

#[test]
fn a_guide_search_keeps_only_logos_that_may_leave() {
    let app = app();
    with_guide(&app);
    let call = LibraryCall::GuideSearch {
        query: "news".into(),
        from: 0,
    };
    let results: Vec<EpgSearchResultDto> =
        serde_json::from_value(ask(&app, call).unwrap()).unwrap();
    let found: Vec<_> = results
        .iter()
        .map(|r| (r.title.as_str(), r.channel_logo_url.as_deref()))
        .collect();
    assert_eq!(found, [("News at Ten", Some(LOGO)), ("World News", None)]);
}

#[test]
fn the_guide_and_a_schedule_come_as_this_device_shows_them() {
    let app = app();
    with_guide(&app);
    let titles = |answer: Value| -> Vec<String> {
        answer
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["title"].as_str().unwrap().to_owned())
            .collect()
    };
    let guide = LibraryCall::Guide {
        from: 0,
        to: 4000,
        ids: Some(vec!["cnn.uk".into()]),
    };
    assert_eq!(titles(ask(&app, guide).unwrap()), ["World News"]);
    let schedule = LibraryCall::Schedule {
        epg_id: "bbc.uk".into(),
        from: 0,
        to: 9000,
    };
    assert_eq!(titles(ask(&app, schedule).unwrap()), ["News at Ten", "Film"]);
}

fn pinned(app: &TestApp) -> Value {
    ask(
        app,
        LibraryCall::PinnedGroups {
            provider_id: "p1".into(),
            content_type: "live".into(),
        },
    )
    .unwrap()
}

#[test]
fn pinning_and_unpinning_change_this_devices_groups() {
    let app = app();
    assert_eq!(pinned(&app), json!([]));
    let pin = LibraryCall::PinGroup {
        provider_id: "p1".into(),
        content_type: "live".into(),
        group: "News".into(),
        order: 3,
    };
    assert_eq!(ask(&app, pin), Ok(Value::Null));
    let groups = pinned(&app);
    assert_eq!(groups.as_array().unwrap().len(), 1, "{groups}");
    assert_eq!(groups[0]["groupName"], "News");
    assert_eq!(groups[0]["sortOrder"], 3);

    let unpin = LibraryCall::UnpinGroup {
        provider_id: "p1".into(),
        content_type: "live".into(),
        group: "News".into(),
    };
    assert_eq!(ask(&app, unpin), Ok(Value::Null));
    assert_eq!(pinned(&app), json!([]));
}

#[test]
fn a_group_hierarchy_comes_as_this_device_keeps_it() {
    let app = app();
    {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        cache
            .save_group_hierarchy("p1", "live", "News", Some("Headlines"), 0, true)
            .unwrap();
    }
    let call = LibraryCall::GroupHierarchy {
        provider_id: "p1".into(),
        content_type: "live".into(),
    };
    let hierarchy = ask(&app, call).unwrap();
    assert_eq!(hierarchy.as_array().unwrap().len(), 1, "{hierarchy}");
    assert_eq!(hierarchy[0]["groupName"], "News");
    assert_eq!(hierarchy[0]["superCategory"], "Headlines");
}

#[test]
fn starring_changes_this_devices_favorites() {
    let app = app();
    let star = || LibraryCall::ToggleFavorite { id: "bbc".into() };
    assert_eq!(ask(&app, star()), Ok(json!(true)));
    let state = app.state();
    let starred = || state.cache.lock().unwrap().get_channel_by_id("bbc").unwrap().unwrap();
    assert!(starred().is_favorite);
    assert_eq!(ask(&app, star()), Ok(json!(false)));
    assert!(!starred().is_favorite);
}

fn history_ids(app: &TestApp) -> Vec<String> {
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    let mut ids: Vec<String> = cache
        .get_watch_history(10)
        .unwrap()
        .into_iter()
        .map(|e| e.channel_id)
        .collect();
    ids.sort();
    ids
}

fn with_history(app: &TestApp) {
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    cache.record_play_start("bbc", "BBC One", None, "live").unwrap();
    cache.record_play_start("cnn", "CNN", None, "live").unwrap();
    cache.record_play_start("show", "Show S01E01", None, "series").unwrap();
}

#[test]
fn removing_history_changes_this_devices_history() {
    let app = app();
    with_history(&app);
    let delete = LibraryCall::DeleteHistory {
        channel_id: "cnn".into(),
    };
    assert_eq!(ask(&app, delete), Ok(Value::Null));
    assert_eq!(history_ids(&app), ["bbc", "show"]);

    let delete = LibraryCall::DeleteHistorySeries {
        series_title: "Show".into(),
    };
    assert_eq!(ask(&app, delete), Ok(Value::Null));
    assert_eq!(history_ids(&app), ["bbc"]);
}

#[test]
fn clearing_history_clears_one_type_or_all_of_it() {
    let app = app();
    with_history(&app);
    let clear = |content_type: Option<&str>| LibraryCall::ClearHistory {
        content_type: content_type.map(str::to_owned),
    };
    assert_eq!(ask(&app, clear(Some("series"))), Ok(Value::Null));
    assert_eq!(history_ids(&app), ["bbc", "cnn"]);
    assert_eq!(ask(&app, clear(None)), Ok(Value::Null));
    assert!(history_ids(&app).is_empty());
}

fn omdb(poster: &str) -> OmdbData {
    OmdbData {
        title: "Big Fish".into(),
        year: Some("2003".into()),
        rated: None,
        runtime: None,
        genre: None,
        director: None,
        actors: None,
        plot: None,
        poster_url: Some(poster.into()),
        imdb_rating: None,
        rotten_tomatoes: None,
        imdb_id: Some("tt0319061".into()),
        imdb_votes: None,
    }
}

#[test]
fn details_come_from_this_devices_cache_and_nothing_is_fetched_without_a_key() {
    let app = app();
    let omdb = omdb(LOGO);
    let whatson = WhatsonData {
        title: Some("Big Fish".into()),
        ..WhatsonData::default()
    };
    {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        cache.save_omdb_cache("fish", &omdb).unwrap();
        cache.save_whatson_cache("tt1", &whatson).unwrap();
    }
    let omdb_call = |id: &str| LibraryCall::Omdb {
        id: id.into(),
        title: "Big Fish".into(),
        kind: "movie".into(),
    };
    let answer = ask(&app, omdb_call("fish")).unwrap();
    assert_eq!(serde_json::from_value::<OmdbData>(answer).unwrap(), omdb);
    assert_eq!(ask(&app, omdb_call("other")), Ok(Value::Null));

    let whatson_call = |imdb_id: &str| LibraryCall::Whatson {
        imdb_id: imdb_id.into(),
        kind: "movie".into(),
    };
    let answer = ask(&app, whatson_call("tt1")).unwrap();
    assert_eq!(answer["title"], "Big Fish");
    assert_eq!(ask(&app, whatson_call("tt2")), Ok(Value::Null));
}

#[test]
fn a_call_this_device_cant_answer_fails() {
    let app = app();
    poison(&app.state().cache);
    for call in [
        LibraryCall::Channels,
        LibraryCall::Providers,
        LibraryCall::History {
            limit: 1,
            content_type: None,
        },
        LibraryCall::ToggleFavorite { id: "bbc".into() },
    ] {
        assert_eq!(ask(&app, call), Err(ErrorCode::Failed));
    }
}

fn sent(value: &impl Serialize) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn checked_as<T: DeserializeOwned>(call: &LibraryCall, json: Vec<u8>) -> T {
    serde_json::from_slice(&checked(call, json).unwrap()).unwrap()
}

#[test]
fn a_controller_names_each_channel_by_its_id_and_drops_what_it_cant_trust() {
    let series = Channel {
        url: SERIES_URL.into(),
        ..channel("show", "series", Some(LOGO))
    };
    let looks_like_a_series = Channel {
        url: format!("{SERIES_URL}42"),
        ..channel("odd", "series", None)
    };
    let answer = sent(&[
        channel("bbc", "live", Some(LOGO)),
        channel("cnn", "live", Some(LOCAL_LOGO)),
        series,
        looks_like_a_series,
    ]);
    for call in [
        LibraryCall::Channels,
        LibraryCall::SeriesEpisodes {
            series_id: "show".into(),
        },
    ] {
        let channels: Vec<Channel> = checked_as(&call, answer.clone());
        let urls: Vec<&str> = channels.iter().map(|c| c.url.as_str()).collect();
        assert_eq!(
            urls,
            [
                "cinette-remote:bbc",
                "cinette-remote:cnn",
                SERIES_URL,
                "cinette-remote:odd"
            ]
        );
        assert!(channels.iter().all(|c| c.sources.is_empty()));
        let logos: Vec<_> = channels.iter().map(|c| c.logo_url.as_deref()).collect();
        assert_eq!(logos, [Some(LOGO), None, Some(LOGO), None]);
        assert_eq!(channels[0].name, "bbc S01E01", "the rest is kept");
    }
}

#[test]
fn a_controller_keeps_only_images_its_webview_may_load() {
    let entry = |logo: &str| WatchHistoryEntryDto {
        channel_id: "bbc".into(),
        channel_name: "BBC One".into(),
        channel_logo: Some(logo.into()),
        content_type: "live".into(),
        first_watched_at: 1,
        last_watched_at: 2,
        total_duration_seconds: 3,
        play_count: 4,
        series_title: None,
    };
    let call = LibraryCall::History {
        limit: 10,
        content_type: None,
    };
    let entries: Vec<WatchHistoryEntryDto> =
        checked_as(&call, sent(&[entry(LOGO), entry(LOCAL_LOGO)]));
    let logos: Vec<_> = entries.iter().map(|e| e.channel_logo.as_deref()).collect();
    assert_eq!(logos, [Some(LOGO), None]);
    assert_eq!(entries[0].play_count, 4);

    let result = |logo: &str| EpgSearchResultDto {
        channel_id: "bbc.uk".into(),
        title: "News".into(),
        description: None,
        start_time: 1,
        end_time: 2,
        channel_name: "BBC One".into(),
        channel_logo_url: Some(logo.into()),
    };
    let call = LibraryCall::GuideSearch {
        query: "news".into(),
        from: 0,
    };
    let results: Vec<EpgSearchResultDto> =
        checked_as(&call, sent(&[result(LOCAL_LOGO), result(LOGO)]));
    let logos: Vec<_> = results.iter().map(|r| r.channel_logo_url.as_deref()).collect();
    assert_eq!(logos, [None, Some(LOGO)]);

    let call = LibraryCall::Omdb {
        id: "fish".into(),
        title: "Big Fish".into(),
        kind: "movie".into(),
    };
    let kept: Option<OmdbData> = checked_as(&call, sent(&Some(omdb(LOGO))));
    assert_eq!(kept, Some(omdb(LOGO)));
    let dropped: Option<OmdbData> = checked_as(&call, sent(&Some(omdb(LOCAL_LOGO))));
    assert_eq!(dropped.unwrap().poster_url, None);
    let none: Option<OmdbData> = checked_as(&call, sent(&None::<OmdbData>));
    assert_eq!(none, None);

    let image = |url: &str| WhatsonData {
        image: Some(url.into()),
        ..WhatsonData::default()
    };
    let call = LibraryCall::Whatson {
        imdb_id: "tt1".into(),
        kind: "movie".into(),
    };
    let kept: Option<WhatsonData> = checked_as(&call, sent(&Some(image(LOGO))));
    assert_eq!(kept.unwrap().image.as_deref(), Some(LOGO));
    let dropped: Option<WhatsonData> = checked_as(&call, sent(&Some(image(LOCAL_LOGO))));
    assert_eq!(dropped.unwrap().image, None);
}

#[test]
fn an_answer_that_isnt_what_the_call_asked_for_is_invalid() {
    let calls = [
        LibraryCall::Channels,
        LibraryCall::SeriesEpisodes {
            series_id: "show".into(),
        },
        LibraryCall::History {
            limit: 10,
            content_type: None,
        },
        LibraryCall::GuideSearch {
            query: "news".into(),
            from: 0,
        },
        LibraryCall::Omdb {
            id: "fish".into(),
            title: "Big Fish".into(),
            kind: "movie".into(),
        },
        LibraryCall::Whatson {
            imdb_id: "tt1".into(),
            kind: "movie".into(),
        },
    ];
    for call in calls {
        assert_eq!(checked(&call, b"{\"not\":1".to_vec()), Err(ErrorCode::Invalid));
        assert_eq!(checked(&call, b"7".to_vec()), Err(ErrorCode::Invalid));
    }
}

#[test]
fn other_answers_hold_nothing_to_load_and_pass_as_they_came() {
    let answer = b"[{\"anything\":\"at all\"}]".to_vec();
    for call in [
        LibraryCall::Providers,
        LibraryCall::PinnedGroups {
            provider_id: "p1".into(),
            content_type: "live".into(),
        },
        LibraryCall::ToggleFavorite { id: "bbc".into() },
    ] {
        assert_eq!(checked(&call, answer.clone()), Ok(answer.clone()));
    }
}
