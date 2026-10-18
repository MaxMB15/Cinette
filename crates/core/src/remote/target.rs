// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The device being controlled.
//!
//! [`Target`] takes everything that happens (bytes from a connection, the
//! user's answer to a dialog, a settings change, a new player state, the
//! time passing) and returns [`Action`]s for the platform layer to carry
//! out. It owns the decisions: who gets in, which commands are valid, and
//! which state every controller sees.
//!
//! The target is authoritative. Commands from all controllers are taken in
//! the order they arrive, and the later one wins. A command about the item
//! playing names that item, and fails with [`ErrorCode::StaleItem`] if
//! something else is playing by then. Every state goes to every controller
//! with a version one higher than the last.

use super::catalog::{CatalogItem, CatalogQuery};
use super::channel::Channel;
use super::consent::{Answer, ConsentQueue, Outcome, RequestId, Resolved};
use super::handshake::{Established, Next, Peer, TargetHandshake, VerificationCode};
use super::identity::{DeviceId, DeviceKey};
use super::message::{
    self, CloseReason, Command, DecodeError, DeviceType, ErrorCode, Feature, Hello, Message,
    PlaybackSnapshot, PlaybackStatus, RequestKind, VersionedState, PROTOCOL_VERSION,
};
use super::sessions::{Session, Sessions};
use super::settings::{ControlMode, Decision, RemoteSettings};
use super::ConnId;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// How long a connection has to finish the handshake and ask.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// A connection that sends nothing for this long has dropped. Controllers
/// ping every 10 s.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(25);
/// The most connections still in the handshake at once.
pub const MAX_HANDSHAKES: usize = 16;
/// The most connections of any kind at once.
pub const MAX_CONNECTIONS: usize = 32;
/// How often a playing target sends its state, so positions don't drift.
pub const STATE_REFRESH: Duration = Duration::from_secs(5);
/// A position this far from where the last state said it would be is sent
/// at once.
const POSITION_JUMP: f64 = 2.0;
/// Commands and catalog queries per second, per connection.
const RATE: f64 = 20.0;
/// The longest item or track id a command can name, in bytes.
const MAX_ID_BYTES: usize = 256;
/// The furthest one relative seek can move, in seconds.
const MAX_SEEK_BY: f64 = 86_400.0;

/// What the platform layer should do.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Write these bytes to the connection.
    Send { conn: ConnId, bytes: Vec<u8> },
    /// Close the connection, once everything sent before is written.
    Close { conn: ConnId },
    /// Show the consent dialog for this request, replacing any other.
    ShowConsent(ConsentPrompt),
    /// Take the dialog for this request off screen.
    HideConsent(RequestId),
    /// The list of connected controllers changed.
    SessionsChanged(Vec<SessionInfo>),
    /// Carry out a controller's command on the player, then call
    /// [`Target::finish_command`].
    Apply {
        conn: ConnId,
        request: u64,
        command: Command,
    },
    /// Answer a catalog query from what this device can play, then call
    /// [`Target::finish_catalog`].
    Catalog {
        conn: ConnId,
        request: u64,
        query: CatalogQuery,
    },
    /// Advertise this record, replacing any earlier one, or stop advertising.
    Advertise(Option<DiscoveryRecord>),
}

/// What the consent dialog shows.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsentPrompt {
    pub request: RequestId,
    pub device_id: DeviceId,
    pub name: String,
    pub device_type: DeviceType,
    /// The 6 digits the controller shows too.
    pub code: String,
    pub expires_at: Instant,
}

/// One controller in the target's list.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionInfo {
    pub session_id: String,
    pub device_id: DeviceId,
    pub name: String,
    pub device_type: DeviceType,
    /// False while the connection is down and the session waits to resume.
    pub connected: bool,
}

/// The DNS-SD record for `_cinette._tcp`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryRecord {
    pub instance: String,
    pub txt: Vec<(String, String)>,
}

/// DNS-SD's service type.
pub const SERVICE_TYPE: &str = "_cinette._tcp";

