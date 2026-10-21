// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! History and provider transfers between a target and its controllers, in
//! memory: the consent spec 5 asks for, denial, expiry, interruption, and a
//! grant that can't be used twice.

use super::consent::{Answer, CONSENT_TIMEOUT};
use super::controller::{AskError, Event};
use super::message::{ErrorCode, Message, RequestKind};
use super::settings::{ControlMode, RemoteSettings};
use super::target::Action;
use super::tests::Net;
use super::transfer::flow::{
    ControllerEvent, Direction, Progress, ProviderKind, ProviderName, ProviderOutcome,
    ProviderResult, ProviderSettings, GRANT_TIMEOUT, STEP_TIMEOUT,
};
use super::transfer::merge::{Report, Tally};
use super::transfer::refs::Salt;
use super::transfer::{Counts, Export, Item, ItemKind, ItemRef, Watched, What};
use std::time::Duration;

/// A target that offers both transfers, with one controller in a session.
fn connected() -> (Net, usize) {
    let mut net = Net::with_mode(ControlMode::Always);
    net.target.offer(true, true);
    let phone = net.connect("Phone");
    assert!(net.clients[phone].connected());
    (net, phone)
}

fn export(items: usize) -> Export {
    Export {
        items: (0..items)
            .map(|n| Item {
                reference: ItemRef {
                    tvg_id: Some(format!("channel-{n}.example")),
                    ..ItemRef::named(ItemKind::Live, format!("Channel {n} with a longer name"))
                },
                watched: Some(Watched {
                    first_watched_at: 1,
                    last_watched_at: 2,
                    play_count: 3,
                    watched_seconds: 4,
                }),
                position: None,
                favorite: true,
            })
            .collect(),
        pins: vec![],
        current: Some(ItemRef::named(ItemKind::Live, "Channel 0")),
        sent_at: 99,
    }
}

fn report() -> Report {
    Report {
        history: Tally {
            added: 2,
            ..Tally::default()
        },
        ..Report::default()
    }
}

/// Lets time pass with the phone pinging, as a real controller does, so
/// only the transfer's own clocks run out.
fn wait(net: &mut Net, phone: usize, by: Duration) {
    let step = Duration::from_secs(5);
    let mut left = by;
    while left > Duration::ZERO {
        let now = step.min(left);
        if let Some(bytes) = net.clients[phone].controller.ping() {
            net.send(phone, bytes);
        }
        net.advance(now);
        left -= now;
    }
}

fn ask(net: &mut Net, client: usize, direction: Direction) {
    let counts = (direction == Direction::Send).then_some(Counts {
        history: 3,
        ..Counts::default()
    });
    let bytes = net.clients[client]
        .controller
        .ask_history(direction, What::ALL, counts)
        .unwrap();
    net.send(client, bytes);
}

