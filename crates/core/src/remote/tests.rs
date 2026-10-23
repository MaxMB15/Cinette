// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A target and its controllers wired together in memory, and the tests
//! spec 4 asks for: permission defaults, consent, revocation, independent
//! playback and synchronization.

use super::catalog::{CatalogItem, CatalogQuery};
use super::channel::{Channel, FrameReader};
use super::consent::{Answer, CONSENT_TIMEOUT, DENIAL_COOLDOWN};
use super::controller::{Controller, Event, Output, GIVE_UP_AFTER};
use super::handshake::{Next, Peer, TargetHandshake};
use super::identity::DeviceKey;
use super::message::{
    Capabilities, CloseReason, Command, DeviceType, ErrorCode, Feature, Hello, Message,
    PlaybackSnapshot, PlaybackStatus, Track, PROTOCOL_VERSION,
};
use super::sessions::RESUME_GRACE;
use super::settings::{ControlMode, RemoteSettings};
use super::target::{Action, ConsentPrompt, SessionInfo, Target, IDLE_TIMEOUT};
use super::ConnId;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// A peer with a new key, for tests that don't run a handshake.
pub(crate) fn peer(name: &str) -> Peer {
    Peer {
        id: DeviceKey::generate().device_id(),
        name: name.into(),
        device_type: DeviceType::Iphone,
        features: vec![Feature::Control],
    }
}

pub(crate) fn hello(key: &DeviceKey, name: &str, device_type: DeviceType) -> Hello {
    Hello {
        id: key.device_id(),
        name: name.into(),
        device_type,
        versions: vec![PROTOCOL_VERSION],
        features: vec![
            Feature::Control,
            Feature::Catalog,
            Feature::History,
            Feature::Providers,
            Feature::Rename,
        ],
    }
}

/// A hello from a Cinette that came before renames.
pub(crate) fn older_hello(key: &DeviceKey, name: &str, device_type: DeviceType) -> Hello {
    let mut hello = hello(key, name, device_type);
    hello.features.retain(|f| *f != Feature::Rename);
    hello
}

/// A catalog item with just an id and a name.
pub(crate) fn item(id: &str) -> CatalogItem {
    CatalogItem {
        id: id.into(),
        name: format!("Item {id}"),
        content_type: "movie".into(),
        ..CatalogItem::default()
    }
}

/// A movie playing with every control available.
pub(crate) fn playing(id: &str, position: f64) -> PlaybackSnapshot {
    PlaybackSnapshot {
        status: PlaybackStatus::Playing,
        item: Some(item(id)),
        position,
        duration: 3600.0,
        volume: Some(80),
        subtitles: vec![Track {
            id: "en".into(),
            label: "English".into(),
            language: Some("en".into()),
        }],
        audio: vec![Track {
            id: "1".into(),
            label: "Main".into(),
            language: None,
        }],
        capabilities: Capabilities {
            pause: true,
            seek: true,
            volume: true,
            subtitles: true,
            audio_tracks: true,
            resume_at: true,
        },
        ..PlaybackSnapshot::default()
    }
}

/// The contents of the one frame in `bytes`.
fn unframe(bytes: &[u8]) -> Vec<u8> {
    let mut reader = FrameReader::new();
    reader.push(bytes);
    let frame = reader.next_frame().unwrap().unwrap();
    assert!(reader.next_frame().unwrap().is_none());
    frame
}

/// A controller let through by a bare target handshake, for tests that
/// play the target by hand. Returns the target's side of the channel.
fn controller_and_bare_target(now: Instant) -> (Controller, Channel) {
    let target_key = DeviceKey::generate();
    let target_hello = hello(&target_key, "TV", DeviceType::FireTv);
    controller_and_bare_target_saying(target_key, target_hello, now)
}

/// [`controller_and_bare_target`] with the target's key and hello.
fn controller_and_bare_target_saying(
    target_key: DeviceKey,
    target_hello: Hello,
    now: Instant,
) -> (Controller, Channel) {
    let key = DeviceKey::generate();
    let (mut controller, first) = Controller::connect(
        &key,
        hello(&key, "Phone", DeviceType::Iphone),
        target_key.device_id(),
        None,
        now,
    )
    .unwrap();
    let mut target = TargetHandshake::new(&target_key, target_hello).unwrap();
    let mut to_target = VecDeque::from([first]);
    loop {
        let bytes = to_target.pop_front().unwrap();
        let (reply, next) = target.read(&unframe(&bytes)).unwrap();
        match next {
            Next::Continue(handshake) => {
                target = handshake;
                let out = controller.receive(&unframe(&reply.unwrap()), Instant::now());
                to_target.extend(out.send);
            }
            Next::Done(established) => return (controller, established.channel),
        }
    }
}

/// One controller in [`Net`].
pub(crate) struct Client {
    pub key: DeviceKey,
    pub controller: Controller,
    pub conn: ConnId,
    pub events: Vec<Event>,
    /// Frames on their way to the target.
    outbox: VecDeque<Vec<u8>>,
    from_target: FrameReader,
    /// The target closed this connection.
    pub closed: bool,
}

impl Client {
    pub fn closed_reason(&self) -> Option<CloseReason> {
        self.events.iter().rev().find_map(|e| match e {
            Event::Closed(reason) => Some(*reason),
            _ => None,
        })
    }

    pub fn connected(&self) -> bool {
        self.controller.session_id().is_some() && !self.closed
    }

    pub fn states(&self) -> Vec<&PlaybackSnapshot> {
        self.events
            .iter()
            .filter_map(|e| match e {
                Event::State(s) => Some(&s.state),
                Event::Connected { state, .. } => Some(&state.state),
                _ => None,
            })
            .collect()
    }

    pub fn last_state(&self) -> Option<&PlaybackSnapshot> {
        self.states().last().copied()
    }

    pub fn code(&self) -> Option<String> {
        self.events.iter().find_map(|e| match e {
            Event::Verified { code, .. } => Some(code.to_string()),
            _ => None,
        })
    }
}

/// A target and its controllers, with frames carried between them in memory.
pub(crate) struct Net {
    pub target: Target,
    pub now: Instant,
    pub clients: Vec<Client>,
    /// Every action the target took other than sending and closing.
    pub log: Vec<Action>,
    /// Commands and catalog queries the target asked the app to carry out.
    pub applied: Vec<(ConnId, u64, Command)>,
    pub queries: Vec<(ConnId, u64, CatalogQuery)>,
}

impl Net {
    pub fn new(settings: RemoteSettings) -> Self {
        Self {
            target: Target::new(DeviceKey::generate(), DeviceType::AndroidTv, settings),
            now: Instant::now(),
            clients: Vec::new(),
            log: Vec::new(),
            applied: Vec::new(),
            queries: Vec::new(),
        }
    }

    pub fn with_mode(mode: ControlMode) -> Self {
        Self::new(RemoteSettings {
            remote_control: mode,
            ..RemoteSettings::default()
        })
    }

