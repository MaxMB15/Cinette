// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::catalog::CatalogQuery;
use serde_json::json;

fn bytes(value: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&value).unwrap()
}

#[test]
fn every_message_carries_the_format_version() {
    let value: serde_json::Value = serde_json::from_slice(&encode(&Message::Ping)).unwrap();
    assert_eq!(value, json!({"v": 1, "type": "ping"}));
}

#[test]
fn messages_read_back() {
    let messages = [
        Message::Request {
            kind: RequestKind::Control,
            resume: Some("ab".into()),
        },
        Message::Pending { expires_in: 30 },
        Message::Closed {
            reason: CloseReason::NotDiscoverable,
        },
        Message::Command {
            id: 3,
            command: Command::Seek {
                item_id: "m".into(),
                to: None,
                by: Some(-10.0),
            },
        },
        Message::Command {
            id: 4,
            command: Command::Subtitle {
                item_id: "m".into(),
                track_id: None,
            },
        },
        Message::Catalog {
            id: 5,
            query: CatalogQuery::Groups {
                content_type: "live".into(),
            },
        },
        Message::State(VersionedState {
            epoch: "e".into(),
            version: 9,
            state: PlaybackSnapshot::default(),
        }),
        Message::Ok { re: 3, version: 9 },
        Message::Error {
            re: None,
            code: ErrorCode::StaleItem,
        },
    ];
    for message in messages {
        assert_eq!(decode(&encode(&message)).unwrap(), message);
    }
}

#[test]
fn the_wire_format_is_camel_case_with_snake_case_reasons() {
    let value: serde_json::Value = serde_json::from_slice(&encode(&Message::Command {
        id: 1,
        command: Command::Load {
            item_id: "live-1".into(),
            start_at: Some(5.0),
        },
    }))
    .unwrap();
    assert_eq!(
        value,
        json!({"v": 1, "type": "command", "id": 1, "command": {"action": "load", "itemId": "live-1", "startAt": 5.0}})
    );
    let value: serde_json::Value = serde_json::from_slice(&encode(&Message::Closed {
        reason: CloseReason::IdentityMismatch,
    }))
    .unwrap();
    assert_eq!(value["reason"], "identity_mismatch");
}

#[test]
fn unknown_fields_are_ignored() {
    let message = decode(&bytes(
        json!({"v": 1, "type": "pending", "expiresIn": 10, "later": true}),
    ))
    .unwrap();
    assert_eq!(message, Message::Pending { expires_in: 10 });
}

#[test]
fn an_unknown_type_is_told_apart_from_a_bad_one() {
    assert_eq!(
        decode(&bytes(json!({"v": 1, "type": "teleport", "id": 8}))),
        Err(DecodeError::UnknownType { id: Some(8) })
    );
    assert_eq!(
        decode(&bytes(
            json!({"v": 1, "type": "command", "id": 8, "command": {"action": "explode"}})
        )),
        Err(DecodeError::Invalid { id: Some(8) })
    );
}

#[test]
fn a_newer_format_or_no_version_is_refused() {
    assert_eq!(
        decode(&bytes(json!({"v": 2, "type": "ping"}))),
        Err(DecodeError::Version(2))
    );
    assert_eq!(
        decode(&bytes(json!({"type": "ping"}))),
        Err(DecodeError::Malformed)
    );
    assert_eq!(
        decode(&bytes(json!({"v": 0, "type": "ping"}))),
        Err(DecodeError::Malformed)
    );
    assert_eq!(decode(&bytes(json!([1, 2]))), Err(DecodeError::Malformed));
    assert_eq!(decode(b"not json"), Err(DecodeError::Malformed));
    assert_eq!(
        decode(&bytes(json!({"v": u64::MAX, "type": "ping"}))),
        Err(DecodeError::Version(u32::MAX))
    );
}

