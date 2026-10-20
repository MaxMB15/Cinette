// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Converts a stream with the bundled ffmpeg and serves it to one receiver
//! on the local network, through [`crate::lan_server`], for as long as the
//! cast lasts.
//!
//! - The provider's URL and login stay with ffmpeg. The receiver only ever
//!   sees this computer's address.
//! - The computer stays awake while ffmpeg runs, as it does for recordings.
//! - Dropping the [`Conversion`] stops ffmpeg and the server.

// The Cast destination starts conversions from the next step on.
#![cfg_attr(not(test), allow(dead_code))]

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mvp_core::convert::mkv::{MkvSplitter, Piece};
use mvp_core::convert::{args, unsupported, Encoders, NoEncoder, Plan};
use mvp_core::streams::probe::{open_error, ProbeError};
use tauri::{AppHandle, Runtime};
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

use crate::lan_server::{LanServer, LiveFeed, LIVE_BYTES};

#[cfg(desktop)]
use crate::keep_awake;

pub mod hls;
pub mod support;

#[cfg(test)]
mod tests;

/// How long ffmpeg gets to open the source and write the stream's header.
const START_LIMIT: Duration = Duration::from_secs(30);
/// The most of ffmpeg's error text that's kept, the end of it, to read why
/// it failed.
const MAX_ERRORS: usize = 64 << 10;
/// How long the error reader gets to finish once ffmpeg has exited.
const ERRORS_LIMIT: Duration = Duration::from_secs(1);
/// How long [`Conversion::stop`] waits for ffmpeg to exit.
const STOP_LIMIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConvertError {
    /// The provider answered 401 or 403.
    #[error("the provider refused the stream ({0})")]
    Refused(u16),
    #[error("couldn't reach the stream")]
    Unreachable,
    #[error("this computer has no hardware video encoder")]
    NoEncoder,
    /// The bundled ffmpeg can't decode or encode one of the tracks.
    #[error("this computer can't convert this stream's format")]
    Unsupported,
    /// ffmpeg wrote something the server can't split, or didn't start.
    #[error("the converter failed: {0}")]
    Failed(String),
    /// No address on this computer reaches the receiver.
    #[error("this computer has no network address the receiver can reach")]
    NoRoute,
}

impl From<NoEncoder> for ConvertError {
    fn from(_: NoEncoder) -> Self {
        ConvertError::NoEncoder
    }
}

/// How a conversion ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// ffmpeg reached the end of a file. Up to [`LIVE_BYTES`] may still
    /// be on their way to the receiver, so the conversion has to stay
    /// until the receiver says it finished playing.
    ///
    /// [`LIVE_BYTES`]: crate::lan_server::LIVE_BYTES
    Finished,
    /// A live channel's connection ended. It has no end of its own, so
    /// it can be started again.
    Dropped,
    /// ffmpeg stopped with an error.
    Failed(ConvertError),
}

/// A running conversion. Dropping it stops ffmpeg and the server.
pub struct Conversion {
    /// The stream's address for the receiver.
    pub url: String,
    /// The server, which can serve files beside the stream, such as
    /// subtitles.
    pub server: LanServer,
    /// Changes from `None` when ffmpeg exits.
    pub ended: watch::Receiver<Option<Ended>>,
    /// How many of the receiver's requests were dropped because it
    /// stopped reading. It changes with each.
    pub stalls: watch::Receiver<u32>,
    /// ffmpeg's process id, while it runs.
    pub(crate) pid: Option<u32>,
    /// Dropping it tells the reader task to kill ffmpeg and wait for it, so
    /// no process is left behind. The error reader then ends with ffmpeg.
    stop: oneshot::Sender<()>,
    reader: JoinHandle<()>,
}

impl Conversion {
    /// Stops ffmpeg and waits until it has exited, so a conversion started
    /// next, as for a seek, isn't a second connection to the provider.
    /// Dropping a conversion stops it too, without waiting.
    pub async fn stop(self) {
        let Conversion { stop, reader, .. } = self;
        drop(stop);
        let _ = tokio::time::timeout(STOP_LIMIT, reader).await;
    }
}

