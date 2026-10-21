// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The target as the app runs it, through the mock app: its commands, its
//! events and its settings file, with a phone on a loopback connection.
//! Nothing is advertised on the network; the advertiser only records.

use super::*;
use crate::remote::test_client::{self, Client, WAIT};
use crate::test_support::TestApp;
use mvp_core::http::test_server::{self, route, serve_routes};
use mvp_core::models::channel::Channel;
use mvp_core::models::playlist::{Provider, ProviderType};
use mvp_core::remote::catalog::CatalogItem;
use mvp_core::remote::controller::Event;
use mvp_core::remote::message::{CloseReason, ErrorCode};
use mvp_core::remote::settings::{default_name, ControlMode};
use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::Listener;
use tokio::sync::mpsc;
use tokio::time::timeout;

struct Running {
    app: TestApp,
    events: mpsc::UnboundedReceiver<(String, Value)>,
    /// Events read while waiting for another, oldest first.
    unclaimed: Vec<(String, Value)>,
    advertised: Arc<Mutex<Vec<Registration>>>,
    port: u16,
    /// Stands in for discovery: what's sent here is what browsing found.
    found: mpsc::UnboundedSender<discovery::Event>,
}

const EVENTS: [&str; 7] = [
    "remote://consent",
    "remote://consent-hidden",
    "remote://sessions",
    "remote://command",
    "remote://devices",
    "remote://controller",
    "remote://state",
];

impl Running {
    /// The app with remote control started, after `before` has had the
    /// chance to save settings.
    async fn start(before: impl FnOnce(&TestApp)) -> Self {
        let app = TestApp::new();
        before(&app);
        let (tx, events) = mpsc::unbounded_channel();
        for name in EVENTS {
            let tx = tx.clone();
            app.handle().listen_any(name, move |event| {
                let payload = serde_json::from_str(event.payload()).unwrap();
                let _ = tx.send((name.to_owned(), payload));
            });
        }
        let advertised = Arc::new(Mutex::new(Vec::new()));
        let record = advertised.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (found, found_rx) = mpsc::unbounded_channel();
        start_on(
            &app.handle(),
            app.app_dir(),
            listener,
            Box::new(move |r: &Registration| {
                lock(&record).push(r.clone());
                None
            }),
            found_rx,
            // Tests load one item after another at once.
            target::Limits {
                load_gap: Duration::ZERO,
                ..target::Limits::STANDARD
            },
        )
        .unwrap();
        Self {
            app,
            events,
            unclaimed: Vec::new(),
            advertised,
            port,
            found,
        }
    }

    fn invoke(&self, command: &str, args: Value) -> Result<Value, Value> {
        self.app.invoke(command, args)
    }

    fn service_settings(&self) -> RemoteSettings {
        self.app.handle().state::<RemoteService>().settings()
    }

    fn service_device_id(&self) -> DeviceId {
        self.app.handle().state::<RemoteService>().device_id()
    }