    /// Connects a new controller and runs as far as it gets on its own.
    pub fn connect(&mut self, name: &str) -> usize {
        self.connect_with(DeviceKey::generate(), name, None)
    }

    pub fn connect_with(&mut self, key: DeviceKey, name: &str, resume: Option<String>) -> usize {
        let hello = hello(&key, name, DeviceType::Iphone);
        self.connect_saying(key, hello, resume)
    }

    /// Connects a controller from a Cinette that came before renames.
    pub fn connect_older(&mut self, name: &str) -> usize {
        let key = DeviceKey::generate();
        let hello = older_hello(&key, name, DeviceType::Iphone);
        self.connect_saying(key, hello, None)
    }

    fn connect_saying(&mut self, key: DeviceKey, hello: Hello, resume: Option<String>) -> usize {
        let (controller, first) = Controller::connect(
            &key,
            hello,
            self.target.device_id(),
            resume,
            self.now,
        )
        .unwrap();
        let conn = self
            .target
            .accept(self.now)
            .expect("the target takes the connection");
        self.clients.push(Client {
            key,
            controller,
            conn,
            events: Vec::new(),
            outbox: VecDeque::from([first]),
            from_target: FrameReader::new(),
            closed: false,
        });
        self.pump();
        self.clients.len() - 1
    }

    fn client_for(&mut self, conn: ConnId) -> Option<&mut Client> {
        self.clients
            .iter_mut()
            .filter(|c| !c.closed)
            .find(|c| c.conn == conn)
    }

    /// Carries out what the target asked for.
    pub fn handle(&mut self, actions: Vec<Action>) {
        let now = self.now;
        for action in actions {
            match action {
                Action::Send { conn, bytes } => {
                    let Some(client) = self.client_for(conn) else {
                        continue;
                    };
                    client.from_target.push(&bytes);
                    while let Some(frame) = client.from_target.next_frame().unwrap() {
                        let out = client.controller.receive(&frame, now);
                        client.outbox.extend(out.send);
                        client.events.extend(out.events);
                    }
                }
                Action::Close { conn } => {
                    if let Some(client) = self.client_for(conn) {
                        client.closed = true;
                        client.outbox.clear();
                    }
                }
                Action::Apply {
                    conn,
                    request,
                    command,
                } => self.applied.push((conn, request, command)),
                Action::Catalog {
                    conn,
                    request,
                    query,
                } => self.queries.push((conn, request, query)),
                other => self.log.push(other),
            }
        }
    }

    /// Delivers frames from the controllers until none are left.
    pub fn pump(&mut self) {
        loop {
            let next = self.clients.iter_mut().enumerate().find_map(|(i, c)| {
                let frame = c.outbox.pop_front()?;
                Some((i, c.conn, frame))
            });
            let Some((_, conn, bytes)) = next else {
                break;
            };
            let mut reader = FrameReader::new();
            reader.push(&bytes);
            while let Some(frame) = reader.next_frame().unwrap() {
                let actions = self.target.receive(conn, &frame, self.now);
                self.handle(actions);
            }
        }
    }

    /// Sends bytes a controller produced outside `receive`, like a command.
    pub fn send(&mut self, client: usize, bytes: Vec<u8>) {
        self.clients[client].outbox.push_back(bytes);
        self.pump();
    }

    /// Queues frames without delivering them, for [`Net::deliver`].
    pub fn queue(&mut self, client: usize, frames: Vec<Vec<u8>>) {
        self.clients[client].outbox.extend(frames);
    }

    /// Delivers the next queued frame of one controller, and nothing more.
    pub fn deliver(&mut self, client: usize) {
        let Some(bytes) = self.clients[client].outbox.pop_front() else {
            return;
        };
        let conn = self.clients[client].conn;
        let mut reader = FrameReader::new();
        reader.push(&bytes);
        while let Some(frame) = reader.next_frame().unwrap() {
            let actions = self.target.receive(conn, &frame, self.now);
            self.handle(actions);
        }
    }

    /// Sends several frames in the order they were sealed.
    pub fn send_all(&mut self, client: usize, frames: Vec<Vec<u8>>) {
        self.clients[client].outbox.extend(frames);
        self.pump();
    }

    pub fn command(&mut self, client: usize, command: Command) -> u64 {
        let (id, bytes) = self.clients[client].controller.command(command).unwrap();
        self.send(client, bytes);
        id
    }

    pub fn query(&mut self, client: usize, query: CatalogQuery) -> u64 {
        let (id, bytes) = self.clients[client].controller.catalog(query).unwrap();
        self.send(client, bytes);
        id
    }

    pub fn advance(&mut self, by: Duration) {
        self.now += by;
        let actions = self.target.tick(self.now);
        self.handle(actions);
        self.pump();
    }

    /// The target's player read a new state.
    pub fn set_state(&mut self, state: PlaybackSnapshot) {
        let actions = self.target.set_state(state, self.now);
        self.handle(actions);
        self.pump();
    }

    /// The dialog on screen now, from the latest Show and Hide actions.
    pub fn prompt(&self) -> Option<ConsentPrompt> {
        let mut shown = None;
        for action in &self.log {
            match action {
                Action::ShowConsent(prompt) => shown = Some(prompt.clone()),
                Action::HideConsent(id) if shown.as_ref().is_some_and(|p| p.request == *id) => {
                    shown = None
                }
                _ => {}
            }
        }
        shown
    }

    pub fn answer(&mut self, answer: Answer) {
        let prompt = self.prompt().expect("a dialog is on screen");
        let actions = self.target.answer(prompt.request, answer, self.now);
        self.handle(actions);
        self.pump();
    }

    pub fn change_settings(&mut self, settings: RemoteSettings) {
        let actions = self.target.update_settings(settings, self.now);
        self.handle(actions);
        self.pump();
    }

    pub fn set_mode(&mut self, mode: ControlMode) {
        let settings = RemoteSettings {
            remote_control: mode,
            ..self.target.settings().clone()
        };
        self.change_settings(settings);
    }

    pub fn last_sessions(&self) -> Option<&Vec<SessionInfo>> {
        self.log.iter().rev().find_map(|a| match a {
            Action::SessionsChanged(list) => Some(list),
            _ => None,
        })
    }

    pub fn finish(&mut self, conn: ConnId, request: u64, result: Result<(), ErrorCode>) {
        let actions = self.target.finish_command(conn, request, result);
        self.handle(actions);
    }

    /// A connection dropped without either side closing it.
    pub fn drop_link(&mut self, client: usize) {
        let conn = self.clients[client].conn;
        self.clients[client].closed = true;
        let actions = self.target.disconnected(conn, self.now);
        self.handle(actions);
    }
}