enum Stage {
    Handshake(TargetHandshake),
    /// Handshake done; waiting for the request.
    Ready(Authenticated),
    Waiting(Authenticated, RequestId),
    InSession(Authenticated),
    /// The connection is closing. Anything more it sends is ignored.
    Closed,
}

struct Authenticated {
    channel: Channel,
    peer: Peer,
    code: VerificationCode,
}

struct Conn {
    stage: Stage,
    opened: Instant,
    last_heard: Instant,
    tokens: f64,
    tokens_at: Instant,
}

impl Conn {
    /// Takes one token from the connection's allowance. False when it's used up.
    fn take_token(&mut self, now: Instant) -> bool {
        let elapsed = now.duration_since(self.tokens_at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * RATE).min(RATE);
        self.tokens_at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

pub struct Target {
    key: DeviceKey,
    device_type: DeviceType,
    settings: RemoteSettings,
    epoch: String,
    version: u64,
    state: PlaybackSnapshot,
    /// When the last state went out, and the position it gave.
    last_sent: Option<(Instant, f64)>,
    conns: BTreeMap<ConnId, Conn>,
    next_conn: u64,
    consent: ConsentQueue,
    shown: Option<RequestId>,
    sessions: Sessions,
}

impl Target {
    pub fn new(key: DeviceKey, device_type: DeviceType, settings: RemoteSettings) -> Self {
        Self {
            key,
            device_type,
            settings,
            epoch: super::to_hex(&super::random_bytes::<8>()),
            version: 0,
            state: PlaybackSnapshot::default(),
            last_sent: None,
            conns: BTreeMap::new(),
            next_conn: 0,
            consent: ConsentQueue::new(),
            shown: None,
            sessions: Sessions::new(),
        }
    }

    pub fn device_id(&self) -> DeviceId {
        self.key.device_id()
    }

    pub fn settings(&self) -> &RemoteSettings {
        &self.settings
    }

    /// What to advertise, or `None` when the device isn't discoverable.
    pub fn discovery_record(&self) -> Option<DiscoveryRecord> {
        if !self.settings.advertise() {
            return None;
        }
        let name = self.settings.name(self.device_type);
        Some(DiscoveryRecord {
            instance: name.clone(),
            txt: vec![
                ("v".into(), PROTOCOL_VERSION.to_string()),
                ("id".into(), self.device_id().to_string()),
                ("n".into(), name),
                ("t".into(), self.device_type.as_str().into()),
                (
                    "rc".into(),
                    if self.settings.available() { "1" } else { "0" }.into(),
                ),
            ],
        })
    }

    fn hello(&self) -> Hello {
        Hello {
            id: self.device_id(),
            name: self.settings.name(self.device_type),
            device_type: self.device_type,
            versions: vec![PROTOCOL_VERSION],
            features: vec![Feature::Control, Feature::Catalog],
        }
    }

    /// A new connection arrived. `None` means close it at once: there are
    /// too many already.
    pub fn accept(&mut self, now: Instant) -> Option<ConnId> {
        let handshaking = self
            .conns
            .values()
            .filter(|c| matches!(c.stage, Stage::Handshake(_)))
            .count();
        if handshaking >= MAX_HANDSHAKES || self.conns.len() >= MAX_CONNECTIONS {
            return None;
        }
        let handshake = TargetHandshake::new(&self.key, self.hello()).ok()?;
        self.next_conn += 1;
        let conn = ConnId(self.next_conn);
        self.conns.insert(
            conn,
            Conn {
                stage: Stage::Handshake(handshake),
                opened: now,
                last_heard: now,
                tokens: RATE,
                tokens_at: now,
            },
        );
        Some(conn)
    }

    /// The connection is gone, closed by the other side or by the network.
    pub fn disconnected(&mut self, conn: ConnId, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Some(c) = self.conns.remove(&conn) {
            match c.stage {
                Stage::Waiting(..) => {
                    self.consent.withdraw(conn);
                    self.sync_prompt(&mut actions);
                }
                Stage::InSession(_) => {
                    self.sessions.detach(conn, now);
                    actions.push(self.sessions_changed());
                }
                _ => {}
            }
        }
        actions
    }

    /// One frame's contents from a connection, as [`super::channel::FrameReader`]
    /// returns them.
    pub fn receive(&mut self, conn: ConnId, frame: &[u8], now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        let Some(c) = self.conns.get_mut(&conn) else {
            return actions;
        };
        c.last_heard = now;
        match std::mem::replace(&mut c.stage, Stage::Closed) {
            Stage::Handshake(handshake) => match handshake.read(frame) {
                Ok((send, next)) => {
                    if let Some(bytes) = send {
                        actions.push(Action::Send { conn, bytes });
                    }
                    c.stage = match next {
                        Next::Continue(handshake) => Stage::Handshake(handshake),
                        Next::Done(established) => {
                            let Established {
                                channel,
                                peer,
                                code,
                                ..
                            } = *established;
                            Stage::Ready(Authenticated {
                                channel,
                                peer,
                                code,
                            })
                        }
                    };
                }
                Err(failure) => {
                    if let Some(bytes) = failure.send {
                        actions.push(Action::Send { conn, bytes });
                    }
                    actions.push(Action::Close { conn });
                    self.conns.remove(&conn);
                }
            },
            Stage::Ready(mut auth) => {
                let message = match open(&mut auth, conn, frame, &mut actions) {
                    Opened::Message(message) => *message,
                    Opened::Answered => {
                        self.set_stage(conn, Stage::Ready(auth));
                        return actions;
                    }
                    Opened::Broken => {
                        self.drop_conn(conn, &mut actions);
                        return actions;
                    }
                };
                match message {
                    Message::Request {
                        kind: RequestKind::Control,
                        resume,
                    } => self.request_control(conn, auth, resume, now, &mut actions),
                    Message::Ping => {
                        send(&mut auth, conn, &Message::Pong, &mut actions);
                        self.set_stage(conn, Stage::Ready(auth));
                    }
                    Message::Closed { .. } => self.close(conn, None, &mut actions),
                    other => {
                        reply_error(&mut auth, conn, &other, &mut actions);
                        self.set_stage(conn, Stage::Ready(auth));
                    }
                }
            }
            Stage::Waiting(mut auth, request) => {
                let message = match open(&mut auth, conn, frame, &mut actions) {
                    Opened::Message(message) => *message,
                    Opened::Answered => {
                        self.set_stage(conn, Stage::Waiting(auth, request));
                        return actions;
                    }
                    Opened::Broken => {
                        self.consent.withdraw(conn);
                        self.sync_prompt(&mut actions);
                        self.drop_conn(conn, &mut actions);
                        return actions;
                    }
                };
                match message {
                    Message::Cancel | Message::Closed { .. } => {
                        self.consent.withdraw(conn);
                        self.sync_prompt(&mut actions);
                        self.set_stage(conn, Stage::Waiting(auth, request));
                        self.close(conn, Some(CloseReason::Cancelled), &mut actions);
                    }
                    Message::Ping => {
                        send(&mut auth, conn, &Message::Pong, &mut actions);
                        self.set_stage(conn, Stage::Waiting(auth, request));
                    }
                    other => {
                        reply_error(&mut auth, conn, &other, &mut actions);
                        self.set_stage(conn, Stage::Waiting(auth, request));
                    }
                }
            }
            Stage::InSession(mut auth) => {
                let message = match open(&mut auth, conn, frame, &mut actions) {
                    Opened::Message(message) => *message,
                    Opened::Answered => {
                        self.set_stage(conn, Stage::InSession(auth));
                        return actions;
                    }
                    Opened::Broken => {
                        // A broken frame ends the connection, not the
                        // session, which the same controller can resume.
                        self.sessions.detach(conn, now);
                        actions.push(self.sessions_changed());
                        self.drop_conn(conn, &mut actions);
                        return actions;
                    }
                };
                match message {
                    Message::Command { id, command } => {
                        let allowed = self.conn_token(conn, now);
                        match (allowed, validate(&command, &self.state)) {
                            (false, _) => error(
                                &mut auth,
                                conn,
                                Some(id),
                                ErrorCode::RateLimited,
                                &mut actions,
                            ),
                            (true, Err(code)) => {
                                error(&mut auth, conn, Some(id), code, &mut actions)
                            }
                            (true, Ok(())) => actions.push(Action::Apply {
                                conn,
                                request: id,
                                command,
                            }),
                        }
                        self.set_stage(conn, Stage::InSession(auth));
                    }
                    Message::Catalog { id, query } => {
                        let allowed = self.conn_token(conn, now);
                        match (allowed, query.validate()) {
                            (false, _) => error(
                                &mut auth,
                                conn,
                                Some(id),
                                ErrorCode::RateLimited,
                                &mut actions,
                            ),
                            (true, None) => {
                                error(&mut auth, conn, Some(id), ErrorCode::Invalid, &mut actions)
                            }
                            (true, Some(query)) => actions.push(Action::Catalog {
                                conn,
                                request: id,
                                query,
                            }),
                        }
                        self.set_stage(conn, Stage::InSession(auth));
                    }
                    Message::Ping => {
                        send(&mut auth, conn, &Message::Pong, &mut actions);
                        self.set_stage(conn, Stage::InSession(auth));
                    }
                    Message::Closed { .. } => {
                        if let Some(id) = self.sessions.by_conn(conn).map(|s| s.id.clone()) {
                            self.sessions.end(&id);
                        }
                        actions.push(self.sessions_changed());
                        self.close(conn, None, &mut actions);
                    }
                    other => {
                        reply_error(&mut auth, conn, &other, &mut actions);
                        self.set_stage(conn, Stage::InSession(auth));
                    }
                }
            }
            Stage::Closed => {}
        }
        actions
    }

    fn conn_token(&mut self, conn: ConnId, now: Instant) -> bool {
        self.conns.get_mut(&conn).is_some_and(|c| c.take_token(now))
    }

    fn set_stage(&mut self, conn: ConnId, stage: Stage) {
        if let Some(c) = self.conns.get_mut(&conn) {
            c.stage = stage;
        }
    }

    fn request_control(
        &mut self,
        conn: ConnId,
        mut auth: Authenticated,
        resume: Option<String>,
        now: Instant,
        actions: &mut Vec<Action>,
    ) {
        // A session that dropped a moment ago comes back without asking.
        // It isn't a new connection, so being undiscoverable doesn't stop it,
        // but Never allow ended every session already.
        if let Some(id) = resume
            && let Ok(old) = self.sessions.resume(&id, &auth.peer.id, conn, now)
        {
            if let Some(old) = old {
                self.close(old, Some(CloseReason::Cancelled), actions);
            }
            let state = self.versioned();
            send(
                &mut auth,
                conn,
                &Message::Accepted {
                    session_id: id,
                    state,
                },
                actions,
            );
            self.set_stage(conn, Stage::InSession(auth));
            actions.push(self.sessions_changed());
            return;
        }
        match self.settings.decide() {
            Decision::Reject(reason) => {
                self.set_stage(conn, Stage::Ready(auth));
                self.close(conn, Some(reason), actions);
            }
            Decision::Accept => self.start_session(conn, auth, now, actions),
            Decision::Ask => {
                match self.consent.submit(
                    now,
                    conn,
                    auth.peer.clone(),
                    auth.code,
                    RequestKind::Control,
                ) {
                    Err(reason) => {
                        self.set_stage(conn, Stage::Ready(auth));
                        self.close(conn, Some(reason), actions);
                    }
                    Ok((request, replaced)) => {
                        let expires_in = super::consent::CONSENT_TIMEOUT.as_secs() as u32;
                        send(&mut auth, conn, &Message::Pending { expires_in }, actions);
                        self.set_stage(conn, Stage::Waiting(auth, request));
                        for resolved in replaced {
                            self.close(
                                resolved.request.conn,
                                Some(CloseReason::Cancelled),
                                actions,
                            );
                        }
                        self.sync_prompt(actions);
                    }
                }
            }
        }
    }

    fn start_session(
        &mut self,
        conn: ConnId,
        mut auth: Authenticated,
        now: Instant,
        actions: &mut Vec<Action>,
    ) {
        match self.sessions.open(auth.peer.clone(), conn, now) {
            Err(reason) => {
                self.set_stage(conn, Stage::Ready(auth));
                self.close(conn, Some(reason), actions);
            }
            Ok((session, old)) => {
                // A device that had a session got a new one. Its old
                // connection, if it still has one, mustn't keep control.
                if let Some(old) = old {
                    self.close(old, Some(CloseReason::Cancelled), actions);
                }
                let state = self.versioned();
                send(
                    &mut auth,
                    conn,
                    &Message::Accepted {
                        session_id: session.id,
                        state,
                    },
                    actions,
                );
                self.set_stage(conn, Stage::InSession(auth));
                actions.push(self.sessions_changed());
            }
        }
    }

    /// The user answered the dialog.
    pub fn answer(&mut self, request: RequestId, answer: Answer, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Some(resolved) = self.consent.answer(request, answer, now) {
            self.resolve(resolved, now, &mut actions);
        }
        self.sync_prompt(&mut actions);
        actions
    }

    fn resolve(&mut self, resolved: Resolved, now: Instant, actions: &mut Vec<Action>) {
        let conn = resolved.request.conn;
        match resolved.outcome {
            Outcome::Granted => {
                let Some(c) = self.conns.get_mut(&conn) else {
                    return;
                };
                if let Stage::Waiting(auth, _) = std::mem::replace(&mut c.stage, Stage::Closed) {
                    self.start_session(conn, auth, now, actions);
                }
            }
            Outcome::Refused(reason) => self.close(conn, Some(reason), actions),
        }
    }

    /// Shows the request at the front of the queue, if it isn't already.
    fn sync_prompt(&mut self, actions: &mut Vec<Action>) {
        let front = self.consent.showing().map(|r| r.id);
        if front == self.shown {
            return;
        }
        if let Some(old) = self.shown.take() {
            actions.push(Action::HideConsent(old));
        }
        if let Some(r) = self.consent.showing() {
            actions.push(Action::ShowConsent(ConsentPrompt {
                request: r.id,
                device_id: r.peer.id.clone(),
                name: r.peer.name.clone(),
                device_type: r.peer.device_type,
                code: r.code.to_string(),
                expires_at: r.expires_at,
            }));
        }
        self.shown = front;
    }

    /// The user on the target disconnected a controller.
    pub fn disconnect(&mut self, session_id: &str) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Some(session) = self.sessions.end(session_id) {
            if let Some(conn) = session.conn {
                self.close(conn, Some(CloseReason::Revoked), &mut actions);
            }
            actions.push(self.sessions_changed());
        }
        actions
    }

    /// The settings changed. Never allow ends every session at once. Turning
    /// discovery off refuses the requests still waiting, and leaves open
    /// sessions alone.
    pub fn update_settings(&mut self, settings: RemoteSettings, _now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        let before = self.discovery_record();
        let was_never = self.settings.remote_control == ControlMode::Never;
        let was_discoverable = self.settings.discoverable;
        self.settings = settings;
        if self.settings.remote_control == ControlMode::Never && !was_never {
            for resolved in self.consent.refuse_all(CloseReason::NotAllowed) {
                self.close(
                    resolved.request.conn,
                    Some(CloseReason::NotAllowed),
                    &mut actions,
                );
            }
            let ended = self.sessions.end_all();
            for session in &ended {
                if let Some(conn) = session.conn {
                    self.close(conn, Some(CloseReason::Revoked), &mut actions);
                }
            }
            if !ended.is_empty() {
                actions.push(self.sessions_changed());
            }
        }
        if !self.settings.discoverable && was_discoverable {
            for resolved in self.consent.refuse_all(CloseReason::NotDiscoverable) {
                self.close(
                    resolved.request.conn,
                    Some(CloseReason::NotDiscoverable),
                    &mut actions,
                );
            }
        }
        self.sync_prompt(&mut actions);
        let after = self.discovery_record();
        if after != before {
            actions.push(Action::Advertise(after));
        }
        actions
    }

    /// The player's state, whenever it's read. The target sends it on when
    /// something changed, when the position moved more than playing would
    /// explain, and every [`STATE_REFRESH`] while playing.
    pub fn set_state(&mut self, state: PlaybackSnapshot, now: Instant) -> Vec<Action> {
        let changed = {
            let mut old = self.state.clone();
            old.position = state.position;
            old != state
        };
        let due = match self.last_sent {
            None => true,
            Some((at, position)) => {
                let elapsed = now.duration_since(at);
                let expected = if self.state.status == PlaybackStatus::Playing {
                    position + elapsed.as_secs_f64()
                } else {
                    position
                };
                (state.position - expected).abs() > POSITION_JUMP
                    || (state.status == PlaybackStatus::Playing && elapsed >= STATE_REFRESH)
            }
        };
        self.state = state;
        if !changed && !due {
            return Vec::new();
        }
        self.broadcast(now)
    }

    fn broadcast(&mut self, now: Instant) -> Vec<Action> {
        self.version += 1;
        self.last_sent = Some((now, self.state.position));
        let message = Message::State(self.versioned());
        let mut actions = Vec::new();
        for (&conn, c) in self.conns.iter_mut() {
            if let Stage::InSession(auth) = &mut c.stage {
                send(auth, conn, &message, &mut actions);
            }
        }
        actions
    }

    fn versioned(&self) -> VersionedState {
        VersionedState {
            epoch: self.epoch.clone(),
            version: self.version,
            state: self.state.clone(),
        }
    }

    /// The player carried out a command, or couldn't.
    pub fn finish_command(
        &mut self,
        conn: ConnId,
        request: u64,
        result: Result<(), ErrorCode>,
    ) -> Vec<Action> {
        let mut actions = Vec::new();
        let version = self.version;
        if let Some(Conn {
            stage: Stage::InSession(auth),
            ..
        }) = self.conns.get_mut(&conn)
        {
            let reply = match result {
                Ok(()) => Message::Ok {
                    re: request,
                    version,
                },
                Err(code) => Message::Error {
                    re: Some(request),
                    code,
                },
            };
            send(auth, conn, &reply, &mut actions);
        }
        actions
    }

    /// The answer to a catalog query. A page that doesn't fit in a frame is
    /// cut short, and its `next` points at the first item left out.
    pub fn finish_catalog(
        &mut self,
        conn: ConnId,
        request: u64,
        result: Result<(Vec<CatalogItem>, Option<String>), ErrorCode>,
    ) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Some(Conn {
            stage: Stage::InSession(auth),
            ..
        }) = self.conns.get_mut(&conn)
        {
            let reply = match result {
                Ok((items, next)) => fit_page(request, items, next),
                Err(code) => Message::Error {
                    re: Some(request),
                    code,
                },
            };
            send(auth, conn, &reply, &mut actions);
        }
        actions
    }

