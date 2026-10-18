// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The registry with hand-made discovery events, and the commands on a mock
//! app that never browses.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Listener;

use super::receivers::{CastReceiver, Registry, MAX_RECEIVERS, UNREACHABLE_FOR};
use super::*;
use crate::discovery::{Event, Txt};
use crate::test_support::TestApp;

// TEST-NET addresses, which nothing dials.
const TV: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 20));
const ELSEWHERE: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 99));

fn record(instance: &str, addr: IpAddr, txt: Txt) -> Event {
    Event::Found {
        instance: instance.into(),
        host: format!("{instance}.local."),
        addrs: vec![addr],
        port: 8009,
        txt,
    }
}

fn found(instance: &str, id: &str, name: &str) -> Event {
    let txt = Txt::new([
        ("id", id),
        ("fn", name),
        ("md", "Chromecast"),
        ("rs", "YouTube"),
    ]);
    record(instance, TV, txt)
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
        receiver,
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
        serde_json::to_value(&receiver).unwrap(),
        json!({
            "id": "cast:abc",
            "name": "Living Room",
            "model": "Chromecast",
            "status": "YouTube",
            "available": true,
        })
    );
    assert_eq!(
        serde_json::to_value(registry.snapshot(true)).unwrap(),
        json!({
            "revision": 1,
            "receivers": [serde_json::to_value(&receiver).unwrap()],
            "localNetworkDenied": true,
        })
    );
}

#[test]
fn names_a_receiver_after_its_instance_without_a_friendly_name() {
    let mut registry = Registry::default();
    for (i, txt) in [
        Txt::new([("id", "abc")]),
        Txt::new([("id", "abc"), ("fn", " \t "), ("rs", "")]),
    ]
    .into_iter()
    .enumerate()
    {
        registry.apply(removed("Chromecast-abc"));
        assert!(registry.apply(record("Chromecast-abc", TV, txt)), "{i}");
        let receiver = registry.get("cast:abc").unwrap();
        assert_eq!(receiver.name, "Chromecast-abc");
        assert_eq!(receiver.model, "");
        assert_eq!(receiver.status, None);
    }
}

#[test]
fn keeps_control_and_bidi_characters_out_of_names() {
    let mut registry = Registry::default();
    let long = "x".repeat(100);
    let txt = Txt::new([
        ("id", " abc\u{7} "),
        ("fn", "  VT \u{202E}moor\u{200F} gnivil\n\u{7} "),
        ("md", long.as_str()),
        ("rs", "\u{2066}News\u{2069}"),
    ]);
    registry.apply(record("tv", TV, txt));
    let receiver = registry.list().remove(0);
    assert_eq!(receiver.id, "cast:abc");
    assert_eq!(receiver.name, "VT moor gnivil");
    assert_eq!(receiver.model, "x".repeat(64));
    assert_eq!(receiver.status.as_deref(), Some("News"));
}

