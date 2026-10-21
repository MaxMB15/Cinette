// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! One connection to a Cast receiver, from the first `CONNECT` to the end.
//!
//! The platform layer opens the TLS connection, passes in what it reads and
//! the time, sends the frames that come back, and calls [`Session::tick`]
//! about once a second. A dropped connection ends the session. The platform
//! layer then opens a new connection with [`Session::rejoin`], which picks
//! the same receiver app back up without loading anything again.

use std::fmt;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::frame::{CastMessage, FrameError, FrameReader, Payload};
use super::message::{
    self, Application, Incoming, LoadRequest, MediaInfo, MediaStatusEntry, MediaTrack,
    ReceiverStatus, COMMAND_PAUSE, COMMAND_SEEK, DEFAULT_MEDIA_RECEIVER, NS_CONNECTION,
    NS_HEARTBEAT, NS_MEDIA, NS_RECEIVER, PLATFORM,
};

/// How often the sender pings the receiver.
pub const PING_INTERVAL: Duration = Duration::from_secs(5);
/// Nothing received for this long means the connection dropped.
pub const SILENCE_LIMIT: Duration = Duration::from_secs(10);
/// How long the receiver gets to start the Default Media Receiver.
pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a `LOAD` gets before it counts as failed.
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the sender asks for the media status while something plays.
/// The receiver only reports changes, so positions would drift otherwise.
pub const STATUS_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
pub enum CloseReason {
    /// The sender stopped the cast.
    Stopped,
    /// The receiver app is gone: the TV's back or home button, another
    /// sender's app, or the receiver closing the connection to it.
    AppStopped,
    /// The receiver couldn't start the Default Media Receiver.
    LaunchFailed(Option<String>),
    /// Nothing came from the receiver for [`SILENCE_LIMIT`].
    Timeout,
    /// The receiver sent something that isn't a valid frame.
    Protocol(FrameError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleReason {
    Finished,
    Cancelled,
    Interrupted,
    Error,
    /// Idle with no reason given, before anything has loaded.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerState {
    Idle(IdleReason),
    Buffering,
    Playing,
    Paused,
}

/// The receiver's media, with what earlier statuses said filled in where
/// the latest one left it out.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaState {
    pub media_session_id: i64,
    pub player: PlayerState,
    /// Seconds, as of when the status arrived.
    pub current_time: f64,
    pub duration: Option<f64>,
    pub live: bool,
    pub can_pause: bool,
    pub can_seek: bool,
    pub tracks: Vec<MediaTrack>,
    pub active_track_ids: Vec<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Volume {
    /// 0 to 1.
    pub level: f64,
    pub muted: bool,
    /// The TV sets the volume, so the sender can't.
    pub fixed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The Default Media Receiver runs and this connection reaches it.
    /// Keep `session_id` to rejoin after a dropped connection.
    Ready {
        session_id: String,
    },
    Volume(Volume),
    /// The media status. `None` when nothing is loaded.
    Media(Option<MediaState>),
    /// The `LOAD` failed, or got no answer in [`LOAD_TIMEOUT`] (no code).
    LoadFailed {
        detailed_error_code: Option<i64>,
    },
    /// Playback failed after it started.
    PlaybackError {
        detailed_error_code: Option<i64>,
    },
    /// The receiver turned down a command.
    Rejected {
        request_id: u64,
        reason: Option<String>,
    },
    /// The session is over. Close the connection.
    Closed(CloseReason),
}

/// What to send, then what happened.
#[derive(Default, PartialEq)]
pub struct Output {
    pub send: Vec<Vec<u8>>,
    pub events: Vec<Event>,
}

/// The frames' sizes only. A `LOAD` frame holds the stream's URL, which
/// carries the login.
impl fmt::Debug for Output {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sizes: Vec<usize> = self.send.iter().map(Vec::len).collect();
        f.debug_struct("Output")
            .field("send_sizes", &sizes)
            .field("events", &self.events)
            .finish()
    }
}

/// Why a command can't be sent now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CommandError {
    #[error("the receiver app isn't ready yet")]
    NotReady,
    #[error("nothing is loaded on the receiver")]
    NoMedia,
    #[error("the cast has ended")]
    Closed,
}