#[test]
fn hex_reads_back_in_either_case() {
    let bytes = [0x00, 0x7f, 0xa5, 0xff];
    assert_eq!(super::to_hex(&bytes), "007fa5ff");
    assert_eq!(super::from_hex::<4>("007fa5ff"), Some(bytes));
    assert_eq!(super::from_hex::<4>("007FA5FF"), Some(bytes));
}

#[test]
fn hex_refuses_the_wrong_length_or_digits() {
    assert_eq!(super::from_hex::<2>("abc"), None);
    assert_eq!(super::from_hex::<2>("abcdef"), None);
    assert_eq!(super::from_hex::<2>("abzz"), None);
    assert_eq!(super::from_hex::<1>("g0"), None);
    assert_eq!(super::from_hex::<0>(""), Some([]));
}

// Permission defaults

#[test]
fn by_default_a_request_waits_for_the_user() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    let prompt = net.prompt().expect("the target shows a dialog");
    assert_eq!(prompt.name, "Phone");
    assert_eq!(prompt.device_id, net.clients[phone].key.device_id());
    assert!(!net.clients[phone].connected());
    assert!(net.clients[phone]
        .events
        .contains(&Event::Pending { expires_in: 30 }));
}

#[test]
fn both_screens_show_the_same_code() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    let code = net.clients[phone].code().unwrap();
    assert_eq!(code.len(), 6);
    assert_eq!(net.prompt().unwrap().code, code);
    // The controller knows which device it reached, before it's let in.
    let target = net.clients[phone].controller.peer().unwrap();
    assert_eq!(target.id, net.target.device_id());
    assert_eq!(target.name, "Android TV");
}

#[test]
fn each_connection_gets_its_own_code() {
    let mut net = Net::with_mode(ControlMode::Always);
    let codes: std::collections::HashSet<_> = (0..6)
        .map(|i| {
            // A second apart, so the target has a nonce for each.
            net.advance(Duration::from_secs(1));
            let c = net.connect(&format!("Phone {i}"));
            net.clients[c].code().unwrap()
        })
        .collect();
    // Six random 6-digit codes are all different, but for a one in a few
    // hundred thousand chance.
    assert!(codes.len() >= 5);
}

#[test]
fn always_allow_connects_without_a_dialog() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    assert!(net.clients[phone].connected());
    assert_eq!(net.prompt(), None);
    assert_eq!(net.target.sessions().len(), 1);
}

#[test]
fn never_allow_refuses_without_a_dialog() {
    let mut net = Net::with_mode(ControlMode::Never);
    let phone = net.connect("Phone");
    assert_eq!(
        net.clients[phone].closed_reason(),
        Some(CloseReason::NotAllowed)
    );
    assert!(net.clients[phone].closed);
    assert_eq!(net.prompt(), None);
    assert!(net.target.sessions().is_empty());
}

#[test]
fn never_allow_is_advertised_as_unavailable() {
    let net = Net::with_mode(ControlMode::Never);
    let record = net.target.discovery_record().unwrap();
    assert!(record.txt.contains(&("rc".into(), "0".into())));
    let net = Net::with_mode(ControlMode::Ask);
    let record = net.target.discovery_record().unwrap();
    assert!(record.txt.contains(&("rc".into(), "1".into())));
}

#[test]
fn the_discovery_record_holds_nothing_private() {
    let net = Net::new(RemoteSettings::default());
    let record = net.target.discovery_record().unwrap();
    let keys: Vec<_> = record.txt.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["v", "id", "n", "t", "rc"]);
    assert_eq!(record.instance, "Android TV");
    assert!(record.txt.contains(&("t".into(), "android-tv".into())));
    assert!(record
        .txt
        .contains(&("id".into(), net.target.device_id().to_string())));
}

#[test]
fn an_undiscoverable_device_refuses_new_connections_and_isnt_advertised() {
    for mode in [ControlMode::Always, ControlMode::Ask] {
        let mut net = Net::new(RemoteSettings {
            discoverable: false,
            remote_control: mode,
            device_name: None,
        });
        assert_eq!(net.target.discovery_record(), None);
        let phone = net.connect("Phone");
        assert_eq!(
            net.clients[phone].closed_reason(),
            Some(CloseReason::NotDiscoverable)
        );
        assert_eq!(net.prompt(), None);
    }
}

// Consent

#[test]
fn allow_grants_control() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    net.answer(Answer::Allow);
    assert!(net.clients[phone].connected());
    assert_eq!(net.prompt(), None);
    let sessions = net.last_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "Phone");
    assert!(sessions[0].connected);
}

#[test]
fn deny_and_dismiss_grant_nothing() {
    for (answer, reason) in [
        (Answer::Deny, CloseReason::Denied),
        (Answer::Dismiss, CloseReason::Denied),
    ] {
        let mut net = Net::new(RemoteSettings::default());
        let phone = net.connect("Phone");
        net.answer(answer);
        assert_eq!(net.clients[phone].closed_reason(), Some(reason));
        assert!(!net.clients[phone].connected());
        assert!(net.target.sessions().is_empty());
        assert_eq!(net.prompt(), None);
    }
}

#[test]
fn a_request_no_one_answers_expires_and_grants_nothing() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    // Keep the connection alive while waiting.
    net.advance(CONSENT_TIMEOUT - Duration::from_secs(1));
    assert!(net.prompt().is_some());
    net.advance(Duration::from_secs(1));
    assert_eq!(
        net.clients[phone].closed_reason(),
        Some(CloseReason::Expired)
    );
    assert_eq!(net.prompt(), None);
    assert!(net.target.sessions().is_empty());
}

#[test]
fn allow_after_the_request_expired_grants_nothing() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    let prompt = net.prompt().unwrap();
    // The tick that would expire it hasn't run yet when the tap lands.
    net.now += CONSENT_TIMEOUT;
    let actions = net.target.answer(prompt.request, Answer::Allow, net.now);
    net.handle(actions);
    assert!(!net.clients[phone].connected());
    net.advance(Duration::ZERO);
    assert_eq!(
        net.clients[phone].closed_reason(),
        Some(CloseReason::Expired)
    );
}

#[test]
fn a_controller_can_withdraw_its_request() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    let bytes = net.clients[phone].controller.leave().unwrap();
    net.send(phone, bytes);
    assert_eq!(net.prompt(), None);
    assert!(net.target.sessions().is_empty());
}

#[test]
fn a_controller_that_hangs_up_takes_its_dialog_away() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    net.drop_link(phone);
    assert_eq!(net.prompt(), None);
}

#[test]
fn a_denied_device_is_refused_without_a_dialog_for_a_minute() {
    let mut net = Net::new(RemoteSettings::default());
    let key = DeviceKey::generate();
    net.connect_with(key.clone(), "Neighbor", None);
    net.answer(Answer::Deny);
    let again = net.connect_with(key.clone(), "Neighbor", None);
    assert_eq!(
        net.clients[again].closed_reason(),
        Some(CloseReason::Denied)
    );
    assert_eq!(net.prompt(), None);
    net.advance(DENIAL_COOLDOWN);
    net.connect_with(key, "Neighbor", None);
    assert!(net.prompt().is_some());
}

