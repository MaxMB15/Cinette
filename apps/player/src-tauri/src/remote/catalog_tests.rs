// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn channel(id: &str, name: &str, content_type: &str, group: &str) -> Channel {
    Channel {
        id: id.into(),
        name: name.into(),
        // A made-up login, which must never reach a controller.
        url: format!("http://iptv.example/live/user/pass/{id}.ts"),
        group_title: group.into(),
        content_type: content_type.into(),
        ..Channel::default()
    }
}

fn channels() -> Vec<Channel> {
    vec![
        channel("live-1", "BBC One", "live", "UK"),
        channel("live-2", "bbc two", "live", "UK"),
        channel("live-3", "CNN", "live", "news"),
        channel("live-4", "Sky News", "live", "News"),
        channel("movie-1", "Big Fish", "movie", "Drama"),
        channel("live-5", "ITV", "live", "UK"),
    ]
}

fn ids(page: &CatalogPage) -> Vec<&str> {
    page.as_ref()
        .unwrap()
        .0
        .iter()
        .map(|i| i.id.as_str())
        .collect()
}

#[test]
fn groups_are_listed_once_each_in_name_order_for_one_type() {
    let page = answer_from(&channels(), &[], groups_query(None, 10));
    let (items, next) = page.as_ref().unwrap();
    assert_eq!(ids(&page), ["News", "news", "UK"]);
    assert_eq!(items[2].name, "UK");
    assert_eq!(items[2].group, "UK");
    assert_eq!(items[2].content_type, "live");
    assert_eq!(*next, None);
}

fn groups_query(cursor: Option<&str>, limit: u32) -> CatalogQuery {
    CatalogQuery::Groups {
        content_type: "live".into(),
        cursor: cursor.map(str::to_owned),
        limit,
    }
}

#[test]
fn groups_come_a_page_at_a_time() {
    let many: Vec<Channel> = (0..MAX_PAGE + 5)
        .map(|i| channel(&format!("c{i}"), "x", "live", &format!("g{i:03}")))
        .collect();
    let first = answer_from(&many, &[], groups_query(None, 500)).unwrap();
    assert_eq!(first.0.len(), MAX_PAGE, "no more than a page");
    assert_eq!(first.0[0].id, "g000");
    assert_eq!(first.1.as_deref(), Some("g100"));

    let rest = answer_from(&many, &[], groups_query(Some("g100"), 10)).unwrap();
    let names: Vec<&str> = rest.0.iter().map(|g| g.id.as_str()).collect();
    assert_eq!(names, ["g100", "g101", "g102", "g103", "g104"]);
    assert_eq!(rest.1, None, "the last page has no next");

    let two = answer_from(&many, &[], groups_query(Some("g001"), 2)).unwrap();
    assert_eq!(two.0.len(), 2);
    assert_eq!(two.1.as_deref(), Some("g003"));
    let one = answer_from(&many, &[], groups_query(None, 0)).unwrap();
    assert_eq!(one.0.len(), 1, "at least one");
}

#[test]
fn a_cursor_for_a_group_thats_gone_starts_at_the_next_one() {
    // "Sport" sorts between "news" and "UK".
    let page = answer_from(&channels(), &[], groups_query(Some("Sport"), 10));
    assert_eq!(ids(&page), ["UK"]);
}

#[test]
fn a_group_name_too_long_to_come_back_doesnt_stop_the_paging() {
    let long = "━".repeat(90);
    let mut all = channels();
    all.push(channel("live-6", "Match", "live", &long));
    all.push(channel("live-7", "Weather", "live", "Weather"));
    let first = answer_from(&all, &[], groups_query(None, 3));
    assert_eq!(ids(&first), ["News", "news", "UK"]);
    let next = first.unwrap().1;
    assert_eq!(next.as_deref(), Some("Weather"));
    let query = groups_query(next.as_deref(), 3).validate().unwrap();
    let rest = answer_from(&all, &[], query);
    assert_eq!(ids(&rest), ["Weather"]);
    assert_eq!(rest.unwrap().1, None);
}

fn items_query(cursor: Option<&str>, limit: u32) -> CatalogQuery {
    CatalogQuery::Items {
        content_type: "live".into(),
        group: "UK".into(),
        cursor: cursor.map(str::to_owned),
        limit,
    }
}

#[test]
fn items_come_a_page_at_a_time() {
    let all = channels();
    let first = answer_from(&all, &[], items_query(None, 2));
    assert_eq!(ids(&first), ["live-1", "live-2"]);
    let next = first.unwrap().1;
    assert_eq!(next.as_deref(), Some("live-5"));
    let second = answer_from(&all, &[], items_query(next.as_deref(), 2));
    assert_eq!(ids(&second), ["live-5"]);
    assert_eq!(second.unwrap().1, None);
}

