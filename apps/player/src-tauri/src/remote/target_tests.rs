// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The target task over loopback TCP, with the core's own controller on the
//! other end and a fake host in place of the webview.

use super::*;
use crate::remote::test_client::{connect, Client, WAIT};
use mvp_core::remote::controller::Event;
use mvp_core::remote::message::{CloseReason, PlaybackStatus, Track};
use mvp_core::remote::settings::ControlMode;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

#[derive(Debug, Clone, PartialEq)]
enum Seen {
    Consent(RequestId, String),
    Hidden(RequestId),
    Sessions(Vec<(String, bool)>),
    Apply(u64, Command),
    Advertise(Option<Registration>),
}

struct FakeHost {
    seen: mpsc::UnboundedSender<Seen>,
    catalog_calls: Mutex<Vec<CatalogQuery>>,
    /// While set, catalog queries wait until it's cleared.
    held: (Mutex<bool>, std::sync::Condvar),
}

impl FakeHost {
    fn hold(&self, on: bool) {
        *self.held.0.lock().unwrap() = on;
        self.held.1.notify_all();
    }
}

impl TargetHost for FakeHost {
    fn show_consent(&self, prompt: &ConsentPrompt) {
        let _ = self
            .seen
            .send(Seen::Consent(prompt.request, prompt.code.clone()));
    }
    fn hide_consent(&self, request: RequestId) {
        let _ = self.seen.send(Seen::Hidden(request));
    }
    fn sessions_changed(&self, sessions: &[SessionInfo]) {
        let list = sessions
            .iter()
            .map(|s| (s.name.clone(), s.connected))
            .collect();
        let _ = self.seen.send(Seen::Sessions(list));
    }
    fn apply(&self, token: u64, command: &Command) {
        let _ = self.seen.send(Seen::Apply(token, command.clone()));
    }
    fn catalog(&self, query: CatalogQuery) -> CatalogPage {
        self.catalog_calls.lock().unwrap().push(query.clone());
        let mut held = self.held.0.lock().unwrap();
        while *held {
            held = self.held.1.wait(held).unwrap();
        }
        // A search's answer is named after it, so tests can tell answers apart.
        let name = match &query {
            CatalogQuery::Search { query, .. } => query.clone(),
            _ => "News".into(),
        };
        Ok((
            vec![CatalogItem {
                id: "live-1".into(),
                name,
                content_type: "live".into(),
                group: "UK".into(),
                ..CatalogItem::default()
            }],
            Some("live-2".into()),
        ))
    }
    fn advertise(&self, registration: Option<Registration>) {
        let _ = self.seen.send(Seen::Advertise(registration));
    }
}

struct Harness {
    handle: TargetHandle,
    host: Arc<FakeHost>,
    key: DeviceKey,
    seen: mpsc::UnboundedReceiver<Seen>,
}

impl Harness {
    async fn start(mode: ControlMode) -> Self {
        Self::start_with_timeout(mode, COMMAND_TIMEOUT).await
    }

    async fn start_with_timeout(mode: ControlMode, command_timeout: Duration) -> Self {
        let limits = Limits {
            command_timeout,
            // Tests load one item after another at once.
            load_gap: Duration::ZERO,
            ..Limits::STANDARD
        };
        Self::start_with_limits(mode, limits).await
    }

    async fn start_with_limits(mode: ControlMode, limits: Limits) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let key = DeviceKey::generate();
        let (tx, seen) = mpsc::unbounded_channel();
        let host = Arc::new(FakeHost {
            seen: tx,
            catalog_calls: Mutex::new(Vec::new()),
            held: (Mutex::new(false), std::sync::Condvar::new()),
        });
        let settings = RemoteSettings {
            remote_control: mode,
            ..RemoteSettings::default()
        };
        let handle = start_with(
            listener,
            key.clone(),
            DeviceType::LinuxPc,
            settings,
            host.clone(),
            limits,
        )
        .unwrap();
        let mut harness = Self {
            handle,
            host,
            key,
            seen,
        };
        let first = harness.next_seen().await;
        assert!(matches!(first, Seen::Advertise(Some(_))), "{first:?}");
        harness
    }

    async fn next_seen(&mut self) -> Seen {
        timeout(WAIT, self.seen.recv())
            .await
            .expect("the host heard nothing")
            .unwrap()
    }

    /// The next thing the host saw that `pick` wants, skipping the rest.
    async fn wait_for<T>(&mut self, mut pick: impl FnMut(&Seen) -> Option<T>) -> T {
        loop {
            let seen = self.next_seen().await;
            if let Some(found) = pick(&seen) {
                return found;
            }
        }
    }

    async fn connect(&self, name: &str) -> Client {
        self.connect_as(DeviceKey::generate(), name, None).await
    }

    async fn connect_as(&self, key: DeviceKey, name: &str, resume: Option<String>) -> Client {
        connect(self.handle.port(), self.key.device_id(), key, name, resume).await
    }
}

