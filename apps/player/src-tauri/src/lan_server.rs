// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A small HTTP server on this device's local network address that serves
//! one receiver what this device converted for it: a live pipe, such as
//! Matroska for a Cast receiver, and named files kept in memory, such as
//! subtitles, or an HLS playlist and its segments for AirPlay.
//!
//! - It listens on this device's address on the route to the receiver,
//!   since a receiver can't reach 127.0.0.1.
//! - It answers only the receiver's address, and only paths under a random
//!   token. Anything else gets the connection closed with no answer.
//! - Where the receiver's address isn't known, as with AirPlay on iOS, it
//!   answers the whole subnet ([`Peers::Subnet`]), and then only the token
//!   keeps the stream from others on the network.
//! - It runs until the [`LanServer`] is dropped.

// Nothing starts a server until the Cast destination does, and AirPlay's
// HLS output adds the subnet server.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use mvp_core::convert::mkv::Piece;
use mvp_core::convert::serve::{head_end, ok_head, read_request, token, Request, MAX_HEAD};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::task::{JoinHandle, JoinSet};

#[cfg(test)]
mod tests;

/// How long a connection gets to send its request.
const REQUEST_LIMIT: Duration = Duration::from_secs(5);

/// No address on this device reaches the receiver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("this device has no network address the receiver can reach")]
pub struct NoRoute;

/// The shortest subnet prefix [`Peers::Subnet`] takes. A shorter one would
/// open the stream to far more than a home network.
pub const MIN_PREFIX: u8 = 16;

/// Who the server answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Peers {
    /// Only the receiver at this address. The server listens on this
    /// device's address on the route to it.
    Receiver(IpAddr),
    /// Any address in `local`'s subnet, this device included, for a
    /// receiver whose address isn't known. The server listens on `local`,
    /// which is this device's address on that network.
    Subnet { local: Ipv4Addr, prefix: u8 },
}

impl Peers {
    /// Whether a connection from `peer` gets an answer.
    fn allows(self, peer: IpAddr) -> bool {
        match (self, peer) {
            (Peers::Receiver(receiver), _) => peer == receiver,
            (Peers::Subnet { local, prefix }, IpAddr::V4(peer)) => {
                let mask = u32::MAX << (32 - u32::from(prefix));
                u32::from(peer) & mask == u32::from(local) & mask
            }
            (Peers::Subnet { .. }, IpAddr::V6(_)) => false,
        }
    }
}

/// A live stream: a header every request starts with, then pieces as they
/// come. A request that joins late starts at the next piece that's a start
/// point, such as a Matroska cluster.
pub struct LivePipe {
    pub content_type: &'static str,
    pub header: Vec<u8>,
    /// Each request gets its own copy. Holding a receiver rather than the
    /// sender lets the stream end when its sender is dropped.
    pub pieces: broadcast::Receiver<Arc<Piece>>,
}

/// The live pipe and the name it's served as.
type NamedPipe = (String, Arc<LivePipe>);

/// A file kept in memory.
#[derive(Debug, Clone)]
pub struct File {
    pub content_type: &'static str,
    pub body: Arc<Vec<u8>>,
}

/// The named files the server holds. A converter can add and remove files
/// while the server runs, as an HLS output does with its segments.
#[derive(Clone, Default)]
pub struct Files(Arc<RwLock<HashMap<String, File>>>);

impl Files {
    /// Serves `body` as `name`, in place of any file of that name.
    pub fn put(&self, name: &str, content_type: &'static str, body: Vec<u8>) {
        let file = File {
            content_type,
            body: Arc::new(body),
        };
        self.write().insert(name.to_string(), file);
    }

    pub fn remove(&self, name: &str) {
        self.write().remove(name);
    }

    fn get(&self, name: &str) -> Option<File> {
        self.0
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(name)
            .cloned()
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, File>> {
        self.0.write().unwrap_or_else(|p| p.into_inner())
    }
}

/// A running server. Dropping it stops it.
pub struct LanServer {
    /// `http://<address>:<port>/cast/<token>/`, which names go after.
    pub base: String,
    pub files: Files,
    live: Arc<RwLock<Option<NamedPipe>>>,
    task: JoinHandle<()>,
}

impl Drop for LanServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl LanServer {
    /// Starts serving to the receiver at `receiver`, with nothing yet.
    pub async fn start(receiver: IpAddr) -> Result<Self, NoRoute> {
        Self::start_for(Peers::Receiver(receiver)).await
    }