enum Stage {
    /// Waiting for the first receiver status. `rejoin` is the session to
    /// pick back up, which must still be running.
    Connecting {
        rejoin: Option<String>,
        since: Instant,
    },
    Launching {
        since: Instant,
    },
    Ready {
        app: Application,
    },
    Closed,
}

pub struct Session {
    sender: String,
    stage: Stage,
    reader: FrameReader,
    next_request: u64,
    last_received: Instant,
    last_ping: Instant,
    last_poll: Instant,
    /// A load asked for before the app was ready.
    queued_load: Option<LoadRequest>,
    /// The load waiting for its first status.
    loading: Option<(u64, Instant)>,
    media: Option<MediaState>,
}

impl Session {
    /// Starts a cast. `sender` is this connection's source id, such as
    /// `sender-<random>`. Returns the frames to send first.
    pub fn start(sender: String, now: Instant) -> (Self, Vec<Vec<u8>>) {
        Self::open(sender, None, now)
    }

    /// Picks up `session_id` again on a new connection. If it isn't running
    /// any more, the session closes with [`CloseReason::AppStopped`].
    pub fn rejoin(sender: String, session_id: String, now: Instant) -> (Self, Vec<Vec<u8>>) {
        Self::open(sender, Some(session_id), now)
    }

    fn open(sender: String, rejoin: Option<String>, now: Instant) -> (Self, Vec<Vec<u8>>) {
        let mut session = Self {
            sender,
            stage: Stage::Connecting { rejoin, since: now },
            reader: FrameReader::default(),
            next_request: 0,
            last_received: now,
            last_ping: now,
            last_poll: now,
            queued_load: None,
            loading: None,
            media: None,
        };
        let connect = session.connect_to(PLATFORM);
        let status = session
            .request(PLATFORM, NS_RECEIVER, json!({ "type": "GET_STATUS" }))
            .1;
        (session, vec![connect, status])
    }

    pub fn is_closed(&self) -> bool {
        matches!(self.stage, Stage::Closed)
    }

    /// The receiver app's session id, once it's ready.
    pub fn session_id(&self) -> Option<&str> {
        match &self.stage {
            Stage::Ready { app } => Some(&app.session_id),
            _ => None,
        }
    }

    /// Bytes read from the connection.
    pub fn receive(&mut self, bytes: &[u8], now: Instant) -> Output {
        let mut out = Output::default();
        if self.is_closed() {
            return out;
        }
        self.last_received = now;
        self.reader.push(bytes);
        while let Some(message) = self.reader.next_message() {
            match message {
                Ok(message) => self.handle(message, now, &mut out),
                Err(e) => self.close(CloseReason::Protocol(e), &mut out),
            }
            if self.is_closed() {
                break;
            }
        }
        out
    }

    /// Heartbeats, status polls and timeouts. Call it about once a second.
    pub fn tick(&mut self, now: Instant) -> Output {
        let mut out = Output::default();
        if self.is_closed() {
            return out;
        }
        if now.duration_since(self.last_received) >= SILENCE_LIMIT {
            self.close(CloseReason::Timeout, &mut out);
            return out;
        }
        if let Stage::Launching { since } = self.stage
            && now.duration_since(since) >= LAUNCH_TIMEOUT
        {
            self.close(CloseReason::LaunchFailed(None), &mut out);
            return out;
        }
        // A receiver that answers heartbeats but never a usable status.
        if let Stage::Connecting { since, .. } = self.stage
            && now.duration_since(since) >= LAUNCH_TIMEOUT
        {
            self.close(CloseReason::Timeout, &mut out);
            return out;
        }
        if let Some((_, sent)) = self.loading
            && now.duration_since(sent) >= LOAD_TIMEOUT
        {
            self.loading = None;
            out.events.push(Event::LoadFailed {
                detailed_error_code: None,
            });
        }
        if now.duration_since(self.last_ping) >= PING_INTERVAL {
            self.last_ping = now;
            out.send
                .push(self.send(PLATFORM, NS_HEARTBEAT, json!({ "type": "PING" })));
        }
        let active = self
            .media
            .as_ref()
            .is_some_and(|m| matches!(m.player, PlayerState::Playing | PlayerState::Buffering));
        if active && now.duration_since(self.last_poll) >= STATUS_INTERVAL {
            self.last_poll = now;
            if let Stage::Ready { app } = &self.stage {
                let transport = app.transport_id.clone();
                out.send.push(
                    self.request(&transport, NS_MEDIA, json!({ "type": "GET_STATUS" }))
                        .1,
                );
            }
        }
        out
    }

