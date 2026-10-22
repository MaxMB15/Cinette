// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::transfer::{Item, ItemKind, ItemRef, Watched};

fn names(n: usize) -> Vec<ProviderName> {
    (0..n)
        .map(|i| ProviderName {
            name: format!("Provider {i}"),
            kind: ProviderKind::Xtream,
        })
        .collect()
}

fn settings(name: &str) -> ProviderSettings {
    ProviderSettings {
        name: name.into(),
        kind: ProviderKind::Xtream,
        url: "http://panel.example".into(),
        username: Some("made-up-user".into()),
        password: Some("made-up-password".into()),
        epg_url: Some("http://panel.example/xmltv.php".into()),
    }
}

fn history_request(direction: Option<Direction>, what: Option<What>) -> Message {
    Message::Request {
        kind: RequestKind::History,
        resume: None,
        id: Some(4),
        direction,
        what,
        counts: Some(Counts {
            history: 9,
            ..Counts::default()
        }),
        providers: None,
    }
}

#[test]
fn a_history_request_reads_back() {
    let asked = Asked::History {
        direction: Direction::Send,
        what: What::ALL,
        counts: Some(Counts {
            pins: 2,
            ..Counts::default()
        }),
    };
    assert_eq!(Asked::from_request(&asked.request(3)), Some((3, asked)));
}

#[test]
fn an_import_request_carries_no_counts() {
    let read = Asked::from_request(&history_request(Some(Direction::Import), Some(What::ALL)));
    assert_eq!(
        read,
        Some((
            4,
            Asked::History {
                direction: Direction::Import,
                what: What::ALL,
                counts: None,
            }
        ))
    );
}

#[test]
fn an_incomplete_history_request_isnt_read() {
    for request in [
        history_request(None, Some(What::ALL)),
        history_request(Some(Direction::Send), None),
        history_request(Some(Direction::Send), Some(What::default())),
        Message::Request {
            kind: RequestKind::History,
            resume: None,
            id: None,
            direction: Some(Direction::Send),
            what: Some(What::ALL),
            counts: None,
            providers: None,
        },
        // A send that doesn't say what it carries.
        Message::Request {
            kind: RequestKind::History,
            resume: None,
            id: Some(4),
            direction: Some(Direction::Send),
            what: Some(What::ALL),
            counts: None,
            providers: None,
        },
        Message::control_request(None),
        Message::Ping,
    ] {
        assert_eq!(Asked::from_request(&request), None, "{request:?}");
    }
}

#[test]
fn a_provider_request_names_one_to_thirty_two_providers() {
    let ok = Asked::Providers(names(MAX_PROVIDERS));
    assert_eq!(Asked::from_request(&ok.request(1)), Some((1, ok)));
    let one = Asked::Providers(names(1));
    assert_eq!(Asked::from_request(&one.request(1)), Some((1, one)));
    for bad in [names(0), names(MAX_PROVIDERS + 1)] {
        assert_eq!(Asked::from_request(&Asked::Providers(bad).request(1)), None);
    }
    let without = Message::Request {
        kind: RequestKind::Providers,
        resume: None,
        id: Some(1),
        direction: None,
        what: None,
        counts: None,
        providers: None,
    };
    assert_eq!(Asked::from_request(&without), None);
}

#[test]
fn a_provider_name_must_be_there_and_short() {
    let named = |name: String| {
        Asked::Providers(vec![ProviderName {
            name,
            kind: ProviderKind::M3u,
        }])
        .request(1)
    };
    assert!(Asked::from_request(&named("x".repeat(MAX_PROVIDER_NAME))).is_some());
    assert!(Asked::from_request(&named("x".repeat(MAX_PROVIDER_NAME + 1))).is_none());
    assert!(Asked::from_request(&named("  ".into())).is_none());
}

#[test]
fn provider_settings_never_print_their_login() {
    let printed = format!("{:?}", settings("Home"));
    assert!(printed.contains("Home"));
    for secret in ["made-up", "panel.example"] {
        assert!(!printed.contains(secret), "{printed}");
    }
}

#[test]
fn provider_settings_need_a_url_and_fields_within_limits() {
    assert!(settings("a").fits());
    let mut s = settings("a");
    s.url = " ".into();
    assert!(!s.fits());
    let mut s = settings("a");
    s.url = "u".repeat(MAX_PROVIDER_FIELD);
    assert!(s.fits());
    s.url = "u".repeat(MAX_PROVIDER_FIELD + 1);
    assert!(!s.fits());
    for field in 0..3 {
        let mut s = settings("a");
        let long = Some("x".repeat(MAX_PROVIDER_FIELD + 1));
        match field {
            0 => s.username = long,
            1 => s.password = long,
            _ => s.epg_url = long,
        }
        assert!(!s.fits(), "field {field}");
    }
    let mut s = settings("a");
    s.username = None;
    s.password = None;
    s.epg_url = None;
    assert!(s.fits());
}

#[test]
fn many_providers_are_split_to_fit_a_frame() {
    let big = |i: usize| {
        let mut s = settings(&format!("P{i}"));
        s.url = format!("http://{}.example/", "a".repeat(MAX_PROVIDER_FIELD - 30));
        s
    };
    let parts = provider_parts((0..30).map(big).collect());
    assert!(parts.len() > 1);
    assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 30);
    for part in &parts {
        assert!(serde_json::to_vec(part).unwrap().len() <= chunks::CHUNK_BYTES);
    }
    assert_eq!(provider_parts(vec![settings("a")]).len(), 1);
    assert_eq!(provider_parts(vec![]), vec![Vec::<ProviderSettings>::new()]);
}

/// Provider settings whose JSON is `len` bytes, padded in the URL.
fn settings_of_len(name: &str, len: usize) -> ProviderSettings {
    let mut p = settings(name);
    let base = serde_json::to_vec(&p).unwrap().len();
    p.url.push_str(&"a".repeat(len - base));
    assert_eq!(serde_json::to_vec(&p).unwrap().len(), len);
    p
}

#[test]
fn providers_that_fill_a_part_exactly_stay_in_one() {
    // Each takes its JSON and a comma.
    let first = 20_000;
    let exact = chunks::CHUNK_BYTES - (first + 1) - 1;
    let parts = provider_parts(vec![
        settings_of_len("A", first),
        settings_of_len("B", exact),
    ]);
    assert_eq!(parts.len(), 1);
    let parts = provider_parts(vec![
        settings_of_len("A", first),
        settings_of_len("B", exact + 1),
    ]);
    assert_eq!(parts.iter().map(Vec::len).collect::<Vec<_>>(), [1, 1]);
}

fn export(items: usize) -> Export {
    Export {
        items: (0..items)
            .map(|n| Item {
                reference: ItemRef::named(ItemKind::Live, format!("A long channel name {n}")),
                watched: Some(Watched {
                    first_watched_at: 1,
                    last_watched_at: 2,
                    play_count: 3,
                    watched_seconds: 4,
                }),
                position: None,
                favorite: false,
            })
            .collect(),
        ..Export::default()
    }
}

fn sent(steps: &[Step]) -> Vec<&Message> {
    steps
        .iter()
        .filter_map(|s| match s {
            Step::Send(m) => Some(&**m),
            _ => None,
        })
        .collect()
}

fn progress_of(steps: &[Step]) -> Vec<&Progress> {
    steps
        .iter()
        .filter_map(|s| match s {
            Step::Progress { progress, .. } => Some(progress),
            _ => None,
        })
        .collect()
}

#[test]
fn a_sender_keeps_four_chunks_in_flight() {
    let now = Instant::now();
    let mut sender = Sender::new("t".into(), &export(5000), now);
    assert!(sender.total > 6);
    let mut steps = Vec::new();
    sender.fill(&mut steps);
    assert_eq!(steps.len(), WINDOW);
    steps.clear();
    sender.fill(&mut steps);
    assert!(steps.is_empty());
    sender.ack(0, now, &mut steps).unwrap();
    assert_eq!(steps.len(), 1);
    // Out of order, or for a chunk not sent yet, it's refused.
    assert!(sender.ack(2, now, &mut steps).is_err());
    let mut tiny = Sender::new("t".into(), &export(1), now);
    let mut steps = Vec::new();
    tiny.fill(&mut steps);
    assert_eq!(tiny.total, 1);
    tiny.ack(0, now, &mut steps).unwrap();
    assert!(tiny.all_acked());
    assert!(tiny.ack(1, now, &mut steps).is_err());
}

