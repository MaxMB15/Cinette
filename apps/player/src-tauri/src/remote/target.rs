// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The task that runs this device as a remote-control target.
//!
//! One task owns the core's [`Target`], so nothing else touches it and it
//! needs no lock. Everything that happens reaches it through its inbox:
//! new connections, frames, the user's answers, settings, the player's
//! state. It carries out the [`Action`]s the core returns, and calls
//! [`Target::tick`] when the core's next deadline comes.
//!
//! What it can't do itself goes to a [`TargetHost`]: showing the dialog,
//! applying commands to the player, reading the catalog and advertising.
//! The app's host does that through Tauri; tests use a fake one.

use super::clock;
use super::conn::{self, Backlogged, Read, Writer};
use crate::discovery::{Registration, Txt};
use mvp_core::remote::catalog::{CatalogItem, CatalogQuery};
use mvp_core::remote::consent::{Answer, RequestId};
use mvp_core::remote::identity::DeviceKey;
use mvp_core::remote::message::{Command, DeviceType, ErrorCode, PlaybackSnapshot};
use mvp_core::remote::settings::RemoteSettings;
use mvp_core::remote::target::{
    Action, ConsentPrompt, DiscoveryRecord, SessionInfo, Target, SERVICE_TYPE,
};
use mvp_core::remote::ConnId;
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

/// How long the player has to carry out a command before the controller
/// hears `failed`.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
/// The most connections one address may have open, so one device can't
/// take every slot the core has. All of an IPv6 /64 counts as one address.
const MAX_PER_ADDRESS: usize = 4;
/// The most catalog queries answered at once, over all connections. Each
/// takes a blocking thread, and an episodes query asks the provider.
const MAX_CATALOG_JOBS: usize = 4;

/// One run of the core [`Target`]. A new identity starts a new one, whose
/// connection and request numbers start again, so anything still on its way
/// from the old one is told apart by this.
type Epoch = u64;
/// The longest the task sleeps without looking at the clock. Timers don't
/// count time asleep, so after a wake this is how soon the deadlines that
/// passed during the sleep are seen.
const MAX_NAP: Duration = Duration::from_secs(2);
/// How long quitting waits for the last frames to be written.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

/// A catalog answer: a page of items and the cursor for the next one.
pub type CatalogPage = Result<(Vec<CatalogItem>, Option<String>), ErrorCode>;

/// What the target task asks of the app.
pub trait TargetHost: Send + Sync + 'static {
    /// Show this consent dialog, in place of any other.
    fn show_consent(&self, prompt: &ConsentPrompt);
    /// Take this request's dialog off screen.
    fn hide_consent(&self, request: RequestId);
    /// The controllers changed.
    fn sessions_changed(&self, sessions: &[SessionInfo]);
    /// Carry out a command on the player, then call
    /// [`TargetHandle::finish_command`] with `token`.
    fn apply(&self, token: u64, command: &Command);
    /// Answer a catalog query. Runs on a blocking thread.
    fn catalog(&self, query: CatalogQuery) -> CatalogPage;
    /// Advertise this, in place of anything advertised before, or stop.
    fn advertise(&self, registration: Option<Registration>);
}

enum Input {
    Accepted(TcpStream, IpAddr),
    Answer(RequestId, Answer),
    Disconnect(String),
    Settings(RemoteSettings),
    ResetIdentity(DeviceKey),
    State(Box<PlaybackSnapshot>),
    Finished(u64, Result<(), ErrorCode>),
    CatalogDone(Epoch, ConnId, u64, CatalogPage),
    Sessions(oneshot::Sender<Vec<SessionInfo>>),
    Shutdown(oneshot::Sender<()>),
}

/// Talks to the running target task. Cheap to clone.
#[derive(Clone)]
pub struct TargetHandle {
    inbox: mpsc::UnboundedSender<Input>,
    port: u16,
}

impl TargetHandle {
    /// The TCP port the target listens on.
    pub fn port(&self) -> u16 {
        self.port
    }

    fn send(&self, input: Input) {
        // After shutdown there's no one to tell, and nothing to do.
        let _ = self.inbox.send(input);
    }

    pub fn answer(&self, request: RequestId, answer: Answer) {
        self.send(Input::Answer(request, answer));
    }

    pub fn disconnect(&self, session_id: String) {
        self.send(Input::Disconnect(session_id));
    }

    pub fn update_settings(&self, settings: RemoteSettings) {
        self.send(Input::Settings(settings));
    }

