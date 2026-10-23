// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn xtream_movie() -> Channel {
    Channel {
        id: "movie-42".into(),
        name: "A Film".into(),
        url: "http://panel.example:8080/movie/someuser/somepass/42.mkv".into(),
        logo_url: Some("https://images.example/posters/42.jpg".into()),
        group_title: "Drama".into(),
        content_type: "movie".into(),
        sources: vec!["http://backup.example/movie/someuser/somepass/42.mkv".into()],
        ..Channel::default()
    }
}

#[test]
fn an_item_carries_no_url_or_login() {
    let channel = xtream_movie();
    let item = CatalogItem::from_channel(&channel, &["panel.example".into()]);
    let json = serde_json::to_string(&item).unwrap();
    assert!(!json.contains("somepass"));
    assert!(!json.contains("someuser"));
    assert!(!json.contains("panel.example"));
    assert!(!json.contains("backup.example"));
    assert_eq!(item.id, "movie-42");
    assert_eq!(
        item.logo.as_deref(),
        Some("https://images.example/posters/42.jpg")
    );
    assert_eq!(item.group, "Drama");
}

#[test]
fn an_episode_keeps_its_series_season_and_number() {
    let channel = Channel {
        id: "xt-ep-7-s1-3".into(),
        content_type: "series".into(),
        series_title: Some("Show".into()),
        season: Some(1),
        episode: Some(3),
        ..Channel::default()
    };
    let item = CatalogItem::from_channel(&channel, &[]);
    assert_eq!(item.series_title.as_deref(), Some("Show"));
    assert_eq!((item.season, item.episode), (Some(1), Some(3)));
}

#[test]
fn a_logo_on_a_provider_server_is_left_out() {
    let mut channel = xtream_movie();
    channel.logo_url = Some("http://PANEL.example:8080/images/42.png".into());
    let item = CatalogItem::from_channel(&channel, &["panel.example".into()]);
    assert_eq!(item.logo, None);
}

#[test]
fn only_plain_logo_urls_are_shared() {
    let hosts: Vec<String> = vec![];
    assert!(shareable_logo("https://cdn.example/a.png", &hosts));
    assert!(shareable_logo("http://cdn.example/a.png", &hosts));
    assert!(!shareable_logo(
        "https://user:pass@cdn.example/a.png",
        &hosts
    ));
    assert!(!shareable_logo("https://user@cdn.example/a.png", &hosts));
    assert!(!shareable_logo("https://cdn.example/a.png?token=x", &hosts));
    assert!(!shareable_logo("https://cdn.example/a.png#t", &hosts));
    assert!(!shareable_logo("file:///etc/passwd", &hosts));
    assert!(!shareable_logo("data:image/png;base64,AAAA", &hosts));
    assert!(!shareable_logo("not a url", &hosts));
}

#[test]
fn provider_host_reads_the_server_host() {
    assert_eq!(
        provider_host("http://Panel.Example:8080/"),
        Some("panel.example".into())
    );
    assert_eq!(provider_host("nonsense"), None);
}

#[test]
fn queries_read_from_camel_case_json() {
    let query: CatalogQuery = serde_json::from_value(serde_json::json!({
        "kind": "items", "contentType": "live", "group": "News", "limit": 50
    }))
    .unwrap();
    assert_eq!(
        query,
        CatalogQuery::Items {
            content_type: "live".into(),
            group: "News".into(),
            cursor: None,
            limit: 50
        }
    );
}

#[test]
fn a_groups_query_reads_and_writes_its_page() {
    let query: CatalogQuery = serde_json::from_value(serde_json::json!({
        "kind": "groups", "contentType": "movie", "cursor": "Drama", "limit": 20
    }))
    .unwrap();
    assert_eq!(
        query,
        CatalogQuery::Groups {
            content_type: "movie".into(),
            cursor: Some("Drama".into()),
            limit: 20
        }
    );
    let first = CatalogQuery::Groups {
        content_type: "live".into(),
        cursor: None,
        limit: 100,
    };
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::json!({ "kind": "groups", "contentType": "live", "limit": 100 })
    );
}

#[test]
fn an_episodes_query_reads_and_writes_its_page() {
    let query: CatalogQuery = serde_json::from_value(serde_json::json!({
        "kind": "episodes", "seriesId": "series-7", "cursor": "ep-3", "limit": 20
    }))
    .unwrap();
    assert_eq!(
        query,
        CatalogQuery::Episodes {
            series_id: "series-7".into(),
            cursor: Some("ep-3".into()),
            limit: 20
        }
    );
    assert_eq!(
        serde_json::to_value(&query).unwrap(),
        serde_json::json!({
            "kind": "episodes", "seriesId": "series-7", "cursor": "ep-3", "limit": 20
        })
    );
    let first = CatalogQuery::Episodes {
        series_id: "series-7".into(),
        cursor: None,
        limit: 100,
    };
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::json!({ "kind": "episodes", "seriesId": "series-7", "limit": 100 })
    );
}

