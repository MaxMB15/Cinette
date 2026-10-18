// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use mvp_core::remote::identity::DeviceKey;
use std::net::Ipv4Addr;

fn ip(last: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(192, 168, 1, last))
}

fn found(instance: &str, id: &DeviceId, extra: &[(&str, &str)]) -> Event {
    let mut txt: Vec<(String, String)> = vec![
        ("v".into(), "1".into()),
        ("id".into(), id.to_string()),
        ("n".into(), "Living Room".into()),
        ("t".into(), "fire-tv".into()),
        ("rc".into(), "1".into()),
    ];
    for (k, v) in extra {
        txt.retain(|(key, _)| key != k);
        txt.push(((*k).into(), (*v).into()));
    }
    Event::Found {
        instance: instance.into(),
        host: "tv.local.".into(),
        addrs: vec![ip(20)],
        port: 47130,
        txt: Txt::new(txt),
    }
}

/// [`found`] at one address and port.
fn found_at(instance: &str, id: &DeviceId, ip: [u8; 4], port: u16) -> Event {
    match found(instance, id, &[]) {
        Event::Found {
            instance,
            host,
            txt,
            ..
        } => Event::Found {
            instance,
            host,
            addrs: vec![IpAddr::from(ip)],
            port,
            txt,
        },
        removed => removed,
    }
}

fn id() -> DeviceId {
    DeviceKey::generate().device_id()
}

#[test]
fn a_record_becomes_a_device() {
    let own = id();
    let tv = id();
    let mut devices = Devices::new(own);
    assert!(devices.apply(found("Living Room", &tv, &[])));
    assert_eq!(
        devices.list(),
        vec![RemoteDevice {
            device_id: tv.to_string(),
            name: "Living Room".into(),
            device_type: DeviceType::FireTv,
            control_allowed: true,
            available: true,
        }]
    );
    assert_eq!(devices.addresses(&tv), vec![SocketAddr::new(ip(20), 47130)]);
    assert_eq!(devices.get(&tv).unwrap().name, "Living Room");
    assert!(
        !devices.apply(found("Living Room", &tv, &[])),
        "nothing changed"
    );
}

#[test]
fn never_allow_shows_as_not_allowed() {
    let tv = id();
    let mut devices = Devices::new(id());
    devices.apply(found("TV", &tv, &[("rc", "0")]));
    assert!(!devices.list()[0].control_allowed);
    devices.apply(found("TV", &tv, &[("rc", "yes")]));
    assert!(!devices.list()[0].control_allowed, "only 1 allows");
}

#[test]
fn this_devices_own_record_is_left_out() {
    let own = id();
    let mut devices = Devices::new(own.clone());
    assert!(!devices.apply(found("Me", &own, &[])));
    assert!(devices.list().is_empty());

    let other = id();
    devices.apply(found("Other", &other, &[]));
    devices.set_own(other.clone());
    assert!(
        devices.list().is_empty(),
        "a new own id drops a listing with it"
    );
    assert!(!devices.apply(found("Other", &other, &[])));
}

#[test]
fn records_that_are_not_ours_are_left_out() {
    let tv = id();
    let mut devices = Devices::new(id());
    for bad in [
        found("A", &tv, &[("v", "2")]),
        found("B", &tv, &[("id", "not-an-id")]),
        found("C", &tv, &[("v", "")]),
    ] {
        assert!(!devices.apply(bad));
    }
    let Event::Found {
        instance,
        host,
        addrs,
        port,
        ..
    } = found("D", &tv, &[])
    else {
        unreachable!()
    };
    let no_version = Event::Found {
        instance,
        host,
        addrs,
        port,
        txt: Txt::new([("id", tv.to_string())]),
    };
    assert!(!devices.apply(no_version));
    assert!(devices.list().is_empty());
}

#[test]
fn a_record_that_stops_reading_as_ours_is_dropped() {
    let tv = id();
    let mut devices = Devices::new(id());
    devices.apply(found("TV", &tv, &[]));
    assert!(devices.apply(found("TV", &tv, &[("v", "9")])));
    assert!(devices.list().is_empty());
}

#[test]
fn a_later_version_list_that_includes_ours_is_fine() {
    let tv = id();
    let mut devices = Devices::new(id());
    assert!(devices.apply(found("TV", &tv, &[("v", "2, 1")])));
}

#[test]
fn a_missing_name_or_type_falls_back() {
    let tv = id();
    let mut devices = Devices::new(id());
    devices.apply(found("TV", &tv, &[("n", "  "), ("t", "toaster")]));
    let d = &devices.list()[0];
    assert_eq!(d.device_type, DeviceType::Other);
    assert_eq!(
        d.name,
        mvp_core::remote::settings::default_name(DeviceType::Other)
    );

    devices.apply(found("TV", &tv, &[("n", "Den\u{7}TV")]));
    assert_eq!(
        devices.list()[0].name,
        "Den TV",
        "control characters are cleaned"
    );
    assert_eq!(devices.list()[0].device_type, DeviceType::FireTv);
}

