// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use std::net::{Ipv4Addr, Ipv6Addr};

fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(a, b, c, d))
}

fn tracker() -> (Tracker, mpsc::UnboundedReceiver<Event>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Tracker::new(tx), rx)
}

fn drain(rx: &mut mpsc::UnboundedReceiver<Event>) -> Vec<Event> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        out.push(event);
    }
    out
}

#[test]
fn txt_keys_match_without_case_and_keep_the_first() {
    let txt = Txt::new([("ID", "abc"), ("fn", "TV"), ("id", "other")]);
    assert_eq!(txt.get("id"), Some(&b"abc"[..]));
    assert_eq!(txt.get("Id"), Some(&b"abc"[..]));
    assert_eq!(txt.get_str("FN"), Some("TV"));
    assert_eq!(txt.get("md"), None);
    assert_eq!(
        txt.entries(),
        &[
            ("id".to_owned(), b"abc".to_vec()),
            ("fn".to_owned(), b"TV".to_vec())
        ]
    );
}

#[test]
fn txt_drops_empty_keys() {
    assert_eq!(Txt::new([("", "x")]), Txt::default());
}

#[test]
fn txt_values_are_raw_bytes() {
    let txt = Txt::new([("k", &[0xff, 0x00, 0x01][..])]);
    assert_eq!(txt.get("k"), Some(&[0xff, 0x00, 0x01][..]));
    assert_eq!(txt.get_str("k"), None);
}

#[test]
fn txt_round_trips_through_wire_format() {
    let txt = Txt::new([
        ("v", &b"1"[..]),
        ("n", "Living Room".as_bytes()),
        ("e", &[][..]),
    ]);
    let wire = txt.encode().unwrap();
    assert_eq!(
        wire,
        b"\x03v=1\x0dn=Living Room\x02e=".to_vec(),
        "each entry is a length byte, then key=value"
    );
    assert_eq!(Txt::parse(&wire), txt);
}

#[test]
fn txt_parse_reads_a_key_with_no_equals_and_stops_at_a_short_entry() {
    let txt = Txt::parse(b"\x04flag\x05a=b=c\x09short");
    assert_eq!(txt.get("flag"), Some(&[][..]));
    assert_eq!(txt.get("a"), Some(&b"b=c"[..]), "only the first = splits");
    assert_eq!(
        txt.entries().len(),
        2,
        "the entry running past the end is dropped"
    );
}

#[test]
fn txt_parse_reads_an_entry_that_ends_exactly_at_the_end() {
    assert_eq!(Txt::parse(b"\x03a=b").get("a"), Some(&b"b"[..]));
    assert_eq!(Txt::parse(b""), Txt::default());
}

#[test]
fn txt_parse_skips_a_key_that_is_not_utf8() {
    let txt = Txt::parse(b"\x03\xff=x\x03k=v");
    assert_eq!(txt.entries(), &[("k".to_owned(), b"v".to_vec())]);
}

#[test]
fn txt_encode_refuses_bad_keys_and_long_entries() {
    assert!(Txt::new([("a=b", "x")]).encode().is_err());
    assert!(Txt::new([("caf\u{e9}", "x")]).encode().is_err());
    assert!(Txt::new([("tab\t", "x")]).encode().is_err());
    assert!(
        Txt::new([("~", "x")]).encode().is_ok(),
        "~ is printable ASCII"
    );
    assert!(
        Txt::new([(" ", "x")]).encode().is_ok(),
        "space is printable ASCII"
    );
    // key, '=' and value: 1 + 1 + 253 = 255 fits, 256 doesn't.
    assert!(Txt::new([("k", vec![b'x'; 253])]).encode().is_ok());
    assert!(Txt::new([("k", vec![b'x'; 254])]).encode().is_err());
}

#[test]
fn service_types_are_checked() {
    for ok in [
        "_cinette._tcp",
        "_googlecast._tcp",
        "_a._udp",
        "_a-b1._tcp",
        "_fifteen-chars-x._tcp",
    ] {
        assert!(check_service_type(ok).is_ok(), "{ok}");
    }
    for bad in [
        "",
        "_cinette",
        "cinette._tcp",
        "__tcp",
        "_._tcp",
        "_cinette._tcp.local.",
        "_sixteen-chars-xx._tcp",
        "_a b._tcp",
        "_a.b._tcp",
    ] {
        assert!(check_service_type(bad).is_err(), "{bad}");
    }
}

#[test]
fn instance_names_undo_dns_escapes() {
    let ty = "_cinette._tcp";
    assert_eq!(
        instance_name("Living Room._cinette._tcp.local.", ty).as_deref(),
        Some("Living Room")
    );
    assert_eq!(
        instance_name(r"Max\.s Mac\\x._cinette._tcp.local.", ty).as_deref(),
        Some(r"Max.s Mac\x")
    );
    assert_eq!(
        instance_name(r"Living\032Room\046._cinette._tcp.local.", ty).as_deref(),
        Some("Living Room.")
    );
    assert_eq!(
        instance_name(r"caf\195\169._cinette._tcp.local.", ty).as_deref(),
        Some("caf\u{e9}"),
        "\\DDD bytes make up UTF-8"
    );
}