    fn device_id(&self) -> DeviceId {
        DeviceId::parse(
            self.invoke("remote_get_settings", json!({})).unwrap()["deviceId"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    }

    async fn phone(&self) -> Client {
        test_client::connect(
            self.port,
            self.device_id(),
            DeviceKey::generate(),
            "Phone",
            None,
        )
        .await
    }

    /// The oldest event called `name` not yet taken, waiting for one.
    async fn event(&mut self, name: &str) -> Value {
        if let Some(i) = self.unclaimed.iter().position(|(got, _)| got == name) {
            return self.unclaimed.remove(i).1;
        }
        loop {
            let (got, payload) = timeout(WAIT, self.events.recv())
                .await
                .unwrap_or_else(|_| panic!("no {name} event came"))
                .unwrap();
            if got == name {
                return payload;
            }
            self.unclaimed.push((got, payload));
        }
    }

    fn last_advertised(&self) -> Option<Registration> {
        lock(&self.advertised).last().cloned()
    }
}

fn saved_settings(app: &TestApp) -> Value {
    let text = std::fs::read_to_string(app.app_dir().join(SETTINGS_STORE_FILE)).unwrap();
    serde_json::from_str::<Value>(&text).unwrap()[SETTINGS_KEY].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_with_the_defaults_and_a_saved_key() {
    let running = Running::start(|_| {}).await;
    let view = running.invoke("remote_get_settings", json!({})).unwrap();
    assert_eq!(view["discoverable"], json!(true));
    assert_eq!(view["remoteControl"], json!("ask"));
    assert_eq!(view["deviceName"], Value::Null);
    assert_eq!(view["defaultName"], json!(default_name(device_type())));
    let key = std::fs::read(running.app.app_dir().join(identity::KEY_FILE)).unwrap();
    let key = DeviceKey::from_private(key.try_into().unwrap());
    assert_eq!(view["deviceId"], json!(key.device_id().to_string()));
    assert_eq!(running.service_device_id(), key.device_id());

    // The first record goes out as the target starts.
    let deadline = std::time::Instant::now() + WAIT;
    while running.last_advertised().is_none() && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let record = running.last_advertised().expect("advertised");
    assert_eq!(record.port, running.port);
    assert_eq!(record.instance, default_name(device_type()));
}

#[tokio::test(flavor = "multi_thread")]
async fn uses_the_settings_saved_last_time() {
    let running = Running::start(|app| {
        let store = app.handle().store(SETTINGS_STORE_FILE).unwrap();
        store.set(
            SETTINGS_KEY,
            json!({ "discoverable": true, "remoteControl": "never", "deviceName": "Den" }),
        );
        store.save().unwrap();
    })
    .await;
    let view = running.invoke("remote_get_settings", json!({})).unwrap();
    assert_eq!(view["remoteControl"], json!("never"));
    assert_eq!(view["deviceName"], json!("Den"));
    let mut phone = running.phone().await;
    assert_eq!(phone.closed().await, Some(CloseReason::NotAllowed));
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_settings_writes_them_and_tells_the_target() {
    let running = Running::start(|_| {}).await;
    let view = running
        .invoke(
            "remote_set_settings",
            json!({ "settings": { "discoverable": true, "remoteControl": "always", "deviceName": "  Den  " } }),
        )
        .unwrap();
    assert_eq!(view["remoteControl"], json!("always"));
    assert_eq!(view["deviceName"], json!("Den"));
    assert_eq!(
        saved_settings(&running.app),
        json!({ "discoverable": true, "remoteControl": "always", "deviceName": "Den" })
    );
    assert_eq!(
        running.service_settings().device_name.as_deref(),
        Some("Den")
    );
    // Always allow lets the phone straight in.
    let mut phone = running.phone().await;
    phone.connected().await;
    let deadline = std::time::Instant::now() + WAIT;
    while running.last_advertised().map(|r| r.instance) != Some("Den".into())
        && std::time::Instant::now() < deadline
    {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(running.last_advertised().unwrap().instance, "Den");
}

#[tokio::test(flavor = "multi_thread")]
async fn never_allow_ends_sessions_even_when_it_cant_be_saved() {
    let running = Running::start(|_| {}).await;
    let mut phone = connected(&running).await;
    let saved = saved_settings(&running.app);
    // A folder where the file goes makes every write of it fail.
    let file = running.app.app_dir().join(SETTINGS_STORE_FILE);
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    let error = running
        .invoke(
            "remote_set_settings",
            json!({ "settings": { "discoverable": true, "remoteControl": "never", "deviceName": null } }),
        )
        .unwrap_err();
    assert!(
        error.as_str().unwrap().contains("couldn't be saved"),
        "{error}"
    );
    assert_eq!(phone.closed().await, Some(CloseReason::Revoked));
    assert_eq!(
        running.service_settings().remote_control,
        ControlMode::Never
    );
    // The store keeps what it had, so the next write doesn't save it.
    let store = running.app.handle().store(SETTINGS_STORE_FILE).unwrap();
    assert_eq!(store.get(SETTINGS_KEY), Some(saved));
}

#[tokio::test(flavor = "multi_thread")]
async fn consent_goes_to_the_webview_and_its_answer_comes_back() {
    let mut running = Running::start(|_| {}).await;
    let mut phone = running.phone().await;
    let code = phone.code().await;
    phone.pending().await;
    let consent = running.event("remote://consent").await;
    // A page that wasn't listening yet finds it.
    let pending = running.invoke("remote_pending_consent", json!({})).unwrap();
    assert_eq!(pending["request"], consent["request"]);
    assert_eq!(pending["code"], consent["code"]);
    assert!(pending["expiresInMs"].as_u64().unwrap() <= consent["expiresInMs"].as_u64().unwrap());
    assert_eq!(consent["name"], json!("Phone"));
    assert_eq!(consent["deviceType"], json!("iphone"));
    assert_eq!(consent["code"], json!(code));
    assert_eq!(
        consent["deviceId"],
        json!(phone.key.device_id().to_string())
    );
    let expires = consent["expiresInMs"].as_u64().unwrap();
    assert!((25_000..=30_000).contains(&expires), "{expires}");

    running
        .invoke(
            "remote_answer_consent",
            json!({ "request": consent["request"], "allow": true }),
        )
        .unwrap();
    phone.connected().await;
    assert_eq!(
        running.event("remote://consent-hidden").await,
        json!({ "request": consent["request"] })
    );
    assert_eq!(
        running.invoke("remote_pending_consent", json!({})),
        Ok(Value::Null),
        "an answered request is gone"
    );
    let sessions = running.event("remote://sessions").await;
    assert_eq!(sessions[0]["name"], json!("Phone"));
    assert_eq!(sessions[0]["deviceType"], json!("iphone"));
    assert_eq!(sessions[0]["connected"], json!(true));
    assert_eq!(
        sessions[0]["deviceId"],
        json!(phone.key.device_id().to_string())
    );
    let listed = running.invoke("remote_sessions", json!({})).unwrap();
    assert_eq!(listed, sessions);

    running
        .invoke(
            "remote_disconnect",
            json!({ "sessionId": sessions[0]["sessionId"] }),
        )
        .unwrap();
    assert_eq!(phone.closed().await, Some(CloseReason::Revoked));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_denied_request_grants_nothing() {
    let mut running = Running::start(|_| {}).await;
    let mut phone = running.phone().await;
    phone.pending().await;
    let consent = running.event("remote://consent").await;
    running
        .invoke(
            "remote_answer_consent",
            json!({ "request": consent["request"], "allow": false }),
        )
        .unwrap();
    assert_eq!(phone.closed().await, Some(CloseReason::Denied));
}

async fn connected(running: &Running) -> Client {
    running
        .invoke(
            "remote_set_settings",
            json!({ "settings": { "discoverable": true, "remoteControl": "always", "deviceName": null } }),
        )
        .unwrap();
    let mut phone = running.phone().await;
    phone.connected().await;
    phone
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_reach_the_webview_and_its_outcome_reaches_the_phone() {
    let mut running = Running::start(|_| {}).await;
    let mut phone = connected(&running).await;
    let (id, bytes) = phone.controller.command(Command::Stop).unwrap();
    phone.write(&bytes).await;
    let command = running.event("remote://command").await;
    assert_eq!(command["command"], json!({ "action": "stop" }));
    running
        .invoke(
            "remote_finish_command",
            json!({ "token": command["token"], "outcome": "failed" }),
        )
        .unwrap();
    let reply = phone
        .wait_for(|e| match e {
            Event::Reply { request, result } if *request == id => Some(*result),
            _ => None,
        })
        .await;
    assert_eq!(reply, Some(Err(ErrorCode::Failed)));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_players_state_reaches_the_phone_without_provider_logos() {
    let running = Running::start(|app| {
        app.state()
            .cache
            .lock()
            .unwrap()
            .upsert_provider(&Provider {
                id: "p1".into(),
                name: "Mine".into(),
                provider_type: ProviderType::Xtream,
                url: "http://iptv.example:8080".into(),
                username: Some("user".into()),
                password: Some("pass".into()),
                last_updated: None,
                channel_count: 0,
                epg_url: None,
            })
            .unwrap();
    })
    .await;
    let mut phone = connected(&running).await;
    running
        .invoke(
            "remote_set_state",
            json!({ "state": {
                "status": "playing",
                "item": { "id": "p1-live-1", "name": "News", "contentType": "live",
                          "logoUrl": "http://iptv.example:8080/logo.png" },
                "position": 3, "duration": 0, "volume": 20,
                "subtitleId": null, "audioId": null, "error": null
            } }),
        )
        .unwrap();
    let state = phone
        .wait_for(|e| match e {
            Event::State(s) if s.state.item.is_some() => Some(s.clone()),
            _ => None,
        })
        .await
        .unwrap();
    let item = state.state.item.unwrap();
    assert_eq!(item.id, "p1-live-1");
    assert_eq!(item.logo, None);
    assert_eq!(state.state.volume, Some(20));
}

#[tokio::test(flavor = "multi_thread")]
async fn catalog_queries_read_the_cache() {
    let running = Running::start(|app| {
        let channel = Channel {
            id: "p1-live-1".into(),
            name: "News".into(),
            url: "http://iptv.example/live/u/p/1.ts".into(),
            group_title: "UK".into(),
            content_type: "live".into(),
            ..Channel::default()
        };
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        cache
            .upsert_provider(&Provider {
                id: "p1".into(),
                name: "Mine".into(),
                provider_type: ProviderType::M3u,
                url: "http://iptv.example/list.m3u".into(),
                username: None,
                password: None,
                last_updated: None,
                channel_count: 1,
                epg_url: None,
            })
            .unwrap();
        cache.save_channels("p1", &[channel]).unwrap();
    })
    .await;
    let mut phone = connected(&running).await;
    let (id, bytes) = phone
        .controller
        .catalog(CatalogQuery::Groups {
            content_type: "live".into(),
            cursor: None,
            limit: 100,
        })
        .unwrap();
    phone.write(&bytes).await;
    let items = phone
        .wait_for(|e| match e {
            Event::Page { request, items, .. } if *request == id => Some(items.clone()),
            _ => None,
        })
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].name, "UK");
}

/// The items of the episodes page of `series_id`, as the phone gets them.
async fn ask_for_episodes(phone: &mut Client, series_id: &str) -> Vec<CatalogItem> {
    let (id, bytes) = phone
        .controller
        .catalog(CatalogQuery::Episodes {
            series_id: series_id.into(),
            cursor: None,
            limit: 100,
        })
        .unwrap();
    phone.write(&bytes).await;
    phone
        .wait_for(|e| match e {
            Event::Page { request, items, .. } if *request == id => Some(items.clone()),
            _ => None,
        })
        .await
        .unwrap()
}

/// The channel the webview gets with a load of `item_id`, if any. The load
/// is finished, so the next can come.
async fn channel_with_load(running: &mut Running, phone: &mut Client, item_id: &str) -> Value {
    let (id, bytes) = phone
        .controller
        .command(Command::Load {
            item_id: item_id.into(),
            start_at: None,
        })
        .unwrap();
    phone.write(&bytes).await;
    let event = running.event("remote://command").await;
    running
        .invoke(
            "remote_finish_command",
            json!({ "token": event["token"], "outcome": "ok" }),
        )
        .unwrap();
    phone
        .wait_for(|e| matches!(e, Event::Reply { request, .. } if *request == id).then_some(()))
        .await
        .unwrap();
    event.get("channel").cloned().unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn episodes_are_loaded_from_the_provider_and_a_load_carries_the_episode() {
    let (url, requests) = serve_routes(vec![route(
        "action=get_series_info",
        "200 OK",
        r#"{"info":{"name":"The Show"},"episodes":{"1":[
            {"id":"9001","episode_num":1,"title":"First"}]}}"#,
    )]);
    let mut running = Running::start(|app| {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        cache
            .upsert_provider(&Provider {
                id: "p1".into(),
                name: "Panel".into(),
                provider_type: ProviderType::Xtream,
                url: url.clone(),
                username: Some("user".into()),
                password: Some(test_server::password()),
                last_updated: None,
                channel_count: 1,
                epg_url: None,
            })
            .unwrap();
        let series = Channel {
            id: "p1-series-7".into(),
            name: "The Show".into(),
            url: "xtream://series/7".into(),
            group_title: "Drama".into(),
            content_type: "series".into(),
            ..Channel::default()
        };
        cache.save_channels("p1", &[series]).unwrap();
    })
    .await;
    let mut phone = connected(&running).await;
    let items = ask_for_episodes(&mut phone, "p1-series-7").await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, "p1-xt-ep-7-s1-0");
    assert_eq!(items[0].episode, Some(1));
    // Asked again soon, they come from what was loaded.
    let again = ask_for_episodes(&mut phone, "p1-series-7").await;
    assert_eq!(again, items);
    let asked = requests
        .try_iter()
        .filter(|r| r.contains("action=get_series_info"))
        .count();
    assert_eq!(asked, 1, "the provider is asked once");

    let channel = channel_with_load(&mut running, &mut phone, "p1-xt-ep-7-s1-0").await;
    assert_eq!(channel["id"], "p1-xt-ep-7-s1-0");
    assert_eq!(channel["name"], "The Show S01E01 First");
    assert!(channel["url"].as_str().unwrap().starts_with(&url));
    let other = channel_with_load(&mut running, &mut phone, "p1-live-1").await;
    assert_eq!(other, Value::Null, "only episodes come with a channel");
}

#[tokio::test(flavor = "multi_thread")]
async fn loads_find_the_episodes_of_the_last_four_series_asked_for() {
    let series = |n: u32| format!("p1-series-{n}");
    let episode = |n: u32| format!("p1-ep-{n}");
    let mut running = Running::start(|app| {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        for n in 1..=5 {
            let ep = Channel {
                id: episode(n),
                name: format!("Episode {n}"),
                url: format!("http://iptv.example/series/user/pass/{n}.mkv"),
                content_type: "series".into(),
                season: Some(1),
                episode: Some(n),
                ..Channel::default()
            };
            cache.save_series_episodes(&series(n), &[ep]).unwrap();
        }
    })
    .await;
    let mut phone = connected(&running).await;
    // The second ask for series 1 moves it to the newest, and keeps one copy.
    for n in [1, 2, 3, 4, 1, 1] {
        ask_for_episodes(&mut phone, &series(n)).await;
    }
    for n in [2, 3, 4, 1] {
        let channel = channel_with_load(&mut running, &mut phone, &episode(n)).await;
        assert_eq!(channel["id"], episode(n), "series {n} is kept");
    }
    ask_for_episodes(&mut phone, &series(5)).await;
    let oldest = channel_with_load(&mut running, &mut phone, &episode(2)).await;
    assert_eq!(oldest, Value::Null, "series 2 is forgotten");
    let next = channel_with_load(&mut running, &mut phone, &episode(3)).await;
    assert_eq!(next["id"], episode(3));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_identity_is_saved_and_ends_sessions() {
    let running = Running::start(|_| {}).await;
    let mut phone = connected(&running).await;
    let before = running.device_id();
    let view = running.invoke("remote_reset_identity", json!({})).unwrap();
    let after = view["deviceId"].as_str().unwrap().to_owned();
    assert_ne!(after, before.to_string());
    let key = std::fs::read(running.app.app_dir().join(identity::KEY_FILE)).unwrap();
    let key = DeviceKey::from_private(key.try_into().unwrap());
    assert_eq!(key.device_id().to_string(), after);
    assert_eq!(phone.closed().await, Some(CloseReason::Shutdown));
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_tells_the_phone() {
    let running = Running::start(|_| {}).await;
    let mut phone = connected(&running).await;
    let handle: tauri::AppHandle<MockRuntime> = running.app.handle();
    tokio::task::spawn_blocking(move || stop_for_exit(&handle))
        .await
        .unwrap();
    assert_eq!(phone.closed().await, Some(CloseReason::Shutdown));
}

#[test]
fn quitting_without_remote_control_does_nothing() {
    let app = TestApp::new();
    stop_for_exit(&app.handle());
}

#[test]
fn commands_say_when_remote_control_did_not_start() {
    let app = TestApp::new();
    for (command, args) in [
        ("remote_get_settings", json!({})),
        ("remote_sessions", json!({})),
        ("remote_pending_consent", json!({})),
        ("remote_disconnect", json!({ "sessionId": "s" })),
    ] {
        assert_eq!(
            app.invoke(command, args),
            Err(json!("Remote control didn't start on this device.")),
            "{command}"
        );
    }
}

/// Two app instances in one process: `mac` finds `tv` as discovery would.
async fn pair(tv_mode: &str) -> (Running, Running) {
    let mac = Running::start(|_| {}).await;
    let tv = Running::start(|_| {}).await;
    tv.invoke(
        "remote_set_settings",
        json!({ "settings": { "discoverable": true, "remoteControl": tv_mode, "deviceName": "TV" } }),
    )
    .unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    let record = loop {
        match tv.last_advertised() {
            Some(r) if r.instance == "TV" && r.txt.get_str("rc").is_some() => {
                let allowed =
                    r.txt.get_str("rc") == Some(if tv_mode == "never" { "0" } else { "1" });
                if allowed {
                    break r;
                }
            }
            _ => {}
        }
        assert!(std::time::Instant::now() < deadline, "tv never advertised");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    mac.found
        .send(discovery::Event::Found {
            instance: record.instance.clone(),
            host: format!("{}.local.", record.host_label),
            addrs: vec![std::net::IpAddr::from([127, 0, 0, 1])],
            port: record.port,
            txt: record.txt.clone(),
        })
        .unwrap();
    (mac, tv)
}

async fn phase(running: &mut Running, wanted: &str) -> Value {
    loop {
        let event = running.event("remote://controller").await;
        if event["phase"] == json!(wanted) {
            return event;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn one_instance_controls_another() {
    let (mut mac, mut tv) = pair("ask").await;
    let devices = mac.event("remote://devices").await;
    let tv_id = tv.device_id().to_string();
    assert_eq!(
        devices,
        json!([{ "deviceId": tv_id, "name": "TV", "deviceType": device_type().as_str(),
                 "controlAllowed": true, "available": true }])
    );
    assert_eq!(mac.invoke("remote_devices", json!({})).unwrap(), devices);

    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 1 }))
        .unwrap();
    let verifying = phase(&mut mac, "verifying").await;
    assert_eq!(verifying["deviceId"], json!(tv_id));
    let consent = tv.event("remote://consent").await;
    assert_eq!(
        consent["code"], verifying["code"],
        "both screens show one code"
    );
    assert_eq!(consent["name"], json!(default_name(device_type())));
    phase(&mut mac, "pending").await;
    tv.invoke(
        "remote_answer_consent",
        json!({ "request": consent["request"], "allow": true }),
    )
    .unwrap();
    phase(&mut mac, "connected").await;
    let first = mac.event("remote://state").await;
    assert_eq!(first["deviceId"], json!(tv_id));

    // A command goes to the TV's player and its answer comes back.
    let reply = {
        let handle = mac.app.handle();
        tokio::task::spawn_blocking(move || {
            crate::test_support::invoke_on(
                &handle,
                "remote_command",
                json!({ "command": { "action": "stop" }, "link": 1 }),
            )
        })
    };
    let command = tv.event("remote://command").await;
    tv.invoke(
        "remote_finish_command",
        json!({ "token": command["token"], "outcome": "ok" }),
    )
    .unwrap();
    assert!(reply.await.unwrap().unwrap().is_u64());

    // A state from the TV reaches the Mac.
    tv.invoke(
        "remote_set_state",
        json!({ "state": {
            "status": "paused", "item": null, "position": 1, "duration": 0,
            "volume": null, "subtitleId": null, "audioId": null, "error": null
        } }),
    )
    .unwrap();
    loop {
        let state = mac.event("remote://state").await;
        if state["state"]["state"]["status"] == json!("paused") {
            break;
        }
    }

    // A catalog page from the TV's cache.
    let page = mac
        .invoke(
            "remote_catalog",
            json!({ "catalogQuery": { "kind": "groups", "contentType": "live", "limit": 100 }, "link": 1 }),
        )
        .unwrap();
    assert_eq!(page, json!({ "items": [], "next": null }));

    // Leaving ends the session on both sides. The webview asked, so no
    // event tells it.
    mac.invoke("remote_leave", json!({ "link": 1 })).unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while tv.invoke("remote_sessions", json!({})).unwrap() != json!([]) {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        mac.invoke(
            "remote_command",
            json!({ "command": { "action": "stop" }, "link": 1 })
        ),
        Err(json!("link_not_connected"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_target_disconnecting_ends_the_link() {
    let (mut mac, mut tv) = pair("always").await;
    let tv_id = tv.device_id().to_string();
    mac.event("remote://devices").await;
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 1 }))
        .unwrap();
    phase(&mut mac, "connected").await;
    let sessions = tv.event("remote://sessions").await;
    tv.invoke(
        "remote_disconnect",
        json!({ "sessionId": sessions[0]["sessionId"] }),
    )
    .unwrap();
    assert_eq!(
        phase(&mut mac, "closed").await["reason"],
        json!({ "target": "revoked" })
    );
    assert_eq!(
        mac.invoke(
            "remote_catalog",
            json!({ "catalogQuery": { "kind": "groups", "contentType": "live", "limit": 100 }, "link": 1 })
        ),
        Err(json!("link_not_connected"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_command_names_its_code() {
    let (mut mac, tv) = pair("always").await;
    let tv_id = tv.device_id().to_string();
    mac.event("remote://devices").await;
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 1 }))
        .unwrap();
    phase(&mut mac, "connected").await;
    assert_eq!(
        mac.invoke(
            "remote_command",
            json!({ "command": { "action": "pause", "itemId": "nothing" }, "link": 1 })
        ),
        Err(json!("stale_item"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn only_devices_on_the_network_that_allow_control_can_be_asked() {
    let (mut mac, tv) = pair("never").await;
    mac.event("remote://devices").await;
    assert_eq!(
        mac.invoke(
            "remote_connect",
            json!({ "deviceId": tv.device_id().to_string(), "link": 1 })
        ),
        Err(json!("That device doesn't allow remote control."))
    );
    assert_eq!(
        mac.invoke(
            "remote_connect",
            json!({ "deviceId": DeviceKey::generate().device_id().to_string(), "link": 1 })
        ),
        Err(json!("That device isn't on the network now."))
    );
    assert_eq!(
        mac.invoke("remote_connect", json!({ "deviceId": "nope", "link": 1 })),
        Err(json!("That isn't a device id."))
    );
    assert_eq!(
        mac.invoke(
            "remote_command",
            json!({ "command": { "action": "stop" }, "link": 1 })
        ),
        Err(json!("link_not_connected"))
    );
    // Leaving with nothing to leave is fine.
    mac.invoke("remote_leave", json!({ "link": 1 })).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_that_goes_away_leaves_the_list() {
    let (mut mac, _tv) = pair("ask").await;
    mac.event("remote://devices").await;
    mac.found
        .send(discovery::Event::Removed {
            instance: "TV".into(),
        })
        .unwrap();
    assert_eq!(mac.event("remote://devices").await, json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_late_leave_for_an_old_link_keeps_the_new_one() {
    let (mut mac, tv) = pair("always").await;
    let tv_id = tv.device_id().to_string();
    mac.event("remote://devices").await;
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 1 }))
        .unwrap();
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 2 }))
        .unwrap();
    // The leave for link 1 arrives after link 2 took its place.
    mac.invoke("remote_leave", json!({ "link": 1 })).unwrap();
    assert_eq!(mac.invoke("remote_link", json!({})), Ok(json!(2)));
    phase(&mut mac, "connected").await;
    mac.invoke("remote_leave", json!({ "link": 2 })).unwrap();
    assert_eq!(mac.invoke("remote_link", json!({})), Ok(json!(null)));
    // A connect the leave overtook on the way, numbered at or below it, is
    // refused, so it can't leave a link no one tracks.
    for link in [1, 2] {
        assert_eq!(
            mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": link })),
            Err(json!("That connection was left already."))
        );
    }
    assert_eq!(mac.invoke("remote_link", json!({})), Ok(json!(null)));
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 3 }))
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn connecting_again_is_not_undone_by_the_old_link_ending() {
    let (mut mac, mut tv) = pair("always").await;
    let tv_id = tv.device_id().to_string();
    mac.event("remote://devices").await;
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 1 }))
        .unwrap();
    phase(&mut mac, "connected").await;
    mac.invoke("remote_leave", json!({ "link": 1 })).unwrap();
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 2 }))
        .unwrap();
    phase(&mut mac, "connected").await;
    // The new session works, and the old one's end said nothing.
    let reply = {
        let handle = mac.app.handle();
        tokio::task::spawn_blocking(move || {
            crate::test_support::invoke_on(
                &handle,
                "remote_command",
                json!({ "command": { "action": "stop" }, "link": 2 }),
            )
        })
    };
    let command = tv.event("remote://command").await;
    tv.invoke(
        "remote_finish_command",
        json!({ "token": command["token"], "outcome": "ok" }),
    )
    .unwrap();
    assert!(reply.await.unwrap().is_ok());
    while let Ok((name, payload)) = mac.events.try_recv() {
        assert!(
            !(name == "remote://controller" && payload["phase"] == json!("closed")),
            "{payload}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_current_link_reaches_the_webview() {
    let mut running = Running::start(|_| {}).await;
    let own = DeviceKey::generate().device_id();
    let device = DeviceKey::generate().device_id();
    let host = TauriLinkHost {
        app: running.app.handle(),
        devices: Arc::new(Mutex::new(Devices::new(own))),
        link: Arc::new(Mutex::new(Some(LinkHandle::detached(2, device.clone())))),
        throttle: Arc::new(Mutex::new(Throttle::default())),
    };
    let state = VersionedState {
        epoch: "e".into(),
        version: 1,
        state: mvp_core::remote::message::PlaybackSnapshot::default(),
    };
    // Link 1 was replaced by link 2.
    host.phase(1, &device, &Phase::Reconnecting { attempt: 1 });
    host.state(1, &device, &state);
    host.phase(2, &device, &Phase::Connected);
    host.state(
        2,
        &device,
        &VersionedState {
            version: 2,
            ..state
        },
    );
    // Events come in order, so the first of each is link 2's.
    let controller = running.event("remote://controller").await;
    assert_eq!(controller["phase"], json!("connected"));
    let shown = running.event("remote://state").await;
    assert_eq!(shown["state"]["version"], json!(2));
}

#[test]
fn consent_asks_for_attention_at_most_every_two_minutes() {
    let now = Instant::now() + Duration::from_secs(300);
    assert!(may_raise(None, now));
    assert!(!may_raise(Some(now - Duration::from_secs(119)), now));
    assert!(may_raise(Some(now - RAISE_EVERY), now));
    assert!(may_raise(Some(now - Duration::from_secs(121)), now));
}

#[test]
fn provider_loads_come_four_at_once_then_one_a_second() {
    let start = Instant::now();
    let mut bucket = Bucket::full();
    for _ in 0..FETCH_BURST {
        assert!(bucket.take(start));
    }
    assert!(!bucket.take(start));
    assert!(!bucket.take(start + Duration::from_millis(999)));
    assert!(bucket.take(start + FETCH_EVERY));
    assert!(!bucket.take(start + FETCH_EVERY));
    // Half a second's wait carries over to the next token.
    assert!(!bucket.take(start + Duration::from_millis(1500)));
    assert!(bucket.take(start + FETCH_EVERY * 2));
    // A long wait fills it, but no further than the burst.
    let later = start + Duration::from_secs(60);
    for _ in 0..FETCH_BURST {
        assert!(bucket.take(later));
    }
    assert!(!bucket.take(later));
}

#[test]
fn a_token_earned_partway_through_isnt_lost_by_taking_one() {
    let start = Instant::now();
    let mut bucket = Bucket::full();
    for _ in 0..FETCH_BURST {
        assert!(bucket.take(start));
    }
    // Half a second into the second interval, the first one's token goes;
    // the second one's still comes a second after the first.
    assert!(bucket.take(start + Duration::from_millis(1500)));
    assert!(bucket.take(start + FETCH_EVERY * 2));
}

#[test]
fn tokens_earned_together_are_handed_out_once() {
    let start = Instant::now();
    let mut bucket = Bucket::full();
    for _ in 0..FETCH_BURST {
        assert!(bucket.take(start));
    }
    let later = start + FETCH_EVERY * 2;
    assert!(bucket.take(later));
    assert!(bucket.take(later));
    assert!(!bucket.take(later), "two intervals earn two");
}

#[test]
fn a_gate_lasts_while_anyone_holds_it() {
    let gates = Gates::default();
    let first = gates.enter("series-1");
    let second = gates.enter("series-1");
    assert!(Arc::ptr_eq(&first, &second), "one lock for one series");
    let other = gates.enter("series-2");
    assert!(!Arc::ptr_eq(&first, &other));
    gates.leave(first);
    assert_eq!(gates.len(), 2, "series-1 is still being loaded");
    gates.leave(second);
    gates.leave(other);
    assert_eq!(gates.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_flood_of_states_reaches_the_webview_as_a_few_with_the_newest_last() {
    let mut running = Running::start(|_| {}).await;
    let own = DeviceKey::generate().device_id();
    let device = DeviceKey::generate().device_id();
    let host = TauriLinkHost {
        app: running.app.handle(),
        devices: Arc::new(Mutex::new(Devices::new(own))),
        link: Arc::new(Mutex::new(Some(LinkHandle::detached(1, device.clone())))),
        throttle: Arc::new(Mutex::new(Throttle::default())),
    };
    let state = |version| VersionedState {
        epoch: "e".into(),
        version,
        state: mvp_core::remote::message::PlaybackSnapshot::default(),
    };
    for version in 1..=50 {
        host.state(1, &device, &state(version));
    }
    let first = running.event("remote://state").await;
    assert_eq!(first["state"]["version"], json!(1));
    assert_eq!(first["link"], json!(1));
    let held = running.event("remote://state").await;
    assert_eq!(held["state"]["version"], json!(50), "the newest, held back");
    tokio::time::sleep(STATE_EVERY * 3).await;
    while let Ok((name, payload)) = running.events.try_recv() {
        assert_ne!(name, "remote://state", "only two: {payload}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_state_from_a_link_that_went_is_dropped() {
    let mut running = Running::start(|_| {}).await;
    let own = DeviceKey::generate().device_id();
    let device = DeviceKey::generate().device_id();
    let slot = Arc::new(Mutex::new(Some(LinkHandle::detached(1, device.clone()))));
    let host = TauriLinkHost {
        app: running.app.handle(),
        devices: Arc::new(Mutex::new(Devices::new(own))),
        link: slot.clone(),
        throttle: Arc::new(Mutex::new(Throttle::default())),
    };
    let state = |version| VersionedState {
        epoch: "e".into(),
        version,
        state: mvp_core::remote::message::PlaybackSnapshot::default(),
    };
    host.state(1, &device, &state(1));
    host.state(1, &device, &state(2));
    running.event("remote://state").await;
    *lock(&slot) = Some(LinkHandle::detached(2, device.clone()));
    tokio::time::sleep(STATE_EVERY * 3).await;
    while let Ok((name, payload)) = running.events.try_recv() {
        assert_ne!(name, "remote://state", "{payload}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn links_are_named_by_the_webview_and_only_the_current_one_takes_commands() {
    let (mut mac, tv) = pair("always").await;
    let tv_id = tv.device_id().to_string();
    mac.event("remote://devices").await;
    assert_eq!(mac.invoke("remote_link", json!({})), Ok(json!(null)));
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 41 }))
        .unwrap();
    let connected = phase(&mut mac, "connected").await;
    assert_eq!(connected["link"], json!(41));
    assert_eq!(mac.invoke("remote_link", json!({})), Ok(json!(41)));
    assert_eq!(
        mac.invoke(
            "remote_command",
            json!({ "command": { "action": "stop" }, "link": 40 })
        ),
        Err(json!("link_not_connected"))
    );
    assert_eq!(
        mac.invoke(
            "remote_catalog",
            json!({ "catalogQuery": { "kind": "groups", "contentType": "live", "limit": 1 }, "link": 40 })
        ),
        Err(json!("link_not_connected"))
    );

    // Leaving says what the list is now, since the left device is no
    // longer kept in it.
    mac.invoke("remote_leave", json!({ "link": 41 })).unwrap();
    mac.event("remote://devices").await;
    assert_eq!(mac.invoke("remote_link", json!({})), Ok(json!(null)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_identity_tells_the_webview_its_link_ended() {
    let (mut mac, tv) = pair("always").await;
    let tv_id = tv.device_id().to_string();
    mac.event("remote://devices").await;
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 7 }))
        .unwrap();
    phase(&mut mac, "connected").await;
    mac.invoke("remote_reset_identity", json!({})).unwrap();
    let closed = phase(&mut mac, "closed").await;
    assert_eq!(closed["link"], json!(7));
    assert_eq!(closed["reason"], json!("left"));
    assert_eq!(closed["deviceId"], json!(tv_id));
    mac.event("remote://devices").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn logos_another_device_sends_reach_the_webview_only_from_public_hosts() {
    let mut running = Running::start(|_| {}).await;
    let own = DeviceKey::generate().device_id();
    let device = DeviceKey::generate().device_id();
    let host = TauriLinkHost {
        app: running.app.handle(),
        devices: Arc::new(Mutex::new(Devices::new(own))),
        link: Arc::new(Mutex::new(Some(LinkHandle::detached(1, device.clone())))),
        throttle: Arc::new(Mutex::new(Throttle::default())),
    };
    let with_logo = |logo: &str| VersionedState {
        epoch: "e".into(),
        version: 1,
        state: mvp_core::remote::message::PlaybackSnapshot {
            item: Some(CatalogItem {
                id: "live-1".into(),
                logo: Some(logo.into()),
                ..CatalogItem::default()
            }),
            ..Default::default()
        },
    };
    host.state(1, &device, &with_logo("http://192.168.1.1/admin.png"));
    let shown = running.event("remote://state").await;
    assert_eq!(shown["state"]["state"]["item"]["id"], json!("live-1"));
    assert_eq!(shown["state"]["state"]["item"].get("logo"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_catalog_page_keeps_only_logos_this_device_may_load() {
    let (mut mac, tv) = pair("always").await;
    {
        let state = tv.app.state();
        let cache = state.cache.lock().unwrap();
        cache
            .upsert_provider(&Provider {
                id: "p1".into(),
                name: "Mine".into(),
                provider_type: ProviderType::M3u,
                url: "http://iptv.example/list.m3u".into(),
                username: None,
                password: None,
                last_updated: None,
                channel_count: 2,
                epg_url: None,
            })
            .unwrap();
        let channel = |id: &str, logo: &str| Channel {
            id: id.into(),
            name: id.into(),
            url: format!("http://iptv.example/{id}.ts"),
            logo_url: Some(logo.into()),
            group_title: "UK".into(),
            content_type: "live".into(),
            ..Channel::default()
        };
        cache
            .save_channels(
                "p1",
                &[
                    channel("a", "http://10.1.1.1/a.png"),
                    channel("b", "https://logos.example/b.png"),
                ],
            )
            .unwrap();
    }
    let tv_id = tv.device_id().to_string();
    mac.event("remote://devices").await;
    mac.invoke("remote_connect", json!({ "deviceId": tv_id, "link": 3 }))
        .unwrap();
    phase(&mut mac, "connected").await;
    let query = json!({ "kind": "items", "contentType": "live", "group": "UK", "limit": 10 });
    let page = mac
        .invoke(
            "remote_catalog",
            json!({ "catalogQuery": query, "link": 3 }),
        )
        .unwrap();
    let logos: Vec<Value> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i.get("logo").cloned().unwrap_or(Value::Null))
        .collect();
    assert_eq!(logos, [Value::Null, json!("https://logos.example/b.png")]);
}

/// Waits until nothing listens on `port` any more.
async fn until_refused(port: u16) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_ok()
    {
        assert!(tokio::time::Instant::now() < deadline, "still listening");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_background_hides_the_device_and_the_foreground_brings_it_back() {
    let running = Running::start(|_| {}).await;
    let handle = running.app.handle();
    let service = handle.state::<RemoteService>();
    // The record from the start, which the target sends when it runs.
    let deadline = tokio::time::Instant::now() + WAIT;
    while running.last_advertised().is_none() {
        assert!(tokio::time::Instant::now() < deadline, "never advertised");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let before = lock(&running.advertised).len();

    service.set_foreground(false);
    service.follow_foreground().await;
    until_refused(running.port).await;
    // Not listening anywhere else either.
    until_refused(service.handle.port()).await;

    service.set_foreground(true);
    service.follow_foreground().await;
    let port = service.handle.port();
    tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("listening again");
    let deadline = tokio::time::Instant::now() + WAIT;
    while lock(&running.advertised).len() == before {
        assert!(tokio::time::Instant::now() < deadline, "not advertised again");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(running.last_advertised().unwrap().port, port);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_last_word_on_the_foreground_counts() {
    let running = Running::start(|_| {}).await;
    let handle = running.app.handle();
    let service = handle.state::<RemoteService>();
    // Away and back before either was carried out: nothing changes.
    service.set_foreground(false);
    service.set_foreground(true);
    service.follow_foreground().await;
    service.follow_foreground().await;
    assert_eq!(service.handle.port(), running.port);
    let mut phone = running.phone().await;
    phone.pending().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_going_to_the_background_reaches_the_service() {
    let running = Running::start(|_| {}).await;
    set_foreground(&running.app.handle(), false);
    until_refused(running.port).await;
}

#[test]
fn going_to_the_background_without_remote_control_does_nothing() {
    let app = TestApp::new();
    set_foreground(&app.handle(), false);
    assert!(app.handle().try_state::<RemoteService>().is_none());
}