#[test]
fn an_ack_moves_the_senders_deadline() {
    let now = Instant::now();
    let mut sender = Sender::new("t".into(), &export(5000), now);
    let mut steps = Vec::new();
    sender.fill(&mut steps);
    let later = now + Duration::from_secs(20);
    sender.ack(0, later, &mut steps).unwrap();
    assert_eq!(sender.deadline, later + STEP_TIMEOUT);
}

fn asking(asked: Asked) -> TargetFlow {
    TargetFlow::Asking { id: 7, asked }
}

fn send_history() -> Asked {
    Asked::History {
        direction: Direction::Send,
        what: What::ALL,
        counts: None,
    }
}

/// A target flow for a granted "send", and its transfer id.
fn receiving(now: Instant) -> (TargetFlow, String) {
    let mut steps = Vec::new();
    let flow = asking(send_history()).granted(now, &mut steps).unwrap();
    let id = flow.transfer().unwrap().to_string();
    (flow, id)
}

fn chunk(transfer: &str, seq: u32, last: bool) -> Message {
    Message::TransferChunk {
        transfer: transfer.into(),
        chunk: Chunk {
            seq,
            last,
            sent_at: Some(5),
            current: None,
            dropped: None,
            items: vec![],
            pins: vec![],
        },
    }
}

#[test]
fn a_granted_send_tells_the_controller_its_id_and_salt() {
    let now = Instant::now();
    let mut steps = Vec::new();
    let flow = asking(send_history()).granted(now, &mut steps).unwrap();
    let id = flow.transfer().unwrap().to_string();
    assert_eq!(id.len(), 32);
    match sent(&steps)[..] {
        [Message::Granted {
            re: 7,
            transfer,
            salt: Some(salt),
            counts: None,
        }] => {
            assert_eq!(transfer, &id);
            assert!(Salt::from_hex(salt).is_some());
        }
        ref other => panic!("{other:?}"),
    }
    assert_eq!(flow.deadline(), Some(now + GRANT_TIMEOUT));
}

#[test]
fn grants_are_new_each_time() {
    let now = Instant::now();
    let (_, one) = receiving(now);
    let (_, two) = receiving(now);
    assert_ne!(one, two);
}

#[test]
fn only_a_waiting_request_is_granted_or_refused() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let flow = flow.granted(now, &mut steps).unwrap();
    assert_eq!(flow.transfer(), Some(id.as_str()));
    assert!(steps.is_empty());
    flow.refused(ErrorCode::Denied, &mut steps);
    assert!(steps.is_empty());
    asking(send_history()).refused(ErrorCode::Expired, &mut steps);
    assert_eq!(
        sent(&steps),
        [&Message::Error {
            re: Some(7),
            code: ErrorCode::Expired,
        }]
    );
}

#[test]
fn the_receiver_acks_each_chunk_and_hands_over_the_last() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let later = now + Duration::from_secs(1);
    let flow = flow
        .receive(chunk(&id, 0, false), later, &mut steps)
        .unwrap()
        .unwrap();
    assert_eq!(flow.deadline(), Some(later + STEP_TIMEOUT));
    assert_eq!(
        sent(&steps),
        [&Message::TransferAck {
            transfer: id.clone(),
            seq: 0,
        }]
    );
    assert_eq!(progress_of(&steps), [&Progress::Receiving { received: 1 }]);
    steps.clear();
    let flow = flow
        .receive(chunk(&id, 1, true), now, &mut steps)
        .unwrap()
        .unwrap();
    assert!(matches!(flow, TargetFlow::Importing { .. }));
    // The app has a while to write it, not forever.
    assert_eq!(flow.deadline(), Some(now + WRITE_TIMEOUT));
    assert!(steps.iter().any(|s| matches!(
        s,
        Step::Import { export, .. } if export.sent_at == 5
    )));
    assert_eq!(progress_of(&steps), [&Progress::Saving]);
}

#[test]
fn a_chunk_out_of_order_ends_the_transfer() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let flow = flow.receive(chunk(&id, 1, false), now, &mut steps).unwrap();
    assert!(flow.is_none());
    assert!(sent(&steps).contains(&&Message::TransferError {
        transfer: id,
        code: ErrorCode::Invalid,
    }));
    assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Invalid)]);
}

#[test]
fn a_message_for_another_transfer_is_answered_and_changes_nothing() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let flow = flow
        .receive(chunk("other", 0, true), now, &mut steps)
        .unwrap()
        .unwrap();
    assert_eq!(flow.transfer(), Some(id.as_str()));
    assert_eq!(
        sent(&steps),
        [&Message::TransferError {
            transfer: "other".into(),
            code: ErrorCode::Invalid,
        }]
    );
    steps.clear();
    for quiet in [
        Message::TransferCancel {
            transfer: "other".into(),
        },
        Message::TransferError {
            transfer: "other".into(),
            code: ErrorCode::Failed,
        },
    ] {
        let next = flow_of(receiving(now).0, quiet, &mut steps);
        assert!(next.is_some());
    }
    assert!(steps.is_empty());
}

fn flow_of(flow: TargetFlow, message: Message, steps: &mut Vec<Step>) -> Option<TargetFlow> {
    flow.receive(message, Instant::now(), steps).unwrap()
}

#[test]
fn a_message_that_isnt_a_transfer_step_is_given_back() {
    let now = Instant::now();
    let (flow, _) = receiving(now);
    let mut steps = Vec::new();
    let (flow, message) = *flow.receive(Message::Ping, now, &mut steps).unwrap_err();
    assert_eq!(message, Message::Ping);
    assert!(flow.transfer().is_some());
    assert!(steps.is_empty());
}

#[test]
fn the_other_side_can_stop_a_transfer() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let cancel = Message::TransferCancel {
        transfer: id.clone(),
    };
    assert!(flow_of(flow, cancel, &mut steps).is_none());
    assert_eq!(
        progress_of(&steps),
        [&Progress::Failed(ErrorCode::Cancelled)]
    );
    assert!(sent(&steps).is_empty());

    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let error = Message::TransferError {
        transfer: id,
        code: ErrorCode::Failed,
    };
    assert!(flow_of(flow, error, &mut steps).is_none());
    assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Failed)]);
}

#[test]
fn a_step_that_doesnt_fit_ends_the_transfer() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let start = Message::TransferStart { transfer: id };
    assert!(flow_of(flow, start, &mut steps).is_none());
    assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Invalid)]);
}

#[test]
fn a_transfer_with_no_chunk_in_time_expires() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let flow = flow
        .tick(now + GRANT_TIMEOUT - Duration::from_millis(1), &mut steps)
        .unwrap();
    assert!(steps.is_empty());
    assert!(flow.tick(now + GRANT_TIMEOUT, &mut steps).is_none());
    assert_eq!(
        sent(&steps),
        [&Message::TransferError {
            transfer: id,
            code: ErrorCode::Expired,
        }]
    );
    assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Expired)]);
}

#[test]
fn a_flow_with_no_deadline_never_expires() {
    let mut steps = Vec::new();
    let flow = asking(send_history());
    assert_eq!(flow.deadline(), None);
    let far = Instant::now() + Duration::from_secs(100_000);
    assert!(flow.tick(far, &mut steps).is_some());
    assert!(steps.is_empty());
}

#[test]
fn a_write_the_app_never_finishes_ends_the_transfer() {
    let now = Instant::now();
    for flow in [
        TargetFlow::Importing {
            transfer: "t".into(),
            deadline: now + WRITE_TIMEOUT,
        },
        TargetFlow::Saving {
            grant: "t".into(),
            deadline: now + WRITE_TIMEOUT,
        },
    ] {
        let mut steps = Vec::new();
        let flow = flow
            .tick(now + WRITE_TIMEOUT - Duration::from_millis(1), &mut steps)
            .expect("still writing");
        assert!(steps.is_empty());
        assert!(flow.tick(now + WRITE_TIMEOUT, &mut steps).is_none());
        assert_eq!(
            sent(&steps),
            [&Message::TransferError {
                transfer: "t".into(),
                code: ErrorCode::Expired,
            }]
        );
    }
}