fn playing(item: &str) -> PlaybackSnapshot {
    PlaybackSnapshot {
        status: PlaybackStatus::Playing,
        item: Some(CatalogItem {
            id: item.into(),
            name: "News".into(),
            content_type: "live".into(),
            ..CatalogItem::default()
        }),
        volume: Some(50),
        capabilities: mvp_core::remote::message::Capabilities {
            pause: true,
            volume: true,
            ..Default::default()
        },
        ..PlaybackSnapshot::default()
    }
}

#[tokio::test]
async fn advertises_the_cores_record_under_the_device_id() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let key = DeviceKey::generate();
    let (tx, mut seen) = mpsc::unbounded_channel();
    let host = Arc::new(FakeHost {
        seen: tx,
        catalog_calls: Mutex::new(Vec::new()),
        held: (Mutex::new(false), std::sync::Condvar::new()),
    });
    let _handle = start_with(
        listener,
        key.clone(),
        DeviceType::LinuxPc,
        RemoteSettings::default(),
        host,
        Limits::STANDARD,
    )
    .unwrap();
    let Some(Seen::Advertise(Some(r))) = seen.recv().await else {
        panic!("advertised");
    };
    let id = key.device_id().to_string();
    assert_eq!(r.service_type, "_cinette._tcp");
    assert_eq!(r.instance, crate::remote::device::default_name());
    assert_eq!(r.host_label, id);
    assert_eq!(r.port, port);
    assert_eq!(r.txt.get_str("id"), Some(id.as_str()));
    assert_eq!(r.txt.get_str("t"), Some("linux-pc"));
    assert_eq!(r.txt.get_str("rc"), Some("1"));
    assert_eq!(r.txt.get_str("v"), Some("1"));
    assert_eq!(
        r.txt.get_str("n"),
        Some(crate::remote::device::default_name())
    );
}

#[tokio::test]
async fn always_allow_lets_a_controller_in_and_attaches_to_what_plays() {
    let mut h = Harness::start(ControlMode::Always).await;
    h.handle.set_state(playing("live-7"));
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    let state = phone
        .wait_for(|e| match e {
            Event::Connected { state, .. } => Some(state.clone()),
            _ => None,
        })
        .await
        .unwrap();
    assert_eq!(
        state.state.item.unwrap().id,
        "live-7",
        "nothing was interrupted"
    );
    let sessions = h
        .wait_for(|s| match s {
            Seen::Sessions(list) if !list.is_empty() => Some(list.clone()),
            _ => None,
        })
        .await;
    assert_eq!(sessions, vec![("Phone".to_owned(), true)]);
}

#[tokio::test]
async fn only_when_allowed_shows_the_code_both_sides_see() {
    let mut h = Harness::start(ControlMode::Ask).await;
    let mut phone = h.connect("Phone").await;
    let code = phone.code().await;
    let (request, shown) = h
        .wait_for(|s| match s {
            Seen::Consent(r, c) => Some((*r, c.clone())),
            _ => None,
        })
        .await;
    assert_eq!(shown, code);
    h.handle.answer(request, Answer::Allow);
    phone.connected().await;
    assert_eq!(
        h.wait_for(|s| match s {
            Seen::Hidden(r) => Some(*r),
            _ => None,
        })
        .await,
        request
    );
}

#[tokio::test]
async fn deny_grants_nothing() {
    let mut h = Harness::start(ControlMode::Ask).await;
    let mut phone = h.connect("Phone").await;
    phone.pending().await;
    let request = h
        .wait_for(|s| match s {
            Seen::Consent(r, _) => Some(*r),
            _ => None,
        })
        .await;
    h.handle.answer(request, Answer::Deny);
    assert_eq!(phone.closed().await, Some(CloseReason::Denied));
    assert!(phone.controller.session_id().is_none());
}

#[tokio::test]
async fn never_allow_refuses_without_a_dialog() {
    let mut h = Harness::start(ControlMode::Never).await;
    let mut phone = h.connect("Phone").await;
    assert_eq!(phone.closed().await, Some(CloseReason::NotAllowed));
    h.handle.set_state(playing("x"));
    assert!(h.handle.sessions().await.is_empty());
    while let Ok(seen) = h.seen.try_recv() {
        assert!(!matches!(seen, Seen::Consent(..)), "no dialog");
    }
}

