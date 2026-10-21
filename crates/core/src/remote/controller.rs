// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The device doing the controlling: one [`Controller`] per target it
//! connects to.
//!
//! It runs the handshake, asks for control, and keeps the newest state the
//! target sent. A state that isn't newer than the last one, by the target's
//! epoch and version, is dropped.
//!
//! It also keeps its own clock on getting in. A device in the middle could
//! hold the code on screen while it tries handshakes with the real target,
//! so a controller doesn't wait for the target past [`GIVE_UP_AFTER`],
//! whatever the target says.

use super::catalog::{CatalogItem, CatalogQuery};
use super::channel::Channel;
use super::consent::CONSENT_TIMEOUT;
use super::handshake::{ControllerHandshake, Next, Peer, VerificationCode};
use super::identity::{DeviceId, DeviceKey};
use super::message::{
    self, CloseReason, Command, DecodeError, ErrorCode, Feature, Hello, Message, VersionedState,
};
use super::target::HANDSHAKE_TIMEOUT;
use super::transfer::flow::{
    Asked, ControllerEvent, ControllerFlow, ControllerOut, Direction, ProviderName,
    ProviderSettings,
};
use super::transfer::merge::Report;
use super::transfer::{Counts, Export, What};
use std::time::{Duration, Instant};

/// How often a controller pings a quiet connection.
pub const PING_INTERVAL: Duration = Duration::from_secs(10);

/// How long after connecting a controller gives up if it isn't in: the
/// target's time for the handshake, then its time for the user to answer.
pub const GIVE_UP_AFTER: Duration =
    Duration::from_secs(HANDSHAKE_TIMEOUT.as_secs() + CONSENT_TIMEOUT.as_secs());

/// Something the controller's UI should know about.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The handshake is done. Show the code while the target decides.
    Verified { peer: Peer, code: VerificationCode },
    /// The target is asking its user, for this many seconds at most. It's
    /// never more than [`CONSENT_TIMEOUT`], whatever the target said.
    Pending { expires_in: u32 },
    /// Control was granted. `state` is what the target is playing now.
    Connected {
        session_id: String,
        state: VersionedState,
    },
    /// A newer state from the target.
    State(VersionedState),
    /// The answer to a command.
    Reply {
        request: u64,
        result: Result<u64, ErrorCode>,
    },
    /// The answer to a catalog query.
    Page {
        request: u64,
        items: Vec<CatalogItem>,
        next: Option<String>,
    },
    /// An error not tied to a request.
    Error(ErrorCode),
    /// Something about the transfer this controller asked for.
    Transfer(ControllerEvent),
    /// The connection ended. Close the socket. [`CloseReason::Timeout`]
    /// means the controller gave up on the target itself.
    Closed(CloseReason),
}

/// What reading a frame gave: bytes to send, then events for the UI.
#[derive(Debug, Default, PartialEq)]
pub struct Output {
    pub send: Vec<Vec<u8>>,
    pub events: Vec<Event>,
}

enum Stage {
    Handshake(ControllerHandshake),
    Requesting {
        channel: Channel,
        peer: Peer,
    },
    InSession {
        channel: Channel,
        peer: Peer,
        session_id: String,
    },
    Closed,
}

/// Not connected, so nothing can be sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("not connected")]
pub struct NotConnected;

/// Why a transfer can't be asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AskError {
    #[error("not connected")]
    NotConnected,
    /// The target's Cinette doesn't offer it.
    #[error("the other device doesn't offer this")]
    Unsupported,
    /// Another transfer is asked for or running.
    #[error("another transfer is going on")]
    Busy,
}

pub struct Controller {
    stage: Stage,
    /// When [`Controller::connect`] ran.
    opened: Instant,
    resume: Option<String>,
    next_request: u64,
    /// The epoch and version of the newest state applied.
    latest: Option<(String, u64)>,
    /// The transfer asked for or running.
    flow: Option<ControllerFlow>,
}

impl Controller {
    /// Starts connecting to the device with id `target`, to resume
    /// `resume` if it's set. Returns the first frame to send. `now` starts
    /// the clock that [`Controller::tick`] gives up by.
    pub fn connect(
        key: &DeviceKey,
        hello: Hello,
        target: DeviceId,
        resume: Option<String>,
        now: Instant,
    ) -> Result<(Self, Vec<u8>), CloseReason> {
        let (handshake, first) =
            ControllerHandshake::start(key, hello, target).map_err(|f| f.reason)?;
        Ok((
            Self {
                stage: Stage::Handshake(handshake),
                opened: now,
                resume,
                next_request: 0,
                latest: None,
                flow: None,
            },
            first,
        ))
    }