#[test]
fn after_a_denial_a_new_device_waits_before_it_can_ask() {
    let mut net = Net::new(RemoteSettings::default());
    net.connect("Neighbor");
    net.answer(Answer::Deny);
    // A device that made up a new id is turned away too.
    let other = net.connect("Neighbor again");
    assert_eq!(net.clients[other].closed_reason(), Some(CloseReason::Busy));
    assert_eq!(net.prompt(), None);
    net.advance(super::consent::DENIAL_BACKOFF);
    net.connect("Phone");
    assert_eq!(net.prompt().unwrap().name, "Phone");
}

#[test]
fn requests_queue_one_dialog_at_a_time() {
    let mut net = Net::new(RemoteSettings::default());
    let first = net.connect("First");
    let second = net.connect("Second");
    assert_eq!(net.prompt().unwrap().name, "First");
    net.answer(Answer::Deny);
    assert_eq!(net.prompt().unwrap().name, "Second");
    net.answer(Answer::Allow);
    assert!(!net.clients[first].connected());
    assert!(net.clients[second].connected());
}

#[test]
fn a_full_queue_is_busy() {
    let mut net = Net::new(RemoteSettings::default());
    for i in 0..super::consent::MAX_WAITING {
        net.connect(&format!("Phone {i}"));
    }
    let extra = net.connect("One too many");
    assert_eq!(net.clients[extra].closed_reason(), Some(CloseReason::Busy));
}

// Revocation

#[test]
fn never_allow_ends_every_session_at_once() {
    let mut net = Net::with_mode(ControlMode::Always);
    let a = net.connect("A");
    let b = net.connect("B");
    net.set_mode(ControlMode::Never);
    for c in [a, b] {
        assert_eq!(net.clients[c].closed_reason(), Some(CloseReason::Revoked));
        assert!(net.clients[c].closed);
    }
    assert!(net.target.sessions().is_empty());
    assert_eq!(net.last_sessions(), Some(&vec![]));
}

#[test]
fn never_allow_also_refuses_waiting_requests_and_dropped_sessions() {
    let mut net = Net::with_mode(ControlMode::Always);
    let key = DeviceKey::generate();
    let dropped = net.connect_with(key.clone(), "Dropped", None);
    let session = net.clients[dropped]
        .controller
        .session_id()
        .unwrap()
        .to_owned();
    net.drop_link(dropped);
    net.set_mode(ControlMode::Ask);
    let waiting = net.connect("Waiting");
    net.set_mode(ControlMode::Never);
    assert_eq!(
        net.clients[waiting].closed_reason(),
        Some(CloseReason::NotAllowed)
    );
    assert_eq!(net.prompt(), None);
    // The dropped session can't come back either.
    let back = net.connect_with(key, "Dropped", Some(session));
    assert_eq!(
        net.clients[back].closed_reason(),
        Some(CloseReason::NotAllowed)
    );
}

#[test]
fn turning_discovery_off_keeps_open_sessions_and_refuses_new_ones() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    net.change_settings(RemoteSettings {
        discoverable: false,
        remote_control: ControlMode::Always,
        device_name: None,
    });
    assert!(net.log.contains(&Action::Advertise(None)));
    assert!(net.clients[phone].connected());
    let late = net.connect("Late");
    assert_eq!(
        net.clients[late].closed_reason(),
        Some(CloseReason::NotDiscoverable)
    );
    // The open session still works.
    net.set_state(playing("movie-1", 0.0));
    assert_eq!(
        net.clients[phone]
            .last_state()
            .unwrap()
            .item
            .as_ref()
            .unwrap()
            .id,
        "movie-1"
    );
}

#[test]
fn turning_discovery_off_refuses_waiting_requests() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    net.change_settings(RemoteSettings {
        discoverable: false,
        ..RemoteSettings::default()
    });
    assert_eq!(
        net.clients[phone].closed_reason(),
        Some(CloseReason::NotDiscoverable)
    );
    assert_eq!(net.prompt(), None);
}

#[test]
fn switching_between_always_and_ask_leaves_sessions_alone() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    net.set_mode(ControlMode::Ask);
    assert!(net.clients[phone].connected());
    net.set_mode(ControlMode::Always);
    assert!(net.clients[phone].connected());
}

#[test]
fn the_target_can_disconnect_one_controller() {
    let mut net = Net::with_mode(ControlMode::Always);
    let a = net.connect("A");
    let b = net.connect("B");
    let id = net.clients[a].controller.session_id().unwrap().to_owned();
    let actions = net.target.disconnect(&id);
    net.handle(actions);
    assert_eq!(net.clients[a].closed_reason(), Some(CloseReason::Revoked));
    assert!(net.clients[b].connected());
    assert_eq!(net.target.sessions().len(), 1);
}

#[test]
fn a_revoked_controller_must_ask_again() {
    let mut net = Net::new(RemoteSettings::default());
    let key = DeviceKey::generate();
    let phone = net.connect_with(key.clone(), "Phone", None);
    net.answer(Answer::Allow);
    let session = net.clients[phone]
        .controller
        .session_id()
        .unwrap()
        .to_owned();
    let actions = net.target.disconnect(&session);
    net.handle(actions);
    let back = net.connect_with(key, "Phone", Some(session));
    assert!(!net.clients[back].connected());
    assert!(net.prompt().is_some());
}

// Sessions that drop

#[test]
fn a_dropped_session_resumes_within_the_grace_period_without_asking() {
    let mut net = Net::new(RemoteSettings::default());
    let key = DeviceKey::generate();
    let phone = net.connect_with(key.clone(), "Phone", None);
    net.answer(Answer::Allow);
    let session = net.clients[phone]
        .controller
        .session_id()
        .unwrap()
        .to_owned();
    net.drop_link(phone);
    assert!(!net.last_sessions().unwrap()[0].connected);
    net.advance(RESUME_GRACE - Duration::from_secs(1));
    let back = net.connect_with(key, "Phone", Some(session.clone()));
    assert!(net.clients[back].connected());
    assert_eq!(
        net.clients[back].controller.session_id(),
        Some(session.as_str())
    );
    assert_eq!(net.prompt(), None);
    assert!(net.last_sessions().unwrap()[0].connected);
}

#[test]
fn a_session_dropped_too_long_has_ended_and_asks_again() {
    let mut net = Net::new(RemoteSettings::default());
    let key = DeviceKey::generate();
    let phone = net.connect_with(key.clone(), "Phone", None);
    net.answer(Answer::Allow);
    let session = net.clients[phone]
        .controller
        .session_id()
        .unwrap()
        .to_owned();
    net.drop_link(phone);
    net.advance(RESUME_GRACE);
    assert!(net.target.sessions().is_empty());
    let back = net.connect_with(key, "Phone", Some(session));
    assert!(!net.clients[back].connected());
    assert!(net.prompt().is_some(), "control never comes back silently");
}