#[tokio::test]
async fn commands_go_to_the_player_and_its_answer_comes_back() {
    let mut h = Harness::start(ControlMode::Always).await;
    h.handle.set_state(playing("live-7"));
    let mut phone = h.connect("Phone").await;
    phone.connected().await;

    let (id, bytes) = phone
        .controller
        .command(Command::Pause {
            item_id: "live-7".into(),
        })
        .unwrap();
    phone.write(&bytes).await;
    let token = h
        .wait_for(|s| match s {
            Seen::Apply(token, Command::Pause { item_id }) if item_id == "live-7" => Some(*token),
            _ => None,
        })
        .await;
    h.handle.finish_command(token, Ok(()));
    let result = phone
        .wait_for(|e| match e {
            Event::Reply { request, result } if *request == id => Some(*result),
            _ => None,
        })
        .await;
    assert!(matches!(result, Some(Ok(_))), "{result:?}");

    // The core checks what it can before the player sees it.
    assert_eq!(
        phone
            .command(Command::Pause {
                item_id: "live-8".into()
            })
            .await,
        Err(ErrorCode::StaleItem)
    );
}

#[tokio::test]
async fn a_load_right_after_another_is_refused_but_other_commands_go_on() {
    let limits = Limits {
        load_gap: Duration::from_secs(3600),
        ..Limits::STANDARD
    };
    let mut h = Harness::start_with_limits(ControlMode::Always, limits).await;
    h.handle.set_state(playing("live-7"));
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    let load = |item: &str| Command::Load {
        item_id: item.into(),
        start_at: None,
    };
    let (id, bytes) = phone.controller.command(load("live-1")).unwrap();
    phone.write(&bytes).await;
    let token = h
        .wait_for(|s| match s {
            Seen::Apply(token, Command::Load { .. }) => Some(*token),
            _ => None,
        })
        .await;
    h.handle.finish_command(token, Ok(()));
    phone
        .wait_for(|e| matches!(e, Event::Reply { request, .. } if *request == id).then_some(()))
        .await;
    assert_eq!(
        phone.command(load("live-2")).await,
        Err(ErrorCode::RateLimited)
    );
    // A pause isn't a load, so it goes to the player.
    let (_, bytes) = phone
        .controller
        .command(Command::Pause {
            item_id: "live-7".into(),
        })
        .unwrap();
    phone.write(&bytes).await;
    h.wait_for(|s| matches!(s, Seen::Apply(_, Command::Pause { .. })).then_some(()))
        .await;
}

#[tokio::test]
async fn the_players_error_reaches_the_controller() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    let (id, bytes) = phone
        .controller
        .command(Command::Load {
            item_id: "gone".into(),
            start_at: None,
        })
        .unwrap();
    phone.write(&bytes).await;
    let token = h
        .wait_for(|s| match s {
            Seen::Apply(token, _) => Some(*token),
            _ => None,
        })
        .await;
    h.handle.finish_command(token, Err(ErrorCode::NotFound));
    let result = phone
        .wait_for(|e| match e {
            Event::Reply { request, result } if *request == id => Some(*result),
            _ => None,
        })
        .await;
    assert_eq!(result, Some(Err(ErrorCode::NotFound)));
}

#[tokio::test]
async fn a_command_the_player_never_finishes_fails() {
    let mut h = Harness::start_with_timeout(ControlMode::Always, Duration::from_millis(200)).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    let (id, bytes) = phone.controller.command(Command::Stop).unwrap();
    let sent = std::time::Instant::now();
    phone.write(&bytes).await;
    let token = h
        .wait_for(|s| match s {
            Seen::Apply(token, Command::Stop) => Some(*token),
            _ => None,
        })
        .await;
    let result = phone
        .wait_for(|e| match e {
            Event::Reply { request, result } if *request == id => Some(*result),
            _ => None,
        })
        .await;
    assert_eq!(result, Some(Err(ErrorCode::Failed)));
    // At its deadline, not at the next look at the clock 2 s later.
    assert!(
        sent.elapsed() < Duration::from_millis(1500),
        "{:?}",
        sent.elapsed()
    );
    // A late answer changes nothing.
    h.handle.finish_command(token, Ok(()));
    assert!(h.handle.sessions().await.len() == 1);
}

#[tokio::test]
async fn every_controller_gets_every_state() {
    let h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    let mut laptop = h.connect("Laptop").await;
    phone.connected().await;
    laptop.connected().await;
    h.handle.set_state(playing("live-9"));
    for client in [&mut phone, &mut laptop] {
        let state = client
            .wait_for(|e| match e {
                Event::State(s) if s.state.item.is_some() => Some(s.clone()),
                _ => None,
            })
            .await
            .unwrap();
        assert_eq!(state.state.item.unwrap().id, "live-9");
    }
}

