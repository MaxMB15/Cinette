// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::transfer::matching::DestProvider;
use crate::remote::transfer::{Item, ItemRef, Pin};

fn watched(first: i64, last: i64, plays: i64, seconds: i64) -> Watched {
    Watched {
        first_watched_at: first,
        last_watched_at: last,
        play_count: plays,
        watched_seconds: seconds,
    }
}

fn at(position: f64, updated_at: i64) -> Position {
    Position {
        position,
        duration: 3000.0,
        updated_at,
        finished: false,
    }
}

#[test]
fn clocks_within_a_minute_are_the_same() {
    assert_eq!(clock_offset(1000, 1000), 0);
    assert_eq!(clock_offset(1000, 1060), 0);
    assert_eq!(clock_offset(1060, 1000), 0);
    assert_eq!(clock_offset(1000, 1061), 61);
    assert_eq!(clock_offset(1061, 1000), -61);
    assert_eq!(clock_offset(i64::MIN, i64::MAX), i64::MAX);
}

#[test]
fn new_history_is_added() {
    assert_eq!(
        merge_watched(None, watched(1, 2, 3, 4)),
        Some(watched(1, 2, 3, 4))
    );
}

#[test]
fn history_takes_the_wider_span_and_the_larger_counts() {
    assert_eq!(
        merge_watched(Some(watched(10, 20, 5, 100)), watched(5, 30, 2, 300)),
        Some(watched(5, 30, 5, 300))
    );
    assert_eq!(
        merge_watched(Some(watched(5, 30, 2, 300)), watched(10, 20, 5, 100)),
        Some(watched(5, 30, 5, 300))
    );
}

#[test]
fn history_already_covered_is_unchanged() {
    assert_eq!(
        merge_watched(Some(watched(5, 30, 5, 300)), watched(10, 20, 5, 100)),
        None
    );
    assert_eq!(
        merge_watched(Some(watched(5, 30, 5, 300)), watched(5, 30, 5, 300)),
        None
    );
}

#[test]
fn history_merged_twice_changes_nothing_the_second_time() {
    let mine = watched(10, 20, 5, 100);
    let theirs = watched(5, 30, 2, 300);
    let once = merge_watched(Some(mine), theirs).unwrap();
    assert_eq!(merge_watched(Some(once), theirs), None);
}

#[test]
fn the_newer_position_wins_even_when_it_is_earlier() {
    // A rewatch: the source started again, after the destination was further in.
    assert_eq!(
        merge_position(Some(at(2500.0, 100)), at(120.0, 200)),
        Some(at(120.0, 200))
    );
    assert_eq!(merge_position(Some(at(120.0, 200)), at(2500.0, 100)), None);
}

#[test]
fn a_tie_keeps_the_destinations_position() {
    assert_eq!(merge_position(Some(at(1.0, 100)), at(2.0, 100)), None);
    assert_eq!(merge_position(None, at(2.0, 100)), Some(at(2.0, 100)));
}

#[test]
fn a_newer_finish_replaces_a_partial_position() {
    let done = Position {
        finished: true,
        position: 3000.0,
        ..at(0.0, 300)
    };
    assert_eq!(merge_position(Some(at(1200.0, 200)), done), Some(done));
}

fn tag(n: u8) -> AccountTag {
    AccountTag::try_from(format!("{n:02x}").repeat(16)).unwrap()
}

fn movie(id: &str, name: &str) -> DestChannel {
    DestChannel {
        id: id.into(),
        provider_id: "xt-a".into(),
        name: name.into(),
        content_type: "movie".into(),
        group: "Films".into(),
        ..DestChannel::default()
    }
}

fn index() -> Index {
    Index::new(
        &[DestProvider {
            id: "xt-a".into(),
            account: Some(tag(1)),
            xtream: true,
        }],
        vec![
            movie("xt-a-movie-1", "Heat"),
            movie("xt-a-movie-2", "Alien"),
            movie("xt-a-movie-3", "Twin"),
            movie("xt-a-movie-4", "twin"),
            DestChannel {
                content_type: "series".into(),
                group: "Shows".into(),
                ..movie("xt-a-series-9", "Lost")
            },
        ],
    )
}

fn item(name: &str) -> Item {
    Item {
        reference: ItemRef::named(ItemKind::Movie, name),
        watched: None,
        position: None,
        favorite: false,
    }
}

fn export(items: Vec<Item>) -> Export {
    Export {
        items,
        ..Export::default()
    }
}

