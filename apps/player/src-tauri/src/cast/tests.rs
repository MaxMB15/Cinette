// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The registry with hand-made discovery events, and the commands on a mock
//! app that never browses.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde_json::json;
use tauri::Listener;

use super::receivers::{CastReceiver, Registry};
use super::*;
use crate::discovery::{Event, Txt};
use crate::test_support::TestApp;

const TV: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));

fn found(instance: &str, id: &str, name: &str) -> Event {
    Event::Found {
        instance: instance.into(),
        host: format!("{instance}.local."),
        addrs: vec![TV, "fe80::1".parse().unwrap()],
        port: 8009,
        txt: Txt::new([
            ("id", id),
            ("fn", name),
            ("md", "Chromecast"),
            ("rs", "YouTube"),
        ]),
    }
}

fn removed(instance: &str) -> Event {
    Event::Removed {
        instance: instance.into(),
    }
}

fn names(registry: &Registry) -> Vec<(String, bool)> {
    registry
        .list()
        .into_iter()
        .map(|r| (r.name, r.available))
        .collect()
}

#[test]
fn reads_a_receiver_from_its_txt_record() {
    let mut registry = Registry::default();
    assert!(registry.apply(found("Chromecast-abc", "abc", "Living Room")));
    let receiver = registry.get("cast:abc").unwrap();
    assert_eq!(
        *receiver,
        CastReceiver {
            id: "cast:abc".into(),
            name: "Living Room".into(),
            model: "Chromecast".into(),
            status: Some("YouTube".into()),
            available: true,
            addr: TV,
            port: 8009,
        }
    );
    // Only what the picker shows goes to the frontend.
    assert_eq!(
        serde_json::to_value(receiver).unwrap(),
        json!({
            "id": "cast:abc",
            "name": "Living Room",
            "model": "Chromecast",
            "status": "YouTube",
            "available": true,
        })
    );
}

#[test]
fn names_a_receiver_after_its_instance_without_a_friendly_name() {
    let mut registry = Registry::default();
    let event = Event::Found {
        instance: "Chromecast-abc".into(),
        host: "abc.local.".into(),
        addrs: vec![TV],
        port: 8009,
        txt: Txt::new([("id", "abc")]),
    };
    assert!(registry.apply(event));
    let receiver = registry.get("cast:abc").unwrap();
    assert_eq!(receiver.name, "Chromecast-abc");
    assert_eq!(receiver.model, "");
    assert_eq!(receiver.status, None);
}

#[test]
fn skips_a_record_with_no_id_or_no_address() {
    let mut registry = Registry::default();
    let no_id = Event::Found {
        instance: "a".into(),
        host: "a.local.".into(),
        addrs: vec![TV],
        port: 8009,
        txt: Txt::new([("fn", "TV")]),
    };
    assert!(!registry.apply(no_id));
    let no_address = Event::Found {
        instance: "b".into(),
        host: "b.local.".into(),
        addrs: vec![],
        port: 8009,
        txt: Txt::new([("id", "b")]),
    };
    assert!(!registry.apply(no_address));
    assert!(registry.list().is_empty());
    // A goodbye from an instance that was never listed changes nothing.
    assert!(!registry.apply(removed("a")));
}

#[test]
fn lists_receivers_by_name_and_follows_their_changes() {
    let mut registry = Registry::default();
    registry.apply(found("k", "k", "Kitchen"));
    registry.apply(found("b", "b", "Bedroom"));
    assert_eq!(
        names(&registry),
        [("Bedroom".into(), true), ("Kitchen".into(), true)]
    );
    // The same record again changes nothing; a new name does.
    assert!(!registry.apply(found("k", "k", "Kitchen")));
    assert!(registry.apply(found("k", "k", "Kitchen TV")));
    assert_eq!(registry.get("cast:k").unwrap().name, "Kitchen TV");
    assert!(registry.apply(removed("b")));
    assert_eq!(names(&registry), [("Kitchen TV".into(), true)]);
    assert!(!registry.apply(removed("b")));
}

#[test]
fn an_instance_that_names_another_receiver_drops_the_old_one() {
    let mut registry = Registry::default();
    registry.apply(found("tv", "old", "TV"));
    assert!(registry.apply(found("tv", "new", "TV")));
    assert!(registry.get("cast:old").is_none());
    assert!(registry.get("cast:new").is_some());
}