#[test]
fn removing_drops_a_device_unless_it_is_kept() {
    let tv = id();
    let den = id();
    let mut devices = Devices::new(id());
    devices.apply(found("TV", &tv, &[]));
    devices.apply(found("Den", &den, &[("n", "Den")]));
    devices.keep(Some(tv.clone()));

    assert!(devices.apply(Event::Removed {
        instance: "Den".into()
    }));
    assert!(devices.get(&den).is_none());

    assert!(devices.apply(Event::Removed {
        instance: "TV".into()
    }));
    assert!(!devices.get(&tv).unwrap().available);
    assert!(devices.addresses(&tv).is_empty(), "nowhere to reach it now");
    assert!(!devices.apply(Event::Removed {
        instance: "TV".into()
    }));
    assert!(!devices.apply(Event::Removed {
        instance: "nobody".into()
    }));

    assert!(devices.apply(found("TV", &tv, &[])), "found again");
    assert!(devices.get(&tv).unwrap().available);

    devices.apply(Event::Removed {
        instance: "TV".into(),
    });
    devices.keep(None);
    assert!(devices.get(&tv).is_none(), "no longer kept, so dropped");
}

#[test]
fn keeping_a_device_leaves_available_ones_listed() {
    let tv = id();
    let mut devices = Devices::new(id());
    devices.apply(found("TV", &tv, &[]));
    devices.keep(None);
    assert!(devices.get(&tv).is_some());
}

#[test]
fn a_device_under_two_instance_names_is_listed_once_by_the_newest() {
    let tv = id();
    let mut devices = Devices::new(id());
    devices.apply(found("Living Room", &tv, &[]));
    assert!(devices.apply(found("Den", &tv, &[("n", "Den")])));
    let list = devices.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Den");
    assert!(devices.apply(Event::Removed {
        instance: "Den".into()
    }));
    assert_eq!(
        devices.list()[0].name,
        "Living Room",
        "the older one is still there"
    );
    assert!(devices.apply(Event::Removed {
        instance: "Living Room".into()
    }));
    assert!(devices.list().is_empty());
}

#[test]
fn a_record_claiming_a_device_id_doesnt_hide_its_addresses() {
    let tv = id();
    let mut devices = Devices::new(id());
    devices.apply(found_at("Living Room", &tv, [192, 168, 1, 20], 47130));
    devices.apply(found_at("Living Room", &tv, [192, 168, 1, 20], 47130));
    devices.apply(found_at("Impostor", &tv, [192, 168, 1, 66], 9));
    let addrs = devices.addresses(&tv);
    assert!(
        addrs.contains(&SocketAddr::from(([192, 168, 1, 20], 47130))),
        "{addrs:?}"
    );
    assert!(addrs.contains(&SocketAddr::from(([192, 168, 1, 66], 9))));
}

#[test]
fn the_list_stops_at_its_limit_until_one_goes() {
    let mut devices = Devices::new(id());
    for n in 0..MAX_INSTANCES {
        assert!(devices.apply(found(&format!("TV {n}"), &id(), &[])));
    }
    assert!(!devices.apply(found("One too many", &id(), &[])));
    assert_eq!(devices.list().len(), MAX_INSTANCES);
    // One already listed still updates.
    let again = id();
    assert!(devices.apply(found("TV 0", &again, &[])));
    assert!(devices.apply(Event::Removed {
        instance: "TV 1".into()
    }));
    assert!(devices.apply(found("Now it fits", &id(), &[])));
}

#[test]
fn the_same_record_again_changes_nothing() {
    let tv = id();
    let mut devices = Devices::new(id());
    assert!(devices.apply(found("Living Room", &tv, &[])));
    assert!(!devices.apply(found("Living Room", &tv, &[])));
}

#[test]
fn the_list_is_in_name_order() {
    let mut devices = Devices::new(id());
    devices.apply(found("1", &id(), &[("n", "Kitchen")]));
    devices.apply(found("2", &id(), &[("n", "Bedroom")]));
    let a = id();
    let b = id();
    devices.apply(found("3", &a, &[("n", "Same")]));
    devices.apply(found("4", &b, &[("n", "Same")]));
    let names: Vec<String> = devices.list().into_iter().map(|d| d.name).collect();
    assert_eq!(names, ["Bedroom", "Kitchen", "Same", "Same"]);
    let same: Vec<String> = devices
        .list()
        .into_iter()
        .filter(|d| d.name == "Same")
        .map(|d| d.device_id)
        .collect();
    let mut sorted = vec![a.to_string(), b.to_string()];
    sorted.sort();
    assert_eq!(same, sorted, "ties go by id");
}
