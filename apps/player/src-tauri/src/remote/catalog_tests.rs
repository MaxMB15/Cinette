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
    let page = answer_from(
        &channels(),
        &[],
        CatalogQuery::Groups {
            content_type: "live".into(),
        },
    );
    let (items, next) = page.as_ref().unwrap();
    assert_eq!(ids(&page), ["News", "news", "UK"]);
    assert_eq!(items[2].name, "UK");
    assert_eq!(items[2].group, "UK");
    assert_eq!(items[2].content_type, "live");
    assert_eq!(*next, None);
}

#[test]
fn groups_stop_at_a_page() {
    let many: Vec<Channel> = (0..MAX_PAGE + 5)
        .map(|i| channel(&format!("c{i}"), "x", "live", &format!("g{i:03}")))
        .collect();
    let page = answer_from(
        &many,
        &[],
        CatalogQuery::Groups {
            content_type: "live".into(),
        },
    );
    assert_eq!(page.unwrap().0.len(), MAX_PAGE);
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

    let page = answer(&cache, items_query(None, 10)).unwrap();
    assert_eq!(page.0.len(), 2);
    assert!(page.0.iter().all(|i| i.logo.is_none()), "{page:?}");

    let episodes = answer(
        &cache,
        CatalogQuery::Episodes {
            series_id: "p1-series-9".into(),
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
    let page = answer(
        &cache,
        CatalogQuery::Episodes {
            series_id: "p1-series-9".into(),
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
                series_id: "x".into()
            }
        ),
        Err(ErrorCode::Unsupported)
    );
}