#[test]
fn many_providers_get_longer_to_save() {
    assert_eq!(providers_write_time(1), WRITE_TIMEOUT);
    assert_eq!(providers_write_time(3), WRITE_TIMEOUT);
    assert_eq!(providers_write_time(4), PROVIDER_SAVE_TIME * 4);
    assert_eq!(providers_write_time(32), PROVIDER_SAVE_TIME * 32);
    assert!(providers_write_time(usize::MAX) >= providers_write_time(32));
}

#[test]
fn a_send_that_keeps_being_acked_still_has_a_limit() {
    let now = Instant::now();
    let mut out = ControllerOut::default();
    let mut flow = ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    }
    .send_export("t", Ok(export(20_000)), now, &mut out)
    .unwrap();
    // One acknowledgement every 29 s keeps the step timeout away.
    let mut at = now;
    for seq in 0..20 {
        at += Duration::from_secs(29);
        flow = flow.tick(at, &mut out).expect("each ack comes in time");
        let ack = Message::TransferAck {
            transfer: "t".into(),
            seq,
        };
        flow = flow.receive(ack, at, &mut out).unwrap().unwrap();
    }
    assert!(matches!(flow, ControllerFlow::Sending(_)));
    assert_eq!(flow.deadline(), Some(now + TRANSFER_LIMIT));
    assert!(flow.tick(now + TRANSFER_LIMIT, &mut out).is_none());
}

#[test]
fn a_cancel_after_the_last_chunk_went_is_too_late() {
    let now = Instant::now();
    let mut out = ControllerOut::default();
    // One chunk: it goes at once, before its acknowledgement.
    let flow = ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    }
    .send_export("t", Ok(export(1)), now, &mut out)
    .unwrap();
    let mut out = ControllerOut::default();
    let flow = flow.cancel(&mut out).expect("too late to cancel");
    assert_eq!(out, ControllerOut::default());
    assert!(matches!(flow, ControllerFlow::Sending(_)));

    // With chunks still to go, it stops.
    let flow = ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    }
    .send_export("t", Ok(export(5000)), now, &mut out)
    .unwrap();
    let mut out = ControllerOut::default();
    assert!(flow.cancel(&mut out).is_none());
    assert_eq!(
        out.send,
        [Message::TransferCancel {
            transfer: "t".into()
        }]
    );
}

#[test]
fn the_import_result_goes_to_the_controller() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let flow = flow_of(flow, chunk(&id, 0, true), &mut steps).unwrap();
    steps.clear();
    // Another transfer's result changes nothing.
    let flow = flow
        .imported("other", Ok(Report::default()), &mut steps)
        .unwrap();
    assert!(steps.is_empty());
    assert!(flow
        .imported(&id, Ok(Report::default()), &mut steps)
        .is_none());
    assert_eq!(
        sent(&steps),
        [&Message::TransferDone {
            transfer: id.clone(),
            report: Report::default(),
        }]
    );

    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let flow = flow_of(flow, chunk(&id, 0, true), &mut steps).unwrap();
    steps.clear();
    assert!(flow
        .imported(&id, Err(ErrorCode::Failed), &mut steps)
        .is_none());
    assert_eq!(
        sent(&steps),
        [&Message::TransferError {
            transfer: id,
            code: ErrorCode::Failed,
        }]
    );
    assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Failed)]);
}

/// A target flow for an allowed import, exported and ready.
fn ready(now: Instant, items: usize) -> (TargetFlow, String) {
    let mut steps = Vec::new();
    let import = Asked::History {
        direction: Direction::Import,
        what: What::ALL,
        counts: None,
    };
    let flow = asking(import).granted(now, &mut steps).unwrap();
    let id = flow.transfer().unwrap().to_string();
    assert!(matches!(steps[..], [Step::Export { .. }]));
    assert_eq!(flow.deadline(), Some(now + GRANT_TIMEOUT));
    // Another transfer's export changes nothing.
    let flow = flow
        .exported("other", Ok(export(1)), now, &mut steps)
        .unwrap();
    assert!(matches!(flow, TargetFlow::Exporting { .. }));
    let flow = flow
        .exported(&id, Ok(export(items)), now, &mut steps)
        .unwrap();
    (flow, id)
}

#[test]
fn an_exported_import_waits_for_start_with_its_counts() {
    let now = Instant::now();
    let mut steps = Vec::new();
    let import = Asked::History {
        direction: Direction::Import,
        what: What::ALL,
        counts: None,
    };
    let flow = asking(import).granted(now, &mut steps).unwrap();
    let id = flow.transfer().unwrap().to_string();
    steps.clear();
    let flow = flow.exported(&id, Ok(export(3)), now, &mut steps).unwrap();
    match sent(&steps)[..] {
        [Message::Granted {
            re: 7,
            transfer,
            salt: Some(_),
            counts: Some(counts),
        }] => {
            assert_eq!(transfer, &id);
            assert_eq!(counts.history, 3);
        }
        ref other => panic!("{other:?}"),
    }
    assert_eq!(flow.deadline(), Some(now + GRANT_TIMEOUT));
}

#[test]
fn an_import_sends_once_started_and_finishes_with_the_result() {
    let now = Instant::now();
    let (flow, id) = ready(now, 5000);
    let mut steps = Vec::new();
    let later = now + Duration::from_secs(3);
    let start = Message::TransferStart {
        transfer: id.clone(),
    };
    let flow = flow.receive(start, later, &mut steps).unwrap().unwrap();
    assert_eq!(flow.deadline(), Some(later + STEP_TIMEOUT));
    let chunks = sent(&steps).len();
    assert_eq!(chunks, WINDOW);
    // The first chunk carries this device's clock as it goes.
    let Message::TransferChunk { chunk, .. } = sent(&steps)[0] else {
        panic!("not a chunk");
    };
    let clock = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let sent_at = chunk.sent_at.expect("the first chunk has a clock");
    assert!((clock - sent_at).abs() <= 5, "{sent_at} vs {clock}");
    let TargetFlow::Sending(sender) = &flow else {
        panic!("not sending");
    };
    let total = sender.total;
    assert_eq!(progress_of(&steps), [&Progress::Sending { done: 0, total }]);

    let mut flow = flow;
    for seq in 0..total {
        steps.clear();
        let ack = Message::TransferAck {
            transfer: id.clone(),
            seq,
        };
        flow = flow.receive(ack, later, &mut steps).unwrap().unwrap();
        assert_eq!(
            progress_of(&steps),
            [&Progress::Sending {
                done: seq + 1,
                total,
            }]
        );
    }
    assert!(matches!(flow, TargetFlow::Finishing { .. }));
    // The controller has all the time it needs to write.
    assert_eq!(flow.deadline(), Some(later + WRITE_TIMEOUT));
    steps.clear();
    let done = Message::TransferDone {
        transfer: id,
        report: Report::default(),
    };
    assert!(flow_of(flow, done, &mut steps).is_none());
    assert_eq!(progress_of(&steps), [&Progress::Done(Box::default())]);
}

#[test]
fn a_bad_ack_ends_a_sending_import() {
    let now = Instant::now();
    let (flow, id) = ready(now, 5000);
    let mut steps = Vec::new();
    let start = Message::TransferStart {
        transfer: id.clone(),
    };
    let flow = flow_of(flow, start, &mut steps).unwrap();
    steps.clear();
    let ack = Message::TransferAck {
        transfer: id,
        seq: 3,
    };
    assert!(flow_of(flow, ack, &mut steps).is_none());
    assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Invalid)]);
}

#[test]
fn an_import_that_failed_to_export_is_refused() {
    let now = Instant::now();
    let mut steps = Vec::new();
    let import = Asked::History {
        direction: Direction::Import,
        what: What::ALL,
        counts: None,
    };
    let flow = asking(import).granted(now, &mut steps).unwrap();
    let id = flow.transfer().unwrap().to_string();
    steps.clear();
    assert!(flow
        .exported(&id, Err(ErrorCode::Failed), now, &mut steps)
        .is_none());
    assert_eq!(
        sent(&steps),
        [&Message::Error {
            re: Some(7),
            code: ErrorCode::Failed,
        }]
    );
}