#[test]
fn instance_names_refuse_what_does_not_fit() {
    let ty = "_cinette._tcp";
    assert_eq!(instance_name("TV._googlecast._tcp.local.", ty), None);
    assert_eq!(instance_name("._cinette._tcp.local.", ty), None);
    assert_eq!(
        instance_name(r"TV\.._cinette._tcp.local.", ty).as_deref(),
        Some("TV.")
    );
    assert_eq!(
        instance_name(r"TV\._cinette._tcp.local.", ty),
        None,
        "a dangling escape"
    );
    assert_eq!(instance_name("TV._cinette._tcp.local", ty), None);
    assert_eq!(
        instance_name(r"TV\256._cinette._tcp.local.", ty),
        None,
        "not a byte"
    );
    assert_eq!(
        instance_name(r"\255._cinette._tcp.local.", ty),
        None,
        "not UTF-8"
    );
    assert_eq!(
        instance_name(r"\12x._cinette._tcp.local.", ty).as_deref(),
        Some("12x"),
        "fewer than three digits is a plain escape"
    );
}

#[test]
fn tracker_reports_a_found_instance_once_until_it_changes() {
    let (mut t, mut rx) = tracker();
    let txt = Txt::new([("id", "a")]);
    assert!(t.resolved("TV", "tv.local.", [v4(10, 0, 0, 2)], 8009, txt.clone()));
    assert!(t.resolved("TV", "tv.local.", [v4(10, 0, 0, 2)], 8009, txt.clone()));
    assert_eq!(
        drain(&mut rx),
        vec![Event::Found {
            instance: "TV".into(),
            host: "tv.local.".into(),
            addrs: vec![v4(10, 0, 0, 2)],
            port: 8009,
            txt: txt.clone(),
        }]
    );

    t.resolved("TV", "tv.local.", [v4(10, 0, 0, 3)], 8009, txt.clone());
    t.resolved("TV", "tv.local.", [v4(10, 0, 0, 3)], 8010, txt.clone());
    t.resolved(
        "TV",
        "tv.local.",
        [v4(10, 0, 0, 3)],
        8010,
        Txt::new([("id", "b")]),
    );
    t.resolved(
        "TV",
        "tv2.local.",
        [v4(10, 0, 0, 3)],
        8010,
        Txt::new([("id", "b")]),
    );
    assert_eq!(
        drain(&mut rx).len(),
        4,
        "address, port, TXT and host each count"
    );
}

#[test]
fn tracker_sorts_ipv4_first_and_drops_duplicates_and_link_local() {
    let (mut t, mut rx) = tracker();
    let global6 = IpAddr::V6("2001:db8::1".parse::<Ipv6Addr>().unwrap());
    let link6 = IpAddr::V6("fe80::1".parse::<Ipv6Addr>().unwrap());
    t.resolved(
        "TV",
        "tv.local.",
        [
            global6,
            v4(10, 0, 0, 9),
            link6,
            v4(10, 0, 0, 2),
            v4(10, 0, 0, 9),
        ],
        1,
        Txt::default(),
    );
    let [Event::Found { addrs, .. }] = &drain(&mut rx)[..] else {
        panic!("one Found");
    };
    assert_eq!(addrs, &vec![v4(10, 0, 0, 2), v4(10, 0, 0, 9), global6]);
}

#[test]
fn tracker_waits_for_an_address() {
    let (mut t, mut rx) = tracker();
    let link6 = IpAddr::V6("fe80::1".parse::<Ipv6Addr>().unwrap());
    assert!(t.resolved("TV", "tv.local.", [link6], 1, Txt::default()));
    assert!(t.removed("TV"));
    assert!(drain(&mut rx).is_empty(), "never found, so never removed");
}

#[test]
fn tracker_reports_removal_once_and_finds_again() {
    let (mut t, mut rx) = tracker();
    t.resolved("TV", "tv.local.", [v4(10, 0, 0, 2)], 1, Txt::default());
    t.removed("TV");
    t.removed("TV");
    t.resolved("TV", "tv.local.", [v4(10, 0, 0, 2)], 1, Txt::default());
    let events = drain(&mut rx);
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[1],
        Event::Removed {
            instance: "TV".into()
        }
    );
    assert!(matches!(events[2], Event::Found { .. }));
}

#[test]
fn tracker_says_when_the_browser_is_gone() {
    let (mut t, rx) = tracker();
    assert!(!t.is_closed());
    t.resolved("A", "a.local.", [v4(10, 0, 0, 2)], 1, Txt::default());
    drop(rx);
    assert!(t.is_closed());
    assert!(!t.resolved("B", "b.local.", [v4(10, 0, 0, 3)], 1, Txt::default()));
    assert!(!t.resolved("A", "a.local.", [v4(10, 0, 0, 2)], 1, Txt::default()));
    assert!(!t.resolved("C", "c.local.", [], 1, Txt::default()));
    assert!(!t.removed("A"));
    assert!(!t.removed("never"));
}

