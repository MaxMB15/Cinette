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
use mvp_core::convert::{args, Encoders, NoEncoder, Plan};
use mvp_core::streams::probe::{open_error, ProbeError};
use tauri::{AppHandle, Runtime};
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::{broadcast, oneshot, watch};
use tokio::task::JoinHandle;

use crate::lan_server::{LanServer, LivePipe};

#[cfg(desktop)]
use crate::keep_awake;

pub mod support;

#[cfg(test)]
mod tests;

/// How long ffmpeg gets to open the source and write the stream's header.
const START_LIMIT: Duration = Duration::from_secs(30);
/// Clusters a slow receiver may fall behind by before it's dropped.
const BACKLOG: usize = 64;
/// The most of ffmpeg's error text that's kept, to read why it failed.
const MAX_ERRORS: usize = 64 << 10;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConvertError {
    /// The provider answered 401 or 403.
    #[error("the provider refused the stream ({0})")]
    Refused(u16),
    #[error("couldn't reach the stream")]
    Unreachable,
    #[error("this computer has no hardware video encoder")]
    NoEncoder,
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
    /// ffmpeg reached the end of the source.
    Finished,
    /// ffmpeg stopped with an error, such as a live stream that dropped.
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
    /// ffmpeg's process id, while it runs.
    pub(crate) pid: Option<u32>,
    /// Tells the reader task to kill ffmpeg and wait for it.
    stop: Option<oneshot::Sender<()>>,
    errors_task: JoinHandle<()>,
}

impl Drop for Conversion {
    fn drop(&mut self) {
        // The reader task kills ffmpeg and waits for it, so no process is
        // left behind. It may have ended already, which is fine.
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.errors_task.abort();
    }
}

/// Starts converting `source` by `plan` for the receiver at `receiver`.
/// Returns once ffmpeg has written the stream's header, so a source that
/// refuses the login fails here, before the receiver is told anything.
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
    let (pieces, _) = broadcast::channel(BACKLOG);
    let (header_tx, mut header_rx) = watch::channel::<Option<Vec<u8>>>(None);
    let (ended_tx, mut ended) = watch::channel::<Option<Ended>>(None);

    let (stop, stopped) = oneshot::channel();
    let errors_task = tokio::spawn(collect_errors(stderr, errors.clone()));
    tokio::spawn(read_output(
        child,
        stdout,
        stopped,
        pieces.clone(),
        header_tx,
        ended_tx,
        errors,
    ));

    let header = tokio::time::timeout(START_LIMIT, async {
        loop {
            if let Some(header) = header_rx.borrow_and_update().clone() {
                return Ok(header);
            }
            if let Some(end) = ended.borrow_and_update().clone() {
                return Err(match end {
                    Ended::Failed(e) => e,
                    Ended::Finished => failed("ffmpeg ended before the stream started"),
                });
            }
            tokio::select! {
                _ = header_rx.changed() => {}
                _ = ended.changed() => {}
            }
        }
    })
    .await;
    let header = match header {
        Ok(Ok(header)) => header,
        failed => {
            let _ = stop.send(());
            errors_task.abort();
            return Err(failed
                .unwrap_or(Err(ConvertError::Unreachable))
                .unwrap_err());
        }
    };

    let url = server.set_live(
        "stream.mkv",
        LivePipe {
            content_type: "video/x-matroska",
            header,
            pieces: pieces.subscribe(),
        },
    );
    Ok(Conversion {
        url,
        server,
        ended,
        pid,
        stop: Some(stop),
        errors_task,
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

/// Keeps the start of ffmpeg's error text, to tell why it stopped.
async fn collect_errors(mut stderr: tokio::process::ChildStderr, errors: Arc<Mutex<Vec<u8>>>) {
    let mut buf = [0u8; 4096];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let mut kept = errors.lock().unwrap_or_else(|p| p.into_inner());
        let room = MAX_ERRORS.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
    }
}

/// Reads ffmpeg's output into pieces until it exits, then says how it
/// ended. `stop` kills ffmpeg and waits for it, and ends the task.
async fn read_output(
    mut child: Child,
    mut stdout: tokio::process::ChildStdout,
    mut stop: oneshot::Receiver<()>,
    pieces: broadcast::Sender<Arc<Piece>>,
    header: watch::Sender<Option<Vec<u8>>>,
    ended: watch::Sender<Option<Ended>>,
    errors: Arc<Mutex<Vec<u8>>>,
) {
    let mut splitter = MkvSplitter::default();
    let mut buf = vec![0u8; 64 * 1024];
    let mut broken = None;
    loop {
        let read = tokio::select! {
            read = stdout.read(&mut buf) => read,
            _ = &mut stop => {
                let _ = child.kill().await;
                return;
            }
        };
        let n = match read {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        match splitter.push(&buf[..n]) {
            Ok(new) => {
                for piece in new {
                    match piece {
                        Piece::Header(bytes) => {
                            let _ = header.send(Some(bytes));
                        }
                        element => {
                            // No receiver connected yet is fine.
                            let _ = pieces.send(Arc::new(element));
                        }
                    }
                }
            }
            Err(e) => {
                broken = Some(failed(&e.to_string()));
                break;
            }
        }
    }
    if broken.is_some() {
        let _ = child.start_kill();
    }
    let status = child.wait().await;
    let end = match broken {
        Some(e) => Ended::Failed(e),
        None if status.is_ok_and(|s| s.success()) => Ended::Finished,
        None => {
            // Let the error reader catch up with ffmpeg's last words.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let text = errors.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let text = String::from_utf8_lossy(&text).into_owned();
            Ended::Failed(match open_error(&text) {
                ProbeError::Refused(code) => ConvertError::Refused(code),
                _ => ConvertError::Unreachable,
            })
        }
    };
    let _ = ended.send(Some(end));
}