    /// Loads `request` on the receiver, once the app is ready.
    pub fn load(&mut self, request: LoadRequest, now: Instant) -> Result<Output, CommandError> {
        let mut out = Output::default();
        match &self.stage {
            Stage::Closed => return Err(CommandError::Closed),
            Stage::Ready { .. } => self.send_load(request, now, &mut out),
            _ => self.queued_load = Some(request),
        }
        Ok(out)
    }

    pub fn play(&mut self) -> Result<(u64, Vec<u8>), CommandError> {
        self.media_command(json!({ "type": "PLAY" }))
    }

    pub fn pause(&mut self) -> Result<(u64, Vec<u8>), CommandError> {
        self.media_command(json!({ "type": "PAUSE" }))
    }

    /// Stops the media and keeps the app open, so the receiver lets go of
    /// the stream while the cast goes on.
    pub fn stop_media(&mut self) -> Result<(u64, Vec<u8>), CommandError> {
        self.media_command(json!({ "type": "STOP" }))
    }

    /// To an absolute position, in seconds.
    pub fn seek(&mut self, seconds: f64) -> Result<(u64, Vec<u8>), CommandError> {
        self.media_command(json!({ "type": "SEEK", "currentTime": seconds }))
    }

    /// The tracks to show, out of the media's own. Empty turns them all off.
    pub fn set_tracks(&mut self, active: &[i64]) -> Result<(u64, Vec<u8>), CommandError> {
        self.media_command(json!({ "type": "EDIT_TRACKS_INFO", "activeTrackIds": active }))
    }

    /// The receiver's volume, 0 to 1.
    pub fn set_volume(&mut self, level: f64) -> Result<(u64, Vec<u8>), CommandError> {
        match self.stage {
            Stage::Closed => Err(CommandError::Closed),
            _ => Ok(self.request(
                PLATFORM,
                NS_RECEIVER,
                json!({ "type": "SET_VOLUME", "volume": { "level": level.clamp(0.0, 1.0) } }),
            )),
        }
    }

    /// Ends the cast: stops the media, closes the receiver app so the TV
    /// goes back to what it showed, and ends the connection.
    pub fn stop(&mut self) -> Output {
        let mut out = Output::default();
        if let Stage::Ready { app } = &self.stage {
            let app = app.clone();
            if let Some(media) = &self.media {
                let stop = json!({ "type": "STOP", "mediaSessionId": media.media_session_id });
                out.send
                    .push(self.request(&app.transport_id, NS_MEDIA, stop).1);
            }
            let stop = json!({ "type": "STOP", "sessionId": app.session_id });
            out.send.push(self.request(PLATFORM, NS_RECEIVER, stop).1);
            out.send.push(self.close_to(&app.transport_id));
        }
        if !self.is_closed() {
            out.send.push(self.close_to(PLATFORM));
            self.close(CloseReason::Stopped, &mut out);
        }
        out
    }

