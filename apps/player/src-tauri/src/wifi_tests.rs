// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn interface(name: &str, address: [u8; 4], netmask: [u8; 4]) -> Interface {
    Interface {
        name: name.into(),
        address: Ipv4Addr::from(address),
        netmask: Ipv4Addr::from(netmask),
    }
}

#[test]
fn serves_the_wifi_subnet() {
    let found = [
        interface("lo0", [127, 0, 0, 1], [255, 0, 0, 0]),
        interface("pdp_ip0", [10, 64, 1, 2], [255, 255, 255, 255]),
        interface("en0", [192, 168, 1, 23], [255, 255, 255, 0]),
    ];
    assert_eq!(
        wifi_peers(&found),
        Some(Peers::Subnet {
            local: Ipv4Addr::new(192, 168, 1, 23),
            prefix: 24
        })
    );
}

#[test]
fn takes_the_first_usable_address_on_wifi() {
    let found = [
        interface("en0", [169, 254, 3, 4], [255, 255, 0, 0]),
        interface("en0", [10, 0, 0, 5], [255, 255, 0, 0]),
        interface("en0", [10, 1, 0, 5], [255, 255, 255, 0]),
    ];
    assert_eq!(
        wifi_peers(&found),
        Some(Peers::Subnet {
            local: Ipv4Addr::new(10, 0, 0, 5),
            prefix: 16
        })
    );
}

#[test]
fn has_nothing_without_wifi() {
    assert_eq!(wifi_peers(&[]), None);
    let cellular = [interface("pdp_ip0", [10, 64, 1, 2], [255, 255, 255, 0])];
    assert_eq!(wifi_peers(&cellular), None);
    let link_local = [interface("en0", [169, 254, 3, 4], [255, 255, 0, 0])];
    assert_eq!(wifi_peers(&link_local), None);
    let loopback = [interface("en0", [127, 0, 0, 1], [255, 255, 0, 0])];
    assert_eq!(wifi_peers(&loopback), None);
}

#[test]
fn refuses_a_subnet_too_wide_or_a_broken_mask() {
    let wide = [interface("en0", [10, 0, 0, 5], [255, 254, 0, 0])];
    assert_eq!(wifi_peers(&wide), None);
    let broken = [interface("en0", [10, 0, 0, 5], [255, 255, 0, 255])];
    assert_eq!(wifi_peers(&broken), None);
}

#[test]
fn reads_prefix_lengths() {
    assert_eq!(prefix(Ipv4Addr::new(255, 255, 255, 255)), Some(32));
    assert_eq!(prefix(Ipv4Addr::new(255, 255, 255, 0)), Some(24));
    assert_eq!(prefix(Ipv4Addr::new(255, 255, 0, 0)), Some(16));
    assert_eq!(prefix(Ipv4Addr::new(255, 255, 255, 252)), Some(30));
    assert_eq!(prefix(Ipv4Addr::new(0, 0, 0, 0)), Some(0));
    assert_eq!(prefix(Ipv4Addr::new(255, 0, 255, 0)), None);
    assert_eq!(prefix(Ipv4Addr::new(0, 255, 255, 255)), None);
}

#[test]
fn serves_the_subnet_of_the_default_routes_address() {
    let found = [
        interface("lo0", [127, 0, 0, 1], [255, 0, 0, 0]),
        interface("en0", [192, 168, 1, 23], [255, 255, 255, 0]),
        interface("en7", [10, 0, 4, 9], [255, 255, 252, 0]),
    ];
    assert_eq!(
        peers_at(Ipv4Addr::new(10, 0, 4, 9), &found),
        Some(Peers::Subnet {
            local: Ipv4Addr::new(10, 0, 4, 9),
            prefix: 22
        })
    );
    assert_eq!(peers_at(Ipv4Addr::new(10, 0, 4, 10), &found), None);
    // The same rules as on Wi-Fi.
    assert_eq!(peers_at(Ipv4Addr::LOCALHOST, &found), None);
    let wide = [interface("en7", [10, 0, 0, 5], [255, 0, 0, 0])];
    assert_eq!(peers_at(Ipv4Addr::new(10, 0, 0, 5), &wide), None);
    let link_local = [interface("en7", [169, 254, 3, 4], [255, 255, 0, 0])];
    assert_eq!(peers_at(Ipv4Addr::new(169, 254, 3, 4), &link_local), None);
}

fn subnet(local: [u8; 4], prefix: u8) -> Option<Peers> {
    Some(Peers::Subnet {
        local: Ipv4Addr::from(local),
        prefix,
    })
}

#[test]
fn a_mac_on_a_vpn_serves_its_wifi_not_the_vpn() {
    let found = [
        interface("lo0", [127, 0, 0, 1], [255, 0, 0, 0]),
        interface("en0", [192, 168, 1, 23], [255, 255, 255, 0]),
        interface("utun4", [10, 8, 0, 2], [255, 255, 255, 255]),
    ];
    let vpn = Some(Ipv4Addr::new(10, 8, 0, 2));
    assert_eq!(lan_peers(vpn, &found), subnet([192, 168, 1, 23], 24));
    // A VPN with a public address doesn't count either.
    let found = [
        interface("en0", [172, 16, 5, 9], [255, 255, 0, 0]),
        interface("utun2", [203, 0, 113, 7], [255, 255, 255, 0]),
    ];
    let vpn = Some(Ipv4Addr::new(203, 0, 113, 7));
    assert_eq!(lan_peers(vpn, &found), subnet([172, 16, 5, 9], 16));
}

#[test]
fn a_mac_prefers_the_local_network_of_its_default_route() {
    let found = [
        interface("en0", [192, 168, 1, 23], [255, 255, 255, 0]),
        interface("en7", [10, 0, 4, 9], [255, 255, 252, 0]),
        interface("bridge100", [192, 168, 2, 1], [255, 255, 255, 0]),
    ];
    let ethernet = Some(Ipv4Addr::new(10, 0, 4, 9));
    assert_eq!(lan_peers(ethernet, &found), subnet([10, 0, 4, 9], 22));
    // Without a default route, the first that fits.
    assert_eq!(lan_peers(None, &found), subnet([192, 168, 1, 23], 24));
    // A bridge counts too.
    let bridge = [interface("bridge100", [192, 168, 2, 1], [255, 255, 255, 0])];
    assert_eq!(lan_peers(None, &bridge), subnet([192, 168, 2, 1], 24));
}

#[test]
fn a_local_address_that_doesnt_fit_gives_way_to_the_next() {
    let found = [
        // Too wide a subnet to serve.
        interface("en0", [10, 0, 0, 5], [255, 0, 0, 0]),
        interface("en1", [192, 168, 1, 23], [255, 255, 255, 0]),
    ];
    let wide = Some(Ipv4Addr::new(10, 0, 0, 5));
    assert_eq!(lan_peers(wide, &found), subnet([192, 168, 1, 23], 24));
}

#[test]
fn a_mac_with_no_private_local_address_serves_its_default_route() {
    // A network with public addresses, on Ethernet.
    let found = [
        interface("en0", [198, 51, 100, 20], [255, 255, 255, 0]),
        // Private, but not Wi-Fi, Ethernet or a bridge.
        interface("utun1", [10, 9, 0, 2], [255, 255, 255, 0]),
    ];
    let public = Some(Ipv4Addr::new(198, 51, 100, 20));
    assert_eq!(lan_peers(public, &found), subnet([198, 51, 100, 20], 24));
    assert_eq!(lan_peers(None, &found), None);
    assert_eq!(lan_peers(None, &[]), None);
}
