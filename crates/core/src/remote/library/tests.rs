// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::channel::Channel;
use crate::remote::controller::{AskError, Controller, Event};
use crate::remote::identity::DeviceKey;
use crate::remote::message::{self, DeviceType, Feature, MAX_MESSAGE};
use crate::remote::settings::{ControlMode, RemoteSettings};
use crate::remote::target::Action;
use crate::remote::tests::{
    controller_and_bare_target, controller_and_bare_target_saying, hello, let_in, unframe, Net,
};
use crate::remote::ConnId;
use std::time::Instant;

fn kinds(content_type: &str) -> [LibraryCall; 2] {
    [
        LibraryCall::GroupHierarchy {
            provider_id: "p".into(),
            content_type: content_type.into(),
        },
        LibraryCall::PinnedGroups {
            provider_id: "p".into(),
            content_type: content_type.into(),
        },
    ]
}

fn guide(from: i64, to: i64, ids: Option<Vec<String>>) -> LibraryCall {
    LibraryCall::Guide { from, to, ids }
}

fn pin(provider_id: &str, content_type: &str, group: &str) -> [LibraryCall; 2] {
    [
        LibraryCall::PinGroup {
            provider_id: provider_id.into(),
            content_type: content_type.into(),
            group: group.into(),
            order: 3,
        },
        LibraryCall::UnpinGroup {
            provider_id: provider_id.into(),
            content_type: content_type.into(),
            group: group.into(),
        },
    ]
}

#[test]
fn calls_within_the_limits_are_valid() {
    let id = "i".repeat(MAX_ID_BYTES);
    let text = "t".repeat(MAX_TEXT_BYTES);
    let mut calls = vec![
        LibraryCall::Channels,
        LibraryCall::Providers,
        guide(5, 5, None),
        guide(5, 6, Some(vec![id.clone(); MAX_GUIDE_IDS])),
        LibraryCall::Schedule {
            epg_id: id.clone(),
            from: 5,
            to: 5,
        },
        // The limit counts characters, not bytes.
        LibraryCall::GuideSearch {
            query: "é".repeat(MAX_QUERY_CHARS),
            from: 0,
        },
        LibraryCall::History {
            limit: MAX_HISTORY,
            content_type: None,
        },
        LibraryCall::History {
            limit: 0,
            content_type: Some("series".into()),
        },
        LibraryCall::SeriesEpisodes {
            series_id: id.clone(),
        },
        LibraryCall::Omdb {
            id: id.clone(),
            title: text.clone(),
            kind: "movie".into(),
        },
        LibraryCall::Omdb {
            id: "m".into(),
            title: "A Film".into(),
            kind: "series".into(),
        },
        LibraryCall::Whatson {
            imdb_id: id.clone(),
            kind: "movie".into(),
        },
        LibraryCall::Whatson {
            imdb_id: "tt1".into(),
            kind: "show".into(),
        },
        LibraryCall::ToggleFavorite { id: id.clone() },
        LibraryCall::DeleteHistory {
            channel_id: id.clone(),
        },
        LibraryCall::DeleteHistorySeries {
            series_title: text.clone(),
        },
        LibraryCall::ClearHistory { content_type: None },
        LibraryCall::ClearHistory {
            content_type: Some("live".into()),
        },
    ];
    calls.extend(kinds("live"));
    calls.extend(kinds("movie"));
    calls.extend(kinds("series"));
    calls.extend(pin(&id, "movie", &text));
    for call in calls {
        assert!(call.is_valid(), "{call:?}");
    }
}