    /// The session id, once control is granted. Keep it to resume after a
    /// dropped connection.
    pub fn session_id(&self) -> Option<&str> {
        match &self.stage {
            Stage::InSession { session_id, .. } => Some(session_id),
            _ => None,
        }
    }

    /// The target, once the handshake proved who it is.
    pub fn peer(&self) -> Option<&Peer> {
        match &self.stage {
            Stage::Requesting { peer, .. } | Stage::InSession { peer, .. } => Some(peer),
            _ => None,
        }
    }

    pub fn is_closed(&self) -> bool {
        matches!(self.stage, Stage::Closed)
    }

    /// One frame's contents from the connection, arrived at `now`.
    pub fn receive(&mut self, frame: &[u8], now: Instant) -> Output {
        let mut out = Output::default();
        match std::mem::replace(&mut self.stage, Stage::Closed) {
            Stage::Handshake(handshake) => match handshake.read(frame) {
                Ok((send, Next::Continue(handshake))) => {
                    out.send.extend(send);
                    self.stage = Stage::Handshake(handshake);
                }
                Ok((send, Next::Done(established))) => {
                    out.send.extend(send);
                    let mut channel = established.channel;
                    let request = Message::control_request(self.resume.clone());
                    match channel.seal(&request) {
                        Ok(bytes) => out.send.push(bytes),
                        Err(_) => return closed(out, CloseReason::Protocol),
                    }
                    out.events.push(Event::Verified {
                        peer: established.peer.clone(),
                        code: established.code,
                    });
                    self.stage = Stage::Requesting {
                        channel,
                        peer: established.peer,
                    };
                }
                Err(failure) => return closed(out, failure.reason),
            },
            Stage::Requesting { mut channel, peer } => {
                let message = match read(&mut channel, frame, &mut out) {
                    Ok(Some(message)) => message,
                    Ok(None) => {
                        self.stage = Stage::Requesting { channel, peer };
                        return out;
                    }
                    Err(()) => return closed(out, CloseReason::Protocol),
                };
                match message {
                    Message::Pending { expires_in, .. } => {
                        let most = CONSENT_TIMEOUT.as_secs() as u32;
                        out.events.push(Event::Pending {
                            expires_in: expires_in.min(most),
                        });
                        self.stage = Stage::Requesting { channel, peer };
                    }
                    Message::Accepted { session_id, state } => {
                        self.latest = Some((state.epoch.clone(), state.version));
                        self.resume = Some(session_id.clone());
                        out.events.push(Event::Connected {
                            session_id: session_id.clone(),
                            state,
                        });
                        self.stage = Stage::InSession {
                            channel,
                            peer,
                            session_id,
                        };
                    }
                    Message::Closed { reason } => return closed(out, reason),
                    other => {
                        handle_common(other, &mut out);
                        self.stage = Stage::Requesting { channel, peer };
                    }
                }
            }
            Stage::InSession {
                mut channel,
                peer,
                session_id,
            } => {
                let message = match read(&mut channel, frame, &mut out) {
                    Ok(Some(message)) => Some(message),
                    Ok(None) => None,
                    Err(()) => return closed(out, CloseReason::Protocol),
                };
                let message = match (message, self.flow.take()) {
                    (Some(message), Some(flow)) => {
                        let mut flow_out = ControllerOut::default();
                        match flow.receive(message, frame.len(), now, &mut flow_out) {
                            Ok(next) => {
                                self.flow = next;
                                seal_flow(&mut channel, flow_out, &mut out);
                                None
                            }
                            Err(back) => {
                                let (flow, message) = *back;
                                self.flow = Some(flow);
                                Some(message)
                            }
                        }
                    }
                    (message, flow) => {
                        self.flow = flow;
                        message
                    }
                };
                match message {
                    None => {}
                    Some(Message::State(state)) => {
                        if self.is_newer(&state) {
                            self.latest = Some((state.epoch.clone(), state.version));
                            out.events.push(Event::State(state));
                        }
                    }
                    Some(Message::Closed { reason }) => return closed(out, reason),
                    Some(other) => handle_common(other, &mut out),
                }
                self.stage = Stage::InSession {
                    channel,
                    peer,
                    session_id,
                };
            }
            Stage::Closed => {}
        }
        out
    }