    /// Ends every session and starts again with this key.
    pub fn reset_identity(&self, key: DeviceKey) {
        self.send(Input::ResetIdentity(key));
    }

    pub fn set_state(&self, state: PlaybackSnapshot) {
        self.send(Input::State(Box::new(state)));
    }

    pub fn finish_command(&self, token: u64, result: Result<(), ErrorCode>) {
        self.send(Input::Finished(token, result));
    }

    /// The controllers, connected or waiting to resume.
    pub async fn sessions(&self) -> Vec<SessionInfo> {
        let (tx, rx) = oneshot::channel();
        self.send(Input::Sessions(tx));
        rx.await.unwrap_or_default()
    }

    /// Closes every connection with `shutdown`, stops advertising, and
    /// waits a moment for the last frames to go out.
    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        self.send(Input::Shutdown(tx));
        let _ = rx.await;
    }
}

/// Binds the port remote control listens on: [`DEFAULT_PORT`] on every
/// address when it's free, any free port otherwise. One socket on `[::]`
/// takes IPv4 too; where that fails, `0.0.0.0`.
pub async fn bind_default() -> std::io::Result<TcpListener> {
    let candidates = [
        format!("[::]:{DEFAULT_PORT}"),
        format!("0.0.0.0:{DEFAULT_PORT}"),
        "[::]:0".to_owned(),
        "0.0.0.0:0".to_owned(),
    ];
    let mut last = None;
    for address in candidates {
        match TcpListener::bind(&address).await {
            Ok(listener) => return Ok(listener),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("no address to bind")))
}

/// The port remote control uses when it's free, so a firewall rule can name it.
pub const DEFAULT_PORT: u16 = 47130;

/// Starts the target on `listener`.
pub fn start(
    listener: TcpListener,
    key: DeviceKey,
    device_type: DeviceType,
    settings: RemoteSettings,
    host: Arc<dyn TargetHost>,
) -> std::io::Result<TargetHandle> {
    let limits = Limits {
        command_timeout: COMMAND_TIMEOUT,
        per_address: MAX_PER_ADDRESS,
    };
    start_with(listener, key, device_type, settings, host, limits)
}