fn transfer_events(net: &Net, client: usize) -> Vec<ControllerEvent> {
    net.clients[client]
        .events
        .iter()
        .filter_map(|e| match e {
            Event::Transfer(t) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

fn last_progress(net: &Net, client: usize) -> Option<Progress> {
    transfer_events(net, client)
        .into_iter()
        .rev()
        .find_map(|e| match e {
            ControllerEvent::Progress { progress, .. } => Some(progress),
            _ => None,
        })
}

fn refused(net: &Net, client: usize) -> Option<ErrorCode> {
    transfer_events(net, client)
        .into_iter()
        .find_map(|e| match e {
            ControllerEvent::Refused(code) => Some(code),
            _ => None,
        })
}

/// The `ExportNeeded` the controller got, as (transfer, salt).
fn export_needed(net: &Net, client: usize) -> Option<(String, Salt)> {
    transfer_events(net, client)
        .into_iter()
        .find_map(|e| match e {
            ControllerEvent::ExportNeeded { transfer, salt, .. } => Some((transfer, salt)),
            _ => None,
        })
}

/// Takes the target's actions of one sort out of its log.
fn take<T>(net: &mut Net, f: impl Fn(&Action) -> Option<T>) -> Vec<T> {
    let found = net.log.iter().filter_map(&f).collect();
    net.log.retain(|a| f(a).is_none());
    found
}

fn imports(net: &mut Net) -> Vec<(super::ConnId, String, Salt, Export)> {
    take(net, |a| match a {
        Action::ImportHistory {
            conn,
            transfer,
            salt,
            export,
        } => Some((*conn, transfer.clone(), *salt, (**export).clone())),
        _ => None,
    })
}

fn target_progress(net: &Net) -> Vec<Progress> {
    net.log
        .iter()
        .filter_map(|a| match a {
            Action::TransferProgress { progress, .. } => Some(progress.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn always_allow_still_asks_before_a_transfer() {
    let (mut net, phone) = connected();
    assert_eq!(net.prompt(), None);
    ask(&mut net, phone, Direction::Send);
    let prompt = net.prompt().expect("the target asks its user");
    assert_eq!(prompt.name, "Phone");
    assert_eq!(
        prompt.asked,
        Some(super::transfer::flow::Asked::History {
            direction: Direction::Send,
            what: What::ALL,
            counts: Some(Counts {
                history: 3,
                ..Counts::default()
            }),
        })
    );
    assert_eq!(
        transfer_events(&net, phone),
        [ControllerEvent::Pending { expires_in: 30 }]
    );
    assert!(net.applied.is_empty());
}

#[test]
fn a_controls_dialog_has_nothing_asked() {
    let mut net = Net::new(RemoteSettings::default());
    net.connect("Phone");
    assert_eq!(net.prompt().unwrap().asked, None);
}

#[test]
fn sending_history_goes_in_chunks_and_is_written_once_at_the_end() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    net.answer(Answer::Allow);
    let (transfer, salt) = export_needed(&net, phone).expect("the phone is asked to export");
    // Big enough for more chunks than the rate limit allows messages in a
    // second, all sent at the same moment.
    let sent = export(12_000);
    let out = net.clients[phone]
        .controller
        .send_export(&transfer, Ok(sent.clone()), net.now);
    net.clients[phone].events.extend(out.events);
    net.send_all(phone, out.send);
    let found = imports(&mut net);
    assert_eq!(found.len(), 1);
    let (conn, got_transfer, got_salt, got) = found.into_iter().next().unwrap();
    assert_eq!((got_transfer.as_str(), got_salt), (transfer.as_str(), salt));
    assert_eq!(got, sent);
    let chunks = target_progress(&net)
        .iter()
        .filter(|p| matches!(p, Progress::Receiving { .. }))
        .count();
    assert!(chunks > 20, "{chunks} chunks");
    assert_eq!(target_progress(&net).last(), Some(&Progress::Saving));
    assert_eq!(last_progress(&net, phone), Some(Progress::Saving));

    let actions = net.target.imported(conn, &transfer, Ok(report()));
    net.handle(actions);
    assert_eq!(
        last_progress(&net, phone),
        Some(Progress::Done(Box::new(report())))
    );
    assert_eq!(
        target_progress(&net).last(),
        Some(&Progress::Done(Box::new(report())))
    );
    assert!(net.clients[phone].connected());
}

#[test]
fn importing_history_shows_a_preview_and_waits_for_start() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Import);
    net.answer(Answer::Allow);
    let (conn, transfer, salt, what) = take(&mut net, |a| match a {
        Action::ExportHistory {
            conn,
            transfer,
            salt,
            what,
        } => Some((*conn, transfer.clone(), *salt, *what)),
        _ => None,
    })
    .pop()
    .expect("the target exports");
    assert_eq!(what, What::ALL);
    let sent = export(5);
    let actions = net
        .target
        .exported(conn, &transfer, Ok(sent.clone()), net.now);
    net.handle(actions);
    net.pump();
    assert!(
        transfer_events(&net, phone).contains(&ControllerEvent::Preview {
            transfer: transfer.clone(),
            counts: sent.counts(),
        })
    );
    // Nothing comes until the phone's user starts it.
    assert!(!transfer_events(&net, phone)
        .iter()
        .any(|e| matches!(e, ControllerEvent::ImportReady { .. })));

    let out = net.clients[phone]
        .controller
        .start_import(&transfer, net.now);
    net.send_all(phone, out.send);
    let ready = transfer_events(&net, phone)
        .into_iter()
        .find_map(|e| match e {
            ControllerEvent::ImportReady {
                transfer,
                salt,
                export,
            } => Some((transfer, salt, *export)),
            _ => None,
        })
        .expect("the history arrives");
    assert_eq!(ready, (transfer.clone(), salt, sent));

    let out = net.clients[phone]
        .controller
        .imported(&transfer, Ok(report()));
    net.clients[phone].events.extend(out.events);
    net.send_all(phone, out.send);
    assert_eq!(
        last_progress(&net, phone),
        Some(Progress::Done(Box::new(report())))
    );
    assert_eq!(
        target_progress(&net).last(),
        Some(&Progress::Done(Box::new(report())))
    );
}

#[test]
fn an_import_the_target_cant_export_is_refused() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Import);
    net.answer(Answer::Allow);
    let (conn, transfer) = take(&mut net, |a| match a {
        Action::ExportHistory { conn, transfer, .. } => Some((*conn, transfer.clone())),
        _ => None,
    })
    .pop()
    .unwrap();
    let actions = net
        .target
        .exported(conn, &transfer, Err(ErrorCode::Failed), net.now);
    net.handle(actions);
    assert_eq!(refused(&net, phone), Some(ErrorCode::Failed));
    assert!(net.clients[phone].connected());
}

#[test]
fn a_denied_transfer_leaves_control_alone_and_cools_down() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    net.answer(Answer::Deny);
    assert_eq!(refused(&net, phone), Some(ErrorCode::Denied));
    assert!(net.clients[phone].connected());
    assert_eq!(net.prompt(), None);
    assert_eq!(export_needed(&net, phone), None);

    // Asking again at once gets no dialog.
    net.clients[phone].events.clear();
    ask(&mut net, phone, Direction::Send);
    assert_eq!(refused(&net, phone), Some(ErrorCode::Denied));
    assert_eq!(net.prompt(), None);
}

#[test]
fn a_dismissed_dialog_grants_nothing() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    net.answer(Answer::Dismiss);
    assert_eq!(refused(&net, phone), Some(ErrorCode::Denied));
    assert_eq!(export_needed(&net, phone), None);
}

