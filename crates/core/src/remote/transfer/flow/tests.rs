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
        .receive(chunk(&id, 0, false), 100, later, &mut steps)
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
        .receive(chunk(&id, 1, true), 100, now, &mut steps)
        .unwrap()
        .unwrap();
    assert!(matches!(flow, TargetFlow::Importing { .. }));
    assert_eq!(flow.deadline(), None);
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
    let flow = flow
        .receive(chunk(&id, 1, false), 100, now, &mut steps)
        .unwrap();
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
        .receive(chunk("other", 0, true), 100, now, &mut steps)
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
    flow.receive(message, 10, Instant::now(), steps).unwrap()
}

#[test]
fn a_message_that_isnt_a_transfer_step_is_given_back() {
    let now = Instant::now();
    let (flow, _) = receiving(now);
    let mut steps = Vec::new();
    let (flow, message) = *flow.receive(Message::Ping, 4, now, &mut steps).unwrap_err();
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
    let saving = TargetFlow::Saving { grant: "g".into() };
    assert!(saving.tick(far, &mut steps).is_some());
    assert!(steps.is_empty());
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
    assert_eq!(flow.deadline(), None);
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
    let flow = flow.receive(start, 10, later, &mut steps).unwrap().unwrap();
    assert_eq!(flow.deadline(), Some(later + STEP_TIMEOUT));
    let chunks = sent(&steps).len();
    assert_eq!(chunks, WINDOW);
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
        flow = flow_of(flow, ack, &mut steps).unwrap();
        assert_eq!(
            progress_of(&steps),
            [&Progress::Sending {
                done: seq + 1,
                total,
            }]
        );
    }
    assert!(matches!(flow, TargetFlow::Finishing { .. }));
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
        .receive(
            providers_send(&grant, 1, true, &["P1"]),
            1,
            later,
            &mut steps,
        )
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
        .receive(
            providers_send(&grant, 0, false, &["P0"]),
            1,
            later,
            &mut steps,
        )
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
        TargetFlow::Saving { grant: "g".into() }.kind(),
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
        },
        TargetFlow::Finishing {
            transfer: "b".into(),
            deadline: now,
        },
        TargetFlow::Saving { grant: "c".into() },
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
    ControllerFlow::Asking { id: 3, asked }
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
    let next = flow.receive(message, 10, now, &mut out).unwrap();
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
        .receive(other, 1, now, &mut out)
        .is_err());
    let control = Message::Pending {
        expires_in: 10,
        re: None,
    };
    assert!(controller_asking(send_history())
        .receive(control, 1, now, &mut out)
        .is_err());
    let error = Message::Error {
        re: Some(9),
        code: ErrorCode::Denied,
    };
    assert!(controller_asking(send_history())
        .receive(error, 1, now, &mut out)
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
    let (next, out) = step(
        controller_asking(send_history()),
        granted(Some(salt), None),
        Instant::now(),
    );
    assert!(matches!(next, Some(ControllerFlow::Exporting { .. })));
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
    assert_eq!(flow.deadline(), None);

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
    assert_eq!(flow.deadline(), Some(now + STEP_TIMEOUT));
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
        .receive(other.clone(), 1, Instant::now(), &mut out)
        .unwrap_err();
    assert_eq!(message, other);
    assert_eq!(flow.transfer(), Some("t"));
    let (_, message) = *flow
        .receive(Message::Pong, 1, Instant::now(), &mut out)
        .unwrap_err();
    assert_eq!(message, Message::Pong);
}

#[test]
fn a_controller_step_that_doesnt_fit_ends_the_transfer() {
    let flow = ControllerFlow::Exporting {
        transfer: "t".into(),
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
        controller_asking(Asked::Providers(names(1))),
        granted(None, None),
        now,
    );
    assert_eq!(
        out.events,
        [ControllerEvent::ProvidersGranted { grant: "t".into() }]
    );
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
    assert_eq!(flow.deadline(), Some(now + GRANT_TIMEOUT));
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
    let flow = ControllerFlow::ProvidersGranted { grant: "g".into() };
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
    assert_eq!(controller_asking(send_history()).deadline(), None);
    let flows = [
        ControllerFlow::Importing {
            transfer: "a".into(),
        },
        ControllerFlow::ProvidersGranted { grant: "b".into() },
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
    assert_eq!(deadlines, [None, None, Some(now), Some(now)]);
    let mut out = ControllerOut::default();
    let far = now + Duration::from_secs(100_000);
    assert!(ControllerFlow::Importing {
        transfer: "a".into(),
    }
    .tick(far, &mut out)
    .is_some());
    assert!(out.send.is_empty());
}

#[test]
fn progress_reads_as_a_state_with_its_data() {
    let json = |p: Progress| serde_json::to_value(p).unwrap();
    assert_eq!(
        json(Progress::Sending { done: 1, total: 4 }),
        serde_json::json!({ "state": "sending", "data": { "done": 1, "total": 4 } })
    );
    assert_eq!(
        json(Progress::Saving),
        serde_json::json!({ "state": "saving" })
    );
    assert_eq!(
        json(Progress::Failed(ErrorCode::Expired)),
        serde_json::json!({ "state": "failed", "data": "expired" })
    );
    assert_eq!(
        json(Progress::ProvidersDone(vec![])),
        serde_json::json!({ "state": "providersDone", "data": [] })
    );
}
