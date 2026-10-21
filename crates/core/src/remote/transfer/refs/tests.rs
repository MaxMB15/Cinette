// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

/// One salt for the whole run, as one transfer uses one.
static SALT: std::sync::LazyLock<Salt> = std::sync::LazyLock::new(Salt::generate);

fn provider(kind: ProviderType, url: &str, username: Option<&str>) -> Provider {
    Provider {
        id: "xt-1".into(),
        name: "Home".into(),
        provider_type: kind,
        url: url.into(),
        username: username.map(Into::into),
        password: Some("secret".into()),
        last_updated: None,
        channel_count: 0,
        epg_url: None,
    }
}

fn xtream(url: &str, username: &str) -> Option<AccountTag> {
    account_tag(&SALT, &provider(ProviderType::Xtream, url, Some(username)))
}

fn m3u(url: &str) -> Option<AccountTag> {
    account_tag(&SALT, &provider(ProviderType::M3u, url, None))
}

#[test]
fn an_xtream_server_typed_two_ways_is_one_account() {
    let tag = xtream("http://panel.example:8080", "alice").unwrap();
    assert_eq!(
        xtream("  HTTP://Panel.Example:8080/ ", "alice"),
        Some(tag.clone())
    );
    assert_eq!(
        xtream("http://panel.example:8080/player_api.php", "alice"),
        Some(tag)
    );
    assert_eq!(
        xtream("http://panel.example", "alice"),
        xtream("http://panel.example:80/", "alice")
    );
}

#[test]
fn another_user_server_port_or_scheme_is_another_account() {
    let tag = xtream("http://panel.example:8080", "alice");
    assert_ne!(xtream("http://panel.example:8080", "bob"), tag);
    assert_ne!(xtream("http://other.example:8080", "alice"), tag);
    assert_ne!(xtream("http://panel.example:8081", "alice"), tag);
    assert_ne!(xtream("https://panel.example:8080", "alice"), tag);
}

#[test]
fn the_password_isnt_part_of_the_account() {
    let mut p = provider(ProviderType::Xtream, "http://panel.example", Some("alice"));
    let tag = account_tag(&SALT, &p);
    p.password = Some("changed".into());
    assert_eq!(account_tag(&SALT, &p), tag);
}

#[test]
fn a_new_salt_gives_a_new_tag() {
    let p = provider(ProviderType::Xtream, "http://panel.example", Some("alice"));
    assert_ne!(account_tag(&SALT, &p), account_tag(&Salt::generate(), &p));
}

#[test]
fn the_parts_cant_run_into_each_other() {
    // Without a separator, port 801 and no username would read the same as
    // port 80 and username "1".
    assert_ne!(
        xtream("http://a.example:801", ""),
        xtream("http://a.example:80", "1")
    );
    let one = m3u("http://a.example/list");
    let two = account_tag(
        &SALT,
        &provider(ProviderType::Xtream, "http://a.example/list", Some("")),
    );
    assert_ne!(one, two);
}

#[test]
fn an_m3u_url_is_its_account_without_the_password() {
    let tag = m3u("http://lists.example/get.php?username=a&password=b").unwrap();
    assert_eq!(
        m3u(" HTTP://Lists.example:80/get.php?password=c&username=a&type=m3u "),
        Some(tag.clone()),
        "the password and other values don't count"
    );
    assert_ne!(
        m3u("http://lists.example/get.php?username=z&password=b"),
        Some(tag.clone())
    );
    assert_ne!(
        m3u("http://lists.example/other.php?username=a&password=b"),
        Some(tag.clone())
    );
    assert_ne!(
        m3u("http://other.example/get.php?username=a&password=b"),
        Some(tag)
    );
}

#[test]
fn an_m3u_login_before_the_host_counts_by_its_username() {
    let tag = m3u("http://a:secret@lists.example/list.m3u").unwrap();
    assert_eq!(
        m3u("http://a:other@lists.example/list.m3u"),
        Some(tag.clone())
    );
    assert_ne!(
        m3u("http://b:secret@lists.example/list.m3u"),
        Some(tag.clone())
    );
    // A username in the query names the account even with one before the host.
    assert_eq!(m3u("http://x@lists.example/list.m3u?USERNAME=a"), Some(tag));
}

#[test]
fn a_file_or_nothing_has_no_account() {
    assert_eq!(m3u("file:///home/me/list.m3u"), None);
    assert_eq!(m3u("   "), None);
    assert_eq!(m3u("not a url"), None);
    assert_eq!(xtream("not a url", "alice"), None);
    assert_eq!(xtream("mailto:someone", "alice"), None);
}

#[test]
fn an_xtream_provider_without_a_username_has_an_account() {
    let p = provider(ProviderType::Xtream, "http://panel.example", None);
    assert_eq!(account_tag(&SALT, &p), xtream("http://panel.example", ""));
}

