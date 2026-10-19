// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

/// A home network: 192.168.1.20/24, and a global IPv6 /64 next to a ULA.
fn home() -> Vec<(IpAddr, IpAddr)> {
    vec![
        (ip("192.168.1.20"), ip("255.255.255.0")),
        (ip("2001:db8:1:2::20"), ip("ffff:ffff:ffff:ffff::")),
        (ip("fd00:1::20"), ip("ffff:ffff:ffff:ffff::")),
        // A tunnel with no subnet.
        (ip("10.8.0.2"), ip("0.0.0.0")),
    ]
}

#[test]
fn only_peers_on_this_machines_networks_are_local() {
    let cases = [
        ("127.0.0.1", true),
        ("::1", true),
        ("192.168.1.77", true),
        ("192.168.2.77", false),
        ("169.254.10.1", true),
        ("fe80::1234", true),
        ("fd00:1::99", true),
        ("fd00:2::99", false),
        ("2001:db8:1:2::abcd", true),
        ("2001:db8:1:3::abcd", false),
        ("::ffff:192.168.1.77", true),
        ("::ffff:8.8.8.8", false),
        ("8.8.8.8", false),
        ("10.8.0.9", false),
        ("2a00:1450::1", false),
    ];
    for (peer, local) in cases {
        assert_eq!(on_local_network(ip(peer), &home()), local, "{peer}");
    }
}

#[test]
fn a_v4_mapped_interface_address_counts_as_ipv4() {
    let mapped = [(ip("::ffff:192.168.1.20"), ip("255.255.255.0"))];
    assert!(on_local_network(ip("192.168.1.5"), &mapped));
    assert!(!on_local_network(ip("192.168.9.5"), &mapped));
}

#[test]
fn this_machine_and_its_own_addresses_are_local_and_the_internet_isnt() {
    assert!(is_local_peer(ip("127.0.0.1")));
    for interface in if_addrs::get_if_addrs().unwrap() {
        assert!(is_local_peer(interface.ip()), "{}", interface.ip());
    }
    // A documentation address, which no test machine's network holds.
    assert!(!is_local_peer(ip("203.0.113.9")));
}