fn granted_providers(now: Instant, n: usize) -> (TargetFlow, String) {
    let mut steps = Vec::new();
    let flow = asking(Asked::Providers(
        (0..n).map(|i| settings(&format!("P{i}")).named()).collect(),
    ))
    .granted(now, &mut steps)
    .unwrap();
    let id = flow.transfer().unwrap().to_string();
    match sent(&steps)[..] {
        [Message::Granted {
            re: 7,
            transfer,
            salt: None,
            counts: None,
        }] => assert_eq!(transfer, &id),
        ref other => panic!("{other:?}"),
    }
    (flow, id)
}

fn providers_send(grant: &str, part: u32, last: bool, names: &[&str]) -> Message {
    Message::ProvidersSend {
        grant: grant.into(),
        part,
        last,
        providers: names.iter().map(|n| settings(n)).collect(),
    }
}

#[test]
fn providers_can_come_in_parts() {
    let now = Instant::now();
    let (flow, grant) = granted_providers(now, 2);
    let mut steps = Vec::new();
    let flow = flow_of(flow, providers_send(&grant, 0, false, &["P0"]), &mut steps).unwrap();
    assert!(steps.is_empty());
    let later = now + Duration::from_secs(1);
    let flow = flow
        .receive(providers_send(&grant, 1, true, &["P1"]), later, &mut steps)
        .unwrap()
        .unwrap();
    assert!(matches!(flow, TargetFlow::Saving { .. }));
    let saved: Vec<String> = steps
        .iter()
        .find_map(|s| match s {
            Step::SaveProviders { providers, .. } => {
                Some(providers.iter().map(|p| p.name.clone()).collect())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(saved, ["P0", "P1"]);
    assert_eq!(progress_of(&steps), [&Progress::Saving]);

    steps.clear();
    let flow = flow.providers_saved("other", vec![], &mut steps).unwrap();
    assert!(steps.is_empty());
    let results = vec![ProviderResult {
        name: "P0".into(),
        outcome: ProviderOutcome::Exists,
        error: None,
        saved_as: None,
    }];
    assert!(flow
        .providers_saved(&grant, results.clone(), &mut steps)
        .is_none());
    assert_eq!(
        sent(&steps),
        [&Message::ProvidersAdded {
            grant,
            results: results.clone(),
        }]
    );
    assert_eq!(progress_of(&steps), [&Progress::ProvidersDone(results)]);
}

#[test]
fn a_provider_part_moves_the_deadline() {
    let now = Instant::now();
    let (flow, grant) = granted_providers(now, 2);
    assert_eq!(flow.deadline(), Some(now + GRANT_TIMEOUT));
    let later = now + Duration::from_secs(5);
    let mut steps = Vec::new();
    let flow = flow
        .receive(providers_send(&grant, 0, false, &["P0"]), later, &mut steps)
        .unwrap()
        .unwrap();
    assert_eq!(flow.deadline(), Some(later + STEP_TIMEOUT));
}

#[test]
fn providers_out_of_order_twice_or_unnamed_are_refused() {
    let now = Instant::now();
    let cases: [(u32, &[&str]); 4] = [(1, &["P0"]), (0, &["P0", "P0"]), (0, &["P9"]), (0, &[])];
    for (case, (part, names)) in cases.into_iter().enumerate() {
        let (flow, grant) = granted_providers(now, 2);
        let mut steps = Vec::new();
        let message = providers_send(&grant, part, true, names);
        assert!(flow_of(flow, message, &mut steps).is_none(), "case {case}");
        assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Invalid)]);
    }
}

#[test]
fn a_provider_without_a_url_is_refused() {
    let now = Instant::now();
    let (flow, grant) = granted_providers(now, 1);
    let mut bare = settings("P0");
    bare.url = String::new();
    let message = Message::ProvidersSend {
        grant,
        part: 0,
        last: true,
        providers: vec![bare],
    };
    let mut steps = Vec::new();
    assert!(flow_of(flow, message, &mut steps).is_none());
}

#[test]
fn a_provider_name_with_the_wrong_kind_is_refused() {
    let now = Instant::now();
    let (flow, grant) = granted_providers(now, 1);
    let mut m3u = settings("P0");
    m3u.kind = ProviderKind::M3u;
    let message = Message::ProvidersSend {
        grant,
        part: 0,
        last: true,
        providers: vec![m3u],
    };
    let mut steps = Vec::new();
    assert!(flow_of(flow, message, &mut steps).is_none());
}

#[test]
fn the_flows_kind_follows_what_it_carries() {
    let now = Instant::now();
    assert_eq!(granted_providers(now, 1).0.kind(), RequestKind::Providers);
    assert_eq!(
        TargetFlow::Saving {
            grant: "g".into(),
            deadline: later()
        }
        .kind(),
        RequestKind::Providers
    );
    assert_eq!(receiving(now).0.kind(), RequestKind::History);
    assert_eq!(asking(send_history()).kind(), RequestKind::History);
    assert_eq!(
        asking(Asked::Providers(names(1))).kind(),
        RequestKind::Providers
    );
}

#[test]
fn every_running_flow_names_its_transfer() {
    let now = Instant::now();
    assert_eq!(asking(send_history()).transfer(), None);
    let flows = [
        TargetFlow::Importing {
            transfer: "a".into(),
            deadline: now,
        },
        TargetFlow::Finishing {
            transfer: "b".into(),
            deadline: now,
        },
        TargetFlow::Saving {
            grant: "c".into(),
            deadline: later(),
        },
    ];
    let ids: Vec<_> = flows.iter().map(|f| f.transfer().unwrap()).collect();
    assert_eq!(ids, ["a", "b", "c"]);
    assert_eq!(
        TargetFlow::Finishing {
            transfer: "b".into(),
            deadline: now,
        }
        .deadline(),
        Some(now)
    );
}

// The controller's side.

fn controller_asking(asked: Asked) -> ControllerFlow {
    ControllerFlow::asking(3, asked, Instant::now())
}

/// A moment far enough away that no deadline in these tests has passed.
fn later() -> Instant {
    Instant::now() + Duration::from_secs(3600)
}

fn granted(salt: Option<Salt>, counts: Option<Counts>) -> Message {
    Message::Granted {
        re: 3,
        transfer: "t".into(),
        salt: salt.map(Salt::to_hex),
        counts,
    }
}

fn step(
    flow: ControllerFlow,
    message: Message,
    now: Instant,
) -> (Option<ControllerFlow>, ControllerOut) {
    let mut out = ControllerOut::default();
    let next = flow.receive(message, now, &mut out).unwrap();
    (next, out)
}

#[test]
fn the_controller_hears_pending_only_for_its_own_request() {
    let now = Instant::now();
    let (next, out) = step(
        controller_asking(send_history()),
        Message::Pending {
            expires_in: 99,
            re: Some(3),
        },
        now,
    );
    assert!(next.is_some());
    assert_eq!(out.events, [ControllerEvent::Pending { expires_in: 30 }]);
    let mut out = ControllerOut::default();
    let other = Message::Pending {
        expires_in: 10,
        re: Some(4),
    };
    assert!(controller_asking(send_history())
        .receive(other, now, &mut out)
        .is_err());
    let control = Message::Pending {
        expires_in: 10,
        re: None,
    };
    assert!(controller_asking(send_history())
        .receive(control, now, &mut out)
        .is_err());
    let error = Message::Error {
        re: Some(9),
        code: ErrorCode::Denied,
    };
    assert!(controller_asking(send_history())
        .receive(error, now, &mut out)
        .is_err());
    assert!(out.events.is_empty());
}

#[test]
fn a_refusal_ends_the_controllers_request() {
    let (next, out) = step(
        controller_asking(send_history()),
        Message::Error {
            re: Some(3),
            code: ErrorCode::Busy,
        },
        Instant::now(),
    );
    assert!(next.is_none());
    assert_eq!(out.events, [ControllerEvent::Refused(ErrorCode::Busy)]);
}

#[test]
fn a_granted_send_asks_for_the_export() {
    let salt = Salt([3; 16]);
    let now = Instant::now();
    let (next, out) = step(
        controller_asking(send_history()),
        granted(Some(salt), None),
        now,
    );
    assert!(matches!(next, Some(ControllerFlow::Exporting { .. })));
    assert_eq!(next.unwrap().deadline(), Some(now + GRANT_TIMEOUT));
    assert_eq!(
        out.events,
        [ControllerEvent::ExportNeeded {
            transfer: "t".into(),
            salt,
            what: What::ALL,
        }]
    );
}

