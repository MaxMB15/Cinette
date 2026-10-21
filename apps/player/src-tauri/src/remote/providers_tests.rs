// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use std::sync::Mutex as StdMutex;

fn provider(
    id: &str,
    name: &str,
    kind: ProviderType,
    url: &str,
    username: Option<&str>,
) -> Provider {
    Provider {
        id: id.into(),
        name: name.into(),
        provider_type: kind,
        url: url.into(),
        username: username.map(Into::into),
        password: Some("made-up-password".into()),
        last_updated: None,
        channel_count: 0,
        epg_url: Some("http://panel.example/xmltv.php".into()),
    }
}

fn cache(providers: &[Provider]) -> Mutex<CacheStore> {
    let store = CacheStore::open_in_memory().unwrap();
    for p in providers {
        store.upsert_provider(p).unwrap();
    }
    Mutex::new(store)
}

fn home() -> Provider {
    provider(
        "xt-1",
        "Home",
        ProviderType::Xtream,
        "http://panel.example:8080",
        Some("viewer"),
    )
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn names_go_out_in_the_order_picked() {
    let lists = provider(
        "m3u-1",
        "Lists",
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    );
    let cache = cache(&[home(), lists]);
    assert_eq!(
        names_for(&cache, &ids(&["m3u-1", "xt-1"])).unwrap(),
        [
            ProviderName {
                name: "Lists".into(),
                kind: ProviderKind::M3u,
            },
            ProviderName {
                name: "Home".into(),
                kind: ProviderKind::Xtream,
            },
        ]
    );
}

#[test]
fn nothing_picked_a_gone_provider_or_a_file_cant_be_sent() {
    let file = provider(
        "m3u-f",
        "Mine",
        ProviderType::M3u,
        " file:///home/me/a.m3u",
        None,
    );
    let cache = cache(&[home(), file]);
    assert_eq!(
        names_for(&cache, &[]).unwrap_err(),
        "Pick a provider to send."
    );
    assert_eq!(
        names_for(&cache, &ids(&["xt-9"])).unwrap_err(),
        "One of those providers was removed."
    );
    assert!(names_for(&cache, &ids(&["xt-1", "m3u-f"]))
        .unwrap_err()
        .contains("file"));
}

#[test]
fn two_providers_with_one_name_and_kind_cant_go_together() {
    let twin = provider(
        "xt-2",
        "Home",
        ProviderType::Xtream,
        "http://other.example",
        Some("u"),
    );
    let m3u = provider(
        "m3u-1",
        "Home",
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    );
    let cache = cache(&[home(), twin, m3u]);
    assert!(names_for(&cache, &ids(&["xt-1", "xt-2"]))
        .unwrap_err()
        .contains("Rename one"));
    // The same name as another kind is fine.
    assert_eq!(
        names_for(&cache, &ids(&["xt-1", "m3u-1"])).unwrap().len(),
        2
    );
}

#[test]
fn settings_carry_the_login() {
    let cache = cache(&[home()]);
    let settings = settings_for(&cache, &ids(&["xt-1"])).unwrap();
    assert_eq!(
        settings,
        [ProviderSettings {
            name: "Home".into(),
            kind: ProviderKind::Xtream,
            url: "http://panel.example:8080".into(),
            username: Some("viewer".into()),
            password: Some("made-up-password".into()),
            epg_url: None,
        }]
    );
    assert!(settings_for(&cache, &ids(&["xt-9"])).is_err());
}

#[test]
fn local_files_are_m3u_file_urls() {
    assert!(is_local_file(&provider(
        "a",
        "a",
        ProviderType::M3u,
        "file:///x.m3u",
        None
    )));
    assert!(!is_local_file(&provider(
        "a",
        "a",
        ProviderType::M3u,
        "http://x/a.m3u",
        None
    )));
    assert!(!is_local_file(&provider(
        "a",
        "a",
        ProviderType::Xtream,
        "file:///x",
        None
    )));
}

#[test]
fn a_taken_name_gets_the_sending_devices_name() {
    let taken = ids(&["Home", "home (from Mac)"]);
    assert_eq!(free_name("Sports", "Mac", &taken), "Sports");
    assert_eq!(free_name("HOME", "Mac", &taken), "HOME (from Mac) 2");
    assert_eq!(
        free_name("Home", " Linux PC ", &taken),
        "Home (from Linux PC)"
    );
    assert_eq!(
        free_name("Home", "  ", &taken),
        "Home (from another device)"
    );
}

/// Stands in for the network: saves the provider under the name it's
/// given, or fails.
struct Fake {
    fail: bool,
    names: StdMutex<Vec<String>>,
}

impl Fake {
    fn new(fail: bool) -> Self {
        Self {
            fail,
            names: StdMutex::new(Vec::new()),
        }
    }
}

impl Loader for Fake {
    async fn load(
        &self,
        cache: &Mutex<CacheStore>,
        settings: &ProviderSettings,
        name: String,
    ) -> Result<(), String> {
        self.names.lock().unwrap().push(name.clone());
        if self.fail {
            return Err(format!("error sending request for url ({})", settings.url));
        }
        let id = format!("new-{}", self.names.lock().unwrap().len());
        let kind = match settings.kind {
            ProviderKind::M3u => ProviderType::M3u,
            ProviderKind::Xtream => ProviderType::Xtream,
        };
        let saved = Provider {
            username: settings.username.clone(),
            ..provider(&id, &name, kind, &settings.url, None)
        };
        cache.lock().unwrap().upsert_provider(&saved).unwrap();
        Ok(())
    }
}

fn sent(name: &str, kind: ProviderKind, url: &str, username: Option<&str>) -> ProviderSettings {
    ProviderSettings {
        name: name.into(),
        kind,
        url: url.into(),
        username: username.map(Into::into),
        password: Some("made-up-password".into()),
        epg_url: None,
    }
}

#[tokio::test]
async fn a_new_account_is_loaded_and_saved_as_this_devices_own() {
    let cache = cache(&[]);
    let fake = Fake::new(false);
    let results = save(
        &cache,
        &fake,
        "Mac",
        vec![sent(
            "Home",
            ProviderKind::Xtream,
            "http://panel.example:8080",
            Some("viewer"),
        )],
    )
    .await;
    assert_eq!(
        results,
        [ProviderResult {
            name: "Home".into(),
            outcome: ProviderOutcome::Added,
            error: None,
            saved_as: None,
        }]
    );
    assert_eq!(cache.lock().unwrap().get_providers().unwrap().len(), 1);
}

#[tokio::test]
async fn an_account_already_here_is_skipped() {
    let cache = cache(&[home()]);
    let fake = Fake::new(false);
    let results = save(
        &cache,
        &fake,
        "Mac",
        vec![
            // The same server and username, typed another way.
            sent(
                "Renamed",
                ProviderKind::Xtream,
                "HTTP://Panel.example:8080/",
                Some("viewer"),
            ),
            // Another user on the same server.
            sent(
                "Home",
                ProviderKind::Xtream,
                "http://panel.example:8080",
                Some("guest"),
            ),
        ],
    )
    .await;
    assert_eq!(results[0].outcome, ProviderOutcome::Exists);
    assert_eq!(results[1].outcome, ProviderOutcome::Added);
    assert_eq!(results[1].saved_as.as_deref(), Some("Home (from Mac)"));
    assert_eq!(*fake.names.lock().unwrap(), ["Home (from Mac)"]);
}

#[tokio::test]
async fn the_same_m3u_url_is_the_same_account() {
    let lists = provider(
        "m3u-1",
        "Lists",
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    );
    let cache = cache(&[lists]);
    let fake = Fake::new(false);
    let results = save(
        &cache,
        &fake,
        "Mac",
        vec![
            sent("Lists", ProviderKind::M3u, "http://l.example/a.m3u", None),
            sent("Lists", ProviderKind::M3u, "http://l.example/b.m3u", None),
        ],
    )
    .await;
    assert_eq!(results[0].outcome, ProviderOutcome::Exists);
    assert_eq!(results[1].outcome, ProviderOutcome::Added);
}

#[tokio::test]
async fn two_sent_with_one_name_get_two_names() {
    let cache = cache(&[]);
    let fake = Fake::new(false);
    let results = save(
        &cache,
        &fake,
        "Mac",
        vec![
            sent("Home", ProviderKind::Xtream, "http://a.example", Some("u")),
            sent("Home", ProviderKind::M3u, "http://b.example/l.m3u", None),
        ],
    )
    .await;
    assert_eq!(results[0].saved_as, None);
    assert_eq!(results[1].saved_as.as_deref(), Some("Home (from Mac)"));
}

#[tokio::test]
async fn a_provider_that_doesnt_load_isnt_saved_and_its_error_stays_here() {
    let cache = cache(&[]);
    let fake = Fake::new(true);
    let results = save(
        &cache,
        &fake,
        "Mac",
        vec![sent(
            "Home",
            ProviderKind::Xtream,
            "http://secret-panel.example",
            Some("u"),
        )],
    )
    .await;
    assert_eq!(
        results,
        [ProviderResult {
            name: "Home".into(),
            outcome: ProviderOutcome::Failed,
            error: Some(COULDNT_LOAD.into()),
            saved_as: None,
        }]
    );
    assert!(cache.lock().unwrap().get_providers().unwrap().is_empty());
}

#[tokio::test]
async fn a_sent_file_playlist_is_refused() {
    let cache = cache(&[]);
    let fake = Fake::new(false);
    let results = save(
        &cache,
        &fake,
        "Mac",
        vec![sent(
            "Mine",
            ProviderKind::M3u,
            "file:///home/me/a.m3u",
            None,
        )],
    )
    .await;
    assert_eq!(results[0].outcome, ProviderOutcome::Failed);
    assert!(fake.names.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_xtream_provider_with_an_address_that_doesnt_read_is_still_tried() {
    // No tag to compare, so it can't be "already here".
    let cache = cache(&[home()]);
    let fake = Fake::new(false);
    let results = save(
        &cache,
        &fake,
        "Mac",
        vec![sent(
            "Odd",
            ProviderKind::Xtream,
            "not a url",
            Some("viewer"),
        )],
    )
    .await;
    assert_eq!(results[0].outcome, ProviderOutcome::Added);
}

#[tokio::test]
async fn nothing_about_a_sent_provider_reaches_the_log() {
    let logged = crate::test_support::Logged::default();
    let _guard = logged.start();
    let cache = cache(&[]);
    for fail in [true, false] {
        save(
            &cache,
            &Fake::new(fail),
            "Mac",
            vec![sent(
                "Home",
                ProviderKind::Xtream,
                "http://secret-panel.example",
                Some("secret-user"),
            )],
        )
        .await;
    }
    let text = logged.text();
    assert!(text.contains("didn't load"), "{text}");
    assert!(text.contains("added a provider"), "{text}");
    for secret in ["secret-panel", "secret-user", "made-up-password"] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
}

#[test]
fn too_many_providers_or_a_name_the_other_device_cant_show_is_refused_first() {
    let many: Vec<Provider> = (0..33)
        .map(|i| {
            provider(
                &format!("m3u-{i}"),
                &format!("P{i}"),
                ProviderType::M3u,
                "http://l.example/a.m3u",
                None,
            )
        })
        .collect();
    let cache = cache(&many);
    let all: Vec<String> = (0..33).map(|i| format!("m3u-{i}")).collect();
    assert_eq!(
        names_for(&cache, &all).unwrap_err(),
        "Pick at most 32 providers at a time."
    );
    assert_eq!(names_for(&cache, &all[..32]).unwrap().len(), 32);

    for (name, why) in [
        ("x".repeat(129), "too long"),
        ("a\nb".to_string(), "a line break"),
        ("\u{202e}Home".to_string(), "a direction override"),
        ("  ".to_string(), "blank"),
    ] {
        let cache = cache_with(provider(
            "m3u-1",
            &name,
            ProviderType::M3u,
            "http://l.example/a.m3u",
            None,
        ));
        let err = names_for(&cache, &ids(&["m3u-1"])).unwrap_err();
        assert!(err.starts_with("Rename"), "{why}: {err}");
    }
    let fine = cache_with(provider(
        "m3u-1",
        &"x".repeat(128),
        ProviderType::M3u,
        "http://l.example/a.m3u",
        None,
    ));
    assert!(names_for(&fine, &ids(&["m3u-1"])).is_ok());
}

fn cache_with(p: Provider) -> Mutex<CacheStore> {
    cache(&[p])
}

#[test]
fn a_provider_whose_address_or_login_is_too_long_is_refused_first() {
    let long = "x".repeat(MAX_PROVIDER_FIELD + 1);
    let mut url = home();
    url.url = format!("http://panel.example/{long}");
    let mut user = home();
    user.username = Some(long.clone());
    let mut password = home();
    password.password = Some(long);
    for p in [url, user, password] {
        let err = names_for(&cache_with(p), &ids(&["xt-1"])).unwrap_err();
        assert!(err.contains("too long"), "{err}");
    }
}

#[test]
fn the_guide_address_isnt_sent() {
    let cache = cache(&[home()]);
    assert_eq!(
        settings_for(&cache, &ids(&["xt-1"])).unwrap()[0].epg_url,
        None
    );
}

#[tokio::test]
async fn an_account_here_twice_is_still_here() {
    let twin = Provider {
        id: "xt-2".into(),
        ..home()
    };
    let cache = cache(&[home(), twin]);
    let results = save(
        &cache,
        &Fake::new(false),
        "Mac",
        vec![sent(
            "Home",
            ProviderKind::Xtream,
            "http://panel.example:8080",
            Some("viewer"),
        )],
    )
    .await;
    assert_eq!(results[0].outcome, ProviderOutcome::Exists);
}

#[tokio::test]
async fn a_playlist_file_here_isnt_taken_for_a_sent_account() {
    let file = provider(
        "m3u-f",
        "Mine",
        ProviderType::M3u,
        "file:///home/me/a.m3u",
        None,
    );
    let cache = cache(&[file]);
    let results = save(
        &cache,
        &Fake::new(false),
        "Mac",
        vec![sent(
            "Lists",
            ProviderKind::M3u,
            "http://l.example/a.m3u",
            None,
        )],
    )
    .await;
    assert_eq!(results[0].outcome, ProviderOutcome::Added);
}
