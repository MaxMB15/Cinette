// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use std::net::{IpAddr, Ipv4Addr};

use super::*;

const LAN: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
const TUNNEL: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 64, 0, 2));
const TAILNET: IpAddr = IpAddr::V4(Ipv4Addr::new(100, 101, 102, 103));

#[test]
fn knows_tunnel_interfaces_by_name() {
    for name in ["utun3", "tun0", "wg0", "wg0-mullvad", "ppp0", "ipsec0"] {
        assert!(is_tunnel(name), "{name}");
    }
    for name in [
        "en0",
        "eth0",
        "wlan0",
        "wlp2s0",
        "lo",
        "tailscale0",
        "bridge0",
    ] {
        assert!(!is_tunnel(name), "{name}");
    }
}

#[test]
fn flags_a_tunnel_only_when_it_holds_the_default_route() {
    let interfaces = vec![
        ("en0".to_string(), LAN),
        ("utun4".to_string(), TUNNEL),
        ("tailscale0".to_string(), TAILNET),
    ];
    assert!(tunnel_holds(TUNNEL, &interfaces));
    // A VPN that's up but doesn't take the default route, such as Tailscale
    // without an exit node.
    assert!(!tunnel_holds(LAN, &interfaces));
    assert!(!tunnel_holds(TAILNET, &interfaces));
    // An address no interface lists.
    assert!(!tunnel_holds(IpAddr::V4(Ipv4Addr::LOCALHOST), &interfaces));
}

#[test]
fn answers_for_this_machine() {
    // Whatever this machine's routes are, the command answers.
    let _ = vpn_active();
}