#[test]
fn a_page_that_ends_exactly_at_the_last_item_has_no_next() {
    let page = answer_from(&channels(), &[], items_query(None, 3));
    assert_eq!(ids(&page), ["live-1", "live-2", "live-5"]);
    assert_eq!(page.unwrap().1, None);
}

#[test]
fn items_limits_are_kept_between_one_and_a_page() {
    let many: Vec<Channel> = (0..MAX_PAGE + 5)
        .map(|i| channel(&format!("c{i}"), "x", "live", "UK"))
        .collect();
    assert_eq!(
        answer_from(&many, &[], items_query(None, 0))
            .unwrap()
            .0
            .len(),
        1
    );
    assert_eq!(
        answer_from(&many, &[], items_query(None, 1000))
            .unwrap()
            .0
            .len(),
        MAX_PAGE
    );
}

#[test]
fn an_unknown_cursor_is_not_found() {
    assert_eq!(
        answer_from(&channels(), &[], items_query(Some("live-3"), 2)),
        Err(ErrorCode::NotFound),
        "live-3 is in another group"
    );
}

#[test]
fn search_matches_names_without_case_like_the_channel_list() {
    let all = channels();
    let search = |query: &str, content_type: Option<&str>, limit| {
        answer_from(
            &all,
            &[],
            CatalogQuery::Search {
                query: query.into(),
                content_type: content_type.map(str::to_owned),
                limit,
            },
        )
    };
    assert_eq!(ids(&search("BBC", None, 10)), ["live-1", "live-2"]);
    assert_eq!(ids(&search("bi", None, 10)), ["movie-1"]);
    assert_eq!(ids(&search("i", Some("movie"), 10)), ["movie-1"]);
    assert_eq!(ids(&search("n", Some("live"), 2)), ["live-1", "live-3"]);
    assert_eq!(search("n", None, 2).unwrap().1, None);
}

#[test]
fn items_never_carry_the_stream_url_and_drop_provider_logos() {
    let mut all = channels();
    all[0].logo_url = Some("http://iptv.example/logo.png".into());
    all[1].logo_url = Some("https://logos.example/bbc2.png".into());
    let page = answer_from(&all, &["iptv.example".into()], items_query(None, 10)).unwrap();
    assert_eq!(page.0[0].logo, None);
    assert_eq!(
        page.0[1].logo.as_deref(),
        Some("https://logos.example/bbc2.png")
    );
    let text = serde_json::to_string(&page.0).unwrap();
    assert!(!text.contains("pass"), "{text}");
}

#[test]
fn answer_reads_the_cache_and_hides_provider_hosts() {
    use mvp_core::models::playlist::{Provider, ProviderType};
    let cache = CacheStore::open_in_memory().unwrap();
    cache
        .upsert_provider(&Provider {
            id: "p1".into(),
            name: "Mine".into(),
            provider_type: ProviderType::Xtream,
            url: "http://iptv.example:8080".into(),
            username: Some("user".into()),
            password: Some("pass".into()),
            last_updated: None,
            channel_count: 0,
            epg_url: Some("http://epg.example/guide.xml".into()),
        })
        .unwrap();
    let mut on_epg_host = channel("p1-live-1", "One", "live", "UK");
    on_epg_host.logo_url = Some("http://epg.example/one.png".into());
    let mut on_server = channel("p1-live-2", "Two", "live", "UK");
    on_server.logo_url = Some("http://iptv.example:8080/two.png".into());
    cache
        .save_channels("p1", &[on_epg_host, on_server])
        .unwrap();

    let cache = Mutex::new(cache);
    let page = answer(&cache, items_query(None, 10)).unwrap();
    assert_eq!(page.0.len(), 2);
    assert!(page.0.iter().all(|i| i.logo.is_none()), "{page:?}");

    let episodes = answer(
        &cache,
        CatalogQuery::Episodes {
            series_id: "p1-series-9".into(),
            cursor: None,
            limit: 100,
        },
    );
    assert_eq!(episodes, Ok((Vec::new(), None)), "nothing cached yet");
}

#[test]
fn episodes_come_from_the_cache() {
    let cache = CacheStore::open_in_memory().unwrap();
    let mut ep = channel("xt-ep-9-s1-0", "Pilot", "series", "Drama");
    ep.season = Some(1);
    ep.episode = Some(1);
    cache.save_series_episodes("p1-series-9", &[ep]).unwrap();
    let cache = Mutex::new(cache);
    let page = answer(
        &cache,
        CatalogQuery::Episodes {
            series_id: "p1-series-9".into(),
            cursor: None,
            limit: 100,
        },
    )
    .unwrap();
    assert_eq!(page.0.len(), 1);
    assert_eq!(page.0[0].season, Some(1));
}