#[test]
fn calls_over_a_limit_are_invalid() {
    let id = "i".repeat(MAX_ID_BYTES + 1);
    let text = "t".repeat(MAX_TEXT_BYTES + 1);
    let mut calls = vec![
        guide(6, 5, None),
        guide(5, 6, Some(vec!["e".into(); MAX_GUIDE_IDS + 1])),
        guide(5, 6, Some(vec![id.clone()])),
        LibraryCall::Schedule {
            epg_id: id.clone(),
            from: 5,
            to: 6,
        },
        LibraryCall::Schedule {
            epg_id: "e".into(),
            from: 6,
            to: 5,
        },
        LibraryCall::GuideSearch {
            query: "q".repeat(MAX_QUERY_CHARS + 1),
            from: 0,
        },
        LibraryCall::History {
            limit: MAX_HISTORY + 1,
            content_type: None,
        },
        LibraryCall::History {
            limit: 10,
            content_type: Some("radio".into()),
        },
        LibraryCall::SeriesEpisodes {
            series_id: id.clone(),
        },
        LibraryCall::Omdb {
            id: id.clone(),
            title: "A Film".into(),
            kind: "movie".into(),
        },
        LibraryCall::Omdb {
            id: "m".into(),
            title: text.clone(),
            kind: "movie".into(),
        },
        LibraryCall::Omdb {
            id: "m".into(),
            title: "A Film".into(),
            kind: "show".into(),
        },
        LibraryCall::Whatson {
            imdb_id: id.clone(),
            kind: "movie".into(),
        },
        LibraryCall::Whatson {
            imdb_id: "tt1".into(),
            kind: "series".into(),
        },
        LibraryCall::ToggleFavorite { id: id.clone() },
        LibraryCall::DeleteHistory {
            channel_id: id.clone(),
        },
        LibraryCall::DeleteHistorySeries {
            series_title: text.clone(),
        },
        LibraryCall::ClearHistory {
            content_type: Some("radio".into()),
        },
    ];
    calls.extend(kinds("radio"));
    calls.push(LibraryCall::GroupHierarchy {
        provider_id: id.clone(),
        content_type: "live".into(),
    });
    calls.extend(pin(&id, "live", "g"));
    calls.extend(pin("p", "radio", "g"));
    calls.extend(pin("p", "live", &text));
    for call in calls {
        assert!(!call.is_valid(), "{call:?}");
    }
}

#[test]
fn only_edits_change_the_library() {
    let edits = [
        LibraryCall::ToggleFavorite { id: "c".into() },
        LibraryCall::DeleteHistory {
            channel_id: "c".into(),
        },
        LibraryCall::DeleteHistorySeries {
            series_title: "Show".into(),
        },
        LibraryCall::ClearHistory { content_type: None },
    ];
    for call in edits.into_iter().chain(pin("p", "live", "g")) {
        assert!(call.edits(), "{call:?}");
    }
    let reads = [
        LibraryCall::Channels,
        LibraryCall::Providers,
        guide(0, 1, None),
        LibraryCall::SeriesEpisodes {
            series_id: "s".into(),
        },
        LibraryCall::History {
            limit: 1,
            content_type: None,
        },
    ];
    for call in reads.into_iter().chain(kinds("live")) {
        assert!(!call.edits(), "{call:?}");
    }
}