    /// The controllers, connected or waiting to resume.
    pub fn sessions(&self) -> Vec<SessionInfo> {
        self.sessions.list().iter().map(session_info).collect()
    }

    fn sessions_changed(&self) -> Action {
        Action::SessionsChanged(self.sessions())
    }

    /// Time passed. Ends handshakes that took too long, connections that
    /// went quiet, requests no one answered and sessions that didn't resume.
    pub fn tick(&mut self, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        let stale: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, c)| match c.stage {
                Stage::Handshake(_) | Stage::Ready(_) => {
                    now.duration_since(c.opened) >= HANDSHAKE_TIMEOUT
                }
                Stage::Waiting(..) => false,
                _ => now.duration_since(c.last_heard) >= IDLE_TIMEOUT,
            })
            .map(|(&conn, _)| conn)
            .collect();
        let mut sessions_changed = false;
        for conn in stale {
            if self.sessions.detach(conn, now).is_some() {
                sessions_changed = true;
            }
            self.close(conn, Some(CloseReason::Timeout), &mut actions);
        }
        for resolved in self.consent.expire(now) {
            self.resolve(resolved, now, &mut actions);
        }
        self.sync_prompt(&mut actions);
        if !self.sessions.expire(now).is_empty() {
            sessions_changed = true;
        }
        if sessions_changed {
            actions.push(self.sessions_changed());
        }
        actions
    }

    /// When [`Target::tick`] next has something to do.
    pub fn next_deadline(&self) -> Option<Instant> {
        let conns = self.conns.values().filter_map(|c| match c.stage {
            Stage::Handshake(_) | Stage::Ready(_) => Some(c.opened + HANDSHAKE_TIMEOUT),
            Stage::InSession(_) => Some(c.last_heard + IDLE_TIMEOUT),
            _ => None,
        });
        conns
            .chain(self.consent.next_deadline())
            .chain(self.sessions.next_deadline())
            .min()
    }

    /// The app is quitting or resetting its identity. Every connection ends.
    pub fn shutdown(&mut self) -> Vec<Action> {
        let mut actions = Vec::new();
        self.consent.refuse_all(CloseReason::Shutdown);
        let had_sessions = !self.sessions.end_all().is_empty();
        let conns: Vec<ConnId> = self.conns.keys().copied().collect();
        for conn in conns {
            self.close(conn, Some(CloseReason::Shutdown), &mut actions);
        }
        self.sync_prompt(&mut actions);
        if had_sessions {
            actions.push(self.sessions_changed());
        }
        actions.push(Action::Advertise(None));
        actions
    }

    /// Tells the other side why, if the channel is up, and closes.
    fn close(&mut self, conn: ConnId, reason: Option<CloseReason>, actions: &mut Vec<Action>) {
        let Some(mut c) = self.conns.remove(&conn) else {
            return;
        };
        if let Some(reason) = reason
            && let Stage::Ready(auth) | Stage::Waiting(auth, _) | Stage::InSession(auth) =
                &mut c.stage
        {
            send(auth, conn, &Message::Closed { reason }, actions);
        }
        actions.push(Action::Close { conn });
    }

    /// Closes without a word, for a connection that broke the protocol.
    fn drop_conn(&mut self, conn: ConnId, actions: &mut Vec<Action>) {
        self.conns.remove(&conn);
        actions.push(Action::Close { conn });
    }
}