    /// Time passed. Gives up on a target that hasn't finished the handshake
    /// within [`HANDSHAKE_TIMEOUT`] of connecting, or let the controller in
    /// within [`GIVE_UP_AFTER`]. Giving up withdraws the request, so send the
    /// bytes, then close the socket.
    pub fn tick(&mut self, now: Instant) -> Output {
        if self.next_deadline().is_none_or(|deadline| now < deadline) {
            return Output::default();
        }
        if let Stage::InSession { channel, .. } = &mut self.stage {
            let mut flow_out = ControllerOut::default();
            self.flow = self.flow.take().and_then(|f| f.tick(now, &mut flow_out));
            let mut out = Output::default();
            seal_flow(channel, flow_out, &mut out);
            return out;
        }
        let out = Output {
            send: self.leave().into_iter().collect(),
            events: Vec::new(),
        };
        self.stage = Stage::Closed;
        closed(out, CloseReason::Timeout)
    }

    /// When [`Controller::tick`] next has something to do: never once the
    /// controller is in or closed.
    pub fn next_deadline(&self) -> Option<Instant> {
        match self.stage {
            Stage::Handshake(_) => Some(self.opened + HANDSHAKE_TIMEOUT),
            Stage::Requesting { .. } => Some(self.opened + GIVE_UP_AFTER),
            Stage::InSession { .. } => self.flow.as_ref().and_then(ControllerFlow::deadline),
            Stage::Closed => None,
        }
    }

    /// A state is newer when it has a higher version, or comes from a new
    /// start of the target app.
    fn is_newer(&self, state: &VersionedState) -> bool {
        match &self.latest {
            None => true,
            Some((epoch, version)) => *epoch != state.epoch || state.version > *version,
        }
    }

    fn channel(&mut self) -> Result<&mut Channel, NotConnected> {
        match &mut self.stage {
            Stage::InSession { channel, .. } => Ok(channel),
            _ => Err(NotConnected),
        }
    }

    fn request(
        &mut self,
        build: impl FnOnce(u64) -> Message,
    ) -> Result<(u64, Vec<u8>), NotConnected> {
        let id = self.next_request + 1;
        let bytes = self.channel()?.seal(&build(id)).map_err(|_| NotConnected)?;
        self.next_request = id;
        Ok((id, bytes))
    }

    /// Seals any message, for tests that send what a controller wouldn't.
    #[cfg(test)]
    pub(crate) fn seal_raw(&mut self, message: &Message) -> Result<Vec<u8>, NotConnected> {
        match &mut self.stage {
            Stage::Requesting { channel, .. } | Stage::InSession { channel, .. } => {
                channel.seal(message).map_err(|_| NotConnected)
            }
            _ => Err(NotConnected),
        }
    }

    /// Sends a playback command. The id comes back in [`Event::Reply`].
    pub fn command(&mut self, command: Command) -> Result<(u64, Vec<u8>), NotConnected> {
        self.request(|id| Message::Command { id, command })
    }

    /// Asks for part of the target's catalog. The id comes back in
    /// [`Event::Page`].
    pub fn catalog(&mut self, query: CatalogQuery) -> Result<(u64, Vec<u8>), NotConnected> {
        self.request(|id| Message::Catalog { id, query })
    }

    /// Asks for a transfer of history. With [`Direction::Send`], `counts`
    /// are this device's own, for the target's dialog. The answer comes as
    /// [`Event::Transfer`].
    pub fn ask_history(
        &mut self,
        direction: Direction,
        what: What,
        counts: Option<Counts>,
    ) -> Result<Vec<u8>, AskError> {
        self.ask(
            Feature::History,
            Asked::History {
                direction,
                what,
                counts: counts.filter(|_| direction == Direction::Send),
            },
        )
    }

    /// Asks to send the named providers. Once allowed,
    /// [`ControllerEvent::ProvidersGranted`] asks for their settings.
    pub fn ask_providers(&mut self, providers: Vec<ProviderName>) -> Result<Vec<u8>, AskError> {
        self.ask(Feature::Providers, Asked::Providers(providers))
    }

    fn ask(&mut self, feature: Feature, asked: Asked) -> Result<Vec<u8>, AskError> {
        let Stage::InSession { peer, .. } = &self.stage else {
            return Err(AskError::NotConnected);
        };
        if !peer.features.contains(&feature) {
            return Err(AskError::Unsupported);
        }
        if self.flow.is_some() {
            return Err(AskError::Busy);
        }
        let (id, bytes) = self
            .request(|id| asked.request(id))
            .map_err(|_| AskError::NotConnected)?;
        self.flow = Some(ControllerFlow::Asking { id, asked });
        Ok(bytes)
    }