#[test]
fn a_granted_import_shows_its_preview_until_started_or_too_late() {
    let now = Instant::now();
    let import = Asked::History {
        direction: Direction::Import,
        what: What::ALL,
        counts: None,
    };
    let counts = Counts {
        favorites: 4,
        ..Counts::default()
    };
    let (next, out) = step(
        controller_asking(import.clone()),
        granted(Some(Salt([3; 16])), Some(counts)),
        now,
    );
    assert_eq!(
        out.events,
        [ControllerEvent::Preview {
            transfer: "t".into(),
            counts,
        }]
    );
    let flow = next.unwrap();
    assert_eq!(flow.deadline(), Some(now + GRANT_TIMEOUT));
    let mut out = ControllerOut::default();
    let flow = flow.tick(now + GRANT_TIMEOUT - Duration::from_millis(1), &mut out);
    assert!(out.send.is_empty());
    let flow = flow.unwrap().tick(now + GRANT_TIMEOUT, &mut out);
    assert!(flow.is_none());
    assert_eq!(
        out.send,
        [Message::TransferError {
            transfer: "t".into(),
            code: ErrorCode::Expired,
        }]
    );

    // Without counts the preview shows none.
    let (_, out) = step(
        controller_asking(import),
        granted(Some(Salt([3; 16])), None),
        now,
    );
    assert_eq!(
        out.events,
        [ControllerEvent::Preview {
            transfer: "t".into(),
            counts: Counts::default(),
        }]
    );
}

#[test]
fn a_history_grant_without_a_salt_is_refused() {
    let (next, out) = step(
        controller_asking(send_history()),
        granted(None, None),
        Instant::now(),
    );
    assert!(next.is_none());
    assert_eq!(
        out.send,
        [Message::TransferError {
            transfer: "t".into(),
            code: ErrorCode::Invalid,
        }]
    );
}

#[test]
fn an_import_receives_and_hands_over_the_last_chunk() {
    let now = Instant::now();
    let flow = ControllerFlow::Preview {
        transfer: "t".into(),
        salt: Salt([1; 16]),
        what: What::ALL,
        counts: Counts::default(),
        deadline: now,
    };
    let mut out = ControllerOut::default();
    // Another transfer's start changes nothing.
    let flow = flow.start_import("other", now, &mut out).unwrap();
    assert!(out.send.is_empty());
    let flow = flow.start_import("t", now, &mut out).unwrap();
    assert_eq!(
        out.send,
        [Message::TransferStart {
            transfer: "t".into(),
        }]
    );
    assert_eq!(flow.deadline(), Some(now + STEP_TIMEOUT));
    let (flow, out) = step(flow, chunk("t", 0, false), now);
    assert_eq!(
        out.send,
        [Message::TransferAck {
            transfer: "t".into(),
            seq: 0,
        }]
    );
    let (flow, out) = step(flow.unwrap(), chunk("t", 1, true), now);
    assert!(out.events.iter().any(|e| matches!(
        e,
        ControllerEvent::ImportReady { transfer, export, .. } if transfer == "t" && export.sent_at == 5
    )));
    let flow = flow.unwrap();
    assert_eq!(flow.deadline(), Some(now + WRITE_TIMEOUT));

    let mut out = ControllerOut::default();
    let flow = flow
        .imported("other", Ok(Report::default()), &mut out)
        .unwrap();
    assert!(out.send.is_empty());
    assert!(flow
        .imported("t", Ok(Report::default()), &mut out)
        .is_none());
    assert_eq!(
        out.send,
        [Message::TransferDone {
            transfer: "t".into(),
            report: Report::default(),
        }]
    );
}

#[test]
fn an_import_that_fails_to_write_tells_the_target() {
    let flow = ControllerFlow::Importing {
        transfer: "t".into(),
        deadline: later(),
    };
    let mut out = ControllerOut::default();
    assert!(flow
        .imported("t", Err(ErrorCode::Failed), &mut out)
        .is_none());
    assert_eq!(
        out.send,
        [Message::TransferError {
            transfer: "t".into(),
            code: ErrorCode::Failed,
        }]
    );
    assert_eq!(
        out.events,
        [ControllerEvent::Progress {
            transfer: "t".into(),
            progress: Progress::Failed(ErrorCode::Failed),
        }]
    );
}

#[test]
fn a_broken_chunk_ends_an_import() {
    let flow = ControllerFlow::Receiving(Box::new(Receiver::new(
        "t".into(),
        Salt([1; 16]),
        What::ALL,
        None,
        Instant::now(),
    )));
    let (next, out) = step(flow, chunk("t", 3, false), Instant::now());
    assert!(next.is_none());
    assert!(out.send.contains(&Message::TransferError {
        transfer: "t".into(),
        code: ErrorCode::Invalid,
    }));
}

#[test]
fn a_send_export_starts_the_window_or_reports_why_not() {
    let now = Instant::now();
    let mut out = ControllerOut::default();
    let exporting = || ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    };
    let flow = exporting()
        .send_export("other", Ok(export(1)), now, &mut out)
        .unwrap();
    assert!(out.send.is_empty());
    let flow = flow
        .send_export("t", Ok(export(5000)), now, &mut out)
        .unwrap();
    assert_eq!(out.send.len(), WINDOW);
    assert_eq!(flow.deadline(), Some(now + STEP_TIMEOUT));

    let mut out = ControllerOut::default();
    assert!(exporting()
        .send_export("t", Err(ErrorCode::Failed), now, &mut out)
        .is_none());
    assert_eq!(
        out.send,
        [Message::TransferError {
            transfer: "t".into(),
            code: ErrorCode::Failed,
        }]
    );
}

#[test]
fn a_sent_export_finishes_with_the_targets_report() {
    let now = Instant::now();
    let mut out = ControllerOut::default();
    let flow = ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    }
    .send_export("t", Ok(export(1)), now, &mut out)
    .unwrap();
    let ack = Message::TransferAck {
        transfer: "t".into(),
        seq: 0,
    };
    let (flow, out) = step(flow, ack, now);
    assert!(out.events.contains(&ControllerEvent::Progress {
        transfer: "t".into(),
        progress: Progress::Saving,
    }));
    let flow = flow.unwrap();
    assert_eq!(flow.deadline(), Some(now + WRITE_TIMEOUT));
    let done = Message::TransferDone {
        transfer: "t".into(),
        report: Report::default(),
    };
    let (flow, out) = step(flow, done, now);
    assert!(flow.is_none());
    assert_eq!(
        out.events,
        [ControllerEvent::Progress {
            transfer: "t".into(),
            progress: Progress::Done(Box::default()),
        }]
    );
}

#[test]
fn a_bad_ack_ends_a_send() {
    let now = Instant::now();
    let mut out = ControllerOut::default();
    let flow = ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    }
    .send_export("t", Ok(export(5000)), now, &mut out)
    .unwrap();
    let ack = Message::TransferAck {
        transfer: "t".into(),
        seq: 2,
    };
    let (flow, out) = step(flow, ack, now);
    assert!(flow.is_none());
    assert!(out.send.contains(&Message::TransferError {
        transfer: "t".into(),
        code: ErrorCode::Invalid,
    }));
}

#[test]
fn the_controller_stops_when_the_target_does() {
    for message in [
        Message::TransferCancel {
            transfer: "t".into(),
        },
        Message::TransferError {
            transfer: "t".into(),
            code: ErrorCode::Expired,
        },
    ] {
        let flow = ControllerFlow::Finishing {
            transfer: "t".into(),
            deadline: Instant::now(),
        };
        let (next, out) = step(flow, message, Instant::now());
        assert!(next.is_none());
        assert!(out.send.is_empty());
        assert!(matches!(
            out.events[..],
            [ControllerEvent::Progress {
                progress: Progress::Failed(_),
                ..
            }]
        ));
    }
}

#[test]
fn a_controller_message_for_another_transfer_is_given_back() {
    let flow = ControllerFlow::Finishing {
        transfer: "t".into(),
        deadline: Instant::now(),
    };
    let mut out = ControllerOut::default();
    let other = Message::TransferCancel {
        transfer: "u".into(),
    };
    let (flow, message) = *flow
        .receive(other.clone(), Instant::now(), &mut out)
        .unwrap_err();
    assert_eq!(message, other);
    assert_eq!(flow.transfer(), Some("t"));
    let (_, message) = *flow
        .receive(Message::Pong, Instant::now(), &mut out)
        .unwrap_err();
    assert_eq!(message, Message::Pong);
}