#[test]
fn a_call_goes_over_the_wire_by_name_in_camel_case() {
    let call = Message::Library {
        id: 3,
        call: LibraryCall::PinGroup {
            provider_id: "p".into(),
            content_type: "live".into(),
            group: "News".into(),
            order: 2,
        },
    };
    let json: serde_json::Value = serde_json::from_slice(&message::encode(&call)).unwrap();
    assert_eq!(json["type"], "library");
    assert_eq!(json["id"], 3);
    assert_eq!(
        json["call"],
        serde_json::json!({
            "name": "pinGroup",
            "providerId": "p",
            "contentType": "live",
            "group": "News",
            "order": 2,
        })
    );
    // Fields left out read as none, and none isn't written.
    for (call, json) in [
        (guide(1, 2, None), r#"{"name":"guide","from":1,"to":2}"#),
        (
            LibraryCall::ClearHistory { content_type: None },
            r#"{"name":"clearHistory"}"#,
        ),
        (
            LibraryCall::History {
                limit: 5,
                content_type: None,
            },
            r#"{"name":"history","limit":5}"#,
        ),
    ] {
        assert_eq!(serde_json::to_string(&call).unwrap(), json);
        assert_eq!(serde_json::from_str::<LibraryCall>(json).unwrap(), call);
    }
    let piece: Message =
        message::decode(br#"{"v":1,"type":"libraryData","re":3,"seq":0,"data":""}"#).unwrap();
    assert_eq!(
        piece,
        Message::LibraryData {
            re: 3,
            seq: 0,
            last: false,
            data: String::new(),
        }
    );
}

#[test]
fn a_full_piece_fits_a_frame() {
    let piece = Message::LibraryData {
        re: u64::MAX,
        seq: u32::MAX,
        last: true,
        data: BASE64.encode(vec![0xff; PIECE_BYTES]),
    };
    let len = message::encode(&piece).len();
    assert!(len <= MAX_MESSAGE);
    // It also fills most of the frame, so a big answer takes few round trips.
    assert!(len > MAX_MESSAGE * 9 / 10, "{len} bytes");
}

#[test]
fn a_big_library_unpacks() {
    // Tens of thousands of channels come to megabytes of JSON.
    let json = vec![b' '; 16 * 1024 * 1024];
    let unpacked = unpack(&pack(&json), MAX_UNPACKED).map(|json| json.len());
    assert_eq!(unpacked, Ok(json.len()));
}

#[test]
fn an_answer_unpacks_to_what_was_packed() {
    let json = br#"[{"id":"live-1","name":"News"}]"#.repeat(100);
    let packed = pack(&json);
    assert!(packed.len() < json.len());
    assert_eq!(unpack(&packed, json.len()), Ok(json.clone()));
    assert_eq!(unpack(&packed, json.len() - 1), Err(ErrorCode::TooLarge));
    assert_eq!(unpack(b"not deflate at all", 1000), Err(ErrorCode::Invalid));
}

/// Bytes that don't repeat in a piece, standing in for a packed answer.
fn data(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// Each piece's request, number, whether it's the last, and its bytes.
fn pieces(messages: &[Message]) -> Vec<(u64, u32, bool, Vec<u8>)> {
    messages
        .iter()
        .map(|m| match m {
            Message::LibraryData {
                re,
                seq,
                last,
                data,
            } => (*re, *seq, *last, BASE64.decode(data).unwrap()),
            other => panic!("not a piece: {other:?}"),
        })
        .collect()
}

#[test]
fn calls_run_one_at_a_time_in_the_order_they_came() {
    let mut library = TargetLibrary::default();
    assert_eq!(
        library.ask(1, LibraryCall::Channels),
        Ok(Some((1, LibraryCall::Channels)))
    );
    assert_eq!(library.ask(2, LibraryCall::Providers), Ok(None));
    assert_eq!(library.ask(3, guide(0, 1, None)), Ok(None));
    // A result for a call that isn't running is dropped.
    assert_eq!(library.finished(2, Ok(vec![1])), (vec![], None));
    let (messages, next) = library.finished(1, Err(ErrorCode::Failed));
    assert_eq!(
        messages,
        [Message::Error {
            re: Some(1),
            code: ErrorCode::Failed
        }]
    );
    assert_eq!(next, Some((2, LibraryCall::Providers)));
    let (messages, next) = library.finished(2, Ok(vec![7]));
    assert_eq!(pieces(&messages), [(2, 0, true, vec![7])]);
    assert_eq!(next, Some((3, guide(0, 1, None))));
}

#[test]
fn too_many_waiting_calls_are_busy() {
    let mut library = TargetLibrary::default();
    assert!(library.ask(0, LibraryCall::Channels).unwrap().is_some());
    for id in 1..=MAX_CALLS as u64 {
        assert_eq!(library.ask(id, LibraryCall::Providers), Ok(None));
    }
    assert_eq!(
        library.ask(99, LibraryCall::Providers),
        Err(ErrorCode::Busy)
    );
}

#[test]
fn an_answer_goes_out_a_window_at_a_time() {
    let mut library = TargetLibrary::default();
    library.ask(1, LibraryCall::Channels).unwrap();
    let packed = data(WINDOW * PIECE_BYTES + 10);
    let (messages, _) = library.finished(1, Ok(packed.clone()));
    let first = pieces(&messages);
    assert_eq!(first.len(), WINDOW);
    for (seq, piece) in first.iter().enumerate() {
        assert_eq!((piece.0, piece.1, piece.2), (1, seq as u32, false));
        assert_eq!(piece.3.len(), PIECE_BYTES);
    }
    assert!(library.expects(&Message::LibraryAck { re: 1, seq: 0 }));
    assert!(!library.expects(&Message::LibraryAck { re: 1, seq: 1 }));
    assert!(!library.expects(&Message::LibraryAck { re: 2, seq: 0 }));
    assert!(!library.expects(&Message::Ping));
    // Only the oldest piece out can be acknowledged.
    assert_eq!(library.acked(1, 1), None);
    assert_eq!(library.acked(2, 0), None);
    let rest = pieces(&library.acked(1, 0).unwrap());
    assert_eq!(rest.len(), 1);
    assert_eq!((rest[0].0, rest[0].1, rest[0].2), (1, WINDOW as u32, true));
    let whole: Vec<u8> = first.into_iter().chain(rest).flat_map(|p| p.3).collect();
    assert_eq!(whole, packed);
    for seq in 1..=WINDOW as u32 {
        assert_eq!(library.acked(1, seq), Some(vec![]));
    }
    assert_eq!(library.acked(1, WINDOW as u32 + 1), None);
    assert!(!library.expects(&Message::LibraryAck {
        re: 1,
        seq: WINDOW as u32 + 1
    }));
}

#[test]
fn answers_go_out_in_the_order_they_finished() {
    let mut library = TargetLibrary::default();
    library.ask(1, LibraryCall::Channels).unwrap();
    library.ask(2, LibraryCall::Providers).unwrap();
    let (messages, next) = library.finished(1, Ok(data(WINDOW * PIECE_BYTES + 1)));
    assert_eq!(messages.len(), WINDOW);
    assert_eq!(next, Some((2, LibraryCall::Providers)));
    // The window is full, so the second answer waits.
    assert_eq!(library.finished(2, Ok(vec![9])), (vec![], None));
    let last = (WINDOW * PIECE_BYTES % 251) as u8;
    assert_eq!(
        pieces(&library.acked(1, 0).unwrap()),
        [(1, WINDOW as u32, true, vec![last])]
    );
    assert_eq!(
        pieces(&library.acked(1, 1).unwrap()),
        [(2, 0, true, vec![9])]
    );
}

#[test]
fn an_answer_over_the_limits_is_refused() {
    let mut library = TargetLibrary::default();
    library.ask(1, LibraryCall::Channels).unwrap();
    library.ask(2, LibraryCall::Channels).unwrap();
    library.ask(3, LibraryCall::Channels).unwrap();
    library.ask(4, LibraryCall::Channels).unwrap();
    library.ask(5, LibraryCall::Channels).unwrap();
    // Zeroed memory isn't touched until it's read, so these cost little.
    let (messages, next) = library.finished(1, Ok(vec![0; MAX_PACKED + 1]));
    assert_eq!(
        messages,
        [Message::Error {
            re: Some(1),
            code: ErrorCode::TooLarge
        }]
    );
    assert_eq!(next.map(|n| n.0), Some(2));
    let (messages, _) = library.finished(2, Ok(vec![0; MAX_PACKED]));
    assert_eq!(messages.len(), WINDOW);
    // What waits to go out may come to MAX_QUEUED, and no more.
    let (messages, _) = library.finished(3, Ok(vec![0; MAX_PACKED]));
    assert!(messages.is_empty());
    let (messages, _) = library.finished(4, Ok(vec![0; WINDOW * PIECE_BYTES]));
    assert!(messages.is_empty());
    let (messages, next) = library.finished(5, Ok(vec![0]));
    assert_eq!(
        messages,
        [Message::Error {
            re: Some(5),
            code: ErrorCode::Busy
        }]
    );
    assert_eq!(next, None);
}

#[test]
fn pieces_in_order_make_the_answer() {
    let mut incoming = Incoming::default();
    assert_eq!(incoming.add(0, false, &BASE64.encode([1, 2])), Piece::More);
    assert_eq!(incoming.add(1, false, &BASE64.encode([3])), Piece::More);
    assert_eq!(
        incoming.add(2, true, &BASE64.encode([4])),
        Piece::Done(vec![1, 2, 3, 4])
    );
}

#[test]
fn a_piece_out_of_order_bad_or_too_big_breaks_the_answer() {
    let mut incoming = Incoming::default();
    assert_eq!(incoming.add(1, false, ""), Piece::Broken);
    assert_eq!(incoming.add(0, false, "not base64!"), Piece::Broken);
    let full = BASE64.encode(vec![0; PIECE_BYTES]);
    assert_eq!(incoming.add(0, false, &full), Piece::More);
    // The same piece again is out of order.
    assert_eq!(incoming.add(0, false, &full), Piece::Broken);
    let over = BASE64.encode(vec![0; PIECE_BYTES + 1]);
    assert_eq!(incoming.add(1, false, &over), Piece::Broken);
    // The whole answer may come to MAX_PACKED, and no more.
    let mut incoming = Incoming {
        packed: vec![0; MAX_PACKED - 1],
        seq: 0,
    };
    assert_eq!(
        incoming.add(0, false, &BASE64.encode([0, 0])),
        Piece::Broken
    );
    match incoming.add(0, true, &BASE64.encode([0])) {
        Piece::Done(packed) => assert_eq!(packed.len(), MAX_PACKED),
        other => panic!("{other:?}"),
    }
}

// A target and a controller together.

/// The library calls the target asked the app to answer.
fn asked(net: &Net) -> Vec<(ConnId, u64, LibraryCall)> {
    net.log
        .iter()
        .filter_map(|a| match a {
            Action::Library {
                conn,
                request,
                call,
            } => Some((*conn, *request, call.clone())),
            _ => None,
        })
        .collect()
}

fn call(net: &mut Net, client: usize, call: LibraryCall) -> u64 {
    let (id, bytes) = net.clients[client].controller.library(call).unwrap();
    net.send(client, bytes);
    id
}

fn finish(net: &mut Net, conn: ConnId, request: u64, result: Result<Vec<u8>, ErrorCode>) {
    let actions = net.target.finish_library(conn, request, result);
    net.handle(actions);
    net.pump();
}

#[test]
fn a_big_answer_reaches_the_controller_whole() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let id = call(&mut net, phone, LibraryCall::Channels);
    let (conn, request, asked_for) = asked(&net).remove(0);
    assert_eq!((request, asked_for), (id, LibraryCall::Channels));
    // More pieces than the rate limit lets messages through: the
    // acknowledgements don't count against it.
    let packed = data(3 * WINDOW * PIECE_BYTES);
    finish(&mut net, conn, request, Ok(packed.clone()));
    let events = &net.clients[phone].events;
    let more = events
        .iter()
        .filter(|e| **e == Event::LibraryPiece { request: id })
        .count();
    assert_eq!(more, 3 * WINDOW - 1);
    assert_eq!(
        events.last(),
        Some(&Event::Library {
            request: id,
            packed
        })
    );
    assert!(net.clients[phone].connected());
}

#[test]
fn the_next_call_starts_when_one_finishes() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let first = call(&mut net, phone, LibraryCall::Providers);
    let second = call(&mut net, phone, LibraryCall::Channels);
    assert_eq!(asked(&net).len(), 1);
    let conn = asked(&net)[0].0;
    finish(&mut net, conn, first, Err(ErrorCode::Failed));
    assert!(net.clients[phone].events.contains(&Event::Reply {
        request: first,
        result: Err(ErrorCode::Failed)
    }));
    assert_eq!(
        asked(&net).last(),
        Some(&(conn, second, LibraryCall::Channels))
    );
    // A connection that isn't there gets nothing.
    assert!(net
        .target
        .finish_library(ConnId(99), second, Ok(vec![1]))
        .is_empty());
}

#[test]
fn an_invalid_call_never_reaches_the_app() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let id = call(
        &mut net,
        phone,
        LibraryCall::SeriesEpisodes {
            series_id: "s".repeat(MAX_ID_BYTES + 1),
        },
    );
    assert!(asked(&net).is_empty());
    assert!(net.clients[phone].events.contains(&Event::Reply {
        request: id,
        result: Err(ErrorCode::Invalid)
    }));
}

