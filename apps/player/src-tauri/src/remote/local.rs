// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Which peers count as on the local network. Remote control is for
//! devices on the same network, so the target turns away anyone else, such
//! as a stranger reaching a public IPv4 or global IPv6 address.

use std::net::IpAddr;

/// Whether `peer` is this machine or on one of its networks: loopback,
/// link-local, or inside the subnet of one of `interfaces`, each an address
/// and its netmask. A v4-mapped IPv6 address counts as its IPv4 address.
pub fn on_local_network(peer: IpAddr, interfaces: &[(IpAddr, IpAddr)]) -> bool {
    let peer = plain(peer);
    peer.is_loopback()
        || link_local(peer)
        || interfaces
            .iter()
            .any(|&(address, mask)| same_subnet(peer, plain(address), mask))
}

/// [`on_local_network`] with this machine's interfaces as they are now.
pub fn is_local_peer(peer: IpAddr) -> bool {
    let interfaces = match if_addrs::get_if_addrs() {
        Ok(list) => list
            .into_iter()
            .map(|interface| match interface.addr {
                if_addrs::IfAddr::V4(a) => (IpAddr::V4(a.ip), IpAddr::V4(a.netmask)),
                if_addrs::IfAddr::V6(a) => (IpAddr::V6(a.ip), IpAddr::V6(a.netmask)),
            })
            .collect(),
        Err(e) => {
            tracing::warn!("[remote] couldn't list the network interfaces: {e}");
            Vec::new()
        }
    };
    on_local_network(peer, &interfaces)
}

fn plain(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

fn link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => v6.segments()[0] & 0xffc0 == 0xfe80,
    }
}

/// Whether `peer` is in the subnet of `address` with `mask`. A mask of
/// nothing, as a tunnel can have, takes in no one.
fn same_subnet(peer: IpAddr, address: IpAddr, mask: IpAddr) -> bool {
    match (peer, address, mask) {
        (IpAddr::V4(p), IpAddr::V4(a), IpAddr::V4(m)) => {
            let m = u32::from(m);
            m != 0 && u32::from(p) & m == u32::from(a) & m
        }
        (IpAddr::V6(p), IpAddr::V6(a), IpAddr::V6(m)) => {
            let m = u128::from(m);
            m != 0 && u128::from(p) & m == u128::from(a) & m
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