/// Starts converting `source` by `plan` for the receiver at `receiver`.
/// Returns once ffmpeg has written the stream's header, so a source that
/// refuses the login fails here, before the receiver is told anything.
/// ffmpeg writes it once it has read enough to know the stream, which can
/// take a few seconds. A source that stops sending before then holds it
/// back until the read times out, and ffmpeg then writes what it has and
/// ends, so `ended` can change as soon as this returns.
pub async fn start<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
    plan: &Plan,
    encoders: Encoders,
    receiver: IpAddr,
) -> Result<Conversion, ConvertError> {
    let args = args(source, plan, encoders)?;
    let server = LanServer::start(receiver)
        .await
        .map_err(|_| ConvertError::NoRoute)?;
    let mut child = spawn(app, args)?;
    let pid = child.id();
    #[cfg(desktop)]
    if let Some(pid) = child.id() {
        keep_awake::hold_while_running(pid, keep_awake::Reason::Casting);
    }
    let stdout = child.stdout.take().ok_or_else(|| failed("no output"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| failed("no error output"))?;
    let errors = Arc::new(Mutex::new(Vec::new()));
    let (feed_tx, mut feed_rx) = watch::channel::<Option<LiveFeed>>(None);
    let (ended_tx, mut ended) = watch::channel::<Option<Ended>>(None);

    let (stop, stopped) = oneshot::channel();
    let collector = tokio::spawn(collect_errors(stderr, errors.clone()));
    let reader = tokio::spawn(read_output(
        child,
        stdout,
        stopped,
        plan.live,
        feed_tx,
        ended_tx,
        Errors {
            text: errors,
            collector,
        },
    ));

    let feed = tokio::time::timeout(START_LIMIT, async {
        loop {
            if let Some(feed) = feed_rx.borrow_and_update().clone() {
                return Ok(feed);
            }
            if let Some(end) = ended.borrow_and_update().clone() {
                return Err(match end {
                    Ended::Failed(e) => e,
                    Ended::Finished | Ended::Dropped => {
                        failed("ffmpeg ended before the stream started")
                    }
                });
            }
            tokio::select! {
                _ = feed_rx.changed() => {}
                _ = ended.changed() => {}
            }
        }
    })
    .await;
    let feed = match feed {
        Ok(Ok(feed)) => feed,
        Ok(Err(e)) => return Err(e),
        // Dropping `stop` kills ffmpeg.
        Err(_) => return Err(ConvertError::Unreachable),
    };

    let stalls = feed.stalls();
    let url = server.set_live("stream.mkv", feed);
    Ok(Conversion {
        url,
        server,
        ended,
        stalls,
        pid,
        stop,
        reader,
    })
}

/// What this computer can convert, for the frontend's `desktopSender`.
#[tauri::command]
pub async fn get_converter_support<R: Runtime>(
    app: AppHandle<R>,
) -> Result<support::Support, String> {
    Ok(support::support(&app).await)
}

fn failed(what: &str) -> ConvertError {
    ConvertError::Failed(what.to_string())
}

/// Starts the bundled ffmpeg with its output piped. Its arguments carry
/// the source URL, so they're never logged.
fn spawn<R: Runtime>(app: &AppHandle<R>, args: Vec<String>) -> Result<Child, ConvertError> {
    use tauri_plugin_shell::ShellExt;
    let sidecar = app
        .shell()
        .sidecar(crate::downloads::FFMPEG_SIDECAR)
        .map_err(|e| failed(&e.to_string()))?
        .args(args);
    let mut command = tokio::process::Command::from(std::process::Command::from(sidecar));
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    command.spawn().map_err(|e| failed(&e.to_string()))
}

/// Keeps the end of ffmpeg's error text, where it says why it stopped.
async fn collect_errors(mut stderr: tokio::process::ChildStderr, errors: Arc<Mutex<Vec<u8>>>) {
    let mut buf = [0u8; 4096];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let mut kept = errors.lock().unwrap_or_else(|p| p.into_inner());
        kept.extend_from_slice(&buf[..n]);
        let over = kept.len().saturating_sub(MAX_ERRORS);
        kept.drain(..over);
    }
}

/// ffmpeg's error text and the task that reads it.
struct Errors {
    text: Arc<Mutex<Vec<u8>>>,
    collector: JoinHandle<()>,
}

impl Errors {
    /// Why ffmpeg failed, once the reader has its last words.
    async fn reason(self) -> ConvertError {
        let _ = tokio::time::timeout(ERRORS_LIMIT, self.collector).await;
        let text = self.text.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let text = String::from_utf8_lossy(&text);
        if unsupported(&text) {
            return ConvertError::Unsupported;
        }
        match open_error(&text) {
            ProbeError::Refused(code) => ConvertError::Refused(code),
            _ => ConvertError::Unreachable,
        }
    }
}

/// Reads ffmpeg's output into a feed until it exits, then says how it
/// ended. The feed goes out once the header is in. A full feed holds
/// ffmpeg back. `stop` closing kills ffmpeg and waits for it, and ends the
/// task.
async fn read_output(
    mut child: Child,
    mut stdout: tokio::process::ChildStdout,
    mut stop: oneshot::Receiver<()>,
    live: bool,
    feed_tx: watch::Sender<Option<LiveFeed>>,
    ended: watch::Sender<Option<Ended>>,
    errors: Errors,
) {
    let mut splitter = MkvSplitter::default();
    let mut buf = vec![0u8; 64 * 1024];
    let mut feed: Option<LiveFeed> = None;
    let mut broken = None;
    let stopped = 'read: loop {
        let read = tokio::select! {
            read = stdout.read(&mut buf) => read,
            _ = &mut stop => break 'read true,
        };
        let n = match read {
            Ok(0) | Err(_) => break false,
            Ok(n) => n,
        };
        let pieces = match splitter.push(&buf[..n]) {
            Ok(pieces) => pieces,
            Err(e) => {
                broken = Some(failed(&e.to_string()));
                break false;
            }
        };
        for piece in pieces {
            match piece {
                Piece::Header(header) => {
                    let new = LiveFeed::new("video/x-matroska", header, LIVE_BYTES, live);
                    feed = Some(new.clone());
                    let _ = feed_tx.send(Some(new));
                }
                Piece::Element { bytes, start } => {
                    let Some(feed) = &feed else { continue };
                    tokio::select! {
                        () = feed.push(bytes, start) => {}
                        _ = &mut stop => break 'read true,
                    }
                }
            }
        }
    };
    if let Some(feed) = &feed {
        feed.end();
    }
    if stopped || broken.is_some() {
        let _ = child.start_kill();
    }
    let status = tokio::select! {
        status = child.wait() => status,
        // ffmpeg exits once its output closes. If it doesn't, a stop still
        // ends it.
        _ = &mut stop, if !stopped => {
            let _ = child.kill().await;
            return;
        }
    };
    if stopped {
        return;
    }
    let end = match broken {
        Some(e) => Ended::Failed(e),
        None if status.is_ok_and(|s| s.success()) => {
            if live {
                Ended::Dropped
            } else {
                Ended::Finished
            }
        }
        None => Ended::Failed(errors.reason().await),
    };
    let _ = ended.send(Some(end));
}