#[test]
fn another_device_cant_take_over_a_session() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    net.answer(Answer::Allow);
    let session = net.clients[phone]
        .controller
        .session_id()
        .unwrap()
        .to_owned();
    net.drop_link(phone);
    let thief = net.connect_with(DeviceKey::generate(), "Phone", Some(session));
    assert!(!net.clients[thief].connected());
    assert!(net.prompt().is_some());
}

#[test]
fn a_new_session_from_the_same_device_closes_its_old_connection() {
    let mut net = Net::with_mode(ControlMode::Always);
    let key = DeviceKey::generate();
    let a = net.connect_with(key.clone(), "Phone", None);
    let b = net.connect_with(key, "Phone", None);
    assert_eq!(net.clients[a].closed_reason(), Some(CloseReason::Cancelled));
    assert!(net.clients[b].connected());
    assert_eq!(net.target.sessions().len(), 1);

    // Only the new connection gets state, and Never allow leaves nothing open.
    let before = net.clients[a].states().len();
    net.set_state(playing("m", 1.0));
    assert_eq!(net.clients[a].states().len(), before);
    assert_eq!(net.clients[b].last_state().map(|s| s.position), Some(1.0));
    net.set_mode(ControlMode::Never);
    assert_eq!(net.clients[b].closed_reason(), Some(CloseReason::Revoked));
    assert!(net.target.sessions().is_empty());
}

#[test]
fn a_quiet_connection_times_out_and_can_resume() {
    let mut net = Net::with_mode(ControlMode::Always);
    let key = DeviceKey::generate();
    let phone = net.connect_with(key.clone(), "Phone", None);
    let session = net.clients[phone]
        .controller
        .session_id()
        .unwrap()
        .to_owned();
    net.advance(IDLE_TIMEOUT);
    assert_eq!(
        net.clients[phone].closed_reason(),
        Some(CloseReason::Timeout)
    );
    assert_eq!(net.target.sessions().len(), 1);
    let back = net.connect_with(key, "Phone", Some(session));
    assert!(net.clients[back].connected());
}

#[test]
fn pings_keep_a_quiet_connection_open() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    for _ in 0..5 {
        net.advance(super::controller::PING_INTERVAL);
        let ping = net.clients[phone].controller.ping().unwrap();
        net.send(phone, ping);
    }
    assert!(net.clients[phone].connected());
}

#[test]
fn a_handshake_that_stalls_is_closed() {
    let mut net = Net::new(RemoteSettings::default());
    let conn = net.target.accept(net.now).unwrap();
    net.now += super::target::HANDSHAKE_TIMEOUT;
    let actions = net.target.tick(net.now);
    assert!(actions.contains(&Action::Close { conn }));
}

#[test]
fn shutting_down_ends_everything() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let actions = net.target.shutdown();
    net.handle(actions);
    assert_eq!(
        net.clients[phone].closed_reason(),
        Some(CloseReason::Shutdown)
    );
    assert!(net.log.contains(&Action::Advertise(None)));
}

// Independent playback

#[test]
fn connecting_attaches_to_what_plays_without_touching_it() {
    let mut net = Net::with_mode(ControlMode::Always);
    net.set_state(playing("movie-1", 120.0));
    let phone = net.connect("Phone");
    let state = net.clients[phone].last_state().unwrap();
    assert_eq!(state.item.as_ref().unwrap().id, "movie-1");
    assert_eq!(state.position, 120.0);
    assert!(
        net.applied.is_empty(),
        "connecting sends the player nothing"
    );
}

#[test]
fn leaving_sends_the_player_nothing() {
    let mut net = Net::with_mode(ControlMode::Always);
    net.set_state(playing("movie-1", 0.0));
    let phone = net.connect("Phone");
    let bytes = net.clients[phone].controller.leave().unwrap();
    net.send(phone, bytes);
    assert!(net.applied.is_empty());
    assert!(net.target.sessions().is_empty());
    assert_eq!(net.last_sessions(), Some(&vec![]));
}

#[test]
fn browsing_sends_the_player_nothing() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let id = net.query(
        phone,
        CatalogQuery::Search {
            query: "news".into(),
            content_type: None,
            limit: 20,
        },
    );
    assert!(net.applied.is_empty());
    let (conn, request, _) = net.queries[0].clone();
    assert_eq!(request, id);
    let actions = net
        .target
        .finish_catalog(conn, request, Ok((vec![item("live-1")], None)));
    net.handle(actions);
    assert!(net.clients[phone].events.contains(&Event::Page {
        request: id,
        items: vec![item("live-1")],
        next: None
    }));
}

#[test]
fn a_search_page_cut_to_fit_has_no_cursor_but_an_items_page_does() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let big = |i: usize| CatalogItem {
        name: "x".repeat(1000),
        ..item(&format!("i{i}"))
    };
    let many: Vec<CatalogItem> = (0..100).map(big).collect();
    let search = net.query(
        phone,
        CatalogQuery::Search {
            query: "x".into(),
            content_type: None,
            limit: 100,
        },
    );
    let browse = net.query(
        phone,
        CatalogQuery::Items {
            content_type: "live".into(),
            group: "g".into(),
            cursor: None,
            limit: 100,
        },
    );
    for (conn, request, _) in net.queries.clone() {
        let actions = net
            .target
            .finish_catalog(conn, request, Ok((many.clone(), None)));
        net.handle(actions);
    }
    let next_of = |id: u64| {
        net.clients[phone].events.iter().find_map(|e| match e {
            Event::Page {
                request,
                items,
                next,
            } if *request == id => Some((items.len(), next.clone())),
            _ => None,
        })
    };
    let (shown, next) = next_of(search).unwrap();
    assert!(shown < 100);
    assert_eq!(next, None, "a search can't go on from a cursor");
    let (shown, next) = next_of(browse).unwrap();
    assert_eq!(next, Some(format!("i{shown}")));
}

#[test]
fn a_controller_that_hasnt_been_let_in_cant_send_commands() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    assert!(net.clients[phone]
        .controller
        .command(Command::Stop)
        .is_err());
    assert!(net.applied.is_empty());
}

// Synchronization

#[test]
fn every_controller_gets_every_state() {
    let mut net = Net::with_mode(ControlMode::Always);
    let a = net.connect("A");
    let b = net.connect("B");
    net.set_state(playing("movie-1", 0.0));
    let mut paused = playing("movie-1", 3.0);
    paused.status = PlaybackStatus::Paused;
    net.set_state(paused.clone());
    for c in [a, b] {
        assert_eq!(net.clients[c].last_state(), Some(&paused));
    }
}

