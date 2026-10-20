// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn hosts(list: &[&str]) -> Vec<String> {
    list.iter().map(|h| (*h).to_owned()).collect()
}

#[test]
fn a_logo_next_to_a_provider_is_on_its_site() {
    let provider = hosts(&["panel.example.tv"]);
    assert!(on_a_provider_site(
        "http://logos.example.tv/a.png",
        &provider
    ));
    assert!(on_a_provider_site("http://example.tv/a.png", &provider));
    assert!(on_a_provider_site("http://EXAMPLE.TV./a.png", &provider));
    assert!(!on_a_provider_site(
        "https://logos.other.tv/a.png",
        &provider
    ));
    assert!(!on_a_provider_site("https://tv.example/a.png", &provider));
}

#[test]
fn addresses_are_compared_whole() {
    let provider = hosts(&["10.0.0.5", "[fd00::1]"]);
    assert!(on_a_provider_site("http://10.0.0.5:8080/a.png", &provider));
    assert!(!on_a_provider_site("http://10.0.1.5/a.png", &provider));
    assert!(on_a_provider_site("http://[fd00::1]/a.png", &provider));
    assert!(!on_a_provider_site("http://[fd00::2]/a.png", &provider));
}

#[test]
fn a_logo_without_a_host_counts_as_on_one() {
    assert!(on_a_provider_site("not a url", &[]));
    assert!(on_a_provider_site("file:///etc/a.png", &[]));
    assert!(!on_a_provider_site("https://logos.example/a.png", &[]));
}

#[test]
fn a_one_label_host_is_its_own_site() {
    let provider = hosts(&["localhost"]);
    assert!(on_a_provider_site("http://localhost/a.png", &provider));
    assert!(!on_a_provider_site("http://otherhost/a.png", &provider));
}