#[test]
fn a_controller_step_that_doesnt_fit_ends_the_transfer() {
    let flow = ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    };
    let (next, out) = step(flow, chunk("t", 0, true), Instant::now());
    assert!(next.is_none());
    assert!(out.send.contains(&Message::TransferError {
        transfer: "t".into(),
        code: ErrorCode::Invalid,
    }));
}

#[test]
fn granted_providers_go_in_parts_and_their_results_come_back() {
    let now = Instant::now();
    let (flow, out) = step(
        controller_asking(Asked::Providers(vec![settings("P0").named()])),
        granted(None, None),
        now,
    );
    assert_eq!(
        out.events,
        [ControllerEvent::ProvidersGranted { grant: "t".into() }]
    );
    assert_eq!(flow.as_ref().unwrap().deadline(), Some(now + GRANT_TIMEOUT));
    let mut out = ControllerOut::default();
    let flow = flow
        .unwrap()
        .send_providers("other", vec![settings("P0")], now, &mut out)
        .unwrap();
    assert!(out.send.is_empty());
    let flow = flow
        .send_providers("t", vec![settings("P0")], now, &mut out)
        .unwrap();
    assert_eq!(
        out.send,
        [Message::ProvidersSend {
            grant: "t".into(),
            part: 0,
            last: true,
            providers: vec![settings("P0")],
        }]
    );
    assert_eq!(flow.deadline(), Some(now + WRITE_TIMEOUT));
    let results = vec![ProviderResult {
        name: "P0".into(),
        outcome: ProviderOutcome::Failed,
        error: Some("Couldn't load".into()),
        saved_as: None,
    }];
    let added = Message::ProvidersAdded {
        grant: "t".into(),
        results: results.clone(),
    };
    let (next, out) = step(flow, added, now);
    assert!(next.is_none());
    assert_eq!(
        out.events,
        [ControllerEvent::Progress {
            transfer: "t".into(),
            progress: Progress::ProvidersDone(results),
        }]
    );
}

#[test]
fn providers_in_several_parts_number_them_and_mark_the_last() {
    let now = Instant::now();
    let flow = ControllerFlow::ProvidersGranted {
        grant: "g".into(),
        names: (0..30)
            .map(|i| settings(&format!("P{i}")).named())
            .collect(),
        deadline: later(),
    };
    let big: Vec<ProviderSettings> = (0..30)
        .map(|i| {
            let mut s = settings(&format!("P{i}"));
            s.url = "u".repeat(MAX_PROVIDER_FIELD);
            s
        })
        .collect();
    let mut out = ControllerOut::default();
    flow.send_providers("g", big, now, &mut out);
    let parts: Vec<(u32, bool)> = out
        .send
        .iter()
        .map(|m| match m {
            Message::ProvidersSend { part, last, .. } => (*part, *last),
            _ => panic!("{m:?}"),
        })
        .collect();
    assert!(parts.len() > 1);
    for (i, (part, last)) in parts.iter().enumerate() {
        assert_eq!(*part as usize, i);
        assert_eq!(*last, i == parts.len() - 1);
    }
}

#[test]
fn cancelling_tells_the_target_what_it_knows_of() {
    let mut out = ControllerOut::default();
    controller_asking(send_history()).cancel(&mut out);
    assert_eq!(out.send, [Message::Cancel]);
    assert!(out.events.is_empty());
    let mut out = ControllerOut::default();
    ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    }
    .cancel(&mut out);
    assert_eq!(
        out.send,
        [Message::TransferCancel {
            transfer: "t".into(),
        }]
    );
    assert_eq!(
        out.events,
        [ControllerEvent::Progress {
            transfer: "t".into(),
            progress: Progress::Failed(ErrorCode::Cancelled),
        }]
    );
}

#[test]
fn controller_flows_name_their_transfer_and_deadline() {
    let now = Instant::now();
    assert_eq!(controller_asking(send_history()).transfer(), None);
    let asking = ControllerFlow::asking(3, send_history(), now);
    assert_eq!(asking.deadline(), Some(now + ASK_TIMEOUT));
    let flows = [
        ControllerFlow::Importing {
            transfer: "a".into(),
            deadline: now,
        },
        ControllerFlow::ProvidersGranted {
            grant: "b".into(),
            names: vec![],
            deadline: now,
        },
        ControllerFlow::ProvidersSent {
            grant: "c".into(),
            deadline: now,
        },
        ControllerFlow::Finishing {
            transfer: "d".into(),
            deadline: now,
        },
    ];
    let ids: Vec<_> = flows.iter().map(|f| f.transfer().unwrap()).collect();
    assert_eq!(ids, ["a", "b", "c", "d"]);
    let deadlines: Vec<_> = flows.iter().map(ControllerFlow::deadline).collect();
    assert_eq!(deadlines, [Some(now); 4]);
    let mut out = ControllerOut::default();
    let importing = ControllerFlow::Importing {
        transfer: "a".into(),
        deadline: later(),
    };
    assert!(importing.tick(now, &mut out).is_some());
    assert!(out.send.is_empty());
}

// From the review of #343.

/// A chunk carrying `export`'s items and pins.
fn carrying(transfer: &str, export: &Export) -> Message {
    let (mut chunks, _) = chunks::split(export, 5);
    assert_eq!(chunks.len(), 1);
    Message::TransferChunk {
        transfer: transfer.into(),
        chunk: chunks.remove(0),
    }
}

/// A granted "send" of only `what`, with `counts` announced.
fn receiving_only(what: What, counts: Option<Counts>, now: Instant) -> (TargetFlow, String) {
    let mut steps = Vec::new();
    let asked = Asked::History {
        direction: Direction::Send,
        what,
        counts,
    };
    let flow = asking(asked).granted(now, &mut steps).unwrap();
    let id = flow.transfer().unwrap().to_string();
    (flow, id)
}

fn imports(steps: &[Step]) -> usize {
    steps
        .iter()
        .filter(|s| matches!(s, Step::Import { .. }))
        .count()
}

#[test]
fn a_send_carrying_more_kinds_than_allowed_writes_nothing() {
    let history_only = What {
        history: true,
        favorites: false,
        pins: false,
    };
    let mut extra = export(2);
    extra.items[0].favorite = true;
    let (flow, id) = receiving_only(history_only, None, Instant::now());
    let mut steps = Vec::new();
    assert!(flow_of(flow, carrying(&id, &extra), &mut steps).is_none());
    assert_eq!(imports(&steps), 0);
    assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Invalid)]);

    let mut pinned = export(1);
    pinned.pins.push(crate::remote::transfer::Pin {
        account: crate::remote::transfer::refs::AccountTag::try_from("ab".repeat(16)).unwrap(),
        content_type: "live".into(),
        group: "News".into(),
    });
    let (flow, id) = receiving_only(history_only, None, Instant::now());
    let mut steps = Vec::new();
    assert!(flow_of(flow, carrying(&id, &pinned), &mut steps).is_none());
    assert_eq!(imports(&steps), 0);

    let favorites_only = What {
        history: false,
        favorites: true,
        pins: false,
    };
    let (flow, id) = receiving_only(favorites_only, None, Instant::now());
    let mut steps = Vec::new();
    assert!(flow_of(flow, carrying(&id, &export(1)), &mut steps).is_none());
    assert_eq!(imports(&steps), 0);

    // What was allowed goes through.
    let (flow, id) = receiving_only(history_only, None, Instant::now());
    let mut steps = Vec::new();
    assert!(flow_of(flow, carrying(&id, &export(2)), &mut steps).is_some());
    assert_eq!(imports(&steps), 1);
}

