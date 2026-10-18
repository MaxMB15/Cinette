// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! This device controlling another: one task per target, owning the core's
//! [`Controller`].
//!
//! The task connects, runs the handshake, waits for the target's answer and
//! then passes commands and catalog queries through, with a ping when
//! nothing else went out for 10 s. When the connection drops without the
//! target closing it, the task reconnects with the session id, so the
//! session resumes without a dialog, for as long as the target keeps it
//! (30 s, counted with time asleep). After that it gives up: control never
//! comes back silently once a session has ended.

use super::clock;
use super::conn::{self, Read, Writer};
use mvp_core::remote::catalog::{CatalogItem, CatalogQuery};
use mvp_core::remote::controller::{Controller, Event, PING_INTERVAL};
use mvp_core::remote::identity::{DeviceId, DeviceKey};
use mvp_core::remote::message::{CloseReason, Command, ErrorCode, Hello, VersionedState};
use mvp_core::remote::target::IDLE_TIMEOUT;
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

/// How long one connection attempt may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The waits between reconnection attempts. The last one repeats.
const BACKOFF: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
];

/// The wait before reconnection attempt `attempt + 1`.
fn backoff(attempt: u32) -> Duration {
    let last = BACKOFF[BACKOFF.len() - 1];
    BACKOFF.get(attempt as usize).copied().unwrap_or(last)
}

/// How long a connection waits for things.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    /// How long the handshake may take once connected.
    pub handshake: Duration,
    /// How long the link stays quiet before it pings.
    pub ping: Duration,
}

impl Timeouts {
    pub const STANDARD: Self = Self {
        handshake: Duration::from_secs(10),
        ping: PING_INTERVAL,
    };
}
/// The longest the task sleeps without looking at the clock, so a sleep of
/// the whole computer is noticed soon after it wakes.
const MAX_NAP: Duration = Duration::from_secs(2);

/// Where the connection stands, as `remote://controller` reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Phase {
    Connecting,
    /// The handshake is done. Both screens show this code.
    Verifying {
        code: String,
    },
    /// The target is asking its user.
    Pending {
        expires_in_ms: u64,
    },
    Connected,
    /// The connection dropped, and the session can still resume.
    Reconnecting {
        attempt: u32,
    },
    /// It's over. `reason` is the target's, or one of the local ones.
    Closed {
        reason: Ended,
    },
}

/// Why a connection ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ended {
    /// The target or the handshake closed it, for this reason.
    Target(CloseReason),
    /// No address of the device answered.
    Unreachable,
    /// The connection dropped and didn't come back in time.
    Lost,
    /// This device left.
    Left,
}

/// What the task tells the app. `link` is the [`LinkConfig::generation`]
/// of the link that says it, so the app can ignore one it already replaced.
pub trait LinkHost: Send + Sync + 'static {
    fn phase(&self, link: u64, device: &DeviceId, phase: &Phase);
    fn state(&self, link: u64, device: &DeviceId, state: &VersionedState);
}

/// Where to reach the target. Asked again before each attempt, since its
/// address may change while the connection is down.
pub type Addresses = Arc<dyn Fn() -> Vec<SocketAddr> + Send + Sync>;

/// A catalog page, or why there isn't one.
pub type Page = Result<(Vec<CatalogItem>, Option<String>), LinkError>;

/// Why a command or query got no answer from the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkError {
    /// The target refused it with this code.
    Refused(ErrorCode),
    /// There's no session right now.
    NotConnected,
}

enum Input {
    Command(Command, oneshot::Sender<Result<u64, LinkError>>),
    Catalog(CatalogQuery, oneshot::Sender<Page>),
    Leave(oneshot::Sender<()>),
}

/// Talks to a running link.
#[derive(Clone)]
pub struct LinkHandle {
    inbox: mpsc::UnboundedSender<Input>,
    generation: u64,
}

impl LinkHandle {
    /// The number it was started with.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Sends a command. Resolves with the target's state version once it
    /// carried it out.
    pub async fn command(&self, command: Command) -> Result<u64, LinkError> {
        let (tx, rx) = oneshot::channel();
        self.inbox
            .send(Input::Command(command, tx))
            .map_err(|_| LinkError::NotConnected)?;
        rx.await.unwrap_or(Err(LinkError::NotConnected))
    }

    pub async fn catalog(&self, query: CatalogQuery) -> Page {
        let (tx, rx) = oneshot::channel();
        self.inbox
            .send(Input::Catalog(query, tx))
            .map_err(|_| LinkError::NotConnected)?;
        rx.await.unwrap_or(Err(LinkError::NotConnected))
    }