#[test]
fn a_plan_places_history_positions_and_favorites() {
    let heat = Item {
        watched: Some(watched(1, 2, 1, 60)),
        position: Some(at(600.0, 2)),
        favorite: true,
        ..item("Heat")
    };
    let plan = plan(&export(vec![heat]), &index(), 0);
    let row = &plan.history["xt-a-movie-1"];
    assert_eq!(row.channel.name, "Heat");
    assert_eq!(row.watched, watched(1, 2, 1, 60));
    assert_eq!(plan.positions["movie:heat"], at(600.0, 2));
    assert_eq!(plan.favorites.iter().collect::<Vec<_>>(), ["xt-a-movie-1"]);
    assert!(plan.unmatched.is_empty());
    assert_eq!(plan.unmatched_total, 0);
}

#[test]
fn a_plan_shifts_the_sources_times() {
    let heat = Item {
        watched: Some(watched(100, 200, 1, 60)),
        position: Some(at(600.0, 200)),
        ..item("Heat")
    };
    let plan = plan(&export(vec![heat]), &index(), -50);
    assert_eq!(
        plan.history["xt-a-movie-1"].watched,
        watched(50, 150, 1, 60)
    );
    assert_eq!(plan.positions["movie:heat"].updated_at, 150);
}

#[test]
fn items_that_find_the_same_thing_are_folded_together() {
    let one = Item {
        watched: Some(watched(10, 20, 2, 60)),
        position: Some(at(100.0, 20)),
        ..item("Heat")
    };
    let two = Item {
        watched: Some(watched(5, 15, 4, 30)),
        position: Some(at(900.0, 15)),
        favorite: true,
        ..item(" HEAT ")
    };
    let three = Item {
        watched: Some(watched(30, 30, 1, 10)),
        ..item("heat")
    };
    let plan = plan(&export(vec![one, two, three]), &index(), 0);
    assert_eq!(plan.history.len(), 1);
    assert_eq!(plan.history["xt-a-movie-1"].watched, watched(5, 30, 4, 60));
    assert_eq!(plan.positions["movie:heat"], at(100.0, 20));
    assert_eq!(plan.favorites.len(), 1);
}

#[test]
fn unmatched_items_are_listed_with_why() {
    let items = vec![
        Item {
            watched: Some(watched(1, 2, 1, 1)),
            ..item("Nowhere")
        },
        Item {
            favorite: true,
            ..item("Twin")
        },
    ];
    let plan = plan(&export(items), &index(), 0);
    assert_eq!(
        plan.unmatched,
        vec![
            Unmatched {
                name: "Nowhere".into(),
                kind: UnmatchedKind::Movie,
                reason: Miss::Missing,
            },
            Unmatched {
                name: "Twin".into(),
                kind: UnmatchedKind::Movie,
                reason: Miss::Ambiguous,
            },
        ]
    );
    assert_eq!(plan.unmatched_total, 2);
    assert!(plan.history.is_empty() && plan.favorites.is_empty());
}

#[test]
fn only_so_many_unmatched_items_are_listed() {
    let items = (0..MAX_UNMATCHED_LISTED + 5)
        .map(|i| Item {
            favorite: true,
            ..item(&format!("Missing {i}"))
        })
        .collect();
    let plan = plan(&export(items), &index(), 0);
    assert_eq!(plan.unmatched.len(), MAX_UNMATCHED_LISTED);
    assert_eq!(plan.unmatched_total as usize, MAX_UNMATCHED_LISTED + 5);
}

fn lost_episode(watched_row: bool, position: bool) -> Item {
    Item {
        reference: ItemRef {
            series: Some("Lost".into()),
            season: Some(1),
            episode: Some(2),
            ..ItemRef::named(ItemKind::Episode, "Lost S01E02")
        },
        watched: watched_row.then_some(watched(1, 2, 1, 60)),
        position: position.then_some(at(700.0, 2)),
        favorite: false,
    }
}

#[test]
fn an_episode_with_only_its_show_found_keeps_its_position() {
    let plan = plan(&export(vec![lost_episode(true, true)]), &index(), 0);
    assert_eq!(plan.positions["series:lost:s1e2"], at(700.0, 2));
    assert!(plan.history.is_empty());
    assert!(plan.unmatched.is_empty());
}