    fn handle(&mut self, message: CastMessage, now: Instant, out: &mut Output) {
        if message.destination != self.sender && message.destination != "*" {
            return;
        }
        let Payload::Text(text) = &message.payload else {
            return;
        };
        let Some(incoming) = message::parse(&message.namespace, text) else {
            return;
        };
        // Media messages only count from the app's own transport.
        let from_app =
            matches!(&self.stage, Stage::Ready { app } if app.transport_id == message.source);
        match incoming {
            Incoming::Ping => {
                let pong = self.send(&message.source, NS_HEARTBEAT, json!({ "type": "PONG" }));
                out.send.push(pong);
            }
            Incoming::Close => {
                if message.source == PLATFORM || from_app {
                    self.close(CloseReason::AppStopped, out);
                }
            }
            Incoming::ReceiverStatus(status) if message.source == PLATFORM => {
                self.receiver_status(status, now, out)
            }
            Incoming::LaunchError { reason } if message.source == PLATFORM => {
                self.close(CloseReason::LaunchFailed(reason), out)
            }
            Incoming::MediaStatus {
                request_id,
                entries,
            } if from_app => self.media_status(request_id, entries, out),
            Incoming::LoadFailed {
                request_id,
                detailed_error_code,
            } if from_app => {
                if self.loading.is_some_and(|(id, _)| id == request_id) {
                    self.loading = None;
                    out.events.push(Event::LoadFailed {
                        detailed_error_code,
                    });
                }
            }
            Incoming::LoadCancelled { request_id } if from_app => {
                if self.loading.is_some_and(|(id, _)| id == request_id) {
                    self.loading = None;
                }
            }
            // The receiver turning the load down fails it at once.
            Incoming::Rejected { request_id, .. }
                if from_app && self.loading.is_some_and(|(id, _)| id == request_id) =>
            {
                self.loading = None;
                out.events.push(Event::LoadFailed {
                    detailed_error_code: None,
                });
            }
            Incoming::Rejected { request_id, reason } if from_app => {
                out.events.push(Event::Rejected { request_id, reason });
            }
            Incoming::Error {
                request_id,
                detailed_error_code,
            } if from_app && self.loading.is_some_and(|(id, _)| id == request_id) => {
                self.loading = None;
                out.events.push(Event::LoadFailed {
                    detailed_error_code,
                });
            }
            Incoming::Error {
                detailed_error_code,
                ..
            } if from_app => out.events.push(Event::PlaybackError {
                detailed_error_code,
            }),
            _ => {}
        }
    }

    fn receiver_status(&mut self, status: ReceiverStatus, now: Instant, out: &mut Output) {
        if let Some(v) = &status.volume {
            out.events.push(Event::Volume(Volume {
                level: v.level.unwrap_or(1.0),
                muted: v.muted.unwrap_or(false),
                fixed: v.control_type.as_deref() == Some("fixed"),
            }));
        }
        let running = status
            .applications
            .into_iter()
            .find(|a| a.app_id == DEFAULT_MEDIA_RECEIVER);
        match std::mem::replace(&mut self.stage, Stage::Closed) {
            Stage::Connecting { rejoin, .. } => match (running, rejoin) {
                (Some(app), None) => self.ready(app, now, out),
                (Some(app), Some(id)) if app.session_id == id => self.ready(app, now, out),
                (_, Some(_)) => self.close(CloseReason::AppStopped, out),
                (None, None) => {
                    self.stage = Stage::Launching { since: now };
                    let launch = json!({ "type": "LAUNCH", "appId": DEFAULT_MEDIA_RECEIVER });
                    out.send.push(self.request(PLATFORM, NS_RECEIVER, launch).1);
                }
            },
            Stage::Launching { since } => match running {
                Some(app) => self.ready(app, now, out),
                // The status from before the launch took effect.
                None => self.stage = Stage::Launching { since },
            },
            Stage::Ready { app } => match running {
                Some(now_running) if now_running.session_id == app.session_id => {
                    self.stage = Stage::Ready { app }
                }
                _ => self.close(CloseReason::AppStopped, out),
            },
            Stage::Closed => {}
        }
    }

    fn ready(&mut self, app: Application, now: Instant, out: &mut Output) {
        let transport = app.transport_id.clone();
        out.events.push(Event::Ready {
            session_id: app.session_id.clone(),
        });
        self.stage = Stage::Ready { app };
        out.send.push(self.connect_to(&transport));
        out.send.push(
            self.request(&transport, NS_MEDIA, json!({ "type": "GET_STATUS" }))
                .1,
        );
        if let Some(load) = self.queued_load.take() {
            self.send_load(load, now, out);
        }
    }

    fn send_load(&mut self, load: LoadRequest, now: Instant, out: &mut Output) {
        let Stage::Ready { app } = &self.stage else {
            return;
        };
        let transport = app.transport_id.clone();
        let id = self.take_request_id();
        out.send
            .push(self.send(&transport, NS_MEDIA, load.to_json(id)));
        self.loading = Some((id, now));
    }

