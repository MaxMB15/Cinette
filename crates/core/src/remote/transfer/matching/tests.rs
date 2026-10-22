// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn tag(n: u8) -> AccountTag {
    AccountTag::try_from(format!("{n:02x}").repeat(16)).unwrap()
}

fn provider(id: &str, account: Option<u8>, xtream: bool) -> DestProvider {
    DestProvider {
        id: id.into(),
        account: account.map(tag),
        xtream,
    }
}

fn channel(id: &str, provider_id: &str, name: &str, content_type: &str) -> DestChannel {
    DestChannel {
        id: id.into(),
        provider_id: provider_id.into(),
        name: name.into(),
        content_type: content_type.into(),
        group: "All".into(),
        ..DestChannel::default()
    }
}

fn live(id: &str, provider_id: &str, name: &str, tvg: Option<&str>) -> DestChannel {
    DestChannel {
        tvg_id: tvg.map(Into::into),
        ..channel(id, provider_id, name, "live")
    }
}

fn episode(id: &str, provider_id: &str, show: &str, season: u32, ep: u32) -> DestChannel {
    DestChannel {
        series_title: Some(show.into()),
        season: Some(season),
        episode: Some(ep),
        ..channel(
            id,
            provider_id,
            &format!("{show} S{season:02}E{ep:02}"),
            "series",
        )
    }
}

fn reference(kind: ItemKind, name: &str) -> ItemRef {
    ItemRef::named(kind, name)
}

fn from(account: u8, panel: &str, r: ItemRef) -> ItemRef {
    ItemRef {
        account: Some(tag(account)),
        panel_id: Some(panel.into()),
        ..r
    }
}

fn found_id(index: &Index, r: &ItemRef) -> Result<Option<String>, Miss> {
    index.find(r).map(|f| f.channel.map(|c| c.id))
}

#[test]
fn the_same_account_and_panel_id_wins_over_the_name() {
    let index = Index::new(
        &[
            provider("xt-a", Some(1), true),
            provider("xt-b", Some(2), true),
        ],
        vec![
            live("xt-a-live-5", "xt-a", "BBC One HD", None),
            live("xt-b-live-5", "xt-b", "Renamed", None),
        ],
    );
    let r = from(2, "live-5", reference(ItemKind::Live, "BBC One HD"));
    assert_eq!(found_id(&index, &r), Ok(Some("xt-b-live-5".into())));
}

#[test]
fn panel_ids_only_count_for_xtream() {
    let index = Index::new(
        &[provider("m3u-a", Some(1), false)],
        vec![live("m3u-a-live-5", "m3u-a", "Other", None)],
    );
    let r = from(1, "live-5", reference(ItemKind::Live, "BBC One"));
    assert_eq!(found_id(&index, &r), Err(Miss::Missing));
}

#[test]
fn a_panel_id_under_another_account_isnt_the_same_item() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![channel("xt-a-movie-8", "xt-a", "Alien", "movie")],
    );
    let r = from(2, "movie-8", reference(ItemKind::Movie, "Heat"));
    assert_eq!(found_id(&index, &r), Err(Miss::Missing));
}

#[test]
fn the_same_account_and_name_finds_an_m3u_channel() {
    let index = Index::new(
        &[
            provider("m3u-a", Some(1), false),
            provider("m3u-b", Some(2), false),
        ],
        vec![
            live("m3u-a-ch-1", "m3u-a", "Sky News", None),
            live("m3u-b-ch-9", "m3u-b", "sky  news", None),
        ],
    );
    let r = ItemRef {
        account: Some(tag(2)),
        ..reference(ItemKind::Live, "Sky News")
    };
    assert_eq!(found_id(&index, &r), Ok(Some("m3u-b-ch-9".into())));
}