#[test]
fn a_query_without_a_limit_asks_for_a_full_page() {
    let read = |json| serde_json::from_value::<CatalogQuery>(json).unwrap();
    assert_eq!(
        read(serde_json::json!({ "kind": "groups", "contentType": "live" })),
        CatalogQuery::Groups {
            content_type: "live".into(),
            cursor: None,
            limit: MAX_PAGE as u32
        }
    );
    assert_eq!(
        read(serde_json::json!({ "kind": "episodes", "seriesId": "s" })),
        CatalogQuery::Episodes {
            series_id: "s".into(),
            cursor: None,
            limit: MAX_PAGE as u32
        }
    );
    assert_eq!(
        read(serde_json::json!({ "kind": "items", "contentType": "live", "group": "g" })),
        CatalogQuery::Items {
            content_type: "live".into(),
            group: "g".into(),
            cursor: None,
            limit: MAX_PAGE as u32
        }
    );
    assert_eq!(
        read(serde_json::json!({ "kind": "search", "query": "news" })),
        CatalogQuery::Search {
            query: "news".into(),
            content_type: None,
            limit: MAX_PAGE as u32
        }
    );
}

fn names(page: &[CatalogItem]) -> Vec<&str> {
    page.iter().map(|item| item.name.as_str()).collect()
}

#[test]
fn group_page_lists_each_group_once_in_name_order() {
    let all = ["news", "Sports", "Kids", "news", "", "Movies"];
    let (page, next) = group_page(all, "live", None, 10);
    assert_eq!(names(&page), ["", "Kids", "Movies", "news", "Sports"]);
    assert_eq!(next, None);
    // A group goes out as an item whose id, name and group are its name.
    assert_eq!(
        page[1],
        CatalogItem {
            id: "Kids".into(),
            name: "Kids".into(),
            content_type: "live".into(),
            group: "Kids".into(),
            ..CatalogItem::default()
        }
    );
}

#[test]
fn group_page_pages_on_from_the_cursor() {
    let all = ["A", "B", "C", "D", "E"];
    let (page, next) = group_page(all, "movie", None, 2);
    assert_eq!((names(&page), next.as_deref()), (vec!["A", "B"], Some("C")));
    let (page, next) = group_page(all, "movie", Some("C"), 2);
    assert_eq!((names(&page), next.as_deref()), (vec!["C", "D"], Some("E")));
    // A page that ends at the last group has no next.
    let (page, next) = group_page(all, "movie", Some("D"), 2);
    assert_eq!((names(&page), next), (vec!["D", "E"], None));
    let (page, next) = group_page(all, "movie", Some("E"), 2);
    assert_eq!((names(&page), next), (vec!["E"], None));
}

#[test]
fn group_page_of_nothing_is_empty() {
    let (page, next) = group_page([], "live", None, 10);
    assert!(page.is_empty());
    assert_eq!(next, None);
    let (page, next) = group_page(["A"], "live", Some("B"), 10);
    assert!(page.is_empty());
    assert_eq!(next, None);
}

#[test]
fn a_cursor_for_a_group_thats_gone_starts_at_the_next_one() {
    let (page, next) = group_page(["Arts", "Drama", "News"], "live", Some("Comedy"), 1);
    assert_eq!(
        (names(&page), next.as_deref()),
        (vec!["Drama"], Some("News"))
    );
}

#[test]
fn names_that_differ_only_in_case_page_without_repeats_or_gaps() {
    let all = ["news", "NEWS", "News", "Arts"];
    let (page, next) = group_page(all, "live", None, 2);
    assert_eq!(
        (names(&page), next.as_deref()),
        (vec!["Arts", "NEWS"], Some("News"))
    );
    let (page, next) = group_page(all, "live", next.as_deref(), 2);
    assert_eq!((names(&page), next), (vec!["News", "news"], None));
}

#[test]
fn a_group_whose_name_is_too_long_is_left_out() {
    let long = "━".repeat(90);
    assert!(!group_ok(&long));
    assert!(group_ok(&"g".repeat(MAX_ID_BYTES)));
    assert!(!group_ok(&"g".repeat(MAX_ID_BYTES + 1)));
    let all = ["A", long.as_str(), "Z"];
    let (page, next) = group_page(all, "live", None, 1);
    assert_eq!((names(&page), next.as_deref()), (vec!["A"], Some("Z")));
    let (page, next) = group_page(all, "live", next.as_deref(), 1);
    assert_eq!((names(&page), next), (vec!["Z"], None));
}