#[test]
fn a_held_receiver_that_goes_away_stays_as_unavailable() {
    let mut registry = Registry::default();
    registry.apply(found("tv", "tv", "TV"));
    registry.apply(found("k", "k", "Kitchen"));
    assert!(!registry.hold(["cast:tv".to_string()]));
    assert!(registry.apply(removed("tv")));
    assert_eq!(
        names(&registry),
        [("Kitchen".into(), true), ("TV".into(), false)]
    );
    // It comes back available when discovery sees it again.
    assert!(registry.apply(found("tv", "tv", "TV")));
    assert!(registry.get("cast:tv").unwrap().available);
    // Let go while it's gone, it's dropped.
    registry.apply(removed("tv"));
    assert!(registry.hold(Vec::new()));
    assert_eq!(names(&registry), [("Kitchen".into(), true)]);
    assert!(!registry.hold(Vec::new()));
}

#[test]
fn a_receiver_that_couldnt_be_reached_is_unavailable_until_seen_again() {
    let mut registry = Registry::default();
    registry.apply(found("tv", "tv", "TV"));
    assert!(registry.unreachable("cast:tv"));
    assert!(!registry.unreachable("cast:tv"));
    assert!(!registry.unreachable("cast:none"));
    assert_eq!(names(&registry), [("TV".into(), false)]);
    // Letting go of it keeps it, since discovery still lists it.
    assert!(!registry.hold(Vec::new()));
    assert!(registry.apply(found("tv", "tv", "TV")));
    assert_eq!(names(&registry), [("TV".into(), true)]);
}

#[test]
fn the_commands_list_hold_and_announce_receivers() {
    let app = TestApp::new();
    let (tx, rx) = mpsc::channel();
    app.handle().listen_any(RECEIVERS_EVENT, move |event| {
        let _ = tx.send(event.payload().to_string());
    });
    assert_eq!(app.invoke("get_cast_receivers", json!({})), Ok(json!([])));

    update(&app.handle(), |registry| {
        registry.apply(found("tv", "tv", "TV"))
    });
    let announced: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(announced[0]["id"], "cast:tv");
    let listed = app.invoke("get_cast_receivers", json!({})).unwrap();
    assert_eq!(listed, announced);

    // Nothing changed, so nothing is announced.
    assert_eq!(
        app.invoke("hold_cast_receivers", json!({ "ids": ["cast:tv"] })),
        Ok(json!(null))
    );
    assert!(rx.try_recv().is_err());
    update(&app.handle(), |registry| registry.apply(removed("tv")));
    let announced: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(announced[0]["available"], false);
    app.invoke("hold_cast_receivers", json!({ "ids": [] }))
        .unwrap();
    assert_eq!(rx.try_recv().unwrap(), "[]");
}

#[test]
fn a_mock_app_never_browses() {
    let app = TestApp::new();
    app.invoke("get_cast_receivers", json!({})).unwrap();
    let handle = app.handle();
    let state = handle.state::<CastReceivers>();
    assert!(!*state.browsing.lock().unwrap());
}

/// A fake browse that counts its starts. The first `fail` starts fail, and
/// each later one hands its sender to the test.
fn fake_browse(
    fail: usize,
) -> (
    Browse,
    Arc<AtomicUsize>,
    mpsc::Receiver<tokio::sync::mpsc::UnboundedSender<Event>>,
) {
    let starts = Arc::new(AtomicUsize::new(0));
    let (senders_tx, senders) = mpsc::channel();
    let counted = starts.clone();
    let senders_tx = Mutex::new(senders_tx);
    let browse: Browse = Box::new(move || {
        if counted.fetch_add(1, Ordering::SeqCst) < fail {
            return Err("no network".into());
        }
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        senders_tx.lock().unwrap().send(tx).unwrap();
        Ok(rx)
    });
    (browse, starts, senders)
}

async fn eventually(check: impl Fn() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("it never happened");
}

#[tokio::test]
async fn browses_once_and_again_after_the_browse_stops_or_fails() {
    let app = TestApp::new();
    let handle = app.handle();
    let (browse, starts, senders) = fake_browse(1);
    handle.state::<CastReceivers>().set_browse(browse);
    let list = || app.invoke("get_cast_receivers", json!({})).unwrap();

    // The first start fails, so the next call tries again.
    assert_eq!(list(), json!([]));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    list();
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    let events = senders.try_recv().unwrap();
    // It runs now, so it isn't started again.
    list();
    assert_eq!(starts.load(Ordering::SeqCst), 2);

    events.send(found("tv", "tv", "TV")).unwrap();
    eventually(|| list()[0]["id"] == "cast:tv").await;
    assert_eq!(starts.load(Ordering::SeqCst), 2);

    // A browse that stops is started again by the next call.
    drop(events);
    let state = handle.state::<CastReceivers>();
    eventually(|| !*state.browsing.lock().unwrap()).await;
    list();
    assert_eq!(starts.load(Ordering::SeqCst), 3);
    assert!(senders.try_recv().is_ok());
}
