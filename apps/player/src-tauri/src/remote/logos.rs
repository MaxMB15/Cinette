// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Which logos may go to another device, past what the core checks.

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

#[cfg(test)]
#[path = "logos_tests.rs"]
mod tests;