#[test]
fn an_unanswered_transfer_expires_and_grants_nothing() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    wait(&mut net, phone, CONSENT_TIMEOUT);
    assert_eq!(refused(&net, phone), Some(ErrorCode::Expired));
    assert_eq!(net.prompt(), None);
    assert!(net.clients[phone].connected());
}

#[test]
fn cancelling_while_asking_takes_the_dialog_down() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    assert!(net.prompt().is_some());
    let out = net.clients[phone].controller.cancel_transfer();
    net.send_all(phone, out.send);
    assert_eq!(net.prompt(), None);
    assert!(net.clients[phone].connected());
    // Asking again works.
    ask(&mut net, phone, Direction::Send);
    assert!(net.prompt().is_some());
}

#[test]
fn a_cancel_with_nothing_asked_isnt_offered() {
    let (mut net, phone) = connected();
    let bytes = net.clients[phone]
        .controller
        .seal_raw(&Message::Cancel)
        .unwrap();
    net.send(phone, bytes);
    assert!(net.clients[phone]
        .events
        .contains(&Event::Error(ErrorCode::Unsupported)));
    assert!(net.clients[phone].connected());
}

/// Allows a "send" and returns the transfer id.
fn granted_send(net: &mut Net, phone: usize) -> String {
    ask(net, phone, Direction::Send);
    net.answer(Answer::Allow);
    export_needed(net, phone).unwrap().0
}

#[test]
fn a_transfer_cut_off_writes_nothing() {
    let (mut net, phone) = connected();
    let transfer = granted_send(&mut net, phone);
    let mut out = net.clients[phone]
        .controller
        .send_export(&transfer, Ok(export(12_000)), net.now);
    // Two chunks arrive before the connection drops.
    net.queue(phone, std::mem::take(&mut out.send));
    net.deliver(phone);
    net.deliver(phone);
    net.drop_link(phone);
    assert!(imports(&mut net).is_empty());
}

#[test]
fn a_cancelled_transfer_writes_nothing() {
    let (mut net, phone) = connected();
    let transfer = granted_send(&mut net, phone);
    let out = net.clients[phone]
        .controller
        .send_export(&transfer, Ok(export(12_000)), net.now);
    net.queue(phone, out.send);
    net.deliver(phone);
    net.deliver(phone);
    let out = net.clients[phone].controller.cancel_transfer();
    net.clients[phone].events.extend(out.events);
    net.send_all(phone, out.send);
    assert!(imports(&mut net).is_empty());
    assert_eq!(
        target_progress(&net).last(),
        Some(&Progress::Failed(ErrorCode::Cancelled))
    );
    assert_eq!(
        last_progress(&net, phone),
        Some(Progress::Failed(ErrorCode::Cancelled))
    );
    assert!(net.clients[phone].connected());
}

