// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::message::Capabilities;
use crate::remote::tests::{item, playing};

fn seek_to(id: &str, to: f64) -> Command {
    Command::Seek {
        item_id: id.into(),
        to: Some(to),
        by: None,
    }
}

#[test]
fn commands_for_the_current_item_pass() {
    let state = playing("m", 10.0);
    for command in [
        Command::Load {
            item_id: "other".into(),
            start_at: Some(30.0),
        },
        Command::Play {
            item_id: "m".into(),
        },
        Command::Pause {
            item_id: "m".into(),
        },
        seek_to("m", 0.0),
        Command::Seek {
            item_id: "m".into(),
            to: None,
            by: Some(-30.0),
        },
        Command::Volume { value: 100 },
        Command::Volume { value: 0 },
        Command::Subtitle {
            item_id: "m".into(),
            track_id: Some("en".into()),
        },
        Command::Subtitle {
            item_id: "m".into(),
            track_id: None,
        },
        Command::Audio {
            item_id: "m".into(),
            track_id: "1".into(),
        },
        Command::Stop,
    ] {
        assert_eq!(validate(&command, &state), Ok(()), "{command:?}");
    }
}

#[test]
fn bad_fields_are_invalid() {
    let state = playing("m", 10.0);
    for command in [
        Command::Load {
            item_id: String::new(),
            start_at: None,
        },
        Command::Load {
            item_id: "x".repeat(257),
            start_at: None,
        },
        Command::Load {
            item_id: "m".into(),
            start_at: Some(-1.0),
        },
        Command::Load {
            item_id: "m".into(),
            start_at: Some(f64::NAN),
        },
        Command::Load {
            item_id: "m".into(),
            start_at: Some(f64::INFINITY),
        },
        seek_to("m", -1.0),
        seek_to("m", f64::NAN),
        Command::Seek {
            item_id: "m".into(),
            to: None,
            by: None,
        },
        Command::Seek {
            item_id: "m".into(),
            to: Some(1.0),
            by: Some(1.0),
        },
        Command::Seek {
            item_id: "m".into(),
            to: None,
            by: Some(86_401.0),
        },
        Command::Seek {
            item_id: "m".into(),
            to: None,
            by: Some(f64::NEG_INFINITY),
        },
        Command::Volume { value: 101 },
        Command::Play {
            item_id: String::new(),
        },
    ] {
        assert_eq!(
            validate(&command, &state),
            Err(ErrorCode::Invalid),
            "{command:?}"
        );
    }
    assert_eq!(
        validate(
            &Command::Load {
                item_id: "x".repeat(256),
                start_at: None
            },
            &state
        ),
        Ok(())
    );
    assert_eq!(
        validate(
            &Command::Load {
                item_id: "m".into(),
                start_at: Some(0.0)
            },
            &state
        ),
        Ok(())
    );
    assert_eq!(
        validate(
            &Command::Seek {
                item_id: "m".into(),
                to: None,
                by: Some(86_400.0)
            },
            &state
        ),
        Ok(())
    );
}

#[test]
fn commands_for_another_item_are_stale() {
    let state = playing("m", 10.0);
    for command in [
        Command::Play {
            item_id: "old".into(),
        },
        Command::Pause {
            item_id: "old".into(),
        },
        seek_to("old", 1.0),
        Command::Subtitle {
            item_id: "old".into(),
            track_id: None,
        },
        Command::Audio {
            item_id: "old".into(),
            track_id: "1".into(),
        },
    ] {
        assert_eq!(
            validate(&command, &state),
            Err(ErrorCode::StaleItem),
            "{command:?}"
        );
    }
    let idle = PlaybackSnapshot::default();
    assert_eq!(
        validate(
            &Command::Play {
                item_id: "m".into()
            },
            &idle
        ),
        Err(ErrorCode::StaleItem)
    );
    assert_eq!(validate(&Command::Stop, &idle), Ok(()));
}

#[test]
fn what_the_player_cant_do_is_unsupported() {
    let mut state = playing("m", 10.0);
    state.capabilities = Capabilities::default();
    for command in [
        Command::Load {
            item_id: "m".into(),
            start_at: Some(5.0),
        },
        Command::Pause {
            item_id: "m".into(),
        },
        seek_to("m", 1.0),
        Command::Volume { value: 5 },
        Command::Subtitle {
            item_id: "m".into(),
            track_id: None,
        },
        Command::Audio {
            item_id: "m".into(),
            track_id: "1".into(),
        },
    ] {
        assert_eq!(
            validate(&command, &state),
            Err(ErrorCode::Unsupported),
            "{command:?}"
        );
    }
    assert_eq!(
        validate(
            &Command::Load {
                item_id: "m".into(),
                start_at: None
            },
            &state
        ),
        Ok(())
    );
}