#[test]
fn a_send_far_bigger_than_announced_writes_nothing() {
    let counts = |history| Counts {
        history,
        ..Counts::default()
    };
    // 3 announced: up to 53 is fine, a few more were watched meanwhile.
    for (items, written) in [(53, 1), (54, 0)] {
        let (flow, id) = receiving_only(What::ALL, Some(counts(3)), Instant::now());
        let mut steps = Vec::new();
        flow_of(flow, carrying(&id, &export(items)), &mut steps);
        assert_eq!(imports(&steps), written, "{items}");
    }
    let favorites = Counts {
        favorites: 0,
        ..Counts::default()
    };
    let mut faves = export(0);
    for n in 0..51 {
        let mut item = export(1).items.remove(0);
        item.watched = None;
        item.favorite = true;
        item.reference.name = format!("Fav {n}");
        faves.items.push(item);
    }
    let (flow, id) = receiving_only(What::ALL, Some(favorites), Instant::now());
    let mut steps = Vec::new();
    flow_of(flow, carrying(&id, &faves), &mut steps);
    assert_eq!(imports(&steps), 0);
}

#[test]
fn the_allowance_over_an_announced_count_is_a_tenth_and_fifty() {
    assert_eq!(allowed(0), 50);
    assert_eq!(allowed(100), 160);
    assert_eq!(allowed(u32::MAX), u32::MAX);
}

#[test]
fn counts_of_each_kind_are_checked() {
    let exported = Export {
        pins: (0..60)
            .map(|n| crate::remote::transfer::Pin {
                account: crate::remote::transfer::refs::AccountTag::try_from("ab".repeat(16))
                    .unwrap(),
                content_type: "live".into(),
                group: format!("G{n}"),
            })
            .collect(),
        ..export(0)
    };
    assert!(!fits_grant(&exported, What::ALL, Some(Counts::default())));
    assert!(fits_grant(&exported, What::ALL, None));
    let positions = Export {
        items: (0..60)
            .map(|n| Item {
                reference: ItemRef::named(ItemKind::Movie, format!("M{n}")),
                watched: None,
                position: Some(crate::remote::transfer::Position {
                    position: 1.0,
                    duration: 2.0,
                    updated_at: 1,
                    finished: false,
                }),
                favorite: false,
            })
            .collect(),
        ..export(0)
    };
    assert!(!fits_grant(&positions, What::ALL, Some(Counts::default())));
    let no_history = What {
        history: false,
        ..What::ALL
    };
    assert!(!fits_grant(&positions, no_history, None));
}

#[test]
fn once_the_target_writes_a_cancel_or_error_doesnt_stop_it() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let mut steps = Vec::new();
    let flow = flow_of(flow, chunk(&id, 0, true), &mut steps).unwrap();
    assert!(matches!(flow, TargetFlow::Importing { .. }));
    for late in [
        Message::TransferCancel {
            transfer: id.clone(),
        },
        Message::TransferError {
            transfer: id.clone(),
            code: ErrorCode::Expired,
        },
        chunk(&id, 1, true),
    ] {
        steps.clear();
        let next = flow_of(flow_back(&id), late, &mut steps);
        assert!(matches!(next, Some(TargetFlow::Importing { .. })));
        assert!(steps.is_empty());
    }
    steps.clear();
    assert!(flow
        .imported(&id, Ok(Report::default()), &mut steps)
        .is_none());
    assert!(sent(&steps).contains(&&Message::TransferDone {
        transfer: id,
        report: Report::default(),
    }));
}

fn flow_back(id: &str) -> TargetFlow {
    TargetFlow::Importing {
        transfer: id.into(),
        deadline: later(),
    }
}

#[test]
fn saving_providers_isnt_stopped_either() {
    let saving = TargetFlow::Saving {
        grant: "g".into(),
        deadline: later(),
    };
    let mut steps = Vec::new();
    let next = flow_of(
        saving,
        Message::TransferCancel {
            transfer: "g".into(),
        },
        &mut steps,
    );
    assert!(matches!(next, Some(TargetFlow::Saving { .. })));
    assert!(steps.is_empty());
}

#[test]
fn the_controller_keeps_waiting_while_the_target_writes() {
    let now = Instant::now();
    for flow in [
        ControllerFlow::Finishing {
            transfer: "t".into(),
            deadline: now + WRITE_TIMEOUT,
        },
        ControllerFlow::ProvidersSent {
            grant: "t".into(),
            deadline: now + WRITE_TIMEOUT,
        },
        ControllerFlow::Importing {
            transfer: "t".into(),
            deadline: now + WRITE_TIMEOUT,
        },
    ] {
        let mut out = ControllerOut::default();
        // Cancelling is too late.
        let flow = flow.cancel(&mut out).expect("too late to cancel");
        assert_eq!(out, ControllerOut::default());
        // Providers that take minutes to load don't time out.
        let flow = flow
            .tick(now + Duration::from_secs(61), &mut out)
            .expect("still waiting");
        assert!(out.send.is_empty());
        assert!(flow.tick(now + WRITE_TIMEOUT, &mut out).is_none());
    }
}

#[test]
fn an_import_this_device_writes_ignores_the_target() {
    let flow = ControllerFlow::Importing {
        transfer: "t".into(),
        deadline: later(),
    };
    let (flow, out) = step(
        flow,
        Message::TransferCancel {
            transfer: "t".into(),
        },
        Instant::now(),
    );
    assert!(matches!(flow, Some(ControllerFlow::Importing { .. })));
    assert_eq!(out, ControllerOut::default());
}

#[test]
fn a_lost_connection_ends_the_controllers_transfer_unless_it_writes() {
    let mut out = ControllerOut::default();
    let importing = ControllerFlow::Importing {
        transfer: "t".into(),
        deadline: later(),
    };
    assert!(importing.lost(&mut out).is_some());
    assert!(out.events.is_empty());
    let sending = ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    };
    assert!(sending.lost(&mut out).is_none());
    assert_eq!(
        out.events,
        [ControllerEvent::Progress {
            transfer: "t".into(),
            progress: Progress::Failed(ErrorCode::Cancelled),
        }]
    );
    let mut out = ControllerOut::default();
    assert!(controller_asking(send_history()).lost(&mut out).is_none());
    assert_eq!(out.events, [ControllerEvent::Refused(ErrorCode::Cancelled)]);
}

#[test]
fn an_unanswered_request_stops_asking() {
    let now = Instant::now();
    let flow = ControllerFlow::asking(3, send_history(), now);
    let mut out = ControllerOut::default();
    let flow = flow
        .tick(now + ASK_TIMEOUT - Duration::from_millis(1), &mut out)
        .unwrap();
    assert_eq!(out, ControllerOut::default());
    assert!(flow.tick(now + ASK_TIMEOUT, &mut out).is_none());
    assert_eq!(out.send, [Message::Cancel]);
    assert_eq!(out.events, [ControllerEvent::Refused(ErrorCode::Expired)]);
}

#[test]
fn an_export_that_never_comes_ends_the_request() {
    let now = Instant::now();
    let import = Asked::History {
        direction: Direction::Import,
        what: What::ALL,
        counts: None,
    };
    let mut steps = Vec::new();
    let flow = asking(import).granted(now, &mut steps).unwrap();
    assert!(flow.untouched());
    steps.clear();
    assert!(flow.tick(now + GRANT_TIMEOUT, &mut steps).is_none());
    assert_eq!(
        sent(&steps),
        [&Message::Error {
            re: Some(7),
            code: ErrorCode::Expired,
        }]
    );
    assert!(progress_of(&steps).is_empty());
}

#[test]
fn a_flow_is_untouched_until_its_first_step() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    assert!(flow.untouched());
    let mut steps = Vec::new();
    let flow = flow_of(flow, chunk(&id, 0, false), &mut steps).unwrap();
    assert!(!flow.untouched());
    let (providers, grant) = granted_providers(now, 2);
    assert!(providers.untouched());
    let providers = flow_of(
        providers,
        providers_send(&grant, 0, false, &["P0"]),
        &mut steps,
    )
    .unwrap();
    assert!(!providers.untouched());
    let (ready, _) = ready(now, 3);
    assert!(ready.untouched());
    assert!(!TargetFlow::Saving {
        grant: "g".into(),
        deadline: later()
    }
    .untouched());
    assert!(!asking(send_history()).untouched());
}

