// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Which logos may go to another device, past what the core checks.

#[cfg(remote)]
use mvp_core::remote::catalog::CatalogItem;
use mvp_core::remote::catalog::provider_host;

/// Whether `logo` is on the same site as one of `hosts`, or has no host.
pub fn on_a_provider_site(logo: &str, hosts: &[String]) -> bool {
    let Some(host) = provider_host(logo) else {
        return true;
    };
    let logo_site = site(&host);
    hosts.iter().any(|h| site(h) == logo_site)
}

/// The part of a host name its sibling hosts share: the last two labels,
/// or an IP address as it is. That's too broad for a name like
/// `panel.co.uk`, which only drops more logos.
fn site(host: &str) -> &str {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<std::net::IpAddr>().is_ok() {
        return host;
    }
    let trimmed = host.trim_end_matches('.');
    match trimmed.rmatch_indices('.').nth(1) {
        Some((dot, _)) => &trimmed[dot + 1..],
        None => trimmed,
    }
}

/// `item` with its logo dropped unless [`fetchable`].
#[cfg(remote)]
pub fn checked(mut item: CatalogItem) -> CatalogItem {
    if item.logo.as_deref().is_some_and(|logo| !fetchable(logo)) {
        item.logo = None;
    }
    item
}

/// Names that point into a home or office network, or at this machine:
/// the usual private suffixes, the routers' own names, and public names
/// that resolve to any address written in them.
#[cfg(remote)]
const LOCAL_NAMES: [&str; 14] = [
    "local",
    "localhost",
    "lan",
    "home",
    "home.arpa",
    "internal",
    "intranet",
    "corp",
    "private",
    "fritz.box",
    "speedport.ip",
    "nip.io",
    "sslip.io",
    "xip.io",
];

/// Whether this device's webview may load `logo`, which another device
/// sent: plain http or https, with no login, query or fragment, on what
/// looks like a public host. Anything else could make the webview probe
/// this network, or this machine, for whoever sent it.
///
/// This is a best effort on the name, not a guarantee: a public name can
/// still resolve to a private address. The full fix is for Rust to fetch
/// these logos and refuse any address it connects to that isn't public.
#[cfg(remote)]
pub fn fetchable(logo: &str) -> bool {
    let Ok(url) = url::Url::parse(logo) else {
        return false;
    };
    let plain = matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    plain
        && match url.host() {
            Some(url::Host::Domain(name)) => {
                let name = name.trim_end_matches('.').to_ascii_lowercase();
                name.contains('.')
                    && !LOCAL_NAMES.iter().any(|local| {
                        name == *local
                            || name
                                .strip_suffix(local)
                                .is_some_and(|rest| rest.ends_with('.'))
                    })
            }
            Some(url::Host::Ipv4(ip)) => {
                !(ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || ip.is_broadcast()
                    || ip.is_multicast()
                    || ip.octets()[0] == 100 && ip.octets()[1] & 0xc0 == 64
                    || ip.octets()[..3] == [192, 0, 0]
                    || ip.octets()[0] == 198 && ip.octets()[1] & 0xfe == 18
                    || ip.octets()[0] >= 240)
            }
            Some(url::Host::Ipv6(ip)) => {
                let first = ip.segments()[0];
                // The first 96 bits all zero: ::, ::1, and IPv4-compatible.
                !(ip.segments()[..6] == [0; 6]
                    || ip.is_multicast()
                    || first & 0xfe00 == 0xfc00
                    || first & 0xffc0 == 0xfe80
                    || first & 0xffc0 == 0xfec0
                    || ip.to_ipv4_mapped().is_some())
            }
            None => false,
        }
}

#[cfg(test)]
#[path = "logos_tests.rs"]
mod tests;