#[test]
fn skips_a_record_with_no_id_or_no_address() {
    let mut registry = Registry::default();
    let no_id = record("a", TV, Txt::new([("fn", "TV")]));
    assert!(!registry.apply(no_id));
    // An empty id would put every such receiver in one entry.
    for id in ["", " \u{7} "] {
        assert!(!registry.apply(record("e", TV, Txt::new([("id", id)]))));
    }
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
fn a_new_address_alone_changes_nothing_the_frontend_sees() {
    let mut registry = Registry::default();
    registry.apply(found("tv", "tv", "TV"));
    let revision = registry.snapshot(false).revision;
    let txt = Txt::new([
        ("id", "tv"),
        ("fn", "TV"),
        ("md", "Chromecast"),
        ("rs", "YouTube"),
    ]);
    assert!(!registry.apply(record("tv", ELSEWHERE, txt)));
    assert_eq!(registry.snapshot(false).revision, revision);
    // It's still where the next connection goes.
    assert_eq!(registry.get("cast:tv").unwrap().addr, ELSEWHERE);
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
fn a_receiver_stays_while_any_instance_still_claims_it() {
    let mut registry = Registry::default();
    registry.apply(found("Made-up-TV", "tv", "TV"));
    // After a restart, mDNS renames it while the old record is cached.
    let renamed = Txt::new([
        ("id", "tv"),
        ("fn", "TV"),
        ("md", "Chromecast"),
        ("rs", "YouTube"),
    ]);
    assert!(!registry.apply(record("Made-up-TV (2)", ELSEWHERE, renamed)));
    // The first instance's address is kept while it's live.
    assert_eq!(registry.get("cast:tv").unwrap().addr, TV);
    assert!(!registry.apply(removed("Made-up-TV")));
    assert_eq!(names(&registry), [("TV".into(), true)]);
    assert_eq!(registry.get("cast:tv").unwrap().addr, ELSEWHERE);
    assert!(registry.apply(removed("Made-up-TV (2)")));
    assert!(registry.list().is_empty());
}

#[test]
fn lists_no_more_than_its_cap() {
    let mut registry = Registry::default();
    for i in 0..MAX_RECEIVERS + 5 {
        registry.apply(found(&format!("tv-{i}"), &format!("{i}"), "TV"));
    }
    assert_eq!(registry.list().len(), MAX_RECEIVERS);
    // A receiver it lists can still change.
    assert!(registry.apply(found("tv-0", "0", "Renamed")));
    // A new id past the cap waits for room.
    assert!(registry.get(&format!("cast:{MAX_RECEIVERS}")).is_none());
    registry.apply(removed("tv-1"));
    assert!(registry.apply(found("late", "late", "Late")));
    assert_eq!(registry.list().len(), MAX_RECEIVERS);
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
    // It's listed, but there's nothing to connect to.
    assert!(registry.get("cast:tv").is_none());
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
fn a_browse_that_ends_takes_what_it_found_with_it() {
    let mut registry = Registry::default();
    registry.apply(found("tv", "tv", "TV"));
    registry.apply(found("k", "k", "Kitchen"));
    registry.hold(["cast:tv".to_string()]);
    assert!(registry.ended());
    assert_eq!(names(&registry), [("TV".into(), false)]);
    assert!(!registry.ended());
}

#[test]
fn a_receiver_that_couldnt_be_reached_is_unavailable_for_a_while() {
    let now = Instant::now();
    let mut registry = Registry::default();
    registry.apply(found("tv", "tv", "TV"));
    assert!(registry.unreachable("cast:tv", now));
    assert!(!registry.unreachable("cast:tv", now));
    assert!(!registry.unreachable("cast:none", now));
    assert_eq!(names(&registry), [("TV".into(), false)]);
    assert!(!registry.get("cast:tv").unwrap().available);
    // Letting go of it keeps it, since discovery still lists it.
    assert!(!registry.hold(Vec::new()));
    // The mark ends once its time is up.
    assert!(!registry.expire(now + UNREACHABLE_FOR - Duration::from_millis(1)));
    assert!(registry.expire(now + UNREACHABLE_FOR));
    assert_eq!(names(&registry), [("TV".into(), true)]);
    // Or when discovery reports it again.
    registry.unreachable("cast:tv", now);
    let txt = Txt::new([("id", "tv"), ("fn", "TV"), ("md", "Chromecast")]);
    assert!(registry.apply(record("tv", TV, txt)));
    assert_eq!(names(&registry), [("TV".into(), true)]);
}

fn announced(rx: &mpsc::Receiver<String>) -> Value {
    serde_json::from_str(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap()
}

#[test]
fn the_commands_list_hold_and_announce_receivers() {
    let app = TestApp::new();
    let (tx, rx) = mpsc::channel();
    app.handle().listen_any(RECEIVERS_EVENT, move |event| {
        let _ = tx.send(event.payload().to_string());
    });
    let first = app.invoke("get_cast_receivers", json!({})).unwrap();
    assert_eq!(
        first,
        json!({ "revision": 0, "receivers": [], "localNetworkDenied": false })
    );

    update(&app.handle(), |registry| {
        registry.apply(found("tv", "tv", "TV"))
    });
    let list = announced(&rx);
    assert_eq!(list["revision"], 1);
    assert_eq!(list["receivers"][0]["id"], "cast:tv");
    assert_eq!(app.invoke("get_cast_receivers", json!({})).unwrap(), list);

    // Nothing changed, so nothing is announced.
    assert_eq!(
        app.invoke("hold_cast_receivers", json!({ "ids": ["cast:tv"] })),
        Ok(json!(null))
    );
    update(&app.handle(), |registry| registry.apply(removed("tv")));
    let list = announced(&rx);
    assert_eq!(list["revision"], 2);
    assert_eq!(list["receivers"][0]["available"], false);
    app.invoke("hold_cast_receivers", json!({ "ids": [] }))
        .unwrap();
    let list = announced(&rx);
    assert_eq!(list["revision"], 3);
    assert_eq!(list["receivers"], json!([]));
    assert!(rx.recv_timeout(ANNOUNCE_GAP * 2).is_err());
}

#[test]
fn changes_close_together_go_out_in_one_list() {
    let app = TestApp::new();
    let (tx, rx) = mpsc::channel();
    app.handle().listen_any(RECEIVERS_EVENT, move |event| {
        let _ = tx.send(event.payload().to_string());
    });
    let started = Instant::now();
    for i in 0..50 {
        update(&app.handle(), |registry| {
            registry.apply(found(&format!("tv-{i}"), &format!("{i}"), "TV"))
        });
    }
    // The first change goes out at once, the rest together after the gap.
    assert_eq!(announced(&rx)["revision"], 1);
    let last = announced(&rx);
    assert_eq!(last["revision"], 50);
    assert_eq!(last["receivers"].as_array().unwrap().len(), 50);
    assert!(started.elapsed() >= ANNOUNCE_GAP);
    assert!(rx.recv_timeout(ANNOUNCE_GAP * 2).is_err());
}

#[test]
fn an_unreachable_receiver_is_marked_as_such() {
    let app = TestApp::new();
    update(&app.handle(), |registry| {
        registry.apply(found("tv", "tv", "TV"))
    });
    mark_unreachable(&app.handle(), "cast:tv");
    let handle = app.handle();
    let state = handle.state::<CastReceivers>();
    assert!(!state.registry().get("cast:tv").unwrap().available);
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
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("it never happened");
}

#[tokio::test]
async fn browses_once_and_again_after_the_browse_stops_or_fails() {
    let app = TestApp::new();
    let handle = app.handle();
    let (browse, starts, senders) = fake_browse(2);
    handle.state::<CastReceivers>().set_browse(browse);
    let list = || app.invoke("get_cast_receivers", json!({})).unwrap();

    // The first starts fail, so each call tries again, and it says so once.
    assert_eq!(list()["receivers"], json!([]));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert!(handle
        .state::<CastReceivers>()
        .warned
        .load(Ordering::SeqCst));
    list();
    list();
    assert_eq!(starts.load(Ordering::SeqCst), 3);
    let events = senders.try_recv().unwrap();
    // It runs now, so it isn't started again.
    list();
    assert_eq!(starts.load(Ordering::SeqCst), 3);

    events.send(found("tv", "tv", "TV")).unwrap();
    eventually(|| list()["receivers"][0]["id"] == "cast:tv").await;

    // A browse that stops takes its receivers with it, and the next call
    // starts it again.
    drop(events);
    let state = handle.state::<CastReceivers>();
    eventually(|| !*state.browsing.lock().unwrap()).await;
    assert_eq!(state.registry().list(), vec![]);
    list();
    assert_eq!(starts.load(Ordering::SeqCst), 4);
    assert!(senders.try_recv().is_ok());
}

#[test]
fn a_browse_that_cant_start_says_so_once() {
    let app = TestApp::new();
    let handle = app.handle();
    let (browse, starts, _senders) = fake_browse(usize::MAX);
    let state = handle.state::<CastReceivers>();
    state.set_browse(browse);
    let logged = crate::test_support::Logged::default();
    let _guard = logged.start();
    let warnings = || {
        logged
            .text()
            .matches("Couldn't look for Cast receivers")
            .count()
    };
    start_browsing(&handle, &state);
    assert_eq!(warnings(), 1);
    start_browsing(&handle, &state);
    start_browsing(&handle, &state);
    assert_eq!(starts.load(Ordering::SeqCst), 3);
    assert_eq!(warnings(), 1);
}

#[test]
fn held_receivers_that_went_away_count_toward_the_cap() {
    let mut registry = Registry::default();
    for i in 0..MAX_RECEIVERS {
        registry.apply(found(&format!("tv-{i}"), &format!("{i}"), "TV"));
    }
    registry.hold(["cast:0".to_string()]);
    registry.apply(removed("tv-0"));
    // One fewer listed by discovery, but the held one is still shown.
    assert_eq!(registry.list().len(), MAX_RECEIVERS);
    assert!(!registry.apply(found("late", "late", "Late")));
    assert!(registry.get("cast:late").is_none());
}
