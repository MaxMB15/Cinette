// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::channel::FrameReader;
use crate::remote::handshake::ControllerHandshake;
use crate::remote::message::Capabilities;
use crate::remote::tests::{hello, item, playing};

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn unframe(bytes: &[u8]) -> Vec<u8> {
    let mut reader = FrameReader::new();
    reader.push(bytes);
    let frame = reader.next_frame().unwrap().unwrap();
    assert!(reader.next_frame().unwrap().is_none());
    frame
}

/// The contents of every frame the target sent on `conn`.
fn sent(actions: &[Action], conn: ConnId) -> Vec<Vec<u8>> {
    actions
        .iter()
        .filter_map(|a| match a {
            Action::Send { conn: to, bytes } if *to == conn => Some(unframe(bytes)),
            _ => None,
        })
        .collect()
}

/// The messages the target sent on `conn`, opened with the controller's
/// side of the channel.
fn messages(actions: &[Action], conn: ConnId, channel: &mut Channel) -> Vec<Message> {
    sent(actions, conn)
        .iter()
        .map(|frame| message::decode(&channel.open(frame).unwrap()).unwrap())
        .collect()
}

fn target() -> Target {
    Target::new(
        DeviceKey::generate(),
        DeviceType::Mac,
        RemoteSettings::default(),
    )
}

/// Runs the handshake on a new connection as a controller with a new key,
/// and stops before asking for anything. `Err` is why the target refused.
fn shake(target: &mut Target, now: Instant) -> (ConnId, Result<Channel, CloseReason>) {
    let key = DeviceKey::generate();
    shake_as(target, &key, now)
}

fn shake_as(
    target: &mut Target,
    key: &DeviceKey,
    now: Instant,
) -> (ConnId, Result<Channel, CloseReason>) {
    let conn = target.accept(now).expect("the target takes the connection");
    let (mut handshake, mut bytes) = ControllerHandshake::start(
        key,
        hello(key, "Phone", DeviceType::Iphone),
        target.device_id(),
    )
    .unwrap();
    loop {
        let actions = target.receive(conn, &unframe(&bytes), now);
        let reply = sent(&actions, conn).remove(0);
        match handshake.read(&reply) {
            Ok((Some(next), Next::Continue(h))) => {
                handshake = h;
                bytes = next;
            }
            Ok((Some(reveal), Next::Done(established))) => {
                assert!(target.receive(conn, &unframe(&reveal), now).is_empty());
                return (conn, Ok(established.channel));
            }
            Ok(_) => panic!("the handshake stalled"),
            Err(failure) => {
                assert!(actions.contains(&Action::Close { conn }));
                return (conn, Err(failure.reason));
            }
        }
    }
}

/// Sends `message` on `conn`, sealed with the controller's channel.
fn say(
    target: &mut Target,
    conn: ConnId,
    channel: &mut Channel,
    message: &Message,
    now: Instant,
) -> Vec<Action> {
    let bytes = channel.seal(message).unwrap();
    target.receive(conn, &unframe(&bytes), now)
}

fn ask(target: &mut Target, conn: ConnId, channel: &mut Channel, now: Instant) -> Vec<Action> {
    let request = Message::Request {
        kind: RequestKind::Control,
        resume: None,
    };
    say(target, conn, channel, &request, now)
}

fn closed_for(actions: &[Action], conn: ConnId, channel: &mut Channel, reason: CloseReason) {
    assert_eq!(
        messages(actions, conn, channel),
        [Message::Closed { reason }],
        "{actions:?}"
    );
    assert_eq!(actions.last(), Some(&Action::Close { conn }));
}

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
fn the_oldest_handshake_makes_room_for_a_new_one() {
    let mut target = target();
    let now = Instant::now();
    let (ready, channel) = shake(&mut target, now);
    assert!(channel.is_ok());
    let handshakes: Vec<ConnId> = (1..=MAX_HANDSHAKES as u64)
        .map(|i| target.accept(now + ms(i)).unwrap())
        .collect();
    // Nothing made room yet. The first deadline is the first connection's.
    assert_eq!(target.next_deadline(), Some(now + HANDSHAKE_TIMEOUT));
    assert!(target.tick(now + ms(100)).is_empty());

    let later = now + ms(100);
    let newest = target.accept(later).unwrap();
    assert!(!handshakes.contains(&newest));
    // The connection that made room closes at the next tick, which is due.
    assert_eq!(target.next_deadline(), Some(later));
    assert!(target.receive(handshakes[0], b"x", later).is_empty());
    assert_eq!(
        target.tick(later),
        [Action::Close {
            conn: handshakes[0]
        }]
    );
    assert!(target.tick(later).is_empty());
    // The connection that finished its handshake is still there.
    assert!(target.conns.contains_key(&ready));
    assert_eq!(target.conns.len(), MAX_HANDSHAKES + 1);
}