#[test]
fn the_same_name_twice_in_one_account_is_ambiguous() {
    let index = Index::new(
        &[provider("m3u-a", Some(1), false)],
        vec![
            live("m3u-a-ch-1", "m3u-a", "Sky News", None),
            live("m3u-a-ch-2", "m3u-a", "Sky News", None),
        ],
    );
    let r = ItemRef {
        account: Some(tag(1)),
        ..reference(ItemKind::Live, "Sky News")
    };
    assert_eq!(found_id(&index, &r), Err(Miss::Ambiguous));
}

#[test]
fn a_live_channel_matches_by_tvg_id_and_name_then_tvg_id_alone() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![
            live("m3u-a-ch-1", "m3u-a", "BBC One", Some("bbc1.uk")),
            live("m3u-a-ch-2", "m3u-a", "BBC One HD", Some("bbc1.uk")),
            live("m3u-a-ch-3", "m3u-a", "CNN", Some("cnn.us")),
        ],
    );
    let by_both = ItemRef {
        tvg_id: Some("bbc1.uk".into()),
        ..reference(ItemKind::Live, "BBC ONE HD")
    };
    assert_eq!(found_id(&index, &by_both), Ok(Some("m3u-a-ch-2".into())));
    let by_tvg = ItemRef {
        tvg_id: Some("cnn.us".into()),
        ..reference(ItemKind::Live, "CNN International")
    };
    assert_eq!(found_id(&index, &by_tvg), Ok(Some("m3u-a-ch-3".into())));
    let two = ItemRef {
        tvg_id: Some("bbc1.uk".into()),
        ..reference(ItemKind::Live, "BBC 1")
    };
    assert_eq!(found_id(&index, &two), Err(Miss::Ambiguous));
}

#[test]
fn a_blank_tvg_id_matches_nothing() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![live("m3u-a-ch-1", "m3u-a", "A", Some(" "))],
    );
    let r = ItemRef {
        tvg_id: Some(" ".into()),
        ..reference(ItemKind::Live, "A")
    };
    assert_eq!(found_id(&index, &r), Err(Miss::Missing));
}

#[test]
fn a_live_channel_never_matches_by_name_alone() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![live("m3u-a-ch-1", "m3u-a", "News", None)],
    );
    assert_eq!(
        found_id(&index, &reference(ItemKind::Live, "News")),
        Err(Miss::Missing)
    );
}

#[test]
fn copies_in_two_providers_narrow_to_the_one_with_the_account() {
    let index = Index::new(
        &[
            provider("m3u-a", Some(1), false),
            provider("m3u-b", Some(2), false),
        ],
        vec![
            live("m3u-a-ch-1", "m3u-a", "BBC One", Some("bbc1.uk")),
            live("m3u-b-ch-1", "m3u-b", "BBC One", Some("bbc1.uk")),
        ],
    );
    let r = ItemRef {
        tvg_id: Some("bbc1.uk".into()),
        account: Some(tag(2)),
        ..reference(ItemKind::Live, "BBC 1")
    };
    assert_eq!(found_id(&index, &r), Ok(Some("m3u-b-ch-1".into())));
    let elsewhere = ItemRef {
        account: Some(tag(3)),
        ..r
    };
    assert_eq!(found_id(&index, &elsewhere), Err(Miss::Ambiguous));
}

#[test]
fn a_movie_matches_by_imdb_id_then_title() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![
            DestChannel {
                imdb: Some("tt1".into()),
                ..channel("m3u-a-ch-1", "m3u-a", "Dune: Part One", "movie")
            },
            channel("m3u-a-ch-2", "m3u-a", "Heat", "movie"),
        ],
    );
    let by_imdb = ItemRef {
        imdb: Some("tt1".into()),
        ..reference(ItemKind::Movie, "Dune (2021)")
    };
    let found = index.find(&by_imdb).unwrap();
    assert_eq!(found.channel.unwrap().id, "m3u-a-ch-1");
    assert_eq!(found.key.as_deref(), Some("movie:dune: part one"));
    assert_eq!(
        found_id(&index, &reference(ItemKind::Movie, " heat ")),
        Ok(Some("m3u-a-ch-2".into()))
    );
    assert_eq!(
        found_id(&index, &reference(ItemKind::Movie, "Heat 2")),
        Err(Miss::Missing)
    );
}