#[test]
fn known_types_match_the_message_enum() {
    let samples = [
        Message::Nonce {
            nonce: String::new(),
        },
        Message::Reveal {
            nonce: String::new(),
        },
        Message::Request {
            kind: RequestKind::Control,
            resume: None,
        },
        Message::Pending { expires_in: 0 },
        Message::Cancel,
        Message::Accepted {
            session_id: String::new(),
            state: VersionedState {
                epoch: String::new(),
                version: 0,
                state: PlaybackSnapshot::default(),
            },
        },
        Message::Closed {
            reason: CloseReason::Left,
        },
        Message::State(VersionedState {
            epoch: String::new(),
            version: 0,
            state: PlaybackSnapshot::default(),
        }),
        Message::Command {
            id: 0,
            command: Command::Stop,
        },
        Message::Catalog {
            id: 0,
            query: CatalogQuery::Groups {
                content_type: "live".into(),
            },
        },
        Message::CatalogPage {
            re: 0,
            items: vec![],
            next: None,
        },
        Message::Ok { re: 0, version: 0 },
        Message::Error {
            re: None,
            code: ErrorCode::Failed,
        },
        Message::Ping,
        Message::Pong,
    ];
    let types: Vec<String> = samples
        .iter()
        .map(|m| {
            serde_json::to_value(m).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(types, KNOWN_TYPES);
}

#[test]
fn device_types_read_back_from_their_record_value() {
    for t in DeviceType::ALL {
        assert_eq!(DeviceType::parse(t.as_str()), Some(t));
        assert_eq!(serde_json::to_value(t).unwrap(), t.as_str());
    }
    assert_eq!(DeviceType::parse("toaster"), None);
}

#[test]
fn values_from_a_newer_version_read_as_unknown() {
    let read = |value: &str| serde_json::Value::String(value.into());
    assert_eq!(
        serde_json::from_value::<Feature>(read("transfer")).unwrap(),
        Feature::Unknown
    );
    assert_eq!(
        serde_json::from_value::<Vec<Feature>>(json!(["control", "transfer"])).unwrap(),
        [Feature::Control, Feature::Unknown]
    );
    assert_eq!(
        serde_json::from_value::<DeviceType>(read("windows-tablet")).unwrap(),
        DeviceType::Other
    );
    assert_eq!(DeviceType::Other.as_str(), "other");
    assert_eq!(
        decode(&bytes(json!({"v": 1, "type": "closed", "reason": "sleeping"}))),
        Ok(Message::Closed {
            reason: CloseReason::Unknown
        })
    );
    assert_eq!(
        serde_json::from_value::<ErrorCode>(read("too_hot")).unwrap(),
        ErrorCode::Unknown
    );
}

#[test]
fn a_playback_error_goes_out_as_its_code() {
    for (error, code) in [
        (PlaybackError::OpenFailed, "openFailed"),
        (PlaybackError::LoadFailed, "loadFailed"),
        (PlaybackError::Refused, "refused"),
        (PlaybackError::Failed, "failed"),
    ] {
        let state = PlaybackSnapshot {
            status: PlaybackStatus::Error,
            error: Some(error),
            ..PlaybackSnapshot::default()
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["error"], code);
        assert_eq!(
            serde_json::from_value::<PlaybackSnapshot>(value).unwrap(),
            state
        );
    }
    assert_eq!(
        serde_json::from_value::<PlaybackError>(json!("overheated")).unwrap(),
        PlaybackError::Unknown
    );
    // Free text reads as a code it doesn't know.
    let old = json!({"status": "error", "error": "http://user:pass@host/live.ts failed"});
    assert_eq!(
        serde_json::from_value::<PlaybackSnapshot>(old)
            .unwrap()
            .error,
        Some(PlaybackError::Unknown)
    );
}

#[test]
fn a_message_leaves_room_for_the_noise_tag() {
    // Noise sends at most 65535 bytes, 16 of them its tag.
    assert_eq!(MAX_MESSAGE, 65_519);
}

#[test]
fn common_version_picks_the_highest_both_speak() {
    assert_eq!(common_version(&[1, 2, 3], &[2, 3, 4]), Some(3));
    assert_eq!(common_version(&[1], &[2]), None);
    assert_eq!(common_version(&[], &[1]), None);
}