#[test]
fn versions_go_up_with_each_state() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    net.set_state(playing("movie-1", 0.0));
    net.set_state(playing("movie-2", 0.0));
    let versions: Vec<u64> = net.clients[phone]
        .events
        .iter()
        .filter_map(|e| match e {
            Event::Connected { state, .. } | Event::State(state) => Some(state.version),
            _ => None,
        })
        .collect();
    assert_eq!(versions, [0, 1, 2]);
}

#[test]
fn a_position_that_moves_as_expected_isnt_sent_every_second() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    net.set_state(playing("movie-1", 0.0));
    let before = net.clients[phone].states().len();
    for s in 1..5 {
        net.now += Duration::from_secs(1);
        net.set_state(playing("movie-1", s as f64));
    }
    assert_eq!(net.clients[phone].states().len(), before);
    // Every 5 s it goes out anyway.
    net.now += Duration::from_secs(1);
    net.set_state(playing("movie-1", 5.0));
    assert_eq!(net.clients[phone].states().len(), before + 1);
}

#[test]
fn a_position_off_by_up_to_two_seconds_waits_for_the_refresh() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    net.set_state(playing("movie-1", 0.0));
    let before = net.clients[phone].states().len();
    // Expected at 1.0 after a second; 2.5 and 3.0 are within two seconds.
    net.now += Duration::from_secs(1);
    net.set_state(playing("movie-1", 2.5));
    net.set_state(playing("movie-1", 3.0));
    assert_eq!(net.clients[phone].states().len(), before);
    net.set_state(playing("movie-1", 3.5));
    assert_eq!(net.clients[phone].states().len(), before + 1);
}

#[test]
fn a_seek_on_the_target_is_sent_at_once() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    net.set_state(playing("movie-1", 0.0));
    net.now += Duration::from_secs(1);
    net.set_state(playing("movie-1", 600.0));
    assert_eq!(net.clients[phone].last_state().unwrap().position, 600.0);
}

#[test]
fn a_paused_position_that_holds_still_isnt_sent_again() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let mut paused = playing("movie-1", 50.0);
    paused.status = PlaybackStatus::Paused;
    net.set_state(paused.clone());
    let before = net.clients[phone].states().len();
    net.now += Duration::from_secs(30);
    net.set_state(paused);
    assert_eq!(net.clients[phone].states().len(), before);
}

#[test]
fn commands_from_two_controllers_apply_in_the_order_they_arrive() {
    let mut net = Net::with_mode(ControlMode::Always);
    let a = net.connect("A");
    let b = net.connect("B");
    net.set_state(playing("movie-1", 0.0));
    let seek = |to| Command::Seek {
        item_id: "movie-1".into(),
        to: Some(to),
        by: None,
    };
    net.command(a, seek(100.0));
    net.command(b, seek(200.0));
    let applied: Vec<_> = net.applied.iter().map(|(_, _, c)| c.clone()).collect();
    assert_eq!(applied, [seek(100.0), seek(200.0)]);
}

#[test]
fn a_command_for_an_item_no_longer_playing_is_stale() {
    let mut net = Net::with_mode(ControlMode::Always);
    let a = net.connect("A");
    let b = net.connect("B");
    net.set_state(playing("movie-1", 0.0));
    let load = net.command(
        b,
        Command::Load {
            item_id: "movie-2".into(),
            start_at: None,
        },
    );
    let (conn, request, _) = net.applied[0].clone();
    assert_eq!(request, load);
    net.finish(conn, request, Ok(()));
    net.set_state(playing("movie-2", 0.0));
    // A's seek was meant for the movie that was playing when A sent it.
    let seek = net.command(
        a,
        Command::Seek {
            item_id: "movie-1".into(),
            to: Some(100.0),
            by: None,
        },
    );
    assert_eq!(net.applied.len(), 1);
    assert!(net.clients[a].events.contains(&Event::Reply {
        request: seek,
        result: Err(ErrorCode::StaleItem)
    }));
    assert!(net.clients[b].events.iter().any(|e| matches!(
        e,
        Event::Reply { request, result: Ok(_) } if *request == load
    )));
}

#[test]
fn a_rejected_command_never_reaches_the_player() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let mut live = playing("live-1", 0.0);
    live.capabilities.seek = false;
    net.set_state(live);
    let id = net.command(
        phone,
        Command::Seek {
            item_id: "live-1".into(),
            to: Some(10.0),
            by: None,
        },
    );
    assert!(net.applied.is_empty());
    assert!(net.clients[phone].events.contains(&Event::Reply {
        request: id,
        result: Err(ErrorCode::Unsupported)
    }));
}

#[test]
fn a_flood_of_commands_is_rate_limited() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    for _ in 0..25 {
        net.command(phone, Command::Volume { value: 50 });
    }
    net.set_state(playing("movie-1", 0.0));
    // The volume command needs the capability; without a state it's
    // unsupported, so count replies instead of applied commands.
    let limited = net.clients[phone]
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                Event::Reply {
                    result: Err(ErrorCode::RateLimited),
                    ..
                }
            )
        })
        .count();
    // The request for control took one of the 20 a second.
    assert_eq!(limited, 6);
    net.advance(Duration::from_secs(1));
    let id = net.command(phone, Command::Stop);
    assert!(net.applied.iter().any(|(_, r, _)| *r == id));
}

#[test]
fn more_than_eight_controllers_are_busy() {
    let mut net = Net::with_mode(ControlMode::Always);
    for i in 0..super::sessions::MAX_SESSIONS {
        // A second apart, so the target has a nonce for each.
        net.advance(Duration::from_secs(1));
        let c = net.connect(&format!("Phone {i}"));
        assert!(net.clients[c].connected());
    }
    net.advance(Duration::from_secs(1));
    let extra = net.connect("One too many");
    assert_eq!(net.clients[extra].closed_reason(), Some(CloseReason::Busy));
}

#[test]
fn each_request_gets_the_next_id() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let first = net.command(phone, Command::Stop);
    let second = net.query(
        phone,
        CatalogQuery::Groups {
            content_type: "live".into(),
            cursor: None,
            limit: 10,
        },
    );
    let third = net.command(phone, Command::Stop);
    assert_eq!([first, second, third], [1, 2, 3]);
}

#[test]
fn a_waiting_request_survives_unrelated_settings_changes() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    net.change_settings(RemoteSettings {
        device_name: Some("Den".into()),
        ..RemoteSettings::default()
    });
    net.set_mode(ControlMode::Always);
    assert!(net.prompt().is_some());
    net.answer(Answer::Allow);
    assert!(net.clients[phone].connected());
}

#[test]
fn a_command_sent_before_being_let_in_is_refused_by_its_id() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    let bytes = net.clients[phone]
        .controller
        .seal_raw(&Message::Command {
            id: 7,
            command: Command::Stop,
        })
        .unwrap();
    net.send(phone, bytes);
    assert!(net.clients[phone].events.contains(&Event::Reply {
        request: 7,
        result: Err(ErrorCode::Unsupported)
    }));
    assert!(net.applied.is_empty());
    assert!(net.prompt().is_some(), "the request still waits");
}