#[test]
fn an_unknown_imdb_id_falls_back_to_the_title() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![channel("m3u-a-ch-2", "m3u-a", "Heat", "movie")],
    );
    let r = ItemRef {
        imdb: Some("tt9".into()),
        ..reference(ItemKind::Movie, "Heat")
    };
    assert_eq!(found_id(&index, &r), Ok(Some("m3u-a-ch-2".into())));
    let empty = ItemRef {
        imdb: Some(String::new()),
        ..reference(ItemKind::Movie, "Heat")
    };
    assert_eq!(found_id(&index, &empty), Ok(Some("m3u-a-ch-2".into())));
}

#[test]
fn an_empty_imdb_id_on_the_destination_isnt_indexed() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![DestChannel {
            imdb: Some(String::new()),
            ..channel("m3u-a-ch-1", "m3u-a", "A", "movie")
        }],
    );
    let r = ItemRef {
        imdb: Some(String::new()),
        ..reference(ItemKind::Movie, "B")
    };
    assert_eq!(found_id(&index, &r), Err(Miss::Missing));
}

#[test]
fn two_movies_with_one_title_place_only_the_position() {
    // One film listed twice: no single channel for a row, but both resume
    // under the same key.
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![
            channel("m3u-a-ch-1", "m3u-a", "Heat", "movie"),
            channel("m3u-a-ch-2", "m3u-a", "HEAT", "movie"),
        ],
    );
    assert_eq!(
        index.find(&reference(ItemKind::Movie, "Heat")),
        Ok(Found {
            channel: None,
            key: Some("movie:heat".into()),
            why: Miss::Ambiguous,
        })
    );
}

#[test]
fn items_with_different_keys_stay_ambiguous() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![
            live("m3u-a-ch-1", "m3u-a", "BBC One", Some("bbc1.uk")),
            live("m3u-a-ch-2", "m3u-a", "BBC One HD", Some("bbc1.uk")),
        ],
    );
    // Live channels have no key, so nothing is placed.
    let r = ItemRef {
        tvg_id: Some("bbc1.uk".into()),
        ..reference(ItemKind::Live, "BBC 1")
    };
    assert_eq!(index.find(&r), Err(Miss::Ambiguous));
    let shows = Index::new(
        &[provider("m3u-a", None, false)],
        vec![
            channel("m3u-a-ch-1", "m3u-a", "Lost", "series"),
            channel("m3u-a-ch-2", "m3u-a", "LOST", "series"),
        ],
    );
    assert_eq!(
        shows.find(&reference(ItemKind::Series, "Lost")),
        Err(Miss::Ambiguous)
    );
}

#[test]
fn a_title_with_another_imdb_id_isnt_the_same_film() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![
            DestChannel {
                imdb: Some("tt2".into()),
                ..channel("m3u-a-ch-1", "m3u-a", "The Office", "series")
            },
            DestChannel {
                imdb: Some("tt3".into()),
                ..channel("m3u-a-ch-2", "m3u-a", "Heat", "movie")
            },
            channel("m3u-a-ch-3", "m3u-a", "Heat", "movie"),
        ],
    );
    let office = ItemRef {
        imdb: Some("tt1".into()),
        ..reference(ItemKind::Series, "The Office")
    };
    assert_eq!(index.find(&office), Err(Miss::Missing));
    // A copy with no IMDb id may still be it; one with another id isn't.
    let heat = ItemRef {
        imdb: Some("tt1".into()),
        ..reference(ItemKind::Movie, "Heat")
    };
    assert_eq!(found_id(&index, &heat), Ok(Some("m3u-a-ch-3".into())));
}

#[test]
fn an_imdb_id_doesnt_narrow_live_channels() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![DestChannel {
            imdb: Some("tt2".into()),
            ..live("m3u-a-ch-1", "m3u-a", "CNN", Some("cnn.us"))
        }],
    );
    let r = ItemRef {
        tvg_id: Some("cnn.us".into()),
        imdb: Some("tt1".into()),
        ..reference(ItemKind::Live, "CNN")
    };
    assert_eq!(found_id(&index, &r), Ok(Some("m3u-a-ch-1".into())));
}