#[test]
fn a_flood_of_calls_is_rate_limited() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let ids: Vec<u64> = (0..25)
        .map(|_| call(&mut net, phone, LibraryCall::Providers))
        .collect();
    assert_eq!(asked(&net).len(), 1);
    let limited = ids.iter().filter(|id| {
        net.clients[phone].events.contains(&Event::Reply {
            request: **id,
            result: Err(ErrorCode::RateLimited),
        })
    });
    assert!(limited.count() > 0);
}

#[test]
fn a_controller_still_asking_cant_call_on_the_library() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    assert_eq!(
        net.clients[phone].controller.library(LibraryCall::Channels),
        Err(AskError::NotConnected)
    );
    let bytes = net.clients[phone]
        .controller
        .seal_raw(&Message::Library {
            id: 4,
            call: LibraryCall::Channels,
        })
        .unwrap();
    net.send(phone, bytes);
    assert!(asked(&net).is_empty());
    assert!(net.clients[phone].events.contains(&Event::Reply {
        request: 4,
        result: Err(ErrorCode::Unsupported)
    }));
}

#[test]
fn a_target_that_doesnt_offer_the_library_isnt_asked() {
    let now = Instant::now();
    let (mut controller, mut target) = controller_and_bare_target(now);
    let_in(&mut controller, &mut target, now);
    assert_eq!(
        controller.library(LibraryCall::Channels),
        Err(AskError::Unsupported)
    );
}