#[test]
fn a_frame_that_doesnt_decrypt_ends_the_connection_but_not_the_session() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let conn = net.clients[phone].conn;
    let actions = net.target.receive(conn, b"not a noise message", net.now);
    assert!(actions.contains(&Action::Close { conn }));
    net.handle(actions);
    assert!(!net.last_sessions().unwrap()[0].connected);
    // Nothing more is read from it.
    assert!(net.target.receive(conn, b"more", net.now).is_empty());
}

#[test]
fn a_controller_never_waits_longer_than_the_consent_timeout() {
    let (mut controller, mut target) = controller_and_bare_target(Instant::now());
    for (said, shown) in [(3600, 30), (30, 30), (12, 12)] {
        let bytes = target
            .seal(&Message::Pending {
                expires_in: said,
                re: None,
            })
            .unwrap();
        let out = controller.receive(&unframe(&bytes), Instant::now());
        assert_eq!(out.events, [Event::Pending { expires_in: shown }]);
    }
}

#[test]
fn a_controller_kept_waiting_gives_up_and_withdraws_its_request() {
    let mut net = Net::new(RemoteSettings::default());
    let started = net.now;
    let phone = net.connect("Phone");
    assert!(net.prompt().is_some());
    let deadline = started + GIVE_UP_AFTER;
    let controller = &mut net.clients[phone].controller;
    assert_eq!(controller.next_deadline(), Some(deadline));
    assert_eq!(
        controller.tick(deadline - Duration::from_millis(1)),
        Output::default()
    );
    let out = controller.tick(deadline);
    assert_eq!(out.events, [Event::Closed(CloseReason::Timeout)]);
    let [bytes] = &out.send[..] else {
        panic!("{out:?}")
    };
    net.send(phone, bytes.clone());
    assert_eq!(net.prompt(), None);
    assert!(net.clients[phone].closed);
}

#[test]
fn a_controller_that_got_in_has_no_deadline() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let controller = &mut net.clients[phone].controller;
    assert_eq!(controller.next_deadline(), None);
    assert_eq!(controller.tick(net.now + GIVE_UP_AFTER), Output::default());
    assert!(net.clients[phone].connected());
}

#[test]
fn a_position_or_duration_that_isnt_a_number_goes_out_as_zero() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    for (id, position, duration, sent) in [
        ("movie-1", f64::NAN, f64::INFINITY, (0.0, 0.0)),
        ("movie-2", f64::NEG_INFINITY, f64::NAN, (0.0, 0.0)),
        ("movie-3", 12.5, 3600.0, (12.5, 3600.0)),
    ] {
        net.set_state(PlaybackSnapshot {
            position,
            duration,
            ..playing(id, 0.0)
        });
        let state = net.clients[phone].last_state().unwrap();
        assert_eq!(state.item.as_ref().unwrap().id, id);
        assert_eq!((state.position, state.duration), sent);
    }
}

#[test]
fn a_tick_with_nothing_due_does_nothing() {
    let mut net = Net::with_mode(ControlMode::Always);
    net.connect("Phone");
    assert!(net.target.tick(net.now + Duration::from_secs(1)).is_empty());
}

#[test]
fn the_next_deadline_is_when_a_quiet_session_times_out() {
    let mut net = Net::with_mode(ControlMode::Always);
    net.connect("Phone");
    assert_eq!(net.target.next_deadline(), Some(net.now + IDLE_TIMEOUT));
}

#[test]
fn shutting_down_with_no_controllers_only_stops_advertising() {
    let mut net = Net::new(RemoteSettings::default());
    assert_eq!(net.target.shutdown(), [Action::Advertise(None)]);
}

// Transfers

#[test]
fn a_target_never_sends_its_own_providers() {
    // The only provider messages are the controller's settings going to the
    // target, and the target's results, which hold names and outcomes.
    let types: Vec<&str> = super::message::KNOWN_TYPES
        .iter()
        .copied()
        .filter(|t| t.to_lowercase().contains("provider"))
        .collect();
    assert_eq!(types, ["providersSend", "providersAdded"]);
}

// Over a real socket

#[test]
fn a_controller_and_target_talk_over_loopback_tcp() {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let target_key = DeviceKey::generate();
    let target_id = target_key.device_id();

    let server = std::thread::spawn(move || {
        let mut target = Target::new(
            target_key,
            DeviceType::Mac,
            RemoteSettings {
                remote_control: ControlMode::Always,
                ..RemoteSettings::default()
            },
        );
        let (mut stream, _) = listener.accept().unwrap();
        let now = Instant::now();
        let conn = target.accept(now).unwrap();
        let mut reader = FrameReader::new();
        let mut buf = [0u8; 4096];
        let mut applied = None;
        while applied.is_none() {
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0, "the controller hung up early");
            reader.push(&buf[..n]);
            while let Some(frame) = reader.next_frame().unwrap() {
                for action in target.receive(conn, &frame, now) {
                    match action {
                        Action::Send { bytes, .. } => stream.write_all(&bytes).unwrap(),
                        Action::Apply {
                            request, command, ..
                        } => {
                            for action in target.finish_command(conn, request, Ok(())) {
                                if let Action::Send { bytes, .. } = action {
                                    stream.write_all(&bytes).unwrap();
                                }
                            }
                            applied = Some(command);
                        }
                        _ => {}
                    }
                }
            }
        }
        applied.unwrap()
    });

    let key = DeviceKey::generate();
    let (mut controller, first) = Controller::connect(
        &key,
        hello(&key, "Laptop", DeviceType::LinuxPc),
        target_id,
        None,
        Instant::now(),
    )
    .unwrap();
    let mut stream = TcpStream::connect(addr).unwrap();
    stream.write_all(&first).unwrap();
    let mut reader = FrameReader::new();
    let mut buf = [0u8; 4096];
    let mut replied = false;
    let mut sent_command = false;
    while !replied {
        let n = stream.read(&mut buf).unwrap();
        assert!(n > 0, "the target hung up early");
        reader.push(&buf[..n]);
        while let Some(frame) = reader.next_frame().unwrap() {
            let out = controller.receive(&frame, Instant::now());
            for bytes in out.send {
                stream.write_all(&bytes).unwrap();
            }
            for event in out.events {
                match event {
                    Event::Connected { .. } if !sent_command => {
                        let (_, bytes) = controller.command(Command::Stop).unwrap();
                        stream.write_all(&bytes).unwrap();
                        sent_command = true;
                    }
                    Event::Reply { result, .. } => {
                        assert!(result.is_ok());
                        replied = true;
                    }
                    Event::Closed(reason) => panic!("closed: {reason:?}"),
                    _ => {}
                }
            }
        }
    }
    assert_eq!(server.join().unwrap(), Command::Stop);
}

// Renames