#[test]
fn a_downloaded_episode_isnt_counted_twice() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![
            DestChannel {
                provider_id: DOWNLOADS_PROVIDER.into(),
                ..episode("xt-a-xt-ep-42-s1-0", "xt-a", "Lost", 1, 1)
            },
            DestChannel {
                show: Some("xt-a-series-42".into()),
                ..episode("xt-a-xt-ep-42-s1-0", "xt-a", "Lost", 1, 1)
            },
            DestChannel {
                provider_id: DOWNLOADS_PROVIDER.into(),
                ..episode("xt-a-xt-ep-42-s1-1", "xt-a", "Lost", 1, 2)
            },
            DestChannel {
                provider_id: DOWNLOADS_PROVIDER.into(),
                ..episode("xt-a-xt-ep-42-s1-1", "xt-a", "Lost", 1, 2)
            },
        ],
    );
    let found = index.find(&episode_ref("Lost", 1, 1)).unwrap();
    assert_eq!(found.channel.unwrap().provider_id, "xt-a");
    assert!(index
        .find(&episode_ref("Lost", 1, 2))
        .unwrap()
        .channel
        .is_some());
}

#[test]
fn a_show_whose_saved_list_lacks_the_episode_has_no_place_for_it() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![
            channel("xt-a-series-42", "xt-a", "Lost", "series"),
            DestChannel {
                show: Some("xt-a-series-42".into()),
                ..episode("xt-a-xt-ep-42-s1-0", "xt-a", "Lost", 1, 1)
            },
        ],
    );
    assert_eq!(index.find(&episode_ref("Lost", 1, 5)), Err(Miss::Missing));
    // In the same account, the id made from the show isn't trusted either.
    let r = from(1, "xt-ep-42-s1-4", episode_ref("Lost", 1, 5));
    assert_eq!(index.find(&r), Err(Miss::Missing));
}

#[test]
fn kinds_dont_mix() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![
            channel("m3u-a-ch-1", "m3u-a", "Heat", "series"),
            channel("m3u-a-ch-2", "m3u-a", "Other", "radio"),
        ],
    );
    assert_eq!(
        found_id(&index, &reference(ItemKind::Movie, "Heat")),
        Err(Miss::Missing)
    );
    assert_eq!(
        found_id(&index, &reference(ItemKind::Series, "Heat")),
        Ok(Some("m3u-a-ch-1".into()))
    );
}

#[test]
fn a_show_has_no_position_key() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![channel("m3u-a-ch-1", "m3u-a", "Heat", "series")],
    );
    assert_eq!(
        index
            .find(&reference(ItemKind::Series, "Heat"))
            .unwrap()
            .key,
        None
    );
}

#[test]
fn a_live_channel_has_no_position_key() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![live("xt-a-live-1", "xt-a", "A", None)],
    );
    let r = from(1, "live-1", reference(ItemKind::Live, "A"));
    assert_eq!(index.find(&r).unwrap().key, None);
}

fn episode_ref(show: &str, season: u32, ep: u32) -> ItemRef {
    ItemRef {
        series: Some(show.into()),
        season: Some(season),
        episode: Some(ep),
        ..reference(
            ItemKind::Episode,
            &format!("{show} S{season:02}E{ep:02} Pilot"),
        )
    }
}

#[test]
fn an_episode_matches_by_its_show_season_and_number() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![
            episode("m3u-a-ch-1", "m3u-a", "The Office", 1, 1),
            episode("m3u-a-ch-2", "m3u-a", "The Office", 1, 2),
        ],
    );
    let found = index.find(&episode_ref("the office", 1, 2)).unwrap();
    assert_eq!(found.channel.unwrap().id, "m3u-a-ch-2");
    assert_eq!(found.key.as_deref(), Some("series:the office:s1e2"));
    assert_eq!(
        found_id(&index, &episode_ref("The Office", 2, 1)),
        Err(Miss::Missing)
    );
}