#[tokio::test]
async fn catalog_queries_are_answered_by_the_host() {
    let h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    let (id, bytes) = phone
        .controller
        .catalog(CatalogQuery::Search {
            query: "news".into(),
            content_type: None,
            limit: 10,
        })
        .unwrap();
    phone.write(&bytes).await;
    let (items, next) = phone
        .wait_for(|e| match e {
            Event::Page {
                request,
                items,
                next,
            } if *request == id => Some((items.clone(), next.clone())),
            _ => None,
        })
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, "live-1");
    assert_eq!(next.as_deref(), Some("live-2"));
}

#[tokio::test]
async fn never_allow_ends_open_sessions_and_says_so_in_the_record() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    h.handle.update_settings(RemoteSettings {
        remote_control: ControlMode::Never,
        ..RemoteSettings::default()
    });
    assert_eq!(phone.closed().await, Some(CloseReason::Revoked));
    let record = h
        .wait_for(|s| match s {
            Seen::Advertise(r) => Some(r.clone()),
            _ => None,
        })
        .await
        .unwrap();
    assert_eq!(record.txt.get_str("rc"), Some("0"));
    assert!(h.handle.sessions().await.is_empty());
}

#[tokio::test]
async fn turning_discovery_off_stops_advertising_and_keeps_sessions() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    h.handle.update_settings(RemoteSettings {
        discoverable: false,
        remote_control: ControlMode::Always,
        device_name: None,
    });
    let record = h
        .wait_for(|s| match s {
            Seen::Advertise(r) => Some(r.clone()),
            _ => None,
        })
        .await;
    assert_eq!(record, None);
    assert_eq!(h.handle.sessions().await.len(), 1);
    let mut other = h.connect("Other").await;
    assert_eq!(other.closed().await, Some(CloseReason::NotDiscoverable));
    // The open session still takes commands.
    let (_, bytes) = phone.controller.command(Command::Stop).unwrap();
    phone.write(&bytes).await;
    h.wait_for(|s| matches!(s, Seen::Apply(_, Command::Stop)).then_some(()))
        .await;
}

#[tokio::test]
async fn the_target_can_disconnect_a_controller_and_the_target_keeps_playing() {
    let mut h = Harness::start(ControlMode::Always).await;
    h.handle.set_state(playing("live-1"));
    let mut phone = h.connect("Phone").await;
    let session = phone.connected().await;
    h.handle.disconnect(session);
    assert_eq!(phone.closed().await, Some(CloseReason::Revoked));
    assert!(h.handle.sessions().await.is_empty());
    while let Ok(seen) = h.seen.try_recv() {
        assert!(
            !matches!(seen, Seen::Apply(..)),
            "nothing was sent to the player"
        );
    }
}

#[tokio::test]
async fn a_dropped_connection_resumes_without_asking_again() {
    let mut h = Harness::start(ControlMode::Ask).await;
    let key = DeviceKey::generate();
    let mut phone = h.connect_as(key.clone(), "Phone", None).await;
    phone.pending().await;
    let request = h
        .wait_for(|s| match s {
            Seen::Consent(r, _) => Some(*r),
            _ => None,
        })
        .await;
    h.handle.answer(request, Answer::Allow);
    let session = phone.connected().await;
    drop(phone);
    // The session waits to resume.
    h.wait_for(|s| match s {
        Seen::Sessions(list) if list == &[("Phone".to_owned(), false)] => Some(()),
        _ => None,
    })
    .await;

    let mut again = h.connect_as(key, "Phone", Some(session.clone())).await;
    assert_eq!(again.connected().await, session);
    while let Ok(seen) = h.seen.try_recv() {
        assert!(!matches!(seen, Seen::Consent(..)), "no second dialog");
    }
    assert_eq!(
        again.key.device_id(),
        h.handle.sessions().await[0].device_id
    );
}

#[tokio::test]
async fn shutting_down_tells_every_controller_and_stops_advertising() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    h.handle.shutdown().await;
    assert_eq!(phone.closed().await, Some(CloseReason::Shutdown));
    assert_eq!(
        h.wait_for(|s| match s {
            Seen::Advertise(r) => Some(r.clone()),
            _ => None,
        })
        .await,
        None
    );
}

#[tokio::test]
async fn a_new_identity_ends_sessions_and_advertises_the_new_id() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    let new_key = DeviceKey::generate();
    h.handle.reset_identity(new_key.clone());
    assert_eq!(phone.closed().await, Some(CloseReason::Shutdown));
    let record = h
        .wait_for(|s| match s {
            Seen::Advertise(Some(r)) => Some(r.clone()),
            _ => None,
        })
        .await;
    let id = new_key.device_id().to_string();
    assert_eq!(record.txt.get_str("id"), Some(id.as_str()));
    assert_eq!(record.host_label, id);

    // Connecting to the old id now fails the handshake.
    let mut stale = h.connect("Phone").await;
    assert_eq!(stale.closed().await, Some(CloseReason::IdentityMismatch));
}