#[test]
fn a_transfer_that_stalls_expires_on_both_sides() {
    let (mut net, phone) = connected();
    let transfer = granted_send(&mut net, phone);
    wait(&mut net, phone, GRANT_TIMEOUT - Duration::from_millis(1));
    assert!(target_progress(&net).is_empty());
    wait(&mut net, phone, Duration::from_millis(1));
    assert_eq!(
        target_progress(&net).last(),
        Some(&Progress::Failed(ErrorCode::Expired))
    );
    // The phone hears it, and a late export is dropped.
    let out = net.clients[phone]
        .controller
        .send_export(&transfer, Ok(export(1)), net.now);
    assert!(out.send.is_empty());
    net.send_all(phone, out.send);
    assert!(imports(&mut net).is_empty());
    assert!(net.clients[phone].connected());
}

#[test]
fn the_controller_gives_up_on_a_target_that_stops_answering() {
    let (mut net, phone) = connected();
    let transfer = granted_send(&mut net, phone);
    // The export goes out, but no acknowledgement comes back.
    let _ = net.clients[phone]
        .controller
        .send_export(&transfer, Ok(export(1)), net.now);
    let deadline = net.clients[phone].controller.next_deadline().unwrap();
    assert_eq!(deadline, net.now + STEP_TIMEOUT);
    let out = net.clients[phone]
        .controller
        .tick(deadline - Duration::from_millis(1));
    assert!(out.events.is_empty());
    let out = net.clients[phone].controller.tick(deadline);
    assert_eq!(out.send.len(), 1);
    assert!(out
        .events
        .contains(&Event::Transfer(ControllerEvent::Progress {
            transfer,
            progress: Progress::Failed(ErrorCode::Expired),
        })));
    assert!(!net.clients[phone].controller.is_closed());
}

#[test]
fn a_target_that_doesnt_offer_transfers_refuses_them() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    assert_eq!(
        net.clients[phone]
            .controller
            .ask_history(Direction::Send, What::ALL, None),
        Err(AskError::Unsupported)
    );
    // Asked anyway, the target refuses without a dialog.
    let request = super::transfer::flow::Asked::History {
        direction: Direction::Send,
        what: What::ALL,
        counts: None,
    }
    .request(77);
    let bytes = net.clients[phone].controller.seal_raw(&request).unwrap();
    net.send(phone, bytes);
    assert!(net.clients[phone].events.contains(&Event::Reply {
        request: 77,
        result: Err(ErrorCode::Unsupported),
    }));
    assert_eq!(net.prompt(), None);
}

#[test]
fn only_one_transfer_at_a_time() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    assert_eq!(
        net.clients[phone]
            .controller
            .ask_history(Direction::Import, What::ALL, None),
        Err(AskError::Busy)
    );
    let request = super::transfer::flow::Asked::History {
        direction: Direction::Import,
        what: What::ALL,
        counts: None,
    }
    .request(78);
    let bytes = net.clients[phone].controller.seal_raw(&request).unwrap();
    net.send(phone, bytes);
    assert!(net.clients[phone].events.contains(&Event::Reply {
        request: 78,
        result: Err(ErrorCode::Busy),
    }));
}

#[test]
fn a_request_for_nothing_is_invalid() {
    let (mut net, phone) = connected();
    let request = super::transfer::flow::Asked::History {
        direction: Direction::Send,
        what: What::default(),
        counts: None,
    }
    .request(79);
    let bytes = net.clients[phone].controller.seal_raw(&request).unwrap();
    net.send(phone, bytes);
    assert!(net.clients[phone].events.contains(&Event::Reply {
        request: 79,
        result: Err(ErrorCode::Invalid),
    }));
    assert_eq!(net.prompt(), None);
}

#[test]
fn a_controller_without_a_session_cant_ask() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    assert_eq!(
        net.clients[phone]
            .controller
            .ask_history(Direction::Send, What::ALL, None),
        Err(AskError::NotConnected)
    );
}

#[test]
fn never_allow_ends_a_transfer_waiting_for_its_dialog() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    net.set_mode(ControlMode::Never);
    assert_eq!(net.prompt(), None);
    assert!(!net.clients[phone].connected());
}