#[test]
fn an_episode_with_only_its_show_found_and_no_position_is_unmatched() {
    let plan = plan(&export(vec![lost_episode(true, false)]), &index(), 0);
    assert!(plan.positions.is_empty() && plan.history.is_empty());
    assert_eq!(
        plan.unmatched,
        vec![Unmatched {
            name: "Lost S01E02".into(),
            kind: UnmatchedKind::Episode,
            reason: Miss::Missing,
        }]
    );
}

#[test]
fn a_position_alone_needs_no_channel() {
    let plan = plan(&export(vec![lost_episode(false, true)]), &index(), 0);
    assert_eq!(plan.positions.len(), 1);
    assert!(plan.unmatched.is_empty());
}

fn pin(account: u8, content_type: &str, group: &str) -> Pin {
    Pin {
        account: tag(account),
        content_type: content_type.into(),
        group: group.into(),
    }
}

#[test]
fn pins_go_to_the_providers_with_the_account_and_group() {
    let index = Index::new(
        &[
            DestProvider {
                id: "xt-a".into(),
                account: Some(tag(1)),
                xtream: true,
            },
            DestProvider {
                id: "xt-b".into(),
                account: Some(tag(1)),
                xtream: true,
            },
        ],
        vec![
            movie("xt-a-movie-1", "Heat"),
            DestChannel {
                provider_id: "xt-b".into(),
                ..movie("xt-b-movie-1", "Heat")
            },
            DestChannel {
                group: "Kids".into(),
                ..movie("xt-a-movie-2", "Up")
            },
        ],
    );
    let export = Export {
        pins: vec![
            pin(1, "movie", "Kids"),
            pin(1, "movie", "Films"),
            pin(1, "movie", "Kids"),
            pin(2, "movie", "Films"),
            pin(1, "live", "Films"),
        ],
        ..Export::default()
    };
    let plan = plan(&export, &index, 0);
    let row = |p: &str, g: &str| PinRow {
        provider_id: p.into(),
        content_type: "movie".into(),
        group: g.into(),
    };
    assert_eq!(
        plan.pins,
        vec![
            row("xt-a", "Kids"),
            row("xt-a", "Films"),
            row("xt-b", "Films")
        ]
    );
    assert_eq!(
        plan.unmatched,
        vec![
            Unmatched {
                name: "Films".into(),
                kind: UnmatchedKind::PinnedGroup,
                reason: Miss::Missing,
            },
            Unmatched {
                name: "Films".into(),
                kind: UnmatchedKind::PinnedGroup,
                reason: Miss::Missing,
            },
        ]
    );
}

#[test]
fn the_sources_last_item_is_offered_to_resume() {
    let export = Export {
        current: Some(ItemRef::named(ItemKind::Movie, "Alien")),
        ..Export::default()
    };
    assert_eq!(
        plan(&export, &index(), 0).resume,
        Some(Resume {
            channel_id: "xt-a-movie-2".into(),
            name: "Alien".into(),
            position: None,
            key: Some("movie:alien".into()),
        })
    );
}

#[test]
fn nothing_is_offered_to_resume_without_a_single_channel() {
    for current in [
        ItemRef::named(ItemKind::Movie, "Twin"),
        lost_episode(false, false).reference,
    ] {
        let export = Export {
            current: Some(current),
            ..Export::default()
        };
        assert_eq!(plan(&export, &index(), 0).resume, None);
    }
}

#[test]
fn tallies_count_each_outcome() {
    let mut tally = Tally::default();
    for outcome in [
        Outcome::Added,
        Outcome::Updated,
        Outcome::Updated,
        Outcome::Unchanged,
        Outcome::Unchanged,
        Outcome::Unchanged,
    ] {
        tally.count(outcome);
    }
    assert_eq!(
        tally,
        Tally {
            added: 1,
            updated: 2,
            unchanged: 3,
        }
    );
    let mut full = Tally {
        added: u32::MAX,
        ..Tally::default()
    };
    full.count(Outcome::Added);
    assert_eq!(full.added, u32::MAX);
}

#[test]
fn unmatched_kinds_follow_item_kinds() {
    assert_eq!(UnmatchedKind::from(ItemKind::Live), UnmatchedKind::Live);
    assert_eq!(UnmatchedKind::from(ItemKind::Movie), UnmatchedKind::Movie);
    assert_eq!(UnmatchedKind::from(ItemKind::Series), UnmatchedKind::Series);
    assert_eq!(
        UnmatchedKind::from(ItemKind::Episode),
        UnmatchedKind::Episode
    );
}
