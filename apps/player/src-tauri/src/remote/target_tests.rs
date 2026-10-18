// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The target task over loopback TCP, with the core's own controller on the
//! other end and a fake host in place of the webview.

use super::*;
use crate::remote::test_client::{connect, Client, WAIT};
use mvp_core::remote::controller::Event;
use mvp_core::remote::message::{CloseReason, PlaybackStatus};
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
        self.catalog_calls.lock().unwrap().push(query);
        Ok((
            vec![CatalogItem {
                id: "live-1".into(),
                name: "News".into(),
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
    key: DeviceKey,
    seen: mpsc::UnboundedReceiver<Seen>,
}

impl Harness {
    async fn start(mode: ControlMode) -> Self {
        Self::start_with_timeout(mode, COMMAND_TIMEOUT).await
    }

    async fn start_with_timeout(mode: ControlMode, command_timeout: Duration) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let key = DeviceKey::generate();
        let (tx, seen) = mpsc::unbounded_channel();
        let host = Arc::new(FakeHost {
            seen: tx,
            catalog_calls: Mutex::new(Vec::new()),
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
            host,
            command_timeout,
        )
        .unwrap();
        let mut harness = Self { handle, key, seen };
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
    });
    let _handle = start(
        listener,
        key.clone(),
        DeviceType::LinuxPc,
        RemoteSettings::default(),
        host,
    )
    .unwrap();
    let Some(Seen::Advertise(Some(r))) = seen.recv().await else {
        panic!("advertised");
    };
    let id = key.device_id().to_string();
    assert_eq!(r.service_type, "_cinette._tcp");
    assert_eq!(r.instance, "Linux PC");
    assert_eq!(r.host_label, id);
    assert_eq!(r.port, port);
    assert_eq!(r.txt.get_str("id"), Some(id.as_str()));
    assert_eq!(r.txt.get_str("t"), Some("linux-pc"));
    assert_eq!(r.txt.get_str("rc"), Some("1"));
    assert_eq!(r.txt.get_str("v"), Some("1"));
    assert_eq!(r.txt.get_str("n"), Some("Linux PC"));
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
    let mut open = Vec::new();
    for _ in 0..MAX_PER_ADDRESS {
        open.push(until_one_stays_open(port).await);
    }
    let mut fifth = quiet_connection(port).await;
    assert!(was_closed(&mut fifth).await, "the fifth is turned away");
    for stream in &mut open {
        assert!(!was_closed(stream).await, "the first four stay open");
    }

    // One that goes frees its slot.
    drop(open.pop());
    open.push(until_one_stays_open(port).await);

    // So does one the core closes, here for a frame that's no handshake.
    let mut broken = open.pop().unwrap();
    broken.write_all(&[0, 3, 1, 2, 3]).await.unwrap();
    assert!(was_closed(&mut broken).await);
    open.push(until_one_stays_open(port).await);
}