#[test]
fn turning_discovery_off_leaves_a_transfer_waiting_for_its_dialog() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    let settings = RemoteSettings {
        discoverable: false,
        ..net.target.settings().clone()
    };
    net.change_settings(settings);
    assert!(net.prompt().is_some());
    net.answer(Answer::Allow);
    assert!(export_needed(&net, phone).is_some());
}

#[test]
fn turning_discovery_off_still_refuses_a_control_request() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    let settings = RemoteSettings {
        discoverable: false,
        ..net.target.settings().clone()
    };
    net.change_settings(settings);
    assert_eq!(net.prompt(), None);
    assert!(net.clients[phone].closed);
}

#[test]
fn a_controller_leaving_takes_its_dialog_down() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    net.drop_link(phone);
    assert_eq!(net.prompt(), None);
}

#[test]
fn a_controller_revoked_while_asking_takes_its_dialog_down() {
    let (mut net, phone) = connected();
    ask(&mut net, phone, Direction::Send);
    let session = net.target.sessions()[0].session_id.clone();
    let actions = net.target.disconnect(&session);
    net.handle(actions);
    assert_eq!(net.prompt(), None);
}

#[test]
fn transfer_steps_without_a_grant_are_refused() {
    let (mut net, phone) = connected();
    let bytes = net.clients[phone]
        .controller
        .seal_raw(&Message::TransferStart {
            transfer: "made-up".into(),
        })
        .unwrap();
    net.send(phone, bytes);
    assert!(take(&mut net, |a| match a {
        Action::ExportHistory { .. } => Some(()),
        _ => None,
    })
    .is_empty());
    assert!(net.clients[phone].connected());
}

fn providers() -> Vec<ProviderSettings> {
    vec![ProviderSettings {
        name: "Home".into(),
        kind: ProviderKind::Xtream,
        url: "http://panel.example:8080".into(),
        username: Some("made-up-user".into()),
        password: Some("made-up-password".into()),
        epg_url: None,
    }]
}

fn ask_providers(net: &mut Net, phone: usize) {
    let names = vec![ProviderName {
        name: "Home".into(),
        kind: ProviderKind::Xtream,
    }];
    let bytes = net.clients[phone].controller.ask_providers(names).unwrap();
    net.send(phone, bytes);
}

fn provider_grant(net: &Net, phone: usize) -> Option<String> {
    transfer_events(net, phone)
        .into_iter()
        .find_map(|e| match e {
            ControllerEvent::ProvidersGranted { grant } => Some(grant),
            _ => None,
        })
}

fn saves(net: &mut Net) -> Vec<(super::ConnId, String, Vec<ProviderSettings>)> {
    take(net, |a| match a {
        Action::SaveProviders {
            conn,
            grant,
            from,
            providers,
        } => {
            assert_eq!(from, "Phone");
            Some((*conn, grant.clone(), providers.clone()))
        }
        _ => None,
    })
}

#[test]
fn providers_go_only_after_their_own_allow() {
    let (mut net, phone) = connected();
    ask_providers(&mut net, phone);
    let prompt = net.prompt().unwrap();
    assert_eq!(
        prompt.asked,
        Some(super::transfer::flow::Asked::Providers(vec![
            ProviderName {
                name: "Home".into(),
                kind: ProviderKind::Xtream,
            }
        ]))
    );
    net.answer(Answer::Allow);
    let grant = provider_grant(&net, phone).expect("the phone may send them now");
    let out = net.clients[phone]
        .controller
        .send_providers(&grant, providers(), net.now);
    net.send_all(phone, out.send);
    let saved = saves(&mut net);
    assert_eq!(saved.len(), 1);
    let (conn, got_grant, got) = saved.into_iter().next().unwrap();
    assert_eq!(got_grant, grant);
    assert_eq!(got, providers());

    let results = vec![ProviderResult {
        name: "Home".into(),
        outcome: ProviderOutcome::Added,
        error: None,
        saved_as: None,
    }];
    let actions = net.target.providers_saved(conn, &grant, results.clone());
    net.handle(actions);
    assert_eq!(
        last_progress(&net, phone),
        Some(Progress::ProvidersDone(results))
    );
}

#[test]
fn a_denied_provider_request_never_sees_a_login() {
    let (mut net, phone) = connected();
    ask_providers(&mut net, phone);
    net.answer(Answer::Deny);
    assert_eq!(refused(&net, phone), Some(ErrorCode::Denied));
    assert_eq!(provider_grant(&net, phone), None);
    assert!(saves(&mut net).is_empty());
}

