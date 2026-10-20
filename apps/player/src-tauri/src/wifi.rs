// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! This device's address on the local network, for a server whose
//! receiver's address isn't known, as with AirPlay. iOS names the Wi-Fi
//! interface `en0`. A Mac can be on Wi-Fi or Ethernet, so it takes the
//! interface of its default route.

use std::net::Ipv4Addr;

use crate::lan_server::{Peers, MIN_PREFIX};

#[cfg(test)]
#[path = "wifi_tests.rs"]
mod tests;

/// One IPv4 address of a network interface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interface {
    pub name: String,
    pub address: Ipv4Addr,
    pub netmask: Ipv4Addr,
}

/// The peers to serve on the Wi-Fi network: `en0`'s subnet, when it has an
/// address that isn't a link-local one and a netmask no wider than
/// [`MIN_PREFIX`] allows.
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
pub fn wifi_peers(interfaces: &[Interface]) -> Option<Peers> {
    subnet_peers(interfaces.iter().filter(|i| i.name == "en0"))
}

/// The peers to serve on the network of `local`, this device's address on
/// its default route, under the same rules as [`wifi_peers`].
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub fn peers_at(local: Ipv4Addr, interfaces: &[Interface]) -> Option<Peers> {
    subnet_peers(interfaces.iter().filter(|i| i.address == local))
}

fn subnet_peers<'a>(mut interfaces: impl Iterator<Item = &'a Interface>) -> Option<Peers> {
    interfaces
        .find_map(|i| {
            if i.address.is_link_local() || i.address.is_loopback() {
                return None;
            }
            let prefix = prefix(i.netmask)?;
            (prefix >= MIN_PREFIX).then_some(Peers::Subnet {
                local: i.address,
                prefix,
            })
        })
}

/// The prefix length of a netmask, or `None` when its bits don't run in
/// one block from the top.
fn prefix(netmask: Ipv4Addr) -> Option<u8> {
    let bits = u32::from(netmask);
    let ones = bits.leading_ones();
    (bits.checked_shl(ones).unwrap_or(0) == 0).then_some(ones as u8)
}

/// This device's IPv4 interface addresses.
#[cfg(target_os = "ios")]
pub fn interfaces() -> Vec<Interface> {
    use std::ffi::CStr;
    let mut found = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return found;
    }
    let mut next = list;
    while let Some(entry) = unsafe { next.as_ref() } {
        next = entry.ifa_next;
        let (Some(addr), Some(mask)) = (unsafe { entry.ifa_addr.as_ref() }, unsafe {
            entry.ifa_netmask.as_ref()
        }) else {
            continue;
        };
        if i32::from(addr.sa_family) != libc::AF_INET {
            continue;
        }
        let read = |sa: &libc::sockaddr| {
            let sin = unsafe { &*(sa as *const libc::sockaddr).cast::<libc::sockaddr_in>() };
            Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr))
        };
        let name = unsafe { CStr::from_ptr(entry.ifa_name) }
            .to_string_lossy()
            .into_owned();
        found.push(Interface {
            name,
            address: read(addr),
            netmask: read(mask),
        });
    }
    unsafe { libc::freeifaddrs(list) };
    found
}

/// This computer's IPv4 interface addresses.
#[cfg(target_os = "macos")]
pub fn interfaces() -> Vec<Interface> {
    let Ok(found) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    found
        .into_iter()
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(a) => Some(Interface {
                name: i.name,
                address: a.ip,
                netmask: a.netmask,
            }),
            if_addrs::IfAddr::V6(_) => None,
        })
        .collect()
}

/// This computer's address on its default route. Nothing is sent: the
/// address is from the documentation range, and only the route to it is
/// looked up.
#[cfg(target_os = "macos")]
pub fn default_route_address() -> Option<Ipv4Addr> {
    let probe = std::net::IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
    match crate::lan_server::route_to(probe).ok()? {
        std::net::IpAddr::V4(local) => Some(local),
        std::net::IpAddr::V6(_) => None,
    }
}