#[test]
fn a_connection_that_made_room_and_dropped_isnt_closed_again() {
    let mut target = target();
    let now = Instant::now();
    let conns: Vec<ConnId> = (0..MAX_HANDSHAKES as u64 + 2)
        .map(|i| target.accept(now + ms(i)).unwrap())
        .collect();
    let later = now + ms(50);
    assert!(target.disconnected(conns[0], later).is_empty());
    assert_eq!(target.tick(later), [Action::Close { conn: conns[1] }]);
}

#[test]
fn with_every_connection_open_the_oldest_that_hasnt_asked_makes_room() {
    let mut target = target();
    let t0 = Instant::now();
    let (waiting, channel) = shake(&mut target, t0);
    let actions = ask(&mut target, waiting, &mut channel.unwrap(), t0);
    assert!(actions.iter().any(|a| matches!(a, Action::ShowConsent(_))));
    // One nonce a second keeps the handshakes under the limit.
    let ready: Vec<ConnId> = (1..=16)
        .map(|i| {
            let (conn, channel) = shake(&mut target, t0 + Duration::from_secs(i));
            assert!(channel.is_ok());
            conn
        })
        .collect();
    let at = t0 + Duration::from_secs(20);
    for i in 1..MAX_HANDSHAKES as u64 {
        target.accept(at + ms(i)).unwrap();
    }
    assert_eq!(target.conns.len(), MAX_CONNECTIONS);

    let later = at + Duration::from_secs(1);
    let newest = target.accept(later).unwrap();
    assert_eq!(target.conns.len(), MAX_CONNECTIONS);
    assert!(target.conns.contains_key(&newest));
    // The request is older, but it's waiting for the user.
    assert!(target.conns.contains_key(&waiting));
    assert!(!target.conns.contains_key(&ready[0]));
    assert_eq!(target.tick(later)[0], Action::Close { conn: ready[0] });
}

#[test]
fn shutting_down_closes_a_connection_that_made_room() {
    let mut target = target();
    let now = Instant::now();
    let first = target.accept(now).unwrap();
    for i in 1..=MAX_HANDSHAKES as u64 {
        target.accept(now + ms(i)).unwrap();
    }
    let actions = target.shutdown();
    assert_eq!(actions.first(), Some(&Action::Close { conn: first }));
    assert_eq!(
        actions
            .iter()
            .filter(|a| matches!(a, Action::Close { .. }))
            .count(),
        MAX_HANDSHAKES + 1
    );
}

// The nonce limit

#[test]
fn nonces_run_out_after_a_burst_and_come_back_one_a_second() {
    let mut target = target();
    let now = Instant::now();
    for _ in 0..NONCE_BURST {
        assert!(shake(&mut target, now).1.is_ok());
    }
    let (busy, refused) = shake(&mut target, now);
    assert_eq!(refused.err(), Some(CloseReason::Busy));
    assert!(!target.conns.contains_key(&busy));
    assert_eq!(
        shake(&mut target, now + ms(500)).1.err(),
        Some(CloseReason::Busy)
    );
    assert!(shake(&mut target, now + ms(1000)).1.is_ok());
    assert_eq!(
        shake(&mut target, now + ms(1000)).1.err(),
        Some(CloseReason::Busy)
    );
}