#[test]
fn unknown_tracks_are_not_found() {
    let state = playing("m", 10.0);
    assert_eq!(
        validate(
            &Command::Subtitle {
                item_id: "m".into(),
                track_id: Some("fr".into())
            },
            &state
        ),
        Err(ErrorCode::NotFound)
    );
    assert_eq!(
        validate(
            &Command::Audio {
                item_id: "m".into(),
                track_id: "9".into()
            },
            &state
        ),
        Err(ErrorCode::NotFound)
    );
}

#[test]
fn a_page_that_fits_goes_out_whole() {
    let items: Vec<_> = (0..10).map(|i| item(&format!("i{i}"))).collect();
    let Message::CatalogPage {
        items: sent,
        next,
        re,
    } = fit_page(4, items.clone(), Some("10".into()))
    else {
        panic!()
    };
    assert_eq!((re, sent, next), (4, items, Some("10".into())));
}

#[test]
fn a_page_too_big_for_a_frame_is_cut_and_points_at_the_rest() {
    let big = |i: usize| CatalogItem {
        name: "x".repeat(1000),
        ..item(&format!("i{i}"))
    };
    let items: Vec<_> = (0..100).map(big).collect();
    let Message::CatalogPage {
        items: sent, next, ..
    } = fit_page(1, items, None)
    else {
        panic!()
    };
    assert!(sent.len() < 100 && !sent.is_empty());
    assert_eq!(next, Some(format!("i{}", sent.len())));
    let encoded = message::encode(&Message::CatalogPage {
        re: 1,
        items: sent,
        next,
    });
    assert!(encoded.len() <= message::MAX_MESSAGE);
}

#[test]
fn more_than_a_page_of_items_is_cut_to_a_page() {
    let items: Vec<_> = (0..150).map(|i| item(&format!("i{i}"))).collect();
    let Message::CatalogPage { items: sent, .. } = fit_page(1, items, None) else {
        panic!()
    };
    assert_eq!(sent.len(), crate::remote::catalog::MAX_PAGE);
}

#[test]
fn an_item_too_big_for_any_frame_fails() {
    let huge = CatalogItem {
        name: "x".repeat(70_000),
        ..item("i")
    };
    assert_eq!(
        fit_page(2, vec![huge], None),
        Message::Error {
            re: Some(2),
            code: ErrorCode::Failed
        }
    );
}

#[test]
fn a_renamed_device_is_advertised_again() {
    let mut target = Target::new(
        DeviceKey::generate(),
        DeviceType::Mac,
        RemoteSettings::default(),
    );
    let actions = target.update_settings(
        RemoteSettings {
            device_name: Some("Studio".into()),
            ..RemoteSettings::default()
        },
        Instant::now(),
    );
    let [Action::Advertise(Some(record))] = actions.as_slice() else {
        panic!("{actions:?}")
    };
    assert_eq!(record.instance, "Studio");
    assert!(record.txt.contains(&("n".into(), "Studio".into())));
    // The same settings again change nothing.
    let same = target.settings().clone();
    assert!(target.update_settings(same, Instant::now()).is_empty());
}

#[test]
fn connections_beyond_the_handshake_limit_are_turned_away() {
    let mut target = Target::new(
        DeviceKey::generate(),
        DeviceType::Mac,
        RemoteSettings::default(),
    );
    let now = Instant::now();
    for _ in 0..MAX_HANDSHAKES {
        assert!(target.accept(now).is_some());
    }
    assert!(target.accept(now).is_none());
    assert_eq!(target.next_deadline(), Some(now + HANDSHAKE_TIMEOUT));
}

#[test]
fn a_frame_on_an_unknown_connection_is_ignored() {
    let mut target = Target::new(
        DeviceKey::generate(),
        DeviceType::Mac,
        RemoteSettings::default(),
    );
    assert!(target.receive(ConnId(7), b"x", Instant::now()).is_empty());
    assert!(target.disconnected(ConnId(7), Instant::now()).is_empty());
}