    fn media_status(&mut self, request_id: u64, entries: Vec<MediaStatusEntry>, out: &mut Output) {
        let Some(entry) = entries.into_iter().next() else {
            self.media = None;
            out.events.push(Event::Media(None));
            return;
        };
        let player = player_state(&entry.player_state, entry.idle_reason.as_deref());
        // The answer to the load, or new media already under way. A status
        // about the media from before the load doesn't count.
        let new_media = self
            .media
            .as_ref()
            .is_none_or(|m| m.media_session_id != entry.media_session_id);
        // A reply to another request, such as the media `GET_STATUS` sent
        // on joining, describes the receiver from before the load.
        if self.loading.is_some_and(|(id, _)| id == request_id)
            || (request_id == 0
                && self.loading.is_some()
                && new_media
                && !matches!(player, PlayerState::Idle(_)))
        {
            self.loading = None;
        }
        // What the receiver left out stays as it was for the same media.
        let previous = self
            .media
            .take()
            .filter(|m| m.media_session_id == entry.media_session_id);
        let info = entry.media.clone().unwrap_or_else(|| MediaInfo {
            duration: previous.as_ref().and_then(|m| m.duration),
            stream_type: previous
                .as_ref()
                .map(|m| if m.live { "LIVE" } else { "BUFFERED" }.to_string()),
            tracks: previous
                .as_ref()
                .map(|m| m.tracks.clone())
                .unwrap_or_default(),
        });
        let live = info.stream_type.as_deref() == Some("LIVE");
        let state = MediaState {
            media_session_id: entry.media_session_id,
            player,
            current_time: entry.current_time,
            // Live streams report a duration of -1 or none at all.
            duration: info.duration.filter(|d| *d > 0.0 && !live),
            live,
            can_pause: entry.supported_media_commands & COMMAND_PAUSE != 0,
            can_seek: entry.supported_media_commands & COMMAND_SEEK != 0,
            tracks: info.tracks,
            active_track_ids: entry
                .active_track_ids
                .or_else(|| previous.map(|m| m.active_track_ids))
                .unwrap_or_default(),
        };
        self.media = Some(state.clone());
        out.events.push(Event::Media(Some(state)));
    }

    fn media_command(&mut self, mut body: Value) -> Result<(u64, Vec<u8>), CommandError> {
        let transport = match &self.stage {
            Stage::Closed => return Err(CommandError::Closed),
            Stage::Ready { app } => app.transport_id.clone(),
            _ => return Err(CommandError::NotReady),
        };
        let media = self.media.as_ref().ok_or(CommandError::NoMedia)?;
        body["mediaSessionId"] = json!(media.media_session_id);
        Ok(self.request(&transport, NS_MEDIA, body))
    }

    fn close(&mut self, reason: CloseReason, out: &mut Output) {
        self.stage = Stage::Closed;
        self.queued_load = None;
        self.loading = None;
        out.events.push(Event::Closed(reason));
    }

    fn take_request_id(&mut self) -> u64 {
        self.next_request += 1;
        self.next_request
    }

    /// A message with the next request id, which the answer echoes.
    fn request(&mut self, to: &str, namespace: &str, mut body: Value) -> (u64, Vec<u8>) {
        let id = self.take_request_id();
        body["requestId"] = json!(id);
        (id, self.send(to, namespace, body))
    }

    fn send(&self, to: &str, namespace: &str, body: Value) -> Vec<u8> {
        CastMessage::text(&self.sender, to, namespace, body.to_string()).encode()
    }

    fn connect_to(&self, to: &str) -> Vec<u8> {
        self.send(
            to,
            NS_CONNECTION,
            json!({ "type": "CONNECT", "connType": 0 }),
        )
    }

    fn close_to(&self, to: &str) -> Vec<u8> {
        self.send(to, NS_CONNECTION, json!({ "type": "CLOSE" }))
    }
}

fn player_state(state: &str, idle_reason: Option<&str>) -> PlayerState {
    match state {
        "PLAYING" => PlayerState::Playing,
        "PAUSED" => PlayerState::Paused,
        // LOADING is what newer receivers send between LOAD and BUFFERING.
        "BUFFERING" | "LOADING" => PlayerState::Buffering,
        _ => PlayerState::Idle(match idle_reason {
            Some("FINISHED") => IdleReason::Finished,
            Some("CANCELLED") => IdleReason::Cancelled,
            Some("INTERRUPTED") => IdleReason::Interrupted,
            Some("ERROR") => IdleReason::Error,
            _ => IdleReason::None,
        }),
    }
}