    /// Starts serving to `peers`, with nothing yet. A subnet prefix shorter
    /// than [`MIN_PREFIX`], or longer than 32, is refused.
    pub async fn start_for(peers: Peers) -> Result<Self, NoRoute> {
        let local = match peers {
            Peers::Receiver(receiver) => route_to(receiver)?,
            Peers::Subnet { local, prefix } if (MIN_PREFIX..=32).contains(&prefix) => {
                IpAddr::V4(local)
            }
            Peers::Subnet { .. } => return Err(NoRoute),
        };
        let listener = TcpListener::bind(SocketAddr::new(local, 0))
            .await
            .map_err(|_| NoRoute)?;
        let port = listener.local_addr().map_err(|_| NoRoute)?.port();
        let host = match local {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        };
        let prefix = format!("/cast/{}/", token());
        let files = Files::default();
        let live = Arc::new(RwLock::new(None));
        let task = tokio::spawn(serve(
            listener,
            peers,
            prefix.clone(),
            files.clone(),
            live.clone(),
        ));
        Ok(Self {
            base: format!("http://{host}:{port}{prefix}"),
            files,
            live,
            task,
        })
    }

    /// Serves `pipe` as `name`, and returns its address.
    pub fn set_live(&self, name: &str, pipe: LivePipe) -> String {
        *self.live.write().unwrap_or_else(|p| p.into_inner()) =
            Some((name.to_string(), Arc::new(pipe)));
        self.url(name)
    }

    /// The address of `name` on this server.
    pub fn url(&self, name: &str) -> String {
        format!("{}{name}", self.base)
    }
}

/// This device's address on the route to `receiver`. Connecting a UDP
/// socket sends nothing; it only picks the route.
pub fn route_to(receiver: IpAddr) -> Result<IpAddr, NoRoute> {
    let unspecified: SocketAddr = match receiver {
        IpAddr::V4(_) => "0.0.0.0:0".parse().expect("a valid address"),
        IpAddr::V6(_) => "[::]:0".parse().expect("a valid address"),
    };
    let socket = UdpSocket::bind(unspecified).map_err(|_| NoRoute)?;
    socket
        .connect(SocketAddr::new(receiver, 8009))
        .map_err(|_| NoRoute)?;
    let local = socket.local_addr().map_err(|_| NoRoute)?.ip();
    if local.is_unspecified() {
        return Err(NoRoute);
    }
    Ok(local)
}

/// Accepts connections from `peers` until the server is dropped.
async fn serve(
    listener: TcpListener,
    peers: Peers,
    prefix: String,
    files: Files,
    live: Arc<RwLock<Option<NamedPipe>>>,
) {
    // Dropped with this task, which ends every request still open.
    let mut requests = JoinSet::new();
    while let Ok((socket, peer)) = listener.accept().await {
        // Anyone else on the network gets nothing at all.
        if !peers.allows(peer.ip()) {
            continue;
        }
        // Forget the requests that are done.
        while requests.try_join_next().is_some() {}
        let (prefix, files, live) = (prefix.clone(), files.clone(), live.clone());
        requests.spawn(async move {
            let _ = answer(socket, &prefix, &files, &live).await;
        });
    }
}

async fn answer(
    mut socket: TcpStream,
    prefix: &str,
    files: &Files,
    live: &RwLock<Option<NamedPipe>>,
) -> std::io::Result<()> {
    let Some(request) = tokio::time::timeout(REQUEST_LIMIT, read_head(&mut socket))
        .await
        .ok()
        .flatten()
    else {
        return Ok(());
    };
    let Some(name) = request.path.strip_prefix(prefix) else {
        return Ok(());
    };
    let pipe = live
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|(live_name, _)| live_name == name)
        .map(|(_, pipe)| pipe.clone());
    if let Some(pipe) = pipe {
        return send_live(socket, &request, &pipe).await;
    }
    if let Some(file) = files.get(name) {
        socket
            .write_all(ok_head(file.content_type, Some(file.body.len())).as_bytes())
            .await?;
        if !request.head_only {
            socket.write_all(&file.body).await?;
        }
    }
    Ok(())
}

async fn send_live(
    mut socket: TcpStream,
    request: &Request,
    pipe: &LivePipe,
) -> std::io::Result<()> {
    // Subscribe before writing the header, so no piece slips by.
    let mut pieces = pipe.pieces.resubscribe();
    socket
        .write_all(ok_head(pipe.content_type, None).as_bytes())
        .await?;
    if request.head_only {
        return Ok(());
    }
    socket.write_all(&pipe.header).await?;
    let mut started = false;
    loop {
        match pieces.recv().await {
            Ok(piece) => {
                let Piece::Element { bytes, cluster } = piece.as_ref() else {
                    continue;
                };
                // A late request starts at a cluster, which starts at a
                // keyframe.
                started |= *cluster;
                if started {
                    socket.write_all(bytes).await?;
                }
            }
            // Fallen too far behind, or the stream ended.
            Err(_) => return Ok(()),
        }
    }
}

/// Reads a request's head, up to [`MAX_HEAD`] bytes.
async fn read_head(socket: &mut TcpStream) -> Option<Request> {
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