fn session_info(session: &Session) -> SessionInfo {
    SessionInfo {
        session_id: session.id.clone(),
        device_id: session.peer.id.clone(),
        name: session.peer.name.clone(),
        device_type: session.peer.device_type,
        connected: session.conn.is_some(),
    }
}

/// What reading a frame gave.
enum Opened {
    Message(Box<Message>),
    /// A message of an unknown type or with bad fields, already answered.
    Answered,
    /// The frame didn't decrypt or wasn't a message. The connection closes.
    Broken,
}

fn open(auth: &mut Authenticated, conn: ConnId, frame: &[u8], actions: &mut Vec<Action>) -> Opened {
    let Ok(plain) = auth.channel.open(frame) else {
        return Opened::Broken;
    };
    match message::decode(&plain) {
        Ok(message) => Opened::Message(Box::new(message)),
        Err(DecodeError::UnknownType { id }) => {
            error(auth, conn, id, ErrorCode::Unsupported, actions);
            Opened::Answered
        }
        Err(DecodeError::Invalid { id }) => {
            error(auth, conn, id, ErrorCode::Invalid, actions);
            Opened::Answered
        }
        Err(DecodeError::Version(_)) => {
            send(
                auth,
                conn,
                &Message::Closed {
                    reason: CloseReason::Version,
                },
                actions,
            );
            Opened::Broken
        }
        Err(DecodeError::Malformed) => Opened::Broken,
    }
}

