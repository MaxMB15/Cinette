// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Whether a VPN looks to hold this device's default route, for the hint
//! the pickers show when no receiver is found or one can't be reached. Many
//! VPN apps block local devices unless an option, usually called "allow
//! LAN" or "local network sharing", is on.
//!
//! It's a guess from the interface's name: a tunnel such as `utun`, `tun`,
//! `wg`, `ppp` or `ipsec` holding the route to the internet. Tailscale
//! without an exit node doesn't take the default route, so it isn't
//! flagged.

use std::net::{IpAddr, Ipv4Addr};

#[cfg(test)]
mod tests;

/// The name prefixes of tunnel interfaces.
const TUNNELS: [&str; 5] = ["utun", "tun", "wg", "ppp", "ipsec"];

/// An address on the internet. Asking for the route to it sends nothing.
const INTERNET: IpAddr = IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1));

/// Whether an interface called `name` is a tunnel.
pub fn is_tunnel(name: &str) -> bool {
    TUNNELS.iter().any(|prefix| name.starts_with(prefix))
}

/// Whether the interface with the address `local`, out of `interfaces`, is a
/// tunnel.
pub fn tunnel_holds(local: IpAddr, interfaces: &[(String, IpAddr)]) -> bool {
    interfaces
        .iter()
        .any(|(name, ip)| *ip == local && is_tunnel(name))
}

/// Whether a VPN looks to hold the default route now.
pub fn vpn_active() -> bool {
    let Ok(local) = crate::lan_server::route_to(INTERNET) else {
        return false;
    };
    let interfaces: Vec<(String, IpAddr)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|i| {
            let ip = i.ip();
            (i.name, ip)
        })
        .collect();
    tunnel_holds(local, &interfaces)
}
