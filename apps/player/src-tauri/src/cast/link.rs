// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Drives a Cast session over a connection: what the receiver sends goes to
//! the session, the session's frames go back, its heartbeats and timeouts
//! run once a second, and the app's commands go in between. Each thing the
//! session reports becomes a [`CastUpdate`] for the frontend.
//!
//! The loop works on any stream, so tests run it over plain TCP to a fake
//! receiver. The app wraps the TLS stream from [`super::tls`].

use std::time::{Duration, Instant};

use mvp_core::cast::message::LoadRequest;
use mvp_core::cast::session::{
    CloseReason, CommandError, Event, IdleReason, MediaState, Output, PlayerState, Session,
};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

/// How often the session's clock runs.
const TICK: Duration = Duration::from_secs(1);

/// What the app asks of the receiver.
#[derive(Debug)]
pub enum Command {
    Load(Box<LoadRequest>),
    Play,
    Pause,
    Seek(f64),
    /// 0 to 1.
    Volume(f64),
    /// Stops the media and keeps the cast, so the receiver lets go of the
    /// stream.
    StopMedia,
    /// Ends the cast and the connection.
    Stop,
}

/// The media as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaView {
    /// The receiver's id for this media, which a new load changes.
    pub media_session_id: i64,
    /// `idle`, `buffering`, `playing` or `paused`.
    pub player: &'static str,
    /// Why it's idle: `finished`, `cancelled`, `interrupted` or `error`.
    pub idle_reason: Option<&'static str>,
    /// Seconds, as of when the status arrived.
    pub position: f64,
    pub duration: Option<f64>,
    pub live: bool,
    pub can_pause: bool,
    pub can_seek: bool,
}

impl From<&MediaState> for MediaView {
    fn from(media: &MediaState) -> Self {
        let (player, idle_reason) = match media.player {
            PlayerState::Idle(reason) => (
                "idle",
                match reason {
                    IdleReason::Finished => Some("finished"),
                    IdleReason::Cancelled => Some("cancelled"),
                    IdleReason::Interrupted => Some("interrupted"),
                    IdleReason::Error => Some("error"),
                    IdleReason::None => None,
                },
            ),
            PlayerState::Buffering => ("buffering", None),
            PlayerState::Playing => ("playing", None),
            PlayerState::Paused => ("paused", None),
        };
        Self {
            media_session_id: media.media_session_id,
            player,
            idle_reason,
            position: media.current_time,
            duration: media.duration,
            live: media.live,
            can_pause: media.can_pause,
            can_seek: media.can_seek,
        }
    }
}