#[tokio::test]
async fn a_player_may_take_its_time_within_the_limit() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    let (id, bytes) = phone.controller.command(Command::Stop).unwrap();
    phone.write(&bytes).await;
    let token = h
        .wait_for(|s| match s {
            Seen::Apply(token, Command::Stop) => Some(*token),
            _ => None,
        })
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.handle.finish_command(token, Ok(()));
    let result = phone
        .wait_for(|e| match e {
            Event::Reply { request, result } if *request == id => Some(*result),
            _ => None,
        })
        .await;
    assert!(matches!(result, Some(Ok(_))), "{result:?}");
}

#[tokio::test]
async fn each_command_gets_its_own_answer_and_a_closed_connection_takes_only_its_own() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    let mut laptop = h.connect("Laptop").await;
    let phone_session = phone.connected().await;
    laptop.connected().await;

    let (phone_id, bytes) = phone.controller.command(Command::Stop).unwrap();
    phone.write(&bytes).await;
    let phone_token = h
        .wait_for(|s| match s {
            Seen::Apply(token, Command::Stop) => Some(*token),
            _ => None,
        })
        .await;
    let (laptop_id, bytes) = laptop.controller.command(Command::Stop).unwrap();
    laptop.write(&bytes).await;
    let laptop_token = h
        .wait_for(|s| match s {
            Seen::Apply(token, Command::Stop) => Some(*token),
            _ => None,
        })
        .await;
    assert_ne!(phone_token, laptop_token);

    // The phone's connection goes; the laptop's command still gets answered.
    h.handle.disconnect(phone_session);
    assert_eq!(phone.closed().await, Some(CloseReason::Revoked));
    h.handle.finish_command(phone_token, Ok(()));
    h.handle
        .finish_command(laptop_token, Err(ErrorCode::Failed));
    let result = laptop
        .wait_for(|e| match e {
            Event::Reply { request, result } if *request == laptop_id => Some(*result),
            _ => None,
        })
        .await;
    assert_eq!(result, Some(Err(ErrorCode::Failed)));
    assert!(!phone
        .events
        .iter()
        .any(|e| matches!(e, Event::Reply { request, .. } if *request == phone_id)));
}

#[tokio::test]
async fn a_hidden_device_with_no_session_closes_connections_before_saying_who_it_is() {
    let mut h = Harness::start(ControlMode::Always).await;
    h.handle.update_settings(RemoteSettings {
        discoverable: false,
        remote_control: ControlMode::Always,
        device_name: None,
    });
    h.wait_for(|s| matches!(s, Seen::Advertise(None)).then_some(()))
        .await;
    let mut phone = h.connect("Phone").await;
    assert_eq!(phone.closed().await, None, "closed without a word");
    assert!(
        !phone
            .events
            .iter()
            .any(|e| matches!(e, Event::Verified { .. })),
        "{:?}",
        phone.events
    );
}

#[tokio::test]
async fn a_peer_outside_the_local_network_is_turned_away_before_the_handshake() {
    let limits = Limits {
        local: |_| false,
        ..Limits::STANDARD
    };
    let h = Harness::start_with_limits(ControlMode::Always, limits).await;
    let mut phone = h.connect("Phone").await;
    assert_eq!(phone.closed().await, None, "closed without a word");
    assert!(
        !phone
            .events
            .iter()
            .any(|e| matches!(e, Event::Verified { .. })),
        "{:?}",
        phone.events
    );
}

#[tokio::test]
async fn the_default_listener_takes_ipv4_even_on_an_ipv6_socket() {
    let listener = bind_default().await.unwrap();
    let address = listener.local_addr().unwrap();
    if address.is_ipv6() {
        let only_v6 = socket2::SockRef::from(&listener).only_v6().unwrap();
        assert!(!only_v6, "the [::] socket takes IPv4 too");
    }
    let accepted = tokio::spawn(async move { listener.accept().await.map(|(_, from)| from) });
    tokio::net::TcpStream::connect(("127.0.0.1", address.port()))
        .await
        .unwrap();
    let from = timeout(WAIT, accepted).await.unwrap().unwrap().unwrap();
    assert!(from.ip().to_canonical().is_loopback(), "{from}");
}

/// A connection that sends nothing, so the core waits for its handshake.
async fn quiet_connection(port: u16) -> tokio::net::TcpStream {
    tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap()
}