#[test]
fn episodes_are_not_answered_from_the_channel_list() {
    assert_eq!(
        answer_from(
            &channels(),
            &[],
            CatalogQuery::Episodes {
                series_id: "x".into(),
                cursor: None,
                limit: 100,
            }
        ),
        Err(ErrorCode::Unsupported)
    );
}

mod loading_episodes {
    use super::*;
    use mvp_core::http::test_server::{self, route, serve_routes};
    use mvp_core::models::playlist::{Provider, ProviderType};

    const SERIES_INFO: &str = r#"{"info":{"name":"The Show"},"episodes":{"1":[
        {"id":"9001","episode_num":1,"title":"First"}]}}"#;

    /// A cache with the Xtream series `p1-series-7` from a panel at `url`,
    /// with `cached` saved as its episodes.
    fn series_on(url: &str, cached: &[Channel]) -> Mutex<CacheStore> {
        let cache = CacheStore::open_in_memory().unwrap();
        cache
            .upsert_provider(&Provider {
                id: "p1".into(),
                name: "Panel".into(),
                provider_type: ProviderType::Xtream,
                url: url.into(),
                username: Some("user".into()),
                password: Some(test_server::password()),
                last_updated: None,
                channel_count: 1,
                epg_url: None,
            })
            .unwrap();
        let mut series = channel("p1-series-7", "The Show", "series", "Drama");
        series.url = "xtream://series/7".into();
        cache.save_channels("p1", &[series]).unwrap();
        cache.save_series_episodes("p1-series-7", cached).unwrap();
        Mutex::new(cache)
    }

    fn cached_episode() -> Channel {
        let mut ep = channel("p1-xt-ep-7-s1-5", "Cached", "series", "Drama");
        ep.season = Some(1);
        ep.episode = Some(6);
        ep
    }

    fn names(episodes: &[Channel]) -> Vec<&str> {
        episodes.iter().map(|e| e.name.as_str()).collect()
    }

    #[tokio::test]
    async fn the_provider_isnt_asked_past_the_limit() {
        let (url, requests) =
            serve_routes(vec![route("action=get_series_info", "200 OK", SERIES_INFO)]);
        let cache = series_on(&url, &[cached_episode()]);
        assert_eq!(
            episodes(&cache, "p1-series-7", || false).await,
            Err(ErrorCode::RateLimited)
        );
        assert_eq!(requests.try_iter().count(), 0);
    }

    #[tokio::test]
    async fn an_xtream_series_is_loaded_from_its_provider() {
        let (url, requests) =
            serve_routes(vec![route("action=get_series_info", "200 OK", SERIES_INFO)]);
        let cache = series_on(&url, &[cached_episode()]);
        let episodes = episodes(&cache, "p1-series-7", || true).await.unwrap();
        assert_eq!(names(&episodes), ["The Show S01E01 First"]);
        assert_eq!(episodes[0].id, "p1-xt-ep-7-s1-0");
        assert!(requests
            .try_iter()
            .any(|r| r.contains("action=get_series_info&series_id=7 ")));
    }

    #[tokio::test]
    async fn the_cached_episodes_stand_in_when_the_provider_fails() {
        let (url, _requests) = serve_routes(vec![route("action=", "500 Oops", "")]);
        let cache = series_on(&url, &[cached_episode()]);
        let episodes = episodes(&cache, "p1-series-7", || true).await.unwrap();
        assert_eq!(names(&episodes), ["Cached"]);
    }

    #[tokio::test]
    async fn the_cached_episodes_stand_in_when_the_provider_has_none() {
        let (url, _requests) = serve_routes(vec![route(
            "action=get_series_info",
            "200 OK",
            r#"{"info":{},"episodes":{}}"#,
        )]);
        let cache = series_on(&url, &[cached_episode()]);
        let episodes = episodes(&cache, "p1-series-7", || true).await.unwrap();
        assert_eq!(names(&episodes), ["Cached"]);
    }

    #[tokio::test]
    async fn a_failed_load_with_nothing_cached_fails() {
        let (url, _requests) = serve_routes(vec![route("action=", "500 Oops", "")]);
        let cache = series_on(&url, &[]);
        assert_eq!(
            episodes(&cache, "p1-series-7", || true).await,
            Err(ErrorCode::Failed)
        );
    }

    #[tokio::test]
    async fn other_series_come_from_the_cache_without_asking_anyone() {
        // Nothing listens here, so a request would fail the load.
        let cache = series_on("http://127.0.0.1:9", &[cached_episode()]);
        {
            let store = cache.lock().unwrap();
            let mut series = channel("p1-series-8", "Other", "series", "Drama");
            series.url = "http://iptv.example/series/8.m3u8".into();
            store.save_channels("p1", &[series]).unwrap();
            store
                .save_series_episodes("p1-series-8", &[cached_episode()])
                .unwrap();
        }
        let loaded = episodes(&cache, "p1-series-8", || false).await.unwrap();
        assert_eq!(names(&loaded), ["Cached"]);
        assert_eq!(
            episodes(&cache, "p1-series-404", || false).await,
            Err(ErrorCode::NotFound)
        );
        {
            let store = cache.lock().unwrap();
            store
                .save_series_episodes("p1-series-gone", &[cached_episode()])
                .unwrap();
        }
        let kept = episodes(&cache, "p1-series-gone", || false).await.unwrap();
        assert_eq!(
            names(&kept),
            ["Cached"],
            "a downloaded series whose channel went"
        );
    }

    #[test]
    fn a_page_of_episodes_hides_provider_logos_and_stops_at_a_page() {
        let cache = series_on("http://iptv.example:8080", &[]);
        let providers = cache.lock().unwrap().get_providers().unwrap();
        let many: Vec<Channel> = (0..MAX_PAGE + 3)
            .map(|i| {
                let mut ep = channel(&format!("ep{i}"), "x", "series", "Drama");
                ep.logo_url = Some("http://iptv.example:8080/logo.png".into());
                ep
            })
            .collect();
        let (items, next) = episode_page(&providers, &many, None, 500).unwrap();
        assert_eq!(items.len(), MAX_PAGE);
        assert_eq!(next.as_deref(), Some("ep100"));
        let (rest, next) = episode_page(&providers, &many, next, 10).unwrap();
        let ids: Vec<&str> = rest.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["ep100", "ep101", "ep102"]);
        assert_eq!(next, None);
        let (two, next) = episode_page(&providers, &many, Some("ep1".into()), 2).unwrap();
        assert_eq!(two.len(), 2);
        assert_eq!(next.as_deref(), Some("ep3"));
        let (one, _) = episode_page(&providers, &many, None, 0).unwrap();
        assert_eq!(one.len(), 1, "at least one");
        assert_eq!(
            episode_page(&providers, &many, Some("gone".into()), 10),
            Err(ErrorCode::NotFound)
        );
        assert!(items.iter().all(|i| i.logo.is_none()));
    }
}