#[test]
fn a_device_with_a_session_skips_the_nonce_limit() {
    let mut target = Target::new(
        DeviceKey::generate(),
        DeviceType::Mac,
        RemoteSettings {
            remote_control: ControlMode::Always,
            ..RemoteSettings::default()
        },
    );
    let now = Instant::now();
    let phone = DeviceKey::generate();
    let (conn, channel) = shake_as(&mut target, &phone, now);
    let mut channel = channel.unwrap();
    let accepted = messages(
        &ask(&mut target, conn, &mut channel, now),
        conn,
        &mut channel,
    );
    assert!(
        matches!(accepted[..], [Message::Accepted { .. }]),
        "{accepted:?}"
    );
    for _ in 1..NONCE_BURST {
        assert!(shake(&mut target, now).1.is_ok());
    }
    // Someone else waits, while the phone can come back.
    assert_eq!(shake(&mut target, now).1.err(), Some(CloseReason::Busy));
    assert!(shake_as(&mut target, &phone, now).1.is_ok());
}

// Before a controller is let in

#[test]
fn a_command_before_asking_closes_the_connection() {
    let mut target = target();
    let now = Instant::now();
    let (conn, channel) = shake(&mut target, now);
    let mut channel = channel.unwrap();
    let command = Message::Command {
        id: 1,
        command: Command::Stop,
    };
    let actions = say(&mut target, conn, &mut channel, &command, now);
    closed_for(&actions, conn, &mut channel, CloseReason::Protocol);
    assert!(!target.conns.contains_key(&conn));
}

