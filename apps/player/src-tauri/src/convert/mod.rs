// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Converts a stream with the bundled ffmpeg and serves it to one receiver
//! on the local network, for as long as the cast lasts.
//!
//! - The server listens on this computer's address on the route to the
//!   receiver, since a receiver can't reach 127.0.0.1.
//! - It answers only the receiver's address, and only an unguessable path.
//!   Anything else gets the connection closed with no answer.
//! - The provider's URL and login stay with ffmpeg. The receiver only ever
//!   sees this computer's address.
//! - The computer stays awake while ffmpeg runs, as it does for recordings.
//! - Dropping the [`Conversion`] stops ffmpeg and the server.

// The Cast destination starts conversions from the next step on.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mvp_core::convert::mkv::{MkvSplitter, Piece};
use mvp_core::convert::serve::{head_end, ok_head, read_request, token, MAX_HEAD};
use mvp_core::convert::{args, HardwareEncoder, NoEncoder, Plan};
use mvp_core::streams::probe::{open_error, ProbeError};
use tauri::{AppHandle, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Child;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

#[cfg(desktop)]
use crate::keep_awake;

pub mod support;

#[cfg(test)]
mod tests;

/// How long ffmpeg gets to open the source and write the stream's header.
const START_LIMIT: Duration = Duration::from_secs(30);
/// How long a connection gets to send its request.
const REQUEST_LIMIT: Duration = Duration::from_secs(5);
/// Clusters a slow receiver may fall behind by before it's dropped.
const BACKLOG: usize = 64;
/// The most of ffmpeg's error text that's kept, to read why it failed.
const MAX_ERRORS: usize = 64 * 1024;

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

/// A file served beside the stream, such as subtitles.
#[derive(Debug, Clone)]
pub struct ServedFile {
    /// The last part of its path, such as `subs.vtt`.
    pub name: String,
    pub content_type: &'static str,
    pub body: Arc<Vec<u8>>,
}

/// A running conversion. Dropping it stops ffmpeg and the server.
pub struct Conversion {
    /// The stream's address for the receiver.
    pub url: String,
    /// The base the served files' names go after.
    pub base: String,
    /// Changes from `None` when ffmpeg exits.
    pub ended: watch::Receiver<Option<Ended>>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Conversion {
    fn drop(&mut self) {
        // The reader task owns ffmpeg with `kill_on_drop`, so aborting it
        // ends ffmpeg too.
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// What the server hands each request for the stream.
struct Stream {
    header: Vec<u8>,
    pieces: broadcast::Sender<Arc<Piece>>,
}

/// Starts converting `source` by `plan` for the receiver at `receiver`.
/// Returns once ffmpeg has written the stream's header, so a source that
/// refuses the login fails here, before the receiver is told anything.
pub async fn start<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
    plan: &Plan,
    encoder: Option<HardwareEncoder>,
    receiver: IpAddr,
    files: Vec<ServedFile>,
) -> Result<Conversion, ConvertError> {
    let args = args(source, plan, encoder)?;
    let local = route_to(receiver)?;
    let listener = TcpListener::bind(SocketAddr::new(local, 0))
        .await
        .map_err(|_| ConvertError::NoRoute)?;
    let port = listener
        .local_addr()
        .map_err(|_| ConvertError::NoRoute)?
        .port();
    let mut child = spawn(app, args)?;
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

    let errors_task = tokio::spawn(collect_errors(stderr, errors.clone()));
    let reader = tokio::spawn(read_output(
        child,
        stdout,
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
        Ok(Err(e)) => {
            reader.abort();
            errors_task.abort();
            return Err(e);
        }
        Err(_) => {
            reader.abort();
            errors_task.abort();
            return Err(ConvertError::Unreachable);
        }
    };

    let token = token();
    let host = match local {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    let base = format!("http://{host}:{port}/cast/{token}/");
    let stream = Arc::new(Stream { header, pieces });
    let files: HashMap<String, ServedFile> = files
        .into_iter()
        .map(|f| (format!("/cast/{token}/{}", f.name), f))
        .collect();
    let server = tokio::spawn(serve(
        listener,
        receiver,
        format!("/cast/{token}/stream.mkv"),
        stream,
        Arc::new(files),
    ));
    Ok(Conversion {
        url: format!("{base}stream.mkv"),
        base,
        ended,
        tasks: vec![reader, errors_task, server],
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

/// This computer's address on the route to `receiver`. Connecting a UDP
/// socket sends nothing; it only picks the route.
fn route_to(receiver: IpAddr) -> Result<IpAddr, ConvertError> {
    let unspecified: SocketAddr = match receiver {
        IpAddr::V4(_) => "0.0.0.0:0".parse().expect("a valid address"),
        IpAddr::V6(_) => "[::]:0".parse().expect("a valid address"),
    };
    let socket = UdpSocket::bind(unspecified).map_err(|_| ConvertError::NoRoute)?;
    socket
        .connect(SocketAddr::new(receiver, 8009))
        .map_err(|_| ConvertError::NoRoute)?;
    let local = socket.local_addr().map_err(|_| ConvertError::NoRoute)?.ip();
    if local.is_unspecified() {
        return Err(ConvertError::NoRoute);
    }
    Ok(local)
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
/// ended. Owns the child, so aborting this task kills ffmpeg.
async fn read_output(
    mut child: Child,
    mut stdout: tokio::process::ChildStdout,
    pieces: broadcast::Sender<Arc<Piece>>,
    header: watch::Sender<Option<Vec<u8>>>,
    ended: watch::Sender<Option<Ended>>,
    errors: Arc<Mutex<Vec<u8>>>,
) {
    let mut splitter = MkvSplitter::default();
    let mut buf = vec![0u8; 64 * 1024];
    let mut broken = None;
    loop {
        let n = match stdout.read(&mut buf).await {
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

/// Accepts connections from the receiver until the conversion stops.
async fn serve(
    listener: TcpListener,
    receiver: IpAddr,
    stream_path: String,
    stream: Arc<Stream>,
    files: Arc<HashMap<String, ServedFile>>,
) {
    while let Ok((socket, peer)) = listener.accept().await {
        // Anyone else on the network gets nothing at all.
        if peer.ip() != receiver {
            continue;
        }
        let (stream, files, stream_path) = (stream.clone(), files.clone(), stream_path.clone());
        tokio::spawn(async move {
            let _ = answer(socket, &stream_path, &stream, &files).await;
        });
    }
}

async fn answer(
    mut socket: TcpStream,
    stream_path: &str,
    stream: &Stream,
    files: &HashMap<String, ServedFile>,
) -> std::io::Result<()> {
    let Some(request) = tokio::time::timeout(REQUEST_LIMIT, read_head(&mut socket))
        .await
        .ok()
        .flatten()
    else {
        return Ok(());
    };
    if request.path == stream_path {
        // Subscribe before writing the header, so no cluster slips by.
        let mut pieces = stream.pieces.subscribe();
        socket
            .write_all(ok_head("video/x-matroska", None).as_bytes())
            .await?;
        if request.head_only {
            return Ok(());
        }
        socket.write_all(&stream.header).await?;
        let mut started = false;
        loop {
            match pieces.recv().await {
                Ok(piece) => {
                    let Piece::Element { bytes, cluster } = piece.as_ref() else {
                        continue;
                    };
                    // A late request starts at a cluster, which starts at
                    // a keyframe.
                    started |= *cluster;
                    if started {
                        socket.write_all(bytes).await?;
                    }
                }
                // Fallen too far behind, or the conversion ended.
                Err(_) => return Ok(()),
            }
        }
    }
    if let Some(file) = files.get(&request.path) {
        socket
            .write_all(ok_head(file.content_type, Some(file.body.len())).as_bytes())
            .await?;
        if !request.head_only {
            socket.write_all(&file.body).await?;
        }
    }
    Ok(())
}

/// Reads a request's head, up to [`MAX_HEAD`] bytes.
async fn read_head(socket: &mut TcpStream) -> Option<mvp_core::convert::serve::Request> {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let n = socket.read(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(end) = head_end(&head) {
            return read_request(&head[..end]);
        }
        if head.len() > MAX_HEAD {
            return None;
        }
    }
}