#[test]
fn no_logo_goes_out_from_the_site_a_stream_comes_from() {
    use mvp_core::models::playlist::{Provider, ProviderType};
    let cache = CacheStore::open_in_memory().unwrap();
    // A playlist kept elsewhere, whose streams and logos are on the panel.
    cache
        .upsert_provider(&Provider {
            id: "p1".into(),
            name: "Mine".into(),
            provider_type: ProviderType::M3u,
            url: "https://lists.example/mine.m3u".into(),
            username: None,
            password: None,
            last_updated: None,
            channel_count: 0,
            epg_url: None,
        })
        .unwrap();
    let mut on_panel = channel("p1-live-1", "One", "live", "UK");
    on_panel.url = "http://live.panel.example:8080/u/p/1.ts".into();
    on_panel.logo_url = Some("http://img.panel.example/one.png".into());
    let mut backup = channel("p1-live-2", "Two", "live", "UK");
    backup.url = "http://plain.example/2.ts".into();
    backup.sources = vec!["http://backup.mirror.example/2.ts".into()];
    backup.logo_url = Some("http://mirror.example/two.png".into());
    let mut elsewhere = channel("p1-live-3", "Three", "live", "UK");
    elsewhere.logo_url = Some("https://logos.example/three.png".into());
    cache
        .save_channels("p1", &[on_panel, backup, elsewhere])
        .unwrap();
    let cache = Mutex::new(cache);
    let (items, _) = answer(&cache, items_query(None, 10)).unwrap();
    let logo = |id: &str| {
        let item = items.iter().find(|i| i.id == id).unwrap();
        item.logo.clone()
    };
    assert_eq!(logo("p1-live-1"), None, "next to its own stream");
    assert_eq!(logo("p1-live-2"), None, "next to a backup stream");
    assert_eq!(
        logo("p1-live-3").as_deref(),
        Some("https://logos.example/three.png")
    );
}