/// [`start`], with other limits.
fn start_with(
    listener: TcpListener,
    key: DeviceKey,
    device_type: DeviceType,
    settings: RemoteSettings,
    host: Arc<dyn TargetHost>,
    limits: Limits,
) -> std::io::Result<TargetHandle> {
    let port = listener.local_addr()?.port();
    let (inbox, rx) = mpsc::unbounded_channel();
    let accept_inbox = inbox.clone();
    let accept = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, from)) => {
                    if accept_inbox
                        .send(Input::Accepted(stream, from.ip()))
                        .is_err()
                    {
                        break;
                    }
                }
                // Too many open files and the like pass; don't spin on them.
                Err(e) => {
                    tracing::warn!("[remote] accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });
    let (reads, read_rx) = mpsc::unbounded_channel();
    let task = Task {
        target: Target::new(key.clone(), device_type, settings),
        key,
        device_type,
        host,
        port,
        inbox: inbox.clone(),
        epoch: 0,
        writers: HashMap::new(),
        peers: HashMap::new(),
        catalog_jobs: HashSet::new(),
        reads,
        pending: HashMap::new(),
        next_token: 0,
        limits,
    };
    tokio::spawn(task.run(rx, read_rx, accept));
    Ok(TargetHandle { inbox, port })
}

struct Pending {
    conn: ConnId,
    request: u64,
    deadline: Instant,
}

struct Task {
    target: Target,
    key: DeviceKey,
    device_type: DeviceType,
    host: Arc<dyn TargetHost>,
    port: u16,
    inbox: mpsc::UnboundedSender<Input>,
    epoch: Epoch,
    writers: HashMap<ConnId, Writer>,
    /// Where each open connection comes from.
    peers: HashMap<ConnId, IpAddr>,
    /// The connections with a catalog query being answered, which may be
    /// from an earlier epoch.
    catalog_jobs: HashSet<(Epoch, ConnId)>,
    reads: mpsc::UnboundedSender<((Epoch, ConnId), Read)>,
    /// Commands the player hasn't finished, by token.
    pending: HashMap<u64, Pending>,
    next_token: u64,
    limits: Limits,
}

/// What [`start`] sets and tests change.
#[derive(Debug, Clone, Copy)]
struct Limits {
    /// The time the player has for each command.
    command_timeout: Duration,
    /// See [`MAX_PER_ADDRESS`].
    per_address: usize,
}

impl Task {
    async fn run(
        mut self,
        mut inbox: mpsc::UnboundedReceiver<Input>,
        mut reads: mpsc::UnboundedReceiver<((Epoch, ConnId), Read)>,
        accept: tokio::task::JoinHandle<()>,
    ) {
        self.advertise(self.target.discovery_record());
        loop {
            let nap = self
                .next_deadline()
                .map_or(MAX_NAP, |at| at.saturating_duration_since(clock::now()))
                .min(MAX_NAP);
            tokio::select! {
                input = inbox.recv() => match input {
                    Some(Input::Shutdown(done)) => {
                        accept.abort();
                        let actions = self.target.shutdown();
                        self.carry_out(actions);
                        self.writers.clear();
                        self.host.advertise(None);
                        tokio::time::sleep(SHUTDOWN_GRACE).await;
                        let _ = done.send(());
                        return;
                    }
                    Some(input) => self.handle(input),
                    None => {
                        accept.abort();
                        return;
                    }
                },
                Some(((epoch, conn), read)) = reads.recv() => {
                    if epoch != self.epoch {
                        // A connection from before a new identity.
                        continue;
                    }
                    let now = clock::now();
                    let actions = match read {
                        Read::Frame(frame) => self.target.receive(conn, &frame, now),
                        Read::Gone => {
                            self.writers.remove(&conn);
                            self.peers.remove(&conn);
                            self.target.disconnected(conn, now)
                        }
                    };
                    self.carry_out(actions);
                }
                () = tokio::time::sleep(nap) => self.tick(),
            }
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        let commands = self.pending.values().map(|p| p.deadline).min();
        [self.target.next_deadline(), commands]
            .into_iter()
            .flatten()
            .min()
    }

    fn tick(&mut self) {
        let now = clock::now();
        let actions = self.target.tick(now);
        self.carry_out(actions);
        let late: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, p)| p.deadline <= now)
            .map(|(&token, _)| token)
            .collect();
        for token in late {
            tracing::warn!("[remote] the player didn't finish command {token} in time");
            self.finish(token, Err(ErrorCode::Failed));
        }
    }

    /// Hands a new connection to the core, unless this device is hidden
    /// with no session to resume, or `from` has enough open already.
    /// Dropping the stream closes it before the core says who this is.
    fn accept(&mut self, stream: TcpStream, from: IpAddr, now: Instant) {
        if !self.target.settings().discoverable && self.target.sessions().is_empty() {
            tracing::info!("[remote] not discoverable; turned a connection away");
            return;
        }
        let from = address_group(from);
        let open = self.peers.values().filter(|&&ip| ip == from).count();
        if open >= self.limits.per_address {
            tracing::info!(
                "[remote] {} connections from one address; turned one away",
                self.limits.per_address
            );
            return;
        }
        // The core makes room for this one by closing the oldest that
        // hasn't asked yet; that close comes from its next tick.
        if let Some(conn) = self.target.accept(now) {
            let writer = conn::spawn(stream, (self.epoch, conn), self.reads.clone());
            self.writers.insert(conn, writer);
            self.peers.insert(conn, from);
        }
    }

    fn finish(&mut self, token: u64, result: Result<(), ErrorCode>) {
        if let Some(p) = self.pending.remove(&token) {
            let actions = self.target.finish_command(p.conn, p.request, result);
            self.carry_out(actions);
        }
    }

    fn handle(&mut self, input: Input) {
        let now = clock::now();
        let actions = match input {
            Input::Accepted(stream, from) => {
                self.accept(stream, from, now);
                Vec::new()
            }
            Input::Answer(request, answer) => match core_request(self.epoch, request) {
                Some(request) => self.target.answer(request, answer, now),
                // Asked before a new identity.
                None => Vec::new(),
            },
            Input::Disconnect(session_id) => self.target.disconnect(&session_id),
            Input::Settings(settings) => self.target.update_settings(settings, now),
            Input::ResetIdentity(key) => {
                // The old target's goodbyes and hidden dialogs go out under
                // its own epoch.
                let goodbye = self.target.shutdown();
                self.carry_out(goodbye);
                let settings = self.target.settings().clone();
                self.key = key;
                self.target = Target::new(self.key.clone(), self.device_type, settings);
                self.epoch += 1;
                self.pending.clear();
                vec![
                    Action::Advertise(self.target.discovery_record()),
                    Action::SessionsChanged(Vec::new()),
                ]
            }
            Input::State(state) => self.target.set_state(*state, now),
            Input::Finished(token, result) => {
                self.finish(token, result);
                Vec::new()
            }
            Input::CatalogDone(epoch, conn, request, page) => {
                self.catalog_jobs.remove(&(epoch, conn));
                if epoch == self.epoch {
                    self.target.finish_catalog(conn, request, page)
                } else {
                    Vec::new()
                }
            }
            Input::Sessions(reply) => {
                let _ = reply.send(self.target.sessions());
                Vec::new()
            }
            Input::Shutdown(_) => unreachable!("run handles Shutdown"),
        };
        self.carry_out(actions);
    }

    fn carry_out(&mut self, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Send { conn, bytes } => {
                    let sent = self.writers.get(&conn).map(|w| w.send(bytes));
                    if sent == Some(Err(Backlogged)) {
                        tracing::info!("[remote] a controller reads too slowly; closing it");
                        self.writers.remove(&conn);
                        self.peers.remove(&conn);
                        let actions = self.target.disconnected(conn, clock::now());
                        self.carry_out(actions);
                    }
                }
                Action::Close { conn } => {
                    // The writer flushes what's queued, then closes.
                    self.writers.remove(&conn);
                    self.peers.remove(&conn);
                    self.pending.retain(|_, p| p.conn != conn);
                }
                Action::ShowConsent(prompt) => self.host.show_consent(&ConsentPrompt {
                    request: app_request(self.epoch, prompt.request),
                    ..prompt
                }),
                Action::HideConsent(request) => {
                    self.host.hide_consent(app_request(self.epoch, request))
                }
                Action::SessionsChanged(sessions) => self.host.sessions_changed(&sessions),
                Action::Apply {
                    conn,
                    request,
                    command,
                } => {
                    self.next_token += 1;
                    let token = self.next_token;
                    self.pending.insert(
                        token,
                        Pending {
                            conn,
                            request,
                            deadline: clock::now() + self.limits.command_timeout,
                        },
                    );
                    self.host.apply(token, &command);
                }
                Action::Catalog {
                    conn,
                    request,
                    query,
                } => {
                    let job = (self.epoch, conn);
                    if self.catalog_jobs.contains(&job)
                        || self.catalog_jobs.len() >= MAX_CATALOG_JOBS
                    {
                        let actions =
                            self.target
                                .finish_catalog(conn, request, Err(ErrorCode::RateLimited));
                        self.carry_out(actions);
                        continue;
                    }
                    self.catalog_jobs.insert(job);
                    let host = self.host.clone();
                    let inbox = self.inbox.clone();
                    let epoch = self.epoch;
                    tokio::task::spawn_blocking(move || {
                        let page = host.catalog(query);
                        let _ = inbox.send(Input::CatalogDone(epoch, conn, request, page));
                    });
                }
                Action::Advertise(record) => self.advertise(record),
            }
        }
    }

    fn advertise(&self, record: Option<DiscoveryRecord>) {
        self.host
            .advertise(record.map(|r| registration(r, &self.key, self.port)));
    }
}

/// The id the webview knows a consent request by: the core's, with the
/// epoch on top, so an answer from before a new identity can't answer a
/// request of the new one.
fn app_request(epoch: Epoch, request: RequestId) -> RequestId {
    // mutants: skip BinaryOperator: the two halves share no bits, so | and ^ give the same.
    (epoch << 32) | (request & u64::from(u32::MAX))
}

/// The core's id for a request the webview names, if it's from `epoch`.
fn core_request(epoch: Epoch, request: RequestId) -> Option<RequestId> {
    (request >> 32 == epoch).then_some(request & u64::from(u32::MAX))
}

/// What the per-address limit counts as one address: an IPv4 address, or
/// the /64 an IPv6 address is in, since one host can take any address in it.
fn address_group(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

/// The DNS-SD registration for the core's record. The SRV host is the
/// device id, so the machine's own host name isn't published.
fn registration(record: DiscoveryRecord, key: &DeviceKey, port: u16) -> Registration {
    Registration {
        service_type: SERVICE_TYPE.to_owned(),
        instance: record.instance,
        host_label: key.device_id().to_string(),
        port,
        txt: Txt::new(record.txt),
    }
}

#[cfg(test)]
#[path = "target_tests.rs"]
mod tests;