    /// Stops asking, or ends the session. The target keeps playing.
    pub async fn leave(&self) {
        let (tx, rx) = oneshot::channel();
        if self.inbox.send(Input::Leave(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

#[cfg(test)]
impl LinkHandle {
    /// A handle with no link behind it, for tests of what holds one.
    pub(crate) fn detached(generation: u64) -> Self {
        let (inbox, _) = mpsc::unbounded_channel();
        Self { inbox, generation }
    }
}

/// Everything a link needs to connect.
pub struct LinkConfig {
    pub key: DeviceKey,
    pub hello: Hello,
    pub target: DeviceId,
    pub addresses: Addresses,
    /// How long after a drop the session can still resume: the target's
    /// [`mvp_core::remote::sessions::RESUME_GRACE`].
    pub grace: Duration,
    /// A number that tells this link from earlier ones to the same device.
    pub generation: u64,
    pub timeouts: Timeouts,
}

/// Starts connecting to a target.
pub fn start(config: LinkConfig, host: Arc<dyn LinkHost>) -> LinkHandle {
    let (inbox, rx) = mpsc::unbounded_channel();
    let generation = config.generation;
    tokio::spawn(run(config, host, rx));
    LinkHandle { inbox, generation }
}

/// How one connection ended.
enum Outcome {
    /// For good, for this reason.
    Ended(Ended),
    /// It dropped. The session, if there is one, may resume.
    Dropped,
}

async fn run(
    config: LinkConfig,
    host: Arc<dyn LinkHost>,
    mut inbox: mpsc::UnboundedReceiver<Input>,
) {
    let device = config.target.clone();
    let link = config.generation;
    let mut session: Option<String> = None;
    let mut dropped_at: Option<Instant> = None;
    let mut attempt: u32 = 0;
    loop {
        host.phase(
            link,
            &device,
            &if attempt == 0 {
                Phase::Connecting
            } else {
                Phase::Reconnecting { attempt }
            },
        );
        let outcome = match connect_any(&(config.addresses)()).await {
            Some(stream) => {
                let mut session_back = false;
                let result = connection(
                    &config,
                    &host,
                    stream,
                    &mut session,
                    &mut session_back,
                    &mut inbox,
                )
                .await;
                if session_back {
                    // The session came back, so a later drop starts afresh.
                    dropped_at = None;
                    attempt = 0;
                }
                result
            }
            None if session.is_some() => Outcome::Dropped,
            None => Outcome::Ended(Ended::Unreachable),
        };
        let ended = match outcome {
            Outcome::Ended(ended) => Some(ended),
            Outcome::Dropped if session.is_none() => Some(Ended::Lost),
            Outcome::Dropped => {
                let since = *dropped_at.get_or_insert_with(clock::now);
                let wait = backoff(attempt);
                if clock::now() + wait >= since + config.grace {
                    Some(Ended::Lost)
                } else {
                    attempt += 1;
                    match wait_or_leave(wait, &mut inbox).await {
                        true => Some(Ended::Left),
                        false => None,
                    }
                }
            }
        };
        if let Some(reason) = ended {
            host.phase(link, &device, &Phase::Closed { reason });
            return;
        }
    }
}

/// Waits before the next attempt, answering what comes in meanwhile. True
/// when this device left.
async fn wait_or_leave(wait: Duration, inbox: &mut mpsc::UnboundedReceiver<Input>) -> bool {
    let until = tokio::time::Instant::now() + wait;
    loop {
        tokio::select! {
            input = inbox.recv() => match input {
                None => return true,
                Some(Input::Leave(done)) => {
                    let _ = done.send(());
                    return true;
                }
                // Dropping a request answers it with NotConnected.
                Some(_) => {}
            },
            () = tokio::time::sleep_until(until) => return false,
        }
    }
}

/// The first of `addrs` that takes a connection.
async fn connect_any(addrs: &[SocketAddr]) -> Option<TcpStream> {
    for addr in addrs {
        if let Ok(Ok(stream)) =
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await
        {
            return Some(stream);
        }
    }
    None
}

enum Waiting {
    Command(oneshot::Sender<Result<u64, LinkError>>),
    Catalog(oneshot::Sender<Page>),
}

/// One connection, from the handshake until it ends.
async fn connection(
    config: &LinkConfig,
    host: &Arc<dyn LinkHost>,
    stream: TcpStream,
    session: &mut Option<String>,
    session_back: &mut bool,
    inbox: &mut mpsc::UnboundedReceiver<Input>,
) -> Outcome {
    let device = &config.target;
    let link = config.generation;
    let (mut controller, first) = match Controller::connect(
        &config.key,
        config.hello.clone(),
        config.target.clone(),
        session.clone(),
    ) {
        Ok(started) => started,
        Err(reason) => return Outcome::Ended(Ended::Target(reason)),
    };
    let (reads_tx, mut reads) = mpsc::unbounded_channel();
    let writer: Writer = conn::spawn(stream, (), reads_tx);
    let _ = writer.send(first);
    let opened = clock::now();
    let mut last_heard = opened;
    let mut last_sent = opened;
    let mut verified = false;
    let mut waiting: HashMap<u64, Waiting> = HashMap::new();

    let finish = |waiting: HashMap<u64, Waiting>| {
        for (_, w) in waiting {
            match w {
                Waiting::Command(reply) => {
                    let _ = reply.send(Err(LinkError::NotConnected));
                }
                Waiting::Catalog(reply) => {
                    let _ = reply.send(Err(LinkError::NotConnected));
                }
            }
        }
    };

    loop {
        tokio::select! {
            read = reads.recv() => {
                let frame = match read {
                    Some(((), Read::Frame(frame))) => frame,
                    _ => {
                        finish(waiting);
                        return Outcome::Dropped;
                    }
                };
                last_heard = clock::now();
                let output = controller.receive(&frame);
                for bytes in output.send {
                    let _ = writer.send(bytes);
                    last_sent = clock::now();
                }
                for event in output.events {
                    match event {
                        Event::Verified { code, .. } => {
                            verified = true;
                            host.phase(link, device, &Phase::Verifying { code: code.to_string() });
                        }
                        Event::Pending { expires_in } => host.phase(
                            link,
                            device,
                            &Phase::Pending { expires_in_ms: u64::from(expires_in) * 1000 },
                        ),
                        Event::Connected { session_id, state } => {
                            *session = Some(session_id);
                            *session_back = true;
                            host.phase(link, device, &Phase::Connected);
                            host.state(link, device, &state);
                        }
                        Event::State(state) => host.state(link, device, &state),
                        Event::Reply { request, result } => {
                            if let Some(Waiting::Command(reply)) = waiting.remove(&request) {
                                let _ = reply.send(result.map_err(LinkError::Refused));
                            }
                        }
                        Event::Page { request, items, next } => {
                            if let Some(Waiting::Catalog(reply)) = waiting.remove(&request) {
                                let _ = reply.send(Ok((items, next)));
                            }
                        }
                        Event::Error(code) => {
                            tracing::warn!("[remote] {device} reported {code:?}");
                        }
                        Event::Closed(reason) => {
                            finish(waiting);
                            // A resume the target no longer knows, after it
                            // restarted, is a new request; it asks again.
                            return Outcome::Ended(Ended::Target(reason));
                        }
                    }
                }
            }
            input = inbox.recv() => match input {
                None => {
                    if let Some(bytes) = controller.leave() {
                        let _ = writer.send(bytes);
                    }
                    finish(waiting);
                    return Outcome::Ended(Ended::Left);
                }
                Some(Input::Leave(done)) => {
                    if let Some(bytes) = controller.leave() {
                        let _ = writer.send(bytes);
                    }
                    finish(waiting);
                    // Dropping the writer flushes the goodbye, then closes.
                    drop(writer);
                    let _ = done.send(());
                    return Outcome::Ended(Ended::Left);
                }
                Some(Input::Command(command, reply)) => match controller.command(command) {
                    Ok((id, bytes)) => {
                        let _ = writer.send(bytes);
                        last_sent = clock::now();
                        waiting.insert(id, Waiting::Command(reply));
                    }
                    Err(_) => {
                        let _ = reply.send(Err(LinkError::NotConnected));
                    }
                },
                Some(Input::Catalog(query, reply)) => match controller.catalog(query) {
                    Ok((id, bytes)) => {
                        let _ = writer.send(bytes);
                        last_sent = clock::now();
                        waiting.insert(id, Waiting::Catalog(reply));
                    }
                    Err(_) => {
                        let _ = reply.send(Err(LinkError::NotConnected));
                    }
                },
            },
            () = tokio::time::sleep(MAX_NAP.min(config.timeouts.ping)) => {}
        }
        let now = clock::now();
        if !verified && now.duration_since(opened) >= config.timeouts.handshake {
            finish(waiting);
            return Outcome::Ended(Ended::Unreachable);
        }
        if verified && now.duration_since(last_heard) >= IDLE_TIMEOUT {
            finish(waiting);
            return Outcome::Dropped;
        }
        if now.duration_since(last_sent) >= config.timeouts.ping
            && let Some(bytes) = controller.ping()
        {
            let _ = writer.send(bytes);
            last_sent = now;
        }
    }
}

#[cfg(test)]
#[path = "link_tests.rs"]
mod tests;
