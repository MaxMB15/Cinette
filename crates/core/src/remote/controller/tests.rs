// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::message::{DeviceType, PlaybackSnapshot};
use crate::remote::tests::hello;

fn state(epoch: &str, version: u64) -> VersionedState {
    VersionedState {
        epoch: epoch.into(),
        version,
        state: PlaybackSnapshot::default(),
    }
}

fn controller() -> Controller {
    controller_at(Instant::now())
}

fn controller_at(now: Instant) -> Controller {
    let key = DeviceKey::generate();
    let (c, _) = Controller::connect(
        &key,
        hello(&key, "P", DeviceType::Iphone),
        DeviceKey::generate().device_id(),
        None,
        now,
    )
    .unwrap();
    c
}

#[test]
fn a_controller_waits_no_longer_than_the_target_would() {
    assert_eq!(GIVE_UP_AFTER, Duration::from_secs(40));
    assert_eq!(GIVE_UP_AFTER, HANDSHAKE_TIMEOUT + CONSENT_TIMEOUT);
}

#[test]
fn a_controller_gives_up_on_a_handshake_that_stalls() {
    let now = Instant::now();
    let mut c = controller_at(now);
    let deadline = now + HANDSHAKE_TIMEOUT;
    assert_eq!(c.next_deadline(), Some(deadline));
    assert_eq!(
        c.tick(deadline - Duration::from_millis(1)),
        Output::default()
    );
    assert!(!c.is_closed());
    let out = c.tick(deadline);
    assert!(out.send.is_empty());
    assert_eq!(out.events, [Event::Closed(CloseReason::Timeout)]);
    assert!(c.is_closed());
    assert_eq!(c.next_deadline(), None);
    assert_eq!(c.tick(deadline + GIVE_UP_AFTER), Output::default());
}

#[test]
fn only_newer_states_are_kept() {
    let mut c = controller();
    assert!(c.is_newer(&state("a", 0)));
    c.latest = Some(("a".into(), 5));
    assert!(!c.is_newer(&state("a", 5)));
    assert!(!c.is_newer(&state("a", 4)));
    assert!(c.is_newer(&state("a", 6)));
    // A target that started again counts from 0 with a new epoch.
    assert!(c.is_newer(&state("b", 0)));
}

#[test]
fn nothing_can_be_sent_before_control_is_granted() {
    let mut c = controller();
    assert_eq!(c.command(Command::Stop), Err(NotConnected));
    assert_eq!(
        c.catalog(crate::remote::catalog::CatalogQuery::Groups {
            content_type: "live".into()
        }),
        Err(NotConnected)
    );
    assert_eq!(c.ping(), None);
    assert_eq!(c.leave(), None);
    assert!(c.peer().is_none());
    assert!(c.session_id().is_none());
}

#[test]
fn junk_during_the_handshake_closes() {
    let mut c = controller();
    assert!(!c.is_closed());
    let out = c.receive(b"junk");
    assert_eq!(out.events, [Event::Closed(CloseReason::Protocol)]);
    assert!(c.is_closed());
    // Anything after that is ignored.
    assert_eq!(c.receive(b"more"), Output::default());
}

#[test]
fn replies_and_pages_become_events() {
    let mut out = Output::default();
    handle_common(Message::Ok { re: 1, version: 3 }, &mut out);
    handle_common(
        Message::Error {
            re: Some(2),
            code: ErrorCode::StaleItem,
        },
        &mut out,
    );
    handle_common(
        Message::Error {
            re: None,
            code: ErrorCode::Unsupported,
        },
        &mut out,
    );
    handle_common(
        Message::CatalogPage {
            re: 3,
            items: vec![],
            next: Some("x".into()),
        },
        &mut out,
    );
    handle_common(Message::Pong, &mut out);
    assert_eq!(
        out.events,
        [
            Event::Reply {
                request: 1,
                result: Ok(3)
            },
            Event::Reply {
                request: 2,
                result: Err(ErrorCode::StaleItem)
            },
            Event::Error(ErrorCode::Unsupported),
            Event::Page {
                request: 3,
                items: vec![],
                next: Some("x".into())
            },
        ]
    );
}