#[test]
fn a_tag_is_32_hex_digits_and_reads_back() {
    let tag = xtream("http://panel.example", "alice").unwrap();
    assert_eq!(tag.as_str().len(), 32);
    assert!(tag.as_str().bytes().all(|b| b.is_ascii_hexdigit()));
    let json = serde_json::to_string(&tag).unwrap();
    assert_eq!(serde_json::from_str::<AccountTag>(&json).unwrap(), tag);
}

#[test]
fn a_tag_reads_in_either_case_and_nothing_else() {
    let upper = "\"00112233445566778899AABBCCDDEEFF\"";
    let tag: AccountTag = serde_json::from_str(upper).unwrap();
    assert_eq!(tag.as_str(), "00112233445566778899aabbccddeeff");
    for bad in ["\"0011\"", "\"zz112233445566778899aabbccddeeff\"", "7"] {
        assert!(serde_json::from_str::<AccountTag>(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_salt_goes_to_hex_and_back_and_never_prints() {
    let salt = Salt::generate();
    assert_eq!(Salt::from_hex(&salt.to_hex()), Some(salt));
    assert_eq!(salt.to_hex().len(), SALT_LEN * 2);
    assert_ne!(Salt::generate(), salt);
    assert_eq!(Salt::from_hex("00"), None);
    assert_eq!(format!("{salt:?}"), "Salt(..)");
}

#[test]
fn titles_compare_without_case_or_extra_spaces() {
    assert_eq!(normalize_title("  The   Office\t(US) "), "the office (us)");
    assert_eq!(normalize_title(""), "");
}

#[test]
fn keys_are_the_ones_the_player_saves() {
    assert_eq!(movie_key(" Dune  Part Two"), "movie:dune part two");
    assert_eq!(episode_key("The Office", 2, 13), "series:the office:s2e13");
}

#[test]
fn keys_read_back() {
    assert_eq!(
        parse_key("movie:dune part two"),
        Some(KeyRef::Movie("dune part two".into()))
    );
    assert_eq!(
        parse_key("series:star trek: picard:s3e10"),
        Some(KeyRef::Episode {
            series: "star trek: picard".into(),
            season: 3,
            episode: 10,
        })
    );
}

#[test]
fn other_keys_dont_read() {
    for key in [
        "movie:",
        "live:news",
        "series:show",
        "series:show:3e1",
        "series:show:s3",
        "series:show:s3e",
        "series:show:se1",
        "series:show:sxe1",
        "series:show:s+1e1",
        "series:show:s1e+1",
        "series:show:s1ex",
        "series::s1e1",
        "series:show:s99999999999e1",
        "series:show:s1e99999999999",
    ] {
        assert_eq!(parse_key(key), None, "{key}");
    }
}

#[test]
fn panel_ids_come_from_xtream_channel_ids() {
    assert_eq!(panel_id("xt-ab-live-123", "xt-ab"), Some("live-123"));
    assert_eq!(panel_id("xt-ab-movie-8", "xt-ab"), Some("movie-8"));
    assert_eq!(panel_id("xt-ab-series-42", "xt-ab"), Some("series-42"));
    assert_eq!(
        panel_id("xt-ab-xt-ep-42-s1-3", "xt-ab"),
        Some("xt-ep-42-s1-3")
    );
}

#[test]
fn other_ids_have_no_panel_id() {
    assert_eq!(panel_id("xt-ab-live-123", "xt-abc"), None);
    assert_eq!(panel_id("xt-abc-live-123", "xt-ab"), None);
    assert_eq!(panel_id("xt-ablive-123", "xt-ab"), None);
    assert_eq!(panel_id("m3u-1-ch-3", "m3u-1"), None);
    assert_eq!(panel_id("xt-ab-live-", "xt-ab"), None);
    assert_eq!(panel_id("xt-ab-live", "xt-ab"), None);
    assert_eq!(panel_id("xt-ab-xt-foo", "xt-ab"), None);
}

#[test]
fn an_episode_id_reads_strictly() {
    assert_eq!(parse_episode_id("xt-ep-42-s1-3"), Some((42, 1, 3)));
    for junk in [
        "xt-ep-42-not-an-episode",
        "xt-ep-42-s1",
        "xt-ep-42-s1-3-4",
        "xt-ep-x-s1-3",
        "xt-ep-42-1-3",
        "xt-ep-42-sx-3",
        "xt-ep-42-s1-x",
        "xt-ep-+4-s1-3",
        "live-42",
        "xt-ep-99999999999999999999-s1-3",
    ] {
        assert_eq!(parse_episode_id(junk), None, "{junk}");
    }
}