#[test]
fn an_episode_without_numbers_matches_only_by_panel_id() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![episode("m3u-a-ch-1", "m3u-a", "The Office", 1, 1)],
    );
    let r = ItemRef {
        series: Some("The Office".into()),
        ..reference(ItemKind::Episode, "The Office S01E01")
    };
    assert_eq!(found_id(&index, &r), Err(Miss::Missing));
}

#[test]
fn an_episode_in_a_saved_list_matches_by_panel_id() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![
            channel("xt-a-series-42", "xt-a", "Lost", "series"),
            episode("xt-a-xt-ep-42-s1-3", "xt-a", "Lost", 1, 4),
        ],
    );
    let r = from(1, "xt-ep-42-s1-3", episode_ref("Lost", 1, 4));
    let found = index.find(&r).unwrap();
    assert_eq!(found.channel.unwrap().id, "xt-a-xt-ep-42-s1-3");
    assert_eq!(found.key.as_deref(), Some("series:lost:s1e4"));
}

#[test]
fn an_episode_of_a_show_in_the_same_account_is_found_without_its_list() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![DestChannel {
            logo: Some("http://img.example/lost.png".into()),
            group: "Drama".into(),
            ..channel("xt-a-series-42", "xt-a", "Lost (2004)", "series")
        }],
    );
    let r = from(1, "xt-ep-42-s1-3", episode_ref("Lost", 1, 4));
    let found = index.find(&r).unwrap();
    assert_eq!(
        found.channel,
        Some(DestChannel {
            id: "xt-a-xt-ep-42-s1-3".into(),
            provider_id: "xt-a".into(),
            // Named from this device's show, never from the other's text.
            name: "Lost (2004) S01E04".into(),
            content_type: "series".into(),
            group: "Drama".into(),
            logo: Some("http://img.example/lost.png".into()),
            tvg_id: None,
            // The panel's own name for the show, as the player keys it.
            series_title: Some("Lost".into()),
            season: Some(1),
            episode: Some(4),
            imdb: None,
            show: Some("xt-a-series-42".into()),
        })
    );
    assert_eq!(found.key.as_deref(), Some("series:lost:s1e4"));
    let no_numbers = ItemRef {
        season: None,
        episode: None,
        ..r.clone()
    };
    assert_eq!(index.find(&no_numbers), Err(Miss::Missing));
    let other_season = ItemRef {
        season: Some(2),
        ..r.clone()
    };
    assert_eq!(index.find(&other_season), Err(Miss::Missing));
    let no_show_title = ItemRef { series: None, ..r };
    assert_eq!(
        index.find(&no_show_title).unwrap().key.as_deref(),
        Some("series:lost (2004):s1e4")
    );
}

#[test]
fn an_episode_panel_id_under_another_account_or_show_finds_nothing() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![channel("xt-a-series-42", "xt-a", "Lost", "series")],
    );
    let other_account = from(
        2,
        "xt-ep-42-s1-3",
        reference(ItemKind::Episode, "Lost S01E04"),
    );
    assert_eq!(found_id(&index, &other_account), Err(Miss::Missing));
    let other_show = from(
        1,
        "xt-ep-43-s1-3",
        reference(ItemKind::Episode, "Lost S01E04"),
    );
    assert_eq!(found_id(&index, &other_show), Err(Miss::Missing));
    let not_an_episode = from(1, "series-42", reference(ItemKind::Episode, "Lost S01E04"));
    assert_eq!(found_id(&index, &not_an_episode), Err(Miss::Missing));
}

#[test]
fn an_episode_whose_show_alone_is_found_gets_only_a_key() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![channel("xt-a-series-42", "xt-a", "Lost", "series")],
    );
    let found = index.find(&episode_ref("LOST", 2, 5)).unwrap();
    assert_eq!(found.channel, None);
    assert_eq!(found.key.as_deref(), Some("series:lost:s2e5"));
}