fn send(auth: &mut Authenticated, conn: ConnId, message: &Message, actions: &mut Vec<Action>) {
    // Every message the target builds fits in a frame; catalog pages are
    // cut to fit before they get here.
    if let Ok(bytes) = auth.channel.seal(message) {
        actions.push(Action::Send { conn, bytes });
    }
}

fn error(
    auth: &mut Authenticated,
    conn: ConnId,
    re: Option<u64>,
    code: ErrorCode,
    actions: &mut Vec<Action>,
) {
    send(auth, conn, &Message::Error { re, code }, actions);
}

/// Answers a message that isn't valid at this point.
fn reply_error(
    auth: &mut Authenticated,
    conn: ConnId,
    message: &Message,
    actions: &mut Vec<Action>,
) {
    match message {
        Message::Command { id, .. } | Message::Catalog { id, .. } => {
            error(auth, conn, Some(*id), ErrorCode::Unsupported, actions)
        }
        _ => error(auth, conn, None, ErrorCode::Unsupported, actions),
    }
}

/// A catalog page cut to fit in one frame.
fn fit_page(request: u64, mut items: Vec<CatalogItem>, next: Option<String>) -> Message {
    items.truncate(super::catalog::MAX_PAGE);
    let page = |items: Vec<CatalogItem>, next| Message::CatalogPage {
        re: request,
        items,
        next,
    };
    let whole = page(items.clone(), next.clone());
    if message::encode(&whole).len() <= message::MAX_MESSAGE {
        return whole;
    }
    // Halve until it fits. The cursor for the rest is the first item left
    // out, which the app's paging reads as "start here".
    // An empty page would point back at the item that didn't fit, and the
    // controller would ask for it forever, so the page keeps at least one.
    let mut keep = items.len();
    while keep > 1 {
        keep /= 2;
        let rest = items.get(keep).map(|item| item.id.clone());
        let candidate = page(items[..keep].to_vec(), rest);
        if message::encode(&candidate).len() <= message::MAX_MESSAGE {
            return candidate;
        }
    }
    Message::Error {
        re: Some(request),
        code: ErrorCode::Failed,
    }
}