/// Something the receiver or the connection did, for the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CastUpdate {
    /// The Default Media Receiver runs and takes commands. `session_id` is
    /// the receiver app's session, which is new when the app was launched and
    /// the same when an app that ran was joined again.
    #[serde(rename_all = "camelCase")]
    Ready { session_id: String },
    #[serde(rename_all = "camelCase")]
    Volume {
        level: f64,
        muted: bool,
        fixed: bool,
    },
    /// `None` when nothing is loaded.
    Media { media: Option<MediaView> },
    /// The receiver couldn't load the stream, with its error code if it gave
    /// one.
    LoadFailed { code: Option<i64> },
    /// Playback failed after it started.
    PlaybackError { code: Option<i64> },
    /// The receiver turned a command down, or it couldn't be sent yet.
    Rejected { reason: Option<String> },
    /// The converter serving the receiver stopped with an error. `refused`
    /// when the provider answered 401 or 403.
    ConversionFailed { refused: bool },
    /// The converted stream has to start again: `dropped` when a live
    /// channel's connection ended, `moved` when this computer's address on
    /// the way to the receiver changed, as after a sleep on another network.
    ConversionStopped { why: &'static str },
    /// The cast is over. `reason` is `stopped`, `appStopped`, `launchFailed`,
    /// `timeout`, `protocol` or `connectionLost`.
    Closed { reason: &'static str },
}

impl From<Event> for CastUpdate {
    fn from(event: Event) -> Self {
        match event {
            Event::Ready { session_id } => CastUpdate::Ready { session_id },
            Event::Volume(v) => CastUpdate::Volume {
                level: v.level,
                muted: v.muted,
                fixed: v.fixed,
            },
            Event::Media(media) => CastUpdate::Media {
                media: media.as_ref().map(MediaView::from),
            },
            Event::LoadFailed {
                detailed_error_code,
            } => CastUpdate::LoadFailed {
                code: detailed_error_code,
            },
            Event::PlaybackError {
                detailed_error_code,
            } => CastUpdate::PlaybackError {
                code: detailed_error_code,
            },
            Event::Rejected { reason, .. } => CastUpdate::Rejected { reason },
            Event::Closed(reason) => CastUpdate::Closed {
                reason: match reason {
                    CloseReason::Stopped => "stopped",
                    CloseReason::AppStopped => "appStopped",
                    CloseReason::LaunchFailed(_) => "launchFailed",
                    CloseReason::Timeout => "timeout",
                    CloseReason::Protocol(_) => "protocol",
                },
            },
        }
    }
}

/// Runs the cast until it closes, the connection drops, or the commands'
/// sender is dropped, which stops it. `first` are the frames
/// [`Session::start`] returned. Every update goes to `emit`, and the last
/// one is always [`CastUpdate::Closed`]. Returns the receiver app's session
/// id the cast joined, if it got that far, so a new connection can rejoin
/// or stop that app.
pub async fn drive<S>(
    mut stream: S,
    mut session: Session,
    first: Vec<Vec<u8>>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    mut emit: impl FnMut(CastUpdate),
) -> Option<String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut out = Output {
        send: first,
        events: Vec::new(),
    };
    // The receiver app's session the cast joined, which a new connection
    // can find again.
    let mut joined = None;
    let mut ticks = tokio::time::interval(TICK);
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        for frame in out.send.drain(..) {
            if stream.write_all(&frame).await.is_err() {
                emit(CastUpdate::Closed {
                    reason: "connectionLost",
                });
                return joined;
            }
        }
        for event in out.events.drain(..) {
            if let Event::Ready { session_id } = &event {
                joined = Some(session_id.clone());
            }
            emit(event.into());
        }
        if session.is_closed() {
            let _ = stream.shutdown().await;
            return joined;
        }
        out = tokio::select! {
            read = stream.read(&mut buf) => match read {
                Ok(n) if n > 0 => session.receive(&buf[..n], Instant::now()),
                _ => {
                    emit(CastUpdate::Closed { reason: "connectionLost" });
                    return joined;
                }
            },
            _ = ticks.tick() => session.tick(Instant::now()),
            command = commands.recv() => {
                apply(&mut session, command.unwrap_or(Command::Stop), &mut emit)
            }
        };
    }
}

/// Sends `command` through the session. One the session can't send yet is
/// reported as rejected.
fn apply(session: &mut Session, command: Command, emit: &mut impl FnMut(CastUpdate)) -> Output {
    let now = Instant::now();
    let single = |sent: Result<(u64, Vec<u8>), CommandError>| {
        sent.map(|(_, frame)| Output {
            send: vec![frame],
            events: Vec::new(),
        })
    };
    let result = match command {
        Command::Load(request) => session.load(*request, now),
        Command::Play => single(session.play()),
        Command::Pause => single(session.pause()),
        Command::Seek(seconds) => single(session.seek(seconds)),
        Command::Volume(level) => single(session.set_volume(level)),
        Command::StopMedia => single(session.stop_media()),
        Command::Stop => Ok(session.stop()),
    };
    result.unwrap_or_else(|e| {
        emit(CastUpdate::Rejected {
            reason: Some(e.to_string()),
        });
        Output::default()
    })
}