/// A controller in a session with a bare target that offers the library.
fn offered(now: Instant) -> (Controller, Channel) {
    let key = DeviceKey::generate();
    let mut target_hello = hello(&key, "TV", DeviceType::FireTv);
    target_hello.features.push(Feature::Library);
    let (mut controller, mut target) = controller_and_bare_target_saying(key, target_hello, now);
    let_in(&mut controller, &mut target, now);
    (controller, target)
}

/// Asks for `call`. The bare target never reads what the controller
/// sends, since the handshake left a request unread on its side.
fn ask_for(controller: &mut Controller, call: LibraryCall) -> u64 {
    controller.library(call).unwrap().0
}

/// What the target's message did on the controller, and how many messages
/// the controller sent back.
fn piece_to(
    controller: &mut Controller,
    target: &mut Channel,
    message: &Message,
) -> (Vec<Event>, usize) {
    let bytes = target.seal(message).unwrap();
    let out = controller.receive(&unframe(&bytes), Instant::now());
    (out.events, out.send.len())
}

fn piece(re: u64, seq: u32, last: bool, bytes: &[u8]) -> Message {
    Message::LibraryData {
        re,
        seq,
        last,
        data: BASE64.encode(bytes),
    }
}

#[test]
fn a_controller_acknowledges_every_piece_even_of_a_broken_answer() {
    let now = Instant::now();
    let (mut controller, mut target) = offered(now);
    let id = ask_for(&mut controller, LibraryCall::Channels);
    assert_eq!(
        piece_to(&mut controller, &mut target, &piece(id, 0, false, &[1])),
        (vec![Event::LibraryPiece { request: id }], 1)
    );
    assert_eq!(
        piece_to(&mut controller, &mut target, &piece(id, 2, true, &[3])),
        (
            vec![Event::Reply {
                request: id,
                result: Err(ErrorCode::Failed)
            }],
            1
        )
    );
    // The answer is gone, so a late piece is only acknowledged.
    assert_eq!(
        piece_to(&mut controller, &mut target, &piece(id, 1, true, &[2])),
        (vec![], 1)
    );
}