    /// Runs one step of the transfer and seals what it sends.
    fn transfer(
        &mut self,
        f: impl FnOnce(ControllerFlow, &mut ControllerOut) -> Option<ControllerFlow>,
    ) -> Output {
        let mut out = Output::default();
        let Stage::InSession { channel, .. } = &mut self.stage else {
            return out;
        };
        let mut flow_out = ControllerOut::default();
        if let Some(flow) = self.flow.take() {
            self.flow = f(flow, &mut flow_out);
        }
        seal_flow(channel, flow_out, &mut out);
        out
    }

    /// "Send": this device's export, after [`ControllerEvent::ExportNeeded`].
    pub fn send_export(
        &mut self,
        transfer: &str,
        export: Result<Export, ErrorCode>,
        now: Instant,
    ) -> Output {
        self.transfer(|flow, out| flow.send_export(transfer, export, now, out))
    }

    /// "Import": the user confirmed the preview.
    pub fn start_import(&mut self, transfer: &str, now: Instant) -> Output {
        self.transfer(|flow, out| flow.start_import(transfer, now, out))
    }

    /// "Import": what writing it here did.
    pub fn imported(&mut self, transfer: &str, result: Result<Report, ErrorCode>) -> Output {
        self.transfer(|flow, out| flow.imported(transfer, result, out))
    }

    /// Providers: their settings, after [`ControllerEvent::ProvidersGranted`].
    pub fn send_providers(
        &mut self,
        grant: &str,
        providers: Vec<ProviderSettings>,
        now: Instant,
    ) -> Output {
        self.transfer(|flow, out| flow.send_providers(grant, providers, now, out))
    }

    /// Stops the transfer asked for or running. Nothing is written.
    pub fn cancel_transfer(&mut self) -> Output {
        self.transfer(|flow, out| {
            flow.cancel(out);
            None
        })
    }

    /// A ping, to send when nothing else went out for [`PING_INTERVAL`].
    pub fn ping(&mut self) -> Option<Vec<u8>> {
        match &mut self.stage {
            Stage::Requesting { channel, .. } | Stage::InSession { channel, .. } => {
                channel.seal(&Message::Ping).ok()
            }
            _ => None,
        }
    }

    /// Stops asking, or leaves the session. The target keeps playing. Send
    /// the bytes, then close the socket.
    pub fn leave(&mut self) -> Option<Vec<u8>> {
        let message = match &self.stage {
            Stage::Requesting { .. } => Message::Cancel,
            Stage::InSession { .. } => Message::Closed {
                reason: CloseReason::Left,
            },
            _ => return None,
        };
        let bytes = match &mut self.stage {
            Stage::Requesting { channel, .. } | Stage::InSession { channel, .. } => {
                channel.seal(&message).ok()
            }
            _ => None,
        };
        self.stage = Stage::Closed;
        bytes
    }
}

/// Seals what a transfer step sends, and passes its events on.
fn seal_flow(channel: &mut Channel, flow_out: ControllerOut, out: &mut Output) {
    for message in flow_out.send {
        if let Ok(bytes) = channel.seal(&message) {
            out.send.push(bytes);
        }
    }
    out.events
        .extend(flow_out.events.into_iter().map(Event::Transfer));
}

fn closed(mut out: Output, reason: CloseReason) -> Output {
    out.events.push(Event::Closed(reason));
    out
}

/// Decrypts and reads a frame. `Ok(None)` is a message to skip, and `Err`
/// means the connection must close.
fn read(channel: &mut Channel, frame: &[u8], out: &mut Output) -> Result<Option<Message>, ()> {
    let plain = channel.open(frame).map_err(|_| ())?;
    match message::decode(&plain) {
        Ok(message) => Ok(Some(message)),
        // Something a newer target sends that this build doesn't know.
        Err(DecodeError::UnknownType { .. }) => Ok(None),
        Err(DecodeError::Invalid { .. }) => {
            out.events.push(Event::Error(ErrorCode::Invalid));
            Ok(None)
        }
        Err(DecodeError::Version(_) | DecodeError::Malformed) => Err(()),
    }
}

/// Replies and pongs, which can come at any point after the handshake.
fn handle_common(message: Message, out: &mut Output) {
    match message {
        Message::Ok { re, version } => out.events.push(Event::Reply {
            request: re,
            result: Ok(version),
        }),
        Message::Error { re: Some(re), code } => out.events.push(Event::Reply {
            request: re,
            result: Err(code),
        }),
        Message::Error { re: None, code } => out.events.push(Event::Error(code)),
        Message::CatalogPage { re, items, next } => out.events.push(Event::Page {
            request: re,
            items,
            next,
        }),
        // Pongs only show the connection is alive. Anything else isn't for
        // a controller and is ignored.
        _ => {}
    }
}

#[cfg(test)]
mod tests;