/// Whether the target closed `stream` within a moment.
async fn was_closed(stream: &mut tokio::net::TcpStream) -> bool {
    let mut buf = [0u8; 64];
    matches!(
        timeout(Duration::from_millis(300), stream.read(&mut buf)).await,
        Ok(Ok(0) | Err(_))
    )
}

/// Opens connections until one stays open, which shows a slot is free.
async fn until_one_stays_open(port: u16) -> tokio::net::TcpStream {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let mut stream = quiet_connection(port).await;
        if !was_closed(&mut stream).await {
            return stream;
        }
        assert!(tokio::time::Instant::now() < deadline, "no slot came free");
    }
}

#[tokio::test]
async fn one_address_gets_four_connections_at_a_time() {
    let h = Harness::start(ControlMode::Always).await;
    let port = h.handle.port();
    // The target takes connections in the order they open.
    let mut open = Vec::new();
    for _ in 0..MAX_PER_ADDRESS {
        open.push(quiet_connection(port).await);
    }
    let mut fifth = quiet_connection(port).await;
    let (fifth_closed, closed) = tokio::join!(
        was_closed(&mut fifth),
        futures_util::future::join_all(open.iter_mut().map(was_closed)),
    );
    assert!(fifth_closed, "the fifth is turned away");
    assert_eq!(closed, [false; MAX_PER_ADDRESS], "the first four stay open");

    // One that goes frees its slot.
    drop(open.pop());
    open.push(until_one_stays_open(port).await);

    // So does one the core closes, here for a frame that's no handshake.
    let mut broken = open.pop().unwrap();
    broken.write_all(&[0, 3, 1, 2, 3]).await.unwrap();
    assert!(was_closed(&mut broken).await);
    open.push(until_one_stays_open(port).await);
}

/// Sends a search and returns its request id.
async fn search(phone: &mut Client) -> u64 {
    search_for(phone, "news").await
}

async fn search_for(phone: &mut Client, text: &str) -> u64 {
    let (id, bytes) = phone
        .controller
        .catalog(CatalogQuery::Search {
            query: text.into(),
            content_type: None,
            limit: 10,
        })
        .unwrap();
    phone.write(&bytes).await;
    id
}

/// What the target answered request `id` with: a page's item count, or an
/// error.
async fn answer_to(phone: &mut Client, id: u64) -> Result<usize, ErrorCode> {
    phone
        .wait_for(|e| match e {
            Event::Page { request, items, .. } if *request == id => Some(Ok(items.len())),
            Event::Reply { request, result } if *request == id => Some(result.map(|_| 0)),
            _ => None,
        })
        .await
        .expect("an answer")
}

#[tokio::test]
async fn a_connection_gets_one_catalog_answer_at_a_time() {
    let h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    h.host.hold(true);
    let first = search(&mut phone).await;
    let second = search(&mut phone).await;
    assert_eq!(
        answer_to(&mut phone, second).await,
        Err(ErrorCode::RateLimited)
    );
    h.host.hold(false);
    assert_eq!(answer_to(&mut phone, first).await, Ok(1));
    // Once it's answered, the next goes ahead.
    let third = search(&mut phone).await;
    assert_eq!(answer_to(&mut phone, third).await, Ok(1));
}