#[test]
fn validate_keeps_good_queries_and_caps_the_page() {
    let query = CatalogQuery::Search {
        query: "news".into(),
        content_type: None,
        limit: 5000,
    };
    assert_eq!(
        query.validate(),
        Some(CatalogQuery::Search {
            query: "news".into(),
            content_type: None,
            limit: MAX_PAGE as u32
        })
    );
    let zero = CatalogQuery::Items {
        content_type: "movie".into(),
        group: String::new(),
        cursor: Some("100".into()),
        limit: 0,
    };
    assert!(matches!(
        zero.validate(),
        Some(CatalogQuery::Items { limit: 1, .. })
    ));
    let groups = |cursor: Option<&str>, limit| CatalogQuery::Groups {
        content_type: "series".into(),
        cursor: cursor.map(str::to_owned),
        limit,
    };
    assert_eq!(groups(None, 0).validate(), Some(groups(None, 1)));
    assert_eq!(
        groups(Some("Drama"), 500).validate(),
        Some(groups(Some("Drama"), MAX_PAGE as u32))
    );
    // A group can have an empty name, and so can the cursor naming it.
    assert_eq!(groups(Some(""), 5).validate(), Some(groups(Some(""), 5)));
    let longest = "g".repeat(MAX_ID_BYTES);
    assert!(groups(Some(&longest), 5).validate().is_some());
    // The limit counts bytes, not characters.
    assert!(groups(Some(&"é".repeat(MAX_ID_BYTES / 2)), 5)
        .validate()
        .is_some());
    assert_eq!(
        groups(Some(&"é".repeat(MAX_ID_BYTES / 2 + 1)), 5).validate(),
        None
    );
    let episodes = |cursor: Option<&str>, limit| CatalogQuery::Episodes {
        series_id: "series-1".into(),
        cursor: cursor.map(str::to_owned),
        limit,
    };
    assert_eq!(episodes(None, 0).validate(), Some(episodes(None, 1)));
    assert_eq!(
        episodes(Some("ep-101"), 900).validate(),
        Some(episodes(Some("ep-101"), MAX_PAGE as u32))
    );
    let longest = "e".repeat(MAX_ID_BYTES);
    assert_eq!(
        episodes(Some(&longest), 5).validate(),
        Some(episodes(Some(&longest), 5))
    );
    let items = |group: &str| CatalogQuery::Items {
        content_type: "live".into(),
        group: group.into(),
        cursor: None,
        limit: 5,
    };
    assert!(items(&"g".repeat(MAX_ID_BYTES)).validate().is_some());
}

#[test]
fn validate_refuses_bad_queries() {
    let bad = [
        CatalogQuery::Groups {
            content_type: "radio".into(),
            cursor: None,
            limit: 10,
        },
        CatalogQuery::Groups {
            content_type: "live".into(),
            cursor: Some("g".repeat(MAX_ID_BYTES + 1)),
            limit: 10,
        },
        CatalogQuery::Search {
            query: "  ".into(),
            content_type: None,
            limit: 10,
        },
        CatalogQuery::Search {
            query: "x".repeat(MAX_QUERY_CHARS + 1),
            content_type: None,
            limit: 10,
        },
        CatalogQuery::Search {
            query: "x".into(),
            content_type: Some("radio".into()),
            limit: 10,
        },
        CatalogQuery::Items {
            content_type: "live".into(),
            group: "g".repeat(MAX_ID_BYTES + 1),
            cursor: None,
            limit: 1,
        },
        CatalogQuery::Items {
            content_type: "live".into(),
            group: "g".into(),
            cursor: Some(String::new()),
            limit: 1,
        },
        CatalogQuery::Episodes {
            series_id: String::new(),
            cursor: None,
            limit: 10,
        },
        CatalogQuery::Episodes {
            series_id: "s".repeat(MAX_ID_BYTES + 1),
            cursor: None,
            limit: 10,
        },
        CatalogQuery::Episodes {
            series_id: "s".into(),
            cursor: Some(String::new()),
            limit: 10,
        },
        CatalogQuery::Episodes {
            series_id: "s".into(),
            cursor: Some("e".repeat(MAX_ID_BYTES + 1)),
            limit: 10,
        },
    ];
    for query in bad {
        assert_eq!(query.clone().validate(), None, "{query:?}");
    }
    assert!(CatalogQuery::Search {
        query: "x".repeat(MAX_QUERY_CHARS),
        content_type: Some("live".into()),
        limit: 1
    }
    .validate()
    .is_some());
}

#[test]
fn an_older_targets_item_has_no_series_and_none_goes_out() {
    // As a target from before `seriesId` sends it.
    let item: CatalogItem = serde_json::from_str(
        r#"{"id":"xt-ep-9-s1-2","name":"Pilot","contentType":"series","group":"Drama","season":1,"episode":2}"#,
    )
    .unwrap();
    assert_eq!(item.series_id, None);
    assert!(!serde_json::to_string(&item).unwrap().contains("seriesId"));
    let named = CatalogItem {
        series_id: Some("xt-series-9".into()),
        ..item
    };
    let json = serde_json::to_string(&named).unwrap();
    assert!(json.contains(r#""seriesId":"xt-series-9""#), "{json}");
}