#[test]
fn the_last_piece_hands_over_the_answer_once() {
    let now = Instant::now();
    let (mut controller, mut target) = offered(now);
    let id = ask_for(&mut controller, LibraryCall::Providers);
    piece_to(&mut controller, &mut target, &piece(id, 0, false, &[1, 2]));
    let (events, _) = piece_to(&mut controller, &mut target, &piece(id, 1, true, &[3]));
    assert_eq!(
        events,
        [Event::Library {
            request: id,
            packed: vec![1, 2, 3]
        }]
    );
    let (events, _) = piece_to(&mut controller, &mut target, &piece(id, 0, true, &[1]));
    assert!(events.is_empty());
}

#[test]
fn an_error_or_forgetting_ends_the_wait_for_an_answer() {
    let now = Instant::now();
    let (mut controller, mut target) = offered(now);
    let failed = ask_for(&mut controller, LibraryCall::Channels);
    let forgotten = ask_for(&mut controller, LibraryCall::Providers);
    let kept = ask_for(&mut controller, LibraryCall::Providers);
    let error = Message::Error {
        re: Some(failed),
        code: ErrorCode::Busy,
    };
    let (events, _) = piece_to(&mut controller, &mut target, &error);
    assert_eq!(
        events,
        [Event::Reply {
            request: failed,
            result: Err(ErrorCode::Busy)
        }]
    );
    controller.forget_library(forgotten);
    for re in [failed, forgotten] {
        let (events, back) = piece_to(&mut controller, &mut target, &piece(re, 0, true, &[1]));
        assert!(events.is_empty());
        assert_eq!(back, 1);
    }
    let (events, _) = piece_to(&mut controller, &mut target, &piece(kept, 0, true, &[1]));
    assert_eq!(
        events,
        [Event::Library {
            request: kept,
            packed: vec![1]
        }]
    );
}