#[test]
fn an_episode_of_two_shows_with_one_title_is_ambiguous() {
    let index = Index::new(
        &[provider("xt-a", Some(1), true)],
        vec![
            channel("xt-a-series-42", "xt-a", "Lost", "series"),
            channel("xt-a-series-43", "xt-a", "Lost", "series"),
        ],
    );
    assert_eq!(
        found_id(&index, &episode_ref("Lost", 1, 1)),
        Err(Miss::Ambiguous)
    );
}

#[test]
fn an_episode_listed_twice_places_only_its_position_unless_one_has_the_account() {
    let index = Index::new(
        &[
            provider("m3u-a", Some(1), false),
            provider("m3u-b", Some(2), false),
        ],
        vec![
            episode("m3u-a-ch-1", "m3u-a", "Lost", 1, 1),
            episode("m3u-b-ch-1", "m3u-b", "Lost", 1, 1),
        ],
    );
    let found = index.find(&episode_ref("Lost", 1, 1)).unwrap();
    assert_eq!(found.channel, None);
    assert_eq!(found.key.as_deref(), Some("series:lost:s1e1"));
    let r = ItemRef {
        account: Some(tag(2)),
        ..episode_ref("Lost", 1, 1)
    };
    assert_eq!(found_id(&index, &r), Ok(Some("m3u-b-ch-1".into())));
}

#[test]
fn an_episode_isnt_matched_by_its_name_within_the_account() {
    let index = Index::new(
        &[provider("m3u-a", Some(1), false)],
        vec![episode("m3u-a-ch-1", "m3u-a", "Lost", 1, 1)],
    );
    let r = ItemRef {
        account: Some(tag(1)),
        ..reference(ItemKind::Episode, "Lost S01E01")
    };
    assert_eq!(found_id(&index, &r), Err(Miss::Missing));
}

#[test]
fn an_episode_without_a_show_title_uses_its_name() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![DestChannel {
            series_title: None,
            ..episode("m3u-a-ch-1", "m3u-a", "Lost", 1, 1)
        }],
    );
    let r = episode_ref("Lost S01E01", 1, 1);
    assert_eq!(found_id(&index, &r), Ok(Some("m3u-a-ch-1".into())));
}

#[test]
fn providers_and_groups_are_known_by_account() {
    let index = Index::new(
        &[
            provider("xt-a", Some(1), true),
            provider("xt-b", Some(1), true),
            provider("m3u-c", None, false),
        ],
        vec![DestChannel {
            group: "News".into(),
            ..live("xt-a-live-1", "xt-a", "A", None)
        }],
    );
    assert_eq!(index.providers_of(&tag(1)), ["xt-a", "xt-b"]);
    assert!(index.providers_of(&tag(2)).is_empty());
    assert!(index.has_group("xt-a", "live", "News"));
    assert!(!index.has_group("xt-b", "live", "News"));
    assert!(!index.has_group("xt-a", "movie", "News"));
    assert!(!index.has_group("xt-a", "live", "news"));
}

#[test]
fn a_channel_of_a_provider_without_an_account_still_matches_by_its_keys() {
    let index = Index::new(
        &[provider("m3u-file", None, false)],
        vec![channel("m3u-file-ch-1", "m3u-file", "Heat", "movie")],
    );
    let r = ItemRef {
        account: Some(tag(1)),
        ..reference(ItemKind::Movie, "Heat")
    };
    assert_eq!(found_id(&index, &r), Ok(Some("m3u-file-ch-1".into())));
}

#[test]
fn a_series_entry_without_an_episode_number_is_a_show() {
    let index = Index::new(
        &[provider("m3u-a", None, false)],
        vec![DestChannel {
            season: Some(1),
            ..channel("m3u-a-ch-1", "m3u-a", "Lost", "series")
        }],
    );
    assert_eq!(
        found_id(&index, &reference(ItemKind::Series, "Lost")),
        Ok(Some("m3u-a-ch-1".into()))
    );
}
