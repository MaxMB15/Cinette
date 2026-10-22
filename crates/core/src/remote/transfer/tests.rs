// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn item(watched: bool, position: bool, favorite: bool) -> Item {
    Item {
        reference: ItemRef::named(ItemKind::Movie, "Dune"),
        watched: watched.then_some(Watched {
            first_watched_at: 1,
            last_watched_at: 2,
            play_count: 1,
            watched_seconds: 60,
        }),
        position: position.then_some(Position {
            position: 30.0,
            duration: 100.0,
            updated_at: 2,
            finished: false,
        }),
        favorite,
    }
}

fn pin() -> Pin {
    Pin {
        account: AccountTag::try_from("00".repeat(16)).unwrap(),
        content_type: "live".into(),
        group: "News".into(),
    }
}

fn export() -> Export {
    Export {
        items: vec![
            item(true, true, false),
            item(true, false, true),
            item(false, false, true),
            item(false, true, false),
        ],
        pins: vec![pin()],
        current: Some(ItemRef::named(ItemKind::Movie, "Dune")),
        sent_at: 9,
        ..Export::default()
    }
}

#[test]
fn counts_each_part() {
    assert_eq!(
        export().counts(),
        Counts {
            history: 2,
            positions: 2,
            favorites: 2,
            pins: 1,
        }
    );
}

#[test]
fn everything_keeps_everything() {
    assert_eq!(export().only(What::ALL), export());
}

#[test]
fn without_history_positions_and_current_go() {
    let only = export().only(What {
        history: false,
        ..What::ALL
    });
    assert_eq!(
        only.items,
        vec![item(false, false, true), item(false, false, true)]
    );
    assert_eq!(only.pins, vec![pin()]);
    assert_eq!(only.current, None);
}

#[test]
fn without_favorites_or_pins_they_go() {
    let only = export().only(What {
        history: true,
        favorites: false,
        pins: false,
    });
    assert_eq!(
        only.items,
        vec![
            item(true, true, false),
            item(true, false, false),
            item(false, true, false),
        ]
    );
    assert!(only.pins.is_empty());
    assert!(only.current.is_some());
}

#[test]
fn nothing_asked_is_empty() {
    assert!(What::default().is_empty());
    for what in [
        What {
            history: true,
            ..What::default()
        },
        What {
            favorites: true,
            ..What::default()
        },
        What {
            pins: true,
            ..What::default()
        },
    ] {
        assert!(!what.is_empty());
    }
}

#[test]
fn an_item_reads_back_from_json_with_short_fields_left_out() {
    let json = serde_json::to_value(item(false, false, false)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "ref": { "kind": "movie", "name": "Dune" } })
    );
    let full = item(true, true, true);
    let back: Item = serde_json::from_value(serde_json::to_value(&full).unwrap()).unwrap();
    assert_eq!(back, full);
}