/// Checks a command against what the target is playing and can do.
pub fn validate(command: &Command, state: &PlaybackSnapshot) -> Result<(), ErrorCode> {
    let caps = &state.capabilities;
    let id_ok = |id: &str| !id.is_empty() && id.len() <= MAX_ID_BYTES;
    let current = |item_id: &str| -> Result<(), ErrorCode> {
        if !id_ok(item_id) {
            return Err(ErrorCode::Invalid);
        }
        match &state.item {
            Some(item) if item.id == item_id => Ok(()),
            _ => Err(ErrorCode::StaleItem),
        }
    };
    let require = |supported: bool| {
        if supported {
            Ok(())
        } else {
            Err(ErrorCode::Unsupported)
        }
    };
    match command {
        Command::Load { item_id, start_at } => {
            if !id_ok(item_id) {
                return Err(ErrorCode::Invalid);
            }
            if let Some(at) = start_at {
                if !at.is_finite() || *at < 0.0 {
                    return Err(ErrorCode::Invalid);
                }
                require(caps.resume_at)?;
            }
            Ok(())
        }
        Command::Play { item_id } | Command::Pause { item_id } => {
            current(item_id)?;
            require(caps.pause)
        }
        Command::Seek { item_id, to, by } => {
            match (to, by) {
                (Some(to), None) if to.is_finite() && *to >= 0.0 => {}
                (None, Some(by)) if by.is_finite() && by.abs() <= MAX_SEEK_BY => {}
                _ => return Err(ErrorCode::Invalid),
            }
            current(item_id)?;
            require(caps.seek)
        }
        Command::Volume { value } => {
            if *value > 100 {
                return Err(ErrorCode::Invalid);
            }
            require(caps.volume)
        }
        Command::Subtitle { item_id, track_id } => {
            current(item_id)?;
            require(caps.subtitles)?;
            match track_id {
                Some(id) if !state.subtitles.iter().any(|t| t.id == *id) => {
                    Err(ErrorCode::NotFound)
                }
                _ => Ok(()),
            }
        }
        Command::Audio { item_id, track_id } => {
            current(item_id)?;
            require(caps.audio_tracks)?;
            if state.audio.iter().any(|t| t.id == *track_id) {
                Ok(())
            } else {
                Err(ErrorCode::NotFound)
            }
        }
        Command::Stop => Ok(()),
    }
}

// `target/` is ignored as Cargo's build folder, so the tests sit beside
// this file rather than in `target/tests.rs`.
#[cfg(test)]
#[path = "target_tests.rs"]
mod tests;
