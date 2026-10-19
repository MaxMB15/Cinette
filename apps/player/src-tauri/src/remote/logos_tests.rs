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

#[test]
fn a_logo_from_another_device_must_be_on_a_public_host() {
    for ok in [
        "https://logos.example/a.png",
        "http://cdn.example.tv:8080/a.png",
        "http://93.184.216.34/a.png",
        "http://[2001:4860::1]/a.png",
        "https://Logos.Example./a.png",
    ] {
        assert!(fetchable(ok), "{ok}");
    }
    for bad in [
        "file:///etc/passwd",
        "data:image/png;base64,AAAA",
        "javascript:alert(1)",
        "https://user:pw@logos.example/a.png",
        "https://logos.example/a.png?track=1",
        "https://logos.example/a.png#x",
        "http://localhost/a.png",
        "http://router/a.png",
        "http://tv.local/a.png",
        "http://app.localhost/a.png",
        "http://127.0.0.1:47130/a.png",
        "http://10.0.0.1/a.png",
        "http://172.16.0.1/a.png",
        "http://192.168.1.1/a.png",
        "http://169.254.1.1/a.png",
        "http://100.64.0.1/a.png",
        "http://100.127.255.1/a.png",
        "http://0.0.0.0/a.png",
        "http://255.255.255.255/a.png",
        "http://224.0.0.1/a.png",
        "http://[::1]/a.png",
        "http://[::]/a.png",
        "http://[fd00::1]/a.png",
        "http://[fc00::1]/a.png",
        "http://[fe80::1]/a.png",
        "http://[ff02::1]/a.png",
        "http://[::ffff:192.168.1.1]/a.png",
        "not a url",
    ] {
        assert!(!fetchable(bad), "{bad}");
    }
    // Next to the shared address space, but outside it.
    assert!(fetchable("http://100.128.0.1/a.png"));
    assert!(fetchable("http://100.63.255.1/a.png"));
}

#[test]
fn an_item_keeps_only_a_logo_it_may_load() {
    let item = |logo: &str| CatalogItem {
        id: "a".into(),
        logo: Some(logo.into()),
        ..CatalogItem::default()
    };
    assert_eq!(checked(item("http://192.168.1.1/a.png")).logo, None);
    assert_eq!(
        checked(item("https://logos.example/a.png")).logo.as_deref(),
        Some("https://logos.example/a.png")
    );
    let none = CatalogItem::default();
    assert_eq!(checked(none.clone()), none);
}
