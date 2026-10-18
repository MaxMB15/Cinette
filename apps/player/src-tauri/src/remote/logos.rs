// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Which logos may go to another device, past what the core checks.

use mvp_core::remote::catalog::{provider_host, CatalogItem};

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
pub fn checked(mut item: CatalogItem) -> CatalogItem {
    if item.logo.as_deref().is_some_and(|logo| !fetchable(logo)) {
        item.logo = None;
    }
    item
}

/// Whether this device's webview may load `logo`, which another device
/// sent: plain http or https, with no login, query or fragment, on a public
/// host. Anything else could make the webview probe this network, or this
/// machine, for whoever sent it.
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
                name.contains('.') && !name.ends_with(".local") && !name.ends_with(".localhost")
            }
            Some(url::Host::Ipv4(ip)) => {
                !(ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || ip.is_broadcast()
                    || ip.is_multicast()
                    || ip.octets()[0] == 100 && ip.octets()[1] & 0xc0 == 64)
            }
            Some(url::Host::Ipv6(ip)) => {
                let first = ip.segments()[0];
                !(ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || first & 0xfe00 == 0xfc00
                    || first & 0xffc0 == 0xfe80
                    || ip.to_ipv4_mapped().is_some())
            }
            None => false,
        }
}

#[cfg(test)]
#[path = "logos_tests.rs"]
mod tests;
