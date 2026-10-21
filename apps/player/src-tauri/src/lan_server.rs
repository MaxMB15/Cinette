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

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use mvp_core::convert::serve::{
    head_end, not_found_head, ok_head, read_request, token, Request, MAX_HEAD,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

#[cfg(test)]
mod tests;

/// How long a connection gets to send its request.
#[cfg(not(test))]
const REQUEST_LIMIT: Duration = Duration::from_secs(5);
/// Tests wait less, still ten times the pauses they make within a request.
#[cfg(test)]
const REQUEST_LIMIT: Duration = Duration::from_secs(2);
/// How long one write may wait on a receiver that stopped reading before
/// its request is dropped. Wi-Fi can stall for a few seconds.
const WRITE_LIMIT: Duration = Duration::from_secs(15);
/// The most requests answered at once. A receiver makes one or two, so
/// more come from something else on the network.
const MAX_REQUESTS: usize = 16;
/// How long the server waits after a failed accept, such as when the app
/// is out of file descriptors for a moment.
const ACCEPT_PAUSE: Duration = Duration::from_millis(100);
/// How long the server waits to listen again while its address is taken.
const REBIND_PAUSE: Duration = Duration::from_secs(1);
/// How many accepts in a row may lose their connection before the server
/// takes its socket for gone. A socket iOS took back may fail that way.
const MAX_LOST: u32 = 10;
/// How much of a live stream is kept: tens of seconds of a 1080p stream.
pub const LIVE_BYTES: usize = 32 << 20;

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
/// come, some of which are start points, such as a Matroska cluster that
/// starts with a keyframe. The writer and each request share one buffer.
///
/// - The first request starts at the first piece, so a stream that starts
///   partway through a file starts where it was asked to.
/// - A later request, as when the receiver opens the stream again, starts
///   at the last start point at or before what was already sent.
/// - The buffer holds at most `cap` bytes. When it's full, the writer
///   waits for the requests to catch up. A live channel with no request
///   open drops its oldest pieces instead, since it can't wait.
/// - A request whose receiver stops reading for [`WRITE_LIMIT`] is dropped
///   and counted in [`LiveFeed::stalls`].
#[derive(Clone)]
pub struct LiveFeed(Arc<Feed>);

struct Feed {
    content_type: &'static str,
    header: Vec<u8>,
    cap: usize,
    live: bool,
    /// [`WRITE_LIMIT`], or less in tests.
    write_limit: Duration,
    state: Mutex<FeedState>,
    /// Changes with every piece written or taken, which wakes whoever
    /// waits.
    changed: watch::Sender<u64>,
    stalls: watch::Sender<u32>,
}

#[derive(Default)]
struct FeedState {
    /// Each piece and whether it's a start point.
    pieces: VecDeque<(Arc<[u8]>, bool)>,
    /// The number of the first piece in `pieces`.
    first: u64,
    bytes: usize,
    /// The first piece no request has taken yet.
    frontier: u64,
    /// Each open request's next piece, by request. A request waiting for a
    /// start point skips what comes before it.
    readers: HashMap<u64, (u64, bool)>,
    next_reader: u64,
    ended: bool,
}

impl FeedState {
    fn end(&self) -> u64 {
        self.first + self.pieces.len() as u64
    }

    fn is_start(&self, n: u64) -> bool {
        n >= self.first
            && self
                .pieces
                .get((n - self.first) as usize)
                .is_some_and(|(_, start)| *start)
    }

    /// Where a new request starts: the last start point among the pieces
    /// already sent, or else the next one kept. `None` when no start point
    /// is kept, and the request waits for the next.
    fn start(&self) -> Option<u64> {
        let sent = self.frontier.clamp(self.first, self.end());
        (self.first..sent)
            .rev()
            .chain(sent..self.end())
            .find(|&n| self.is_start(n))
    }

    /// The piece a request takes next: its next one, or for a request
    /// waiting for a start point, the first one kept from there, or else
    /// the end.
    fn place(&self, (next, waiting): (u64, bool)) -> u64 {
        let next = next.max(self.first);
        if !waiting {
            return next;
        }
        (next..self.end())
            .find(|&n| self.is_start(n))
            .unwrap_or(self.end())
    }

    /// The first piece an open request still needs.
    fn needed(&self) -> Option<u64> {
        self.readers
            .values()
            .map(|&reader| self.place(reader))
            .min()
    }

    /// Drops the pieces before `keep`.
    fn drop_before(&mut self, keep: u64) {
        while self.first < keep {
            let Some((bytes, _)) = self.pieces.pop_front() else {
                break;
            };
            self.bytes -= bytes.len();
            self.first += 1;
        }
        self.frontier = self.frontier.max(self.first);
    }

    /// Drops the pieces no request needs and no new one starts from.
    fn trim(&mut self) {
        let start = self.start().unwrap_or(self.frontier);
        let keep = self.needed().map_or(start, |needed| needed.min(start));
        self.drop_before(keep);
    }

    /// Drops the oldest pieces up to the next start point, for a live
    /// channel no request reads.
    fn skip(&mut self) {
        let next = (self.first + 1..self.end())
            .find(|&n| self.is_start(n))
            .unwrap_or(self.end());
        self.drop_before(next);
    }
}

impl LiveFeed {
    /// A feed that keeps at most `cap` bytes. A `live` one drops pieces
    /// rather than wait when no request reads.
    pub fn new(content_type: &'static str, header: Vec<u8>, cap: usize, live: bool) -> Self {
        Self::with_write_limit(content_type, header, cap, live, WRITE_LIMIT)
    }

    fn with_write_limit(
        content_type: &'static str,
        header: Vec<u8>,
        cap: usize,
        live: bool,
        write_limit: Duration,
    ) -> Self {
        Self(Arc::new(Feed {
            content_type,
            header,
            cap,
            live,
            write_limit,
            state: Mutex::new(FeedState::default()),
            changed: watch::Sender::new(0),
            stalls: watch::Sender::new(0),
        }))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, FeedState> {
        self.0.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn wake(&self) {
        self.0.changed.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Adds a piece, once there's room for it.
    pub async fn push(&self, bytes: Vec<u8>, start: bool) {
        let mut changed = self.0.changed.subscribe();
        loop {
            changed.borrow_and_update();
            let dropped = {
                let mut state = self.state();
                state.trim();
                if state.pieces.is_empty() || state.bytes + bytes.len() <= self.0.cap {
                    state.bytes += bytes.len();
                    state.pieces.push_back((bytes.into(), start));
                    drop(state);
                    self.wake();
                    return;
                }
                // What's kept for a new request's start point gives way
                // first. Then a live channel no one reads skips ahead, and
                // anything else waits for its readers.
                if let Some(needed) = state.needed().filter(|&n| n > state.first) {
                    state.drop_before(needed);
                    true
                } else if self.0.live && state.readers.is_empty() {
                    state.skip();
                    true
                } else {
                    false
                }
            };
            if dropped {
                // Lets the runtime run between tries, so a timeout around
                // the push can end it if dropping never makes room.
                tokio::task::yield_now().await;
                continue;
            }
            // The feed holds the sender, so this never fails.
            let _ = changed.changed().await;
        }
    }

    /// No more pieces come. Requests end once they've sent what's left.
    pub fn end(&self) {
        self.state().ended = true;
        self.wake();
    }

    /// How many requests were dropped because their receiver stopped
    /// reading. It changes with each.
    pub fn stalls(&self) -> watch::Receiver<u32> {
        self.0.stalls.subscribe()
    }

    fn reader(&self) -> Reader {
        let mut state = self.state();
        let id = state.next_reader;
        state.next_reader += 1;
        let start = state.start();
        let next = start.unwrap_or(state.end());
        state.readers.insert(id, (next, start.is_none()));
        Reader {
            feed: self.clone(),
            id,
        }
    }
}

/// One request's place in a [`LiveFeed`].
struct Reader {
    feed: LiveFeed,
    id: u64,
}

impl Reader {
    /// The next piece, or `None` once the feed has ended and every piece
    /// was taken.
    async fn next(&mut self) -> Option<Arc<[u8]>> {
        let mut changed = self.feed.0.changed.subscribe();
        loop {
            changed.borrow_and_update();
            {
                let mut state = self.feed.state();
                let next = state.place(*state.readers.get(&self.id)?);
                if let Some((bytes, _)) = state.pieces.get((next - state.first) as usize) {
                    let bytes = bytes.clone();
                    state.readers.insert(self.id, (next + 1, false));
                    state.frontier = state.frontier.max(next + 1);
                    drop(state);
                    self.feed.wake();
                    return Some(bytes);
                }
                if state.ended && next >= state.end() {
                    return None;
                }
            }
            let _ = changed.changed().await;
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.feed.state().readers.remove(&self.id);
        self.feed.wake();
    }
}

/// The live feed and the name it's served as.
type NamedPipe = (String, LiveFeed);

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

    pub(crate) fn get(&self, name: &str) -> Option<File> {
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
    /// The listening socket, which a test takes away as iOS does.
    #[cfg(all(test, target_os = "linux"))]
    fd: std::os::fd::RawFd,
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
        let address = listener.local_addr().map_err(|_| NoRoute)?;
        let port = address.port();
        #[cfg(all(test, target_os = "linux"))]
        let fd = std::os::fd::AsRawFd::as_raw_fd(&listener);
        let host = match local {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        };
        let prefix = format!("/cast/{}/", token());
        let files = Files::default();
        let live = Arc::new(RwLock::new(None));
        let task = tokio::spawn(serve(
            listener,
            address,
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
            #[cfg(all(test, target_os = "linux"))]
            fd,
        })
    }

    /// Serves `feed` as `name`, and returns its address.
    pub fn set_live(&self, name: &str, feed: LiveFeed) -> String {
        *self.live.write().unwrap_or_else(|p| p.into_inner()) = Some((name.to_string(), feed));
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

/// Accepts connections from `peers` until the server is dropped. If the
/// listening socket goes, it listens on `address` again, so the addresses
/// the receiver has keep working.
async fn serve(
    mut listener: TcpListener,
    address: SocketAddr,
    peers: Peers,
    prefix: String,
    files: Files,
    live: Arc<RwLock<Option<NamedPipe>>>,
) {
    // Dropped with this task, which ends every request still open.
    let mut requests = JoinSet::new();
    let slots = Arc::new(Semaphore::new(MAX_REQUESTS));
    let mut failures = AcceptFailures::default();
    loop {
        let (socket, peer) = match listener.accept().await {
            Ok(accepted) => {
                failures.accepted();
                accepted
            }
            Err(e) => {
                match failures.after(&e) {
                    AfterAccept::Retry => {
                        tracing::warn!(kind = ?e.kind(), "the converter's server lost a connection before accepting it");
                    }
                    AfterAccept::Pause => {
                        tracing::warn!(kind = ?e.kind(), "the converter's server is out of resources for a moment");
                        tokio::time::sleep(ACCEPT_PAUSE).await;
                    }
                    AfterAccept::Rebind => {
                        tracing::warn!(kind = ?e.kind(), "the converter's server lost its socket and listens again");
                        drop(listener);
                        // A socket that's taken back at once doesn't spin.
                        tokio::time::sleep(ACCEPT_PAUSE).await;
                        listener = rebind(address).await;
                    }
                }
                continue;
            }
        };
        // Anyone else on the network gets nothing at all, and so does a
        // connection past the limit.
        if !peers.allows(peer.ip()) {
            continue;
        }
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            continue;
        };
        // Forget the requests that are done.
        while requests.try_join_next().is_some() {}
        let (prefix, files, live) = (prefix.clone(), files.clone(), live.clone());
        requests.spawn(async move {
            let _ = answer(socket, &prefix, &files, &live).await;
            drop(slot);
        });
    }
}

/// What the server does after a failed accept.
#[derive(Debug, PartialEq, Eq)]
enum AfterAccept {
    /// A connection went before it was accepted. Others still come.
    Retry,
    /// The app is out of file descriptors or memory for a moment.
    Pause,
    /// The listening socket is gone, as when iOS takes it back from a
    /// suspended app.
    Rebind,
}

/// The accepts that failed since the last one that didn't.
#[derive(Debug, Default)]
struct AcceptFailures {
    lost: u32,
}

impl AcceptFailures {
    fn after(&mut self, e: &std::io::Error) -> AfterAccept {
        match after_accept(e) {
            AfterAccept::Retry if self.lost + 1 >= MAX_LOST => {
                self.lost = 0;
                AfterAccept::Rebind
            }
            AfterAccept::Retry => {
                self.lost += 1;
                AfterAccept::Retry
            }
            AfterAccept::Rebind => {
                self.lost = 0;
                AfterAccept::Rebind
            }
            AfterAccept::Pause => AfterAccept::Pause,
        }
    }

    fn accepted(&mut self) {
        self.lost = 0;
    }
}

fn after_accept(e: &std::io::Error) -> AfterAccept {
    use std::io::ErrorKind;
    if matches!(
        e.raw_os_error(),
        Some(libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM)
    ) {
        return AfterAccept::Pause;
    }
    match e.kind() {
        ErrorKind::ConnectionAborted
        | ErrorKind::ConnectionReset
        | ErrorKind::Interrupted
        | ErrorKind::WouldBlock => AfterAccept::Retry,
        _ => AfterAccept::Rebind,
    }
}

/// Listens on `address` again, trying each [`REBIND_PAUSE`] while it's
/// taken. Dropping the server ends it.
async fn rebind(address: SocketAddr) -> TcpListener {
    loop {
        match TcpListener::bind(address).await {
            Ok(listener) => return listener,
            Err(e) => {
                tracing::warn!(kind = ?e.kind(), "the converter's server can't listen again yet");
                tokio::time::sleep(REBIND_PAUSE).await;
            }
        }
    }
}

/// Writes `bytes`, or fails once the receiver has stopped reading for
/// `limit`.
async fn write(socket: &mut TcpStream, bytes: &[u8], limit: Duration) -> std::io::Result<()> {
    tokio::time::timeout(limit, socket.write_all(bytes))
        .await
        .map_err(|_| std::io::ErrorKind::TimedOut)?
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
    let feed = live
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|(live_name, _)| live_name == name)
        .map(|(_, feed)| feed.clone());
    if let Some(feed) = feed {
        return send_live(socket, &request, &feed).await;
    }
    // A path outside the token got nothing above. One under it that isn't
    // there, such as a segment the window dropped, is a 404, so the
    // receiver moves on.
    let Some(file) = files.get(name) else {
        return write(&mut socket, not_found_head().as_bytes(), WRITE_LIMIT).await;
    };
    write(
        &mut socket,
        ok_head(file.content_type, Some(file.body.len())).as_bytes(),
        WRITE_LIMIT,
    )
    .await?;
    if !request.head_only {
        write(&mut socket, &file.body, WRITE_LIMIT).await?;
    }
    Ok(())
}

async fn send_live(
    mut socket: TcpStream,
    request: &Request,
    feed: &LiveFeed,
) -> std::io::Result<()> {
    let limit = feed.0.write_limit;
    write(
        &mut socket,
        ok_head(feed.0.content_type, None).as_bytes(),
        limit,
    )
    .await?;
    if request.head_only {
        return Ok(());
    }
    let mut reader = feed.reader();
    let sent: std::io::Result<()> = async {
        write(&mut socket, &feed.0.header, limit).await?;
        while let Some(piece) = reader.next().await {
            write(&mut socket, &piece, limit).await?;
        }
        Ok(())
    }
    .await;
    if sent
        .as_ref()
        .is_err_and(|e| e.kind() == std::io::ErrorKind::TimedOut)
    {
        feed.0.stalls.send_modify(|n| *n += 1);
    }
    sent
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