fn renames(client: &Client) -> Vec<&str> {
    client
        .events
        .iter()
        .filter_map(|e| match e {
            Event::Renamed(name) => Some(name.as_str()),
            _ => None,
        })
        .collect()
}

fn session_names(net: &Net) -> Vec<String> {
    net.last_sessions()
        .unwrap()
        .iter()
        .map(|s| s.name.clone())
        .collect()
}

#[test]
fn a_new_name_reaches_the_controllers_that_read_renames() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let older = net.connect_older("Old phone");
    net.change_settings(RemoteSettings {
        device_name: Some(" Den\u{202E} ".into()),
        ..net.target.settings().clone()
    });
    assert_eq!(renames(&net.clients[phone]), ["Den"]);
    assert_eq!(net.clients[phone].controller.peer().unwrap().name, "Den");
    // An older Cinette never hears it, so it can't answer unsupported.
    assert!(!net.clients[older]
        .controller
        .heard
        .iter()
        .any(|m| matches!(m, Message::Renamed { .. })));
    assert!(net.clients[older].connected());

    // Settings that keep the name send nothing.
    net.set_mode(ControlMode::Ask);
    assert_eq!(renames(&net.clients[phone]), ["Den"]);
    // Clearing the name goes back to the device type's.
    net.change_settings(RemoteSettings {
        device_name: None,
        ..net.target.settings().clone()
    });
    assert_eq!(renames(&net.clients[phone]), ["Den", "Android TV"]);
}

#[test]
fn a_controllers_new_name_reaches_the_targets_list() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    net.connect("Tablet");
    let bytes = net.clients[phone]
        .controller
        .rename("\u{2066}Kitchen\u{2069} ")
        .unwrap();
    net.send(phone, bytes);
    assert_eq!(session_names(&net), ["Kitchen", "Tablet"]);

    // The same name again changes nothing.
    let changes = net.log.len();
    let bytes = net.clients[phone].controller.rename("Kitchen").unwrap();
    net.send(phone, bytes);
    assert_eq!(net.log.len(), changes);

    // Nothing left of a name is the device type's.
    let bytes = net.clients[phone].controller.rename("\u{200B}").unwrap();
    net.send(phone, bytes);
    assert_eq!(session_names(&net), ["iPhone", "Tablet"]);
}

/// The bare target lets the controller in.
fn let_in(controller: &mut Controller, target: &mut Channel, now: Instant) {
    let accepted = target
        .seal(&Message::Accepted {
            session_id: "s".into(),
            state: super::message::VersionedState {
                epoch: "e".into(),
                version: 1,
                state: PlaybackSnapshot::default(),
            },
        })
        .unwrap();
    controller.receive(&unframe(&accepted), now);
    assert!(controller.session_id().is_some());
}

#[test]
fn a_controller_doesnt_rename_to_a_target_that_cant_read_it() {
    let now = Instant::now();
    let target_key = DeviceKey::generate();
    let target_hello = older_hello(&target_key, "TV", DeviceType::FireTv);
    let (mut controller, mut target) =
        controller_and_bare_target_saying(target_key, target_hello, now);
    // Not in a session yet.
    assert_eq!(controller.rename("Den"), None);
    let_in(&mut controller, &mut target, now);
    assert_eq!(controller.rename("Den"), None);
}

#[test]
fn a_controller_reports_only_a_name_that_changed() {
    let now = Instant::now();
    let (mut controller, mut target) = controller_and_bare_target(now);
    let_in(&mut controller, &mut target, now);
    let mut renamed = |name: &str| {
        let bytes = target
            .seal(&Message::Renamed { name: name.into() })
            .unwrap();
        controller.receive(&unframe(&bytes), now).events
    };
    assert_eq!(renamed("TV"), []);
    assert_eq!(renamed("Den\u{200B}"), [Event::Renamed("Den".into())]);
    assert_eq!(renamed("Den"), []);
    assert_eq!(controller.peer().unwrap().name, "Den");
}

#[test]
fn a_rename_while_asking_reaches_the_controller() {
    let now = Instant::now();
    let (mut controller, mut target) = controller_and_bare_target(now);
    let bytes = target
        .seal(&Message::Renamed { name: "Den".into() })
        .unwrap();
    let out = controller.receive(&unframe(&bytes), now);
    assert_eq!(out.events, [Event::Renamed("Den".into())]);
    assert_eq!(controller.peer().unwrap().name, "Den");
    assert_eq!(controller.session_id(), None);
}

#[test]
fn a_controller_waiting_for_the_dialog_hears_a_new_name() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    assert!(net.prompt().is_some());
    net.change_settings(RemoteSettings {
        device_name: Some("Den".into()),
        ..net.target.settings().clone()
    });
    assert_eq!(renames(&net.clients[phone]), ["Den"]);
    net.answer(Answer::Allow);
    assert!(net.clients[phone].connected());
    assert_eq!(net.clients[phone].controller.peer().unwrap().name, "Den");
}

#[test]
fn a_rename_from_a_controller_still_asking_is_refused() {
    let mut net = Net::new(RemoteSettings::default());
    let phone = net.connect("Phone");
    let bytes = net.clients[phone]
        .controller
        .seal_raw(&Message::Renamed { name: "Den".into() })
        .unwrap();
    net.send(phone, bytes);
    assert!(net.clients[phone]
        .events
        .contains(&Event::Error(ErrorCode::Unsupported)));
    assert_eq!(net.prompt().unwrap().name, "Phone");
    net.answer(Answer::Allow);
    assert_eq!(session_names(&net), ["Phone"]);
}

#[test]
fn renames_count_against_the_rate_limit() {
    let mut net = Net::with_mode(ControlMode::Always);
    let phone = net.connect("Phone");
    let frames: Vec<Vec<u8>> = (0..30)
        .map(|i| {
            net.clients[phone]
                .controller
                .rename(&format!("Name {i}"))
                .unwrap()
        })
        .collect();
    net.send_all(phone, frames);
    let names = session_names(&net);
    assert_ne!(names, ["Name 29"], "every rename was taken");
    // The bucket fills again with time.
    net.advance(Duration::from_secs(1));
    let bytes = net.clients[phone].controller.rename("Den").unwrap();
    net.send(phone, bytes);
    assert_eq!(session_names(&net), ["Den"]);
}

#[test]
fn a_session_resumed_under_a_new_name_shows_it() {
    let mut net = Net::with_mode(ControlMode::Always);
    let key = DeviceKey::generate();
    let phone = net.connect_with(key.clone(), "Phone", None);
    let session = net.clients[phone].controller.session_id().unwrap().to_owned();
    net.drop_link(phone);
    let back = net.connect_with(key, "Kitchen", Some(session.clone()));
    assert_eq!(
        net.clients[back].controller.session_id(),
        Some(session.as_str())
    );
    assert_eq!(session_names(&net), ["Kitchen"]);
}