fn registration() -> Registration {
    Registration {
        service_type: "_cinettetest._tcp".into(),
        instance: "Test PC".into(),
        host_label: "abcdefghijklmnopqrstuvwxyz".into(),
        port: 47130,
        txt: Txt::new([("v", "1")]),
    }
}

#[test]
fn advertise_refuses_bad_registrations() {
    let bad = [
        Registration {
            service_type: "cinette".into(),
            ..registration()
        },
        Registration {
            instance: String::new(),
            ..registration()
        },
        Registration {
            instance: "x".repeat(64),
            ..registration()
        },
        Registration {
            host_label: String::new(),
            ..registration()
        },
        Registration {
            host_label: "a.b".into(),
            ..registration()
        },
        Registration {
            host_label: "x".repeat(64),
            ..registration()
        },
        Registration {
            txt: Txt::new([("a=b", "c")]),
            ..registration()
        },
    ];
    for r in bad {
        assert!(advertise(&r).is_err(), "{r:?}");
    }
}

#[test]
fn registrations_are_checked_up_to_their_limits() {
    let ok = |r: Registration| check_registration(&r).is_ok();
    assert!(ok(registration()));
    assert!(ok(Registration {
        instance: "x".repeat(63),
        host_label: "a".repeat(63),
        ..registration()
    }));
    assert!(ok(Registration {
        instance: "x".into(),
        host_label: "a-1".into(),
        ..registration()
    }));
    assert!(!ok(Registration {
        host_label: "a_b".into(),
        ..registration()
    }));
}

#[test]
fn errors_print_their_message() {
    let e = DiscoveryError("couldn't start mDNS".into());
    assert_eq!(e.to_string(), "couldn't start mDNS");
    let as_error: &dyn std::error::Error = &e;
    assert_eq!(format!("{as_error}"), "couldn't start mDNS");
}

#[test]
fn a_type_can_only_be_browsed_once_at_a_time() {
    let first = BrowseGuard::take("_onlyonce._tcp").unwrap();
    assert!(BrowseGuard::take("_onlyonce._tcp").is_err());
    let other = BrowseGuard::take("_another._tcp");
    assert!(other.is_ok(), "other types can run beside it");
    drop(first);
    assert!(BrowseGuard::take("_onlyonce._tcp").is_ok());
}

/// Advertises a service and finds it by browsing, through the real mDNS
/// stack. The service type is made up, so nothing else on the network
/// answers it.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn advertising_and_browsing_find_each_other() {
    let service_type = "_cinettetest._tcp";
    let mut browser = browse(service_type).unwrap();
    assert!(
        browse(service_type).is_err(),
        "a second browse of the type is refused"
    );
    let instance = format!("Test {}", std::process::id());
    let ad = advertise(&Registration {
        instance: instance.clone(),
        txt: Txt::new([("v", &b"1"[..]), ("id", &b"ABC"[..]), ("raw", &[0xff][..])]),
        ..registration()
    })
    .unwrap();

    // A daemon of mdns-sd's own, outside the module, says whether multicast
    // works here at all. Where it does, the module must find the record too.
    let raw = mdns_sd::ServiceDaemon::new().unwrap();
    let raw_events = raw.browse(&format!("{service_type}.local.")).unwrap();
    let multicast_works = tokio::task::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            if let Ok(mdns_sd::ServiceEvent::ServiceResolved(_)) = raw_events.recv_timeout(left) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap();
    let _ = raw.shutdown();
    if !multicast_works {
        // No interface here takes multicast, as in some containers.
        eprintln!("skipped: mDNS itself found nothing over multicast");
        return;
    }
    let found = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            match browser.next().await {
                Some(Event::Found {
                    instance: i,
                    host,
                    addrs,
                    port,
                    txt,
                }) if i == instance => {
                    break (host, addrs, port, txt);
                }
                Some(_) => {}
                None => panic!("the browse ended"),
            }
        }
    })
    .await;
    let (host, addrs, port, txt) = found.expect("mDNS works here, but the browse found nothing");
    assert_eq!(host, "abcdefghijklmnopqrstuvwxyz.local.");
    assert!(!addrs.is_empty());
    assert_eq!(port, 47130);
    assert_eq!(txt.get_str("ID"), Some("ABC"));
    assert_eq!(txt.get("raw"), Some(&[0xff][..]));

    drop(ad);
    let removed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match browser.next().await {
                Some(Event::Removed { instance: i }) if i == instance => break,
                Some(_) => {}
                None => panic!("the browse ended"),
            }
        }
    })
    .await;
    assert!(removed.is_ok(), "the goodbye removes it");
}