#[tokio::test]
async fn only_a_few_catalog_answers_are_worked_on_at_once() {
    // Every phone here comes from 127.0.0.1.
    let limits = Limits {
        per_address: MAX_CATALOG_JOBS + 1,
        ..Limits::STANDARD
    };
    let h = Harness::start_with_limits(ControlMode::Always, limits).await;
    let mut phones = Vec::new();
    for n in 0..=MAX_CATALOG_JOBS {
        let mut phone = h.connect(&format!("Phone {n}")).await;
        phone.connected().await;
        phones.push(phone);
    }
    h.host.hold(true);
    let mut asked = Vec::new();
    for phone in &mut phones[..MAX_CATALOG_JOBS] {
        asked.push(search(phone).await);
    }
    // Wait for every job to start before the one too many.
    let deadline = tokio::time::Instant::now() + WAIT;
    while h.host.catalog_calls.lock().unwrap().len() < MAX_CATALOG_JOBS {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let last = phones.last_mut().unwrap();
    let extra = search(last).await;
    assert_eq!(answer_to(last, extra).await, Err(ErrorCode::RateLimited));
    h.host.hold(false);
    for (phone, id) in phones.iter_mut().zip(asked) {
        assert_eq!(answer_to(phone, id).await, Ok(1));
    }
}

#[tokio::test]
async fn an_answer_from_before_a_new_identity_goes_to_no_one() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    h.host.hold(true);
    let asked = search(&mut phone).await;
    let deadline = tokio::time::Instant::now() + WAIT;
    while h.host.catalog_calls.lock().unwrap().is_empty() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let new_key = DeviceKey::generate();
    h.handle.reset_identity(new_key.clone());
    assert_eq!(phone.closed().await, Some(CloseReason::Shutdown));
    h.wait_for(|s| matches!(s, Seen::Advertise(Some(_))).then_some(()))
        .await;
    // The first connection after the reset has the old one's number again.
    let mut tablet = connect(
        h.handle.port(),
        new_key.device_id(),
        DeviceKey::generate(),
        "Tablet",
        None,
    )
    .await;
    tablet.connected().await;
    h.host.hold(false);
    // Time for the old answer to come back, and go nowhere.
    tokio::time::sleep(Duration::from_millis(200)).await;
    // The old answer was for the same connection number and request id.
    let own = search_for(&mut tablet, "tablet").await;
    assert_eq!(own, asked);
    assert_eq!(answer_to(&mut tablet, own).await, Ok(1));
    let next = search_for(&mut tablet, "again").await;
    assert_eq!(answer_to(&mut tablet, next).await, Ok(1));
    let names: Vec<&str> = tablet
        .events
        .iter()
        .filter_map(|e| match e {
            Event::Page { items, .. } => Some(items[0].name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(names, ["tablet", "again"], "only its own answers");
}

#[tokio::test]
async fn an_answer_to_a_request_from_before_a_new_identity_answers_nothing() {
    let mut h = Harness::start(ControlMode::Ask).await;
    let mut phone = h.connect("Phone").await;
    phone.pending().await;
    let old = h
        .wait_for(|s| match s {
            Seen::Consent(r, _) => Some(*r),
            _ => None,
        })
        .await;
    let new_key = DeviceKey::generate();
    h.handle.reset_identity(new_key.clone());
    let hidden = h
        .wait_for(|s| match s {
            Seen::Hidden(r) => Some(*r),
            _ => None,
        })
        .await;
    assert_eq!(hidden, old, "the old dialog goes under its own id");
    let mut tablet = connect(
        h.handle.port(),
        new_key.device_id(),
        DeviceKey::generate(),
        "Tablet",
        None,
    )
    .await;
    tablet.pending().await;
    let new = h
        .wait_for(|s| match s {
            Seen::Consent(r, _) => Some(*r),
            _ => None,
        })
        .await;
    assert_ne!(new, old);
    // A click on the old dialog that comes late.
    h.handle.answer(old, Answer::Allow);
    h.handle.answer(new, Answer::Deny);
    assert_eq!(tablet.closed().await, Some(CloseReason::Denied));
}

#[test]
fn request_ids_carry_the_epoch() {
    assert_eq!(app_request(0, 7), 7);
    assert_eq!(app_request(2, 7), (2 << 32) | 7);
    assert_eq!(core_request(2, app_request(2, 7)), Some(7));
    assert_eq!(core_request(1, app_request(2, 7)), None);
    assert_eq!(core_request(0, 7), Some(7));
    assert_eq!(app_request(1, u64::MAX), (1 << 32) | u64::from(u32::MAX));
}

#[test]
fn an_ipv6_slash_64_counts_as_one_address() {
    let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
    let b: IpAddr = "2001:db8:1:2:bbbb::9".parse().unwrap();
    let other: IpAddr = "2001:db8:1:3::1".parse().unwrap();
    assert_eq!(address_group(a), address_group(b));
    assert_ne!(address_group(a), address_group(other));
    let v4: IpAddr = "192.0.2.7".parse().unwrap();
    assert_eq!(address_group(v4), v4);
    let mapped: IpAddr = "::ffff:192.0.2.7".parse().unwrap();
    assert_eq!(address_group(mapped), v4);
}

#[tokio::test]
async fn a_controller_that_stops_reading_is_let_go() {
    let mut h = Harness::start(ControlMode::Always).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    h.wait_for(|s| match s {
        Seen::Sessions(list) if list == &[("Phone".to_owned(), true)] => Some(()),
        _ => None,
    })
    .await;
    // The phone reads nothing more, so states pile up: first in the
    // socket's buffers, then in the queue, which then gives up.
    let tracks: Vec<Track> = (0..400)
        .map(|n| Track {
            id: format!("t{n}"),
            label: "x".repeat(100),
            language: None,
        })
        .collect();
    for position in 0..3000 {
        h.handle.set_state(PlaybackSnapshot {
            // Each one a jump, so the core sends it.
            position: f64::from(position) * 100.0,
            subtitles: tracks.clone(),
            ..playing("live-1")
        });
    }
    h.wait_for(|s| match s {
        Seen::Sessions(list) if list == &[("Phone".to_owned(), false)] => Some(()),
        _ => None,
    })
    .await;
    drop(phone);
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

#[tokio::test]
async fn the_background_stops_advertising_and_listening_but_keeps_sessions() {
    let mut h = Harness::start(ControlMode::Always).await;
    let port = h.handle.port();
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
    h.handle.background().await;
    assert_eq!(
        h.wait_for(|s| match s {
            Seen::Advertise(r) => Some(r.clone()),
            _ => None,
        })
        .await,
        None
    );
    until_refused(port).await;
    // The open session still takes commands.
    let (_, bytes) = phone.controller.command(Command::Stop).unwrap();
    phone.write(&bytes).await;
    h.wait_for(|s| matches!(s, Seen::Apply(_, Command::Stop)).then_some(()))
        .await;
    assert_eq!(h.handle.sessions().await.len(), 1);
}

#[tokio::test]
async fn back_in_the_foreground_it_listens_and_advertises_on_the_new_port() {
    let mut h = Harness::start(ControlMode::Always).await;
    h.handle.background().await;
    h.wait_for(|s| matches!(s, Seen::Advertise(None)).then_some(()))
        .await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    h.handle.foreground(listener).unwrap();
    assert_eq!(h.handle.port(), port);
    let record = h
        .wait_for(|s| match s {
            Seen::Advertise(r) => Some(r.clone()),
            _ => None,
        })
        .await
        .expect("advertised again");
    assert_eq!(record.port, port);
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
}

#[tokio::test]
async fn nothing_is_advertised_in_the_background_until_the_app_comes_back() {
    let mut h = Harness::start(ControlMode::Always).await;
    h.handle.background().await;
    h.wait_for(|s| matches!(s, Seen::Advertise(None)).then_some(()))
        .await;
    // A rename would advertise the new name, and a new identity a new id.
    h.handle.update_settings(RemoteSettings {
        device_name: Some("Kitchen".into()),
        ..RemoteSettings::default()
    });
    h.handle.reset_identity(DeviceKey::generate());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    h.handle.foreground(listener).unwrap();
    let record = h
        .wait_for(|s| match s {
            Seen::Advertise(Some(r)) => Some(r.clone()),
            Seen::Advertise(None) => None,
            _ => None,
        })
        .await;
    // The first record since going to the background is the foreground's.
    assert_eq!(record.instance, "Kitchen");
    assert_eq!(record.port, h.handle.port());
}

#[tokio::test]
async fn a_new_listener_replaces_the_old_one() {
    let mut h = Harness::start(ControlMode::Always).await;
    let old = h.handle.port();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    h.handle.foreground(listener).unwrap();
    h.wait_for(|s| matches!(s, Seen::Advertise(Some(_))).then_some(()))
        .await;
    until_refused(old).await;
    let mut phone = h.connect("Phone").await;
    phone.connected().await;
}

#[tokio::test]
async fn the_background_frees_the_port_before_it_answers() {
    let h = Harness::start(ControlMode::Always).await;
    let port = h.handle.port();
    h.handle.background().await;
    // Coming straight back can take the same port again.
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("the port is free");
    h.handle.foreground(listener).unwrap();
    assert_eq!(h.handle.port(), port);
}

fn fake_host() -> FakeHost {
    let (seen, _) = mpsc::unbounded_channel();
    FakeHost {
        seen,
        catalog_calls: Mutex::new(Vec::new()),
        held: (Mutex::new(false), std::sync::Condvar::new()),
    }
}

#[test]
fn a_host_that_cant_save_providers_answers_that_none_were() {
    let (tx, rx) = std::sync::mpsc::channel();
    fake_host().save_providers(
        "Mac".into(),
        Vec::new(),
        Box::new(move |results| tx.send(results).unwrap()),
    );
    assert_eq!(rx.try_recv(), Ok(Vec::new()));
}

#[test]
fn a_host_that_cant_copy_history_says_so() {
    let host = fake_host();
    let (tx, rx) = std::sync::mpsc::channel();
    host.export_history(
        Salt::generate(),
        What::ALL,
        Box::new(move |exported| tx.send(exported.map(|_| ())).unwrap()),
    );
    assert_eq!(rx.try_recv(), Ok(Err(ErrorCode::Unsupported)));
    let (tx, rx) = std::sync::mpsc::channel();
    host.import_history(
        "Mac".into(),
        Salt::generate(),
        Export::default(),
        Box::new(move |imported| tx.send(imported.map(|_| ())).unwrap()),
    );
    assert_eq!(rx.try_recv(), Ok(Err(ErrorCode::Unsupported)));
}