#[test]
fn a_message_it_cant_read_before_asking_closes_the_connection() {
    let mut target = target();
    let now = Instant::now();
    let (conn, channel) = shake(&mut target, now);
    let mut channel = channel.unwrap();
    let bytes = channel
        .seal_bytes(br#"{"v": 1, "type": "teleport", "id": 8}"#)
        .unwrap();
    let actions = target.receive(conn, &unframe(&bytes), now);
    closed_for(&actions, conn, &mut channel, CloseReason::Protocol);
}

#[test]
fn before_asking_a_controller_can_ping_and_hear_what_isnt_offered() {
    let mut target = target();
    let now = Instant::now();
    let (conn, channel) = shake(&mut target, now);
    let mut channel = channel.unwrap();
    let actions = say(&mut target, conn, &mut channel, &Message::Ping, now);
    assert_eq!(messages(&actions, conn, &mut channel), [Message::Pong]);
    let history = Message::Request {
        kind: RequestKind::History,
        resume: None,
    };
    let actions = say(&mut target, conn, &mut channel, &history, now);
    assert_eq!(
        messages(&actions, conn, &mut channel),
        [Message::Error {
            re: None,
            code: ErrorCode::Unsupported
        }]
    );
    let actions = ask(&mut target, conn, &mut channel, now);
    assert!(actions.iter().any(|a| matches!(a, Action::ShowConsent(_))));
}

#[test]
fn a_goodbye_before_asking_closes_without_a_reply() {
    let mut target = target();
    let now = Instant::now();
    let (conn, channel) = shake(&mut target, now);
    let goodbye = Message::Closed {
        reason: CloseReason::Left,
    };
    let actions = say(&mut target, conn, &mut channel.unwrap(), &goodbye, now);
    assert_eq!(actions, [Action::Close { conn }]);
}

#[test]
fn too_many_messages_before_asking_close_the_connection() {
    let mut target = target();
    let now = Instant::now();
    let (conn, channel) = shake(&mut target, now);
    let mut channel = channel.unwrap();
    for _ in 0..RATE as usize {
        let actions = say(&mut target, conn, &mut channel, &Message::Ping, now);
        assert_eq!(messages(&actions, conn, &mut channel), [Message::Pong]);
    }
    let actions = say(&mut target, conn, &mut channel, &Message::Ping, now);
    closed_for(&actions, conn, &mut channel, CloseReason::Protocol);
}

#[test]
fn too_many_messages_while_waiting_withdraw_the_request() {
    let mut target = target();
    let now = Instant::now();
    let (conn, channel) = shake(&mut target, now);
    let mut channel = channel.unwrap();
    // The request took the first of the allowance.
    let actions = ask(&mut target, conn, &mut channel, now);
    let Some(Action::ShowConsent(prompt)) =
        actions.iter().find(|a| matches!(a, Action::ShowConsent(_)))
    else {
        panic!("{actions:?}")
    };
    let request = prompt.request;
    messages(&actions, conn, &mut channel);
    for _ in 1..RATE as usize {
        let actions = say(&mut target, conn, &mut channel, &Message::Ping, now);
        assert_eq!(messages(&actions, conn, &mut channel), [Message::Pong]);
    }
    let actions = say(&mut target, conn, &mut channel, &Message::Ping, now);
    assert!(actions.contains(&Action::HideConsent(request)));
    closed_for(&actions, conn, &mut channel, CloseReason::Protocol);
    assert!(target.consent.is_empty());
}

#[test]
fn a_message_it_cant_read_while_waiting_gets_an_error() {
    let mut target = target();
    let now = Instant::now();
    let (conn, channel) = shake(&mut target, now);
    let mut channel = channel.unwrap();
    let actions = ask(&mut target, conn, &mut channel, now);
    messages(&actions, conn, &mut channel);
    for (json, code) in [
        (
            &br#"{"v": 1, "type": "teleport", "id": 8}"#[..],
            ErrorCode::Unsupported,
        ),
        (
            &br#"{"v": 1, "type": "command", "id": 8, "command": {"action": "explode"}}"#[..],
            ErrorCode::Invalid,
        ),
    ] {
        let bytes = channel.seal_bytes(json).unwrap();
        let actions = target.receive(conn, &unframe(&bytes), now);
        assert_eq!(
            messages(&actions, conn, &mut channel),
            [Message::Error { re: Some(8), code }]
        );
    }
    assert_eq!(target.consent.len(), 1);
}

#[test]
fn over_the_limit_a_session_hears_only_that_it_is_limited() {
    let mut target = Target::new(
        DeviceKey::generate(),
        DeviceType::Mac,
        RemoteSettings {
            remote_control: ControlMode::Always,
            ..RemoteSettings::default()
        },
    );
    let now = Instant::now();
    let (conn, channel) = shake(&mut target, now);
    let mut channel = channel.unwrap();
    let actions = ask(&mut target, conn, &mut channel, now);
    messages(&actions, conn, &mut channel);
    let unknown = |channel: &mut Channel, json: &[u8]| channel.seal_bytes(json).unwrap();
    // Under the limit, a message it can't read gets an answer.
    let bytes = unknown(&mut channel, br#"{"v": 1, "type": "teleport", "id": 3}"#);
    let actions = target.receive(conn, &unframe(&bytes), now);
    assert_eq!(
        messages(&actions, conn, &mut channel),
        [Message::Error {
            re: Some(3),
            code: ErrorCode::Unsupported
        }]
    );
    for _ in 2..RATE as usize {
        let actions = say(&mut target, conn, &mut channel, &Message::Ping, now);
        assert_eq!(messages(&actions, conn, &mut channel), [Message::Pong]);
    }
    assert!(say(&mut target, conn, &mut channel, &Message::Ping, now).is_empty());
    let history = Message::Request {
        kind: RequestKind::History,
        resume: None,
    };
    assert!(say(&mut target, conn, &mut channel, &history, now).is_empty());
    let limited = |re| Message::Error {
        re: Some(re),
        code: ErrorCode::RateLimited,
    };
    let command = Message::Command {
        id: 5,
        command: Command::Stop,
    };
    let actions = say(&mut target, conn, &mut channel, &command, now);
    assert_eq!(messages(&actions, conn, &mut channel), [limited(5)]);
    let catalog = Message::Catalog {
        id: 6,
        query: CatalogQuery::Groups {
            content_type: "live".into(),
        },
    };
    let actions = say(&mut target, conn, &mut channel, &catalog, now);
    assert_eq!(messages(&actions, conn, &mut channel), [limited(6)]);
    let bytes = unknown(&mut channel, br#"{"v": 1, "type": "teleport", "id": 9}"#);
    let actions = target.receive(conn, &unframe(&bytes), now);
    assert_eq!(messages(&actions, conn, &mut channel), [limited(9)]);
    let bytes = unknown(&mut channel, br#"{"v": 1, "type": "teleport"}"#);
    assert!(target.receive(conn, &unframe(&bytes), now).is_empty());
    // A goodbye still ends the session.
    let goodbye = Message::Closed {
        reason: CloseReason::Left,
    };
    let actions = say(&mut target, conn, &mut channel, &goodbye, now);
    assert_eq!(actions.last(), Some(&Action::Close { conn }));
    assert!(target.sessions().is_empty());
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