#[test]
fn a_flow_expects_only_its_own_next_step() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    assert!(flow.expects(&chunk(&id, 0, false)));
    assert!(!flow.expects(&chunk("other", 0, false)));
    assert!(!flow.expects(&Message::TransferAck {
        transfer: id.clone(),
        seq: 0,
    }));
    assert!(!flow.expects(&Message::TransferCancel { transfer: id }));
    let (ready, id) = ready(now, 3);
    assert!(ready.expects(&Message::TransferStart {
        transfer: id.clone()
    }));
    let mut steps = Vec::new();
    let sending = flow_of(
        ready,
        Message::TransferStart {
            transfer: id.clone(),
        },
        &mut steps,
    )
    .unwrap();
    assert!(sending.expects(&Message::TransferAck {
        transfer: id.clone(),
        seq: 0,
    }));
    let finishing = TargetFlow::Finishing {
        transfer: id.clone(),
        deadline: now,
    };
    assert!(finishing.expects(&Message::TransferDone {
        transfer: id,
        report: Report::default(),
    }));
    let (providers, grant) = granted_providers(now, 1);
    assert!(providers.expects(&providers_send(&grant, 0, true, &["P0"])));
    assert!(!asking(send_history()).expects(&chunk("x", 0, true)));
}

#[test]
fn transfer_ids_are_32_hex_digits() {
    assert!(valid_id(&new_grant()));
    assert!(valid_id(&"AB".repeat(16)));
    assert!(!valid_id(&"ab".repeat(17)));
    assert!(!valid_id(&"ab".repeat(15)));
    assert!(!valid_id(&"zz".repeat(16)));
}

#[test]
fn providers_trickling_in_still_end_at_the_limit() {
    let now = Instant::now();
    let (mut flow, grant) = granted_providers(now, 30);
    let mut at = now;
    let mut steps = Vec::new();
    for part in 0..20 {
        at += Duration::from_secs(29);
        flow = flow.tick(at, &mut steps).expect("each part comes in time");
        let name = format!("P{part}");
        flow = flow
            .receive(
                providers_send(&grant, part, false, &[&name]),
                at,
                &mut steps,
            )
            .unwrap()
            .unwrap();
    }
    // 20 × 29 s is 580 s. The limit comes before the next step is due.
    assert!(flow.tick(now + TRANSFER_LIMIT, &mut steps).is_none());
    assert!(progress_of(&steps).contains(&&Progress::Failed(ErrorCode::Expired)));
}

#[test]
fn an_empty_providers_part_is_refused() {
    let now = Instant::now();
    let (flow, grant) = granted_providers(now, 2);
    let mut steps = Vec::new();
    assert!(flow_of(flow, providers_send(&grant, 0, false, &[]), &mut steps).is_none());
    assert_eq!(progress_of(&steps), [&Progress::Failed(ErrorCode::Invalid)]);
}

#[test]
fn three_parts_go_in_order() {
    let now = Instant::now();
    let (flow, grant) = granted_providers(now, 3);
    let mut steps = Vec::new();
    let flow = flow_of(flow, providers_send(&grant, 0, false, &["P0"]), &mut steps).unwrap();
    let flow = flow_of(flow, providers_send(&grant, 1, false, &["P1"]), &mut steps).unwrap();
    let flow = flow_of(flow, providers_send(&grant, 2, true, &["P2"]), &mut steps).unwrap();
    assert!(matches!(flow, TargetFlow::Saving { .. }));
}

#[test]
fn a_receiver_says_when_a_transfer_is_too_large() {
    let now = Instant::now();
    let (flow, id) = receiving(now);
    let big = Message::TransferChunk {
        transfer: id,
        chunk: Chunk {
            seq: 0,
            last: false,
            sent_at: Some(5),
            current: None,
            dropped: None,
            items: export(chunks::MAX_ITEMS + 1).items,
            pins: vec![],
        },
    };
    let mut steps = Vec::new();
    assert!(flow.receive(big, now, &mut steps).unwrap().is_none());
    assert_eq!(
        progress_of(&steps),
        [&Progress::Failed(ErrorCode::TooLarge)]
    );
}

#[test]
fn an_export_too_large_to_take_isnt_sent() {
    let now = Instant::now();
    let huge = export(chunks::MAX_ITEMS + 1);
    let mut out = ControllerOut::default();
    let flow = ControllerFlow::Exporting {
        transfer: "t".into(),
        deadline: later(),
    };
    assert!(flow
        .send_export("t", Ok(huge.clone()), now, &mut out)
        .is_none());
    assert_eq!(
        out.send,
        [Message::TransferError {
            transfer: "t".into(),
            code: ErrorCode::TooLarge,
        }]
    );

    let import = Asked::History {
        direction: Direction::Import,
        what: What::ALL,
        counts: None,
    };
    let mut steps = Vec::new();
    let flow = asking(import).granted(now, &mut steps).unwrap();
    let id = flow.transfer().unwrap().to_string();
    steps.clear();
    assert!(flow.exported(&id, Ok(huge), now, &mut steps).is_none());
    assert_eq!(
        sent(&steps),
        [&Message::Error {
            re: Some(7),
            code: ErrorCode::TooLarge,
        }]
    );
}

#[test]
fn only_the_granted_providers_go_each_once() {
    let now = Instant::now();
    let flow = ControllerFlow::ProvidersGranted {
        grant: "g".into(),
        names: vec![settings("P0").named()],
        deadline: later(),
    };
    let mut out = ControllerOut::default();
    flow.send_providers(
        "g",
        vec![settings("P0"), settings("Other"), settings("P0")],
        now,
        &mut out,
    );
    assert_eq!(
        out.send,
        [Message::ProvidersSend {
            grant: "g".into(),
            part: 0,
            last: true,
            providers: vec![settings("P0")],
        }]
    );
    let flow = ControllerFlow::ProvidersGranted {
        grant: "g".into(),
        names: vec![settings("P0").named()],
        deadline: later(),
    };
    let mut out = ControllerOut::default();
    assert!(flow.send_providers("g", vec![], now, &mut out).is_none());
    assert_eq!(
        out.send,
        [Message::TransferError {
            transfer: "g".into(),
            code: ErrorCode::Invalid,
        }]
    );
}

#[test]
fn a_grant_for_another_request_is_given_back() {
    let mut out = ControllerOut::default();
    let other = Message::Granted {
        re: 99,
        transfer: "t".into(),
        salt: Some(Salt([3; 16]).to_hex()),
        counts: None,
    };
    let back = controller_asking(send_history())
        .receive(other, Instant::now(), &mut out)
        .unwrap_err();
    assert!(matches!(back.0, ControllerFlow::Asking { .. }));
    assert!(out.events.is_empty());
}

#[test]
fn provider_names_that_would_hide_or_reorder_the_dialog_are_refused() {
    for name in [
        "\u{202e}x",
        "a\nb",
        "a\u{200b}b",
        "a\u{2028}b",
        " Home",
        "Home ",
    ] {
        let request = Asked::Providers(vec![ProviderName {
            name: name.into(),
            kind: ProviderKind::M3u,
        }])
        .request(1);
        assert_eq!(Asked::from_request(&request), None, "{name:?}");
    }
    let long = Asked::Providers(vec![ProviderName {
        name: "é".repeat(60),
        kind: ProviderKind::M3u,
    }]);
    assert!(
        Asked::from_request(&long.request(1)).is_some(),
        "longer than a device name"
    );
}

#[test]
fn provider_parts_fill_each_message_close_to_the_limit() {
    let size = |s: &ProviderSettings| serde_json::to_vec(s).unwrap().len() + 1;
    for pad in [0, 1, 2, 3, 50, 400] {
        let all: Vec<ProviderSettings> = (0..30)
            .map(|i| {
                let mut s = settings(&format!("P{i}"));
                s.url = format!("http://{}.example/", "a".repeat(3000 + pad));
                s
            })
            .collect();
        let each = size(&all[0]);
        let parts = provider_parts(all);
        for part in &parts[..parts.len() - 1] {
            let used: usize = part.iter().map(size).sum();
            assert!(used <= chunks::CHUNK_BYTES, "pad {pad}");
            // The next one wouldn't have fit.
            assert!(used + each > chunks::CHUNK_BYTES, "pad {pad}");
        }
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 30);
    }
}

#[test]
fn continue_watching_comes_only_with_the_history() {
    let with_current = Export {
        current: Some(ItemRef::named(ItemKind::Movie, "Heat")),
        ..Export::default()
    };
    let favorites_only = What {
        history: false,
        ..What::ALL
    };
    assert!(fits_grant(&with_current, What::ALL, None));
    assert!(!fits_grant(&with_current, favorites_only, None));
    assert!(fits_grant(&Export::default(), favorites_only, None));
}