#[test]
fn a_provider_grant_takes_one_send() {
    let (mut net, phone) = connected();
    ask_providers(&mut net, phone);
    net.answer(Answer::Allow);
    let grant = provider_grant(&net, phone).unwrap();
    let send = Message::ProvidersSend {
        grant: grant.clone(),
        part: 0,
        last: true,
        providers: providers(),
    };
    for _ in 0..2 {
        let bytes = net.clients[phone].controller.seal_raw(&send).unwrap();
        net.send(phone, bytes);
    }
    assert_eq!(saves(&mut net).len(), 1);
}

#[test]
fn a_provider_the_request_didnt_name_is_refused_with_the_rest() {
    let (mut net, phone) = connected();
    ask_providers(&mut net, phone);
    net.answer(Answer::Allow);
    let grant = provider_grant(&net, phone).unwrap();
    let mut sent = providers();
    let mut sneaky = providers().remove(0);
    sneaky.name = "Sneaky".into();
    sent.push(sneaky);
    let bytes = net.clients[phone]
        .controller
        .seal_raw(&Message::ProvidersSend {
            grant,
            part: 0,
            last: true,
            providers: sent,
        })
        .unwrap();
    net.send(phone, bytes);
    assert!(saves(&mut net).is_empty());
    assert_eq!(
        target_progress(&net).last(),
        Some(&Progress::Failed(ErrorCode::Invalid))
    );
}

#[test]
fn a_grant_isnt_good_for_another_kind_of_transfer() {
    let (mut net, phone) = connected();
    let transfer = granted_send(&mut net, phone);
    let bytes = net.clients[phone]
        .controller
        .seal_raw(&Message::ProvidersSend {
            grant: transfer,
            part: 0,
            last: true,
            providers: providers(),
        })
        .unwrap();
    net.send(phone, bytes);
    assert!(saves(&mut net).is_empty());
}

#[test]
fn a_grant_is_only_good_on_its_own_connection() {
    let mut net = Net::with_mode(ControlMode::Always);
    net.target.offer(true, true);
    let phone = net.connect("Phone");
    let laptop = net.connect("Laptop");
    ask_providers(&mut net, phone);
    net.answer(Answer::Allow);
    let grant = provider_grant(&net, phone).unwrap();
    let bytes = net.clients[laptop]
        .controller
        .seal_raw(&Message::ProvidersSend {
            grant,
            part: 0,
            last: true,
            providers: providers(),
        })
        .unwrap();
    net.send(laptop, bytes);
    assert!(saves(&mut net).is_empty());
}

#[test]
fn the_target_offers_what_it_was_told_to() {
    let mut net = Net::with_mode(ControlMode::Always);
    net.target.offer(false, true);
    let phone = net.connect("Phone");
    assert_eq!(
        net.clients[phone]
            .controller
            .ask_history(Direction::Send, What::ALL, None),
        Err(AskError::Unsupported)
    );
    assert!(net.clients[phone]
        .controller
        .ask_providers(vec![ProviderName {
            name: "Home".into(),
            kind: ProviderKind::M3u,
        }])
        .is_ok());
    net.target.offer(true, false);
    let laptop = net.connect("Laptop");
    assert!(net.clients[laptop]
        .controller
        .ask_providers(vec![ProviderName {
            name: "Home".into(),
            kind: ProviderKind::M3u,
        }])
        .is_err());
}

#[test]
fn a_transfer_request_over_the_rate_limit_is_refused() {
    let (mut net, phone) = connected();
    for _ in 0..super::target::RATE as usize {
        let bytes = net.clients[phone].controller.ping().unwrap();
        net.send(phone, bytes);
    }
    ask(&mut net, phone, Direction::Send);
    assert_eq!(net.prompt(), None);
    assert_eq!(refused(&net, phone), Some(ErrorCode::RateLimited));
}

#[test]
fn a_request_kind_reads_from_what_is_asked() {
    use super::transfer::flow::Asked;
    let history = Asked::History {
        direction: Direction::Send,
        what: What::ALL,
        counts: None,
    };
    assert_eq!(history.kind(), RequestKind::History);
    assert_eq!(Asked::Providers(vec![]).kind(), RequestKind::Providers);
}
