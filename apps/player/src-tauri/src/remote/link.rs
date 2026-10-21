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

use super::conn::{self, Read, Writer};
use mvp_core::remote::catalog::{CatalogItem, CatalogQuery};
use mvp_core::remote::controller::{AskError, Controller, Event, PING_INTERVAL};
use mvp_core::remote::identity::{DeviceId, DeviceKey};
use mvp_core::remote::message::{CloseReason, Command, ErrorCode, Feature, Hello, VersionedState};
use mvp_core::remote::target::IDLE_TIMEOUT;
use mvp_core::remote::transfer::flow::{
    ControllerEvent, Direction, ProviderName, ProviderSettings,
};
use mvp_core::remote::transfer::merge::Report;
use mvp_core::remote::transfer::{Counts, Export, What};
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

/// How long a connection waits for things, and how much it takes on.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// How long the handshake may take once connected.
    pub handshake: Duration,
    /// How long the link stays quiet before it pings.
    pub ping: Duration,
    /// How long a command or catalog query waits for its answer. The
    /// target gives its player 10 s for a command.
    pub request: Duration,
    /// The most commands and queries waiting for answers at once.
    pub waiting: usize,
    /// The longest the task sleeps without looking at the clock.
    pub nap: Duration,
    /// The wait before reconnection attempt `attempt + 1`.
    pub backoff: fn(attempt: u32) -> Duration,
}

impl Limits {
    pub const STANDARD: Self = Self {
        handshake: Duration::from_secs(10),
        ping: PING_INTERVAL,
        request: Duration::from_secs(15),
        waiting: 32,
        nap: MAX_NAP,
        backoff,
    };
}

/// The most addresses tried in one attempt. A record can list any number.
const MAX_ADDRESSES: usize = 8;

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
        /// The name the other device gave in the handshake, which its
        /// key vouches for, unlike the one discovery found.
        name: String,
        /// What it offers besides control, such as taking providers.
        features: Vec<Feature>,
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
    /// Something about a transfer this device asked for.
    fn transfer(&self, _link: u64, _device: &DeviceId, _event: &ControllerEvent) {}
}

/// Where to reach the target. Asked again before each attempt, since its
/// address may change while the connection is down.
pub type Addresses = Arc<dyn Fn() -> Vec<SocketAddr> + Send + Sync>;

/// The time now, counting time asleep: [`super::clock::now`] outside tests.
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

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
    /// No answer came in time.
    TimedOut,
    /// Too many are waiting for answers already.
    Busy,
}

enum Input {
    Command(Command, oneshot::Sender<Result<u64, LinkError>>),
    Catalog(CatalogQuery, oneshot::Sender<Page>),
    AskProviders(Vec<ProviderName>, oneshot::Sender<Result<(), AskError>>),
    SendProviders(String, Vec<ProviderSettings>),
    CancelTransfer,
    AskHistory(
        Direction,
        What,
        Option<Counts>,
        oneshot::Sender<Result<(), AskError>>,
    ),
    SendExport(String, Box<Result<Export, ErrorCode>>),
    StartImport(String),
    Imported(String, Box<Result<Report, ErrorCode>>),
    Leave(oneshot::Sender<()>),
}

/// Talks to a running link.
#[derive(Clone)]
pub struct LinkHandle {
    inbox: mpsc::UnboundedSender<Input>,
    generation: u64,
    device: DeviceId,
}

impl LinkHandle {
    /// The number it was started with.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The device it's a link to.
    pub fn device(&self) -> &DeviceId {
        &self.device
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

    /// Asks the target to take these providers. Resolves once the request
    /// went out; the answer comes through [`LinkHost::transfer`].
    pub async fn ask_providers(&self, names: Vec<ProviderName>) -> Result<(), AskError> {
        let (tx, rx) = oneshot::channel();
        self.inbox
            .send(Input::AskProviders(names, tx))
            .map_err(|_| AskError::NotConnected)?;
        rx.await.unwrap_or(Err(AskError::NotConnected))
    }

    /// Sends the providers' settings after the target allowed them.
    pub fn send_providers(&self, grant: String, providers: Vec<ProviderSettings>) {
        let _ = self.inbox.send(Input::SendProviders(grant, providers));
    }

    /// Stops the transfer asked for or running. Nothing is written.
    pub fn cancel_transfer(&self) {
        let _ = self.inbox.send(Input::CancelTransfer);
    }

    /// Asks the target for a history transfer. Resolves once the request
    /// went out; the answer comes through [`LinkHost::transfer`].
    pub async fn ask_history(
        &self,
        direction: Direction,
        what: What,
        counts: Option<Counts>,
    ) -> Result<(), AskError> {
        let (tx, rx) = oneshot::channel();
        self.inbox
            .send(Input::AskHistory(direction, what, counts, tx))
            .map_err(|_| AskError::NotConnected)?;
        rx.await.unwrap_or(Err(AskError::NotConnected))
    }

    /// "Send": this device's export, after the target allowed it.
    pub fn send_export(&self, transfer: String, export: Result<Export, ErrorCode>) {
        let _ = self
            .inbox
            .send(Input::SendExport(transfer, Box::new(export)));
    }

    /// "Import": the user confirmed the preview.
    pub fn start_import(&self, transfer: String) {
        let _ = self.inbox.send(Input::StartImport(transfer));
    }

    /// "Import": what writing it here did.
    pub fn imported(&self, transfer: String, result: Result<Report, ErrorCode>) {
        let _ = self.inbox.send(Input::Imported(transfer, Box::new(result)));
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
    pub(crate) fn detached(generation: u64, device: DeviceId) -> Self {
        let (inbox, _) = mpsc::unbounded_channel();
        Self {
            inbox,
            generation,
            device,
        }
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
    /// A number that tells this link from earlier ones. The webview picks
    /// it; its events carry it.
    pub generation: u64,
    pub limits: Limits,
    pub clock: Clock,
}

/// Starts connecting to a target.
pub fn start(config: LinkConfig, host: Arc<dyn LinkHost>) -> LinkHandle {
    let (inbox, rx) = mpsc::unbounded_channel();
    let generation = config.generation;
    let device = config.target.clone();
    tokio::spawn(run(config, host, rx));
    LinkHandle {
        inbox,
        generation,
        device,
    }
}

/// How one connection ended.
enum Outcome {
    /// For good, for this reason.
    Ended(Ended),
    /// The address didn't turn out to be the device: it closed, said
    /// nothing, broke the handshake or had another key, for this reason.
    NotThere(Ended),
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
        let addresses: Vec<SocketAddr> = (config.addresses)()
            .into_iter()
            .take(MAX_ADDRESSES)
            .collect();
        // An address that doesn't turn out to be the device, such as one
        // with someone else's key, is passed over for the next.
        let mut from = 0;
        let mut why_not: Option<Ended> = None;
        let outcome = loop {
            break match connect_any(&addresses[from..], &mut inbox).await {
                Reached::Left => Outcome::Ended(Ended::Left),
                Reached::Stream(stream, at) => {
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
                    if let Outcome::NotThere(why) = result {
                        why_not = Some(more_telling(why_not, why));
                        from += at + 1;
                        continue;
                    }
                    result
                }
                // During a resume, discovery may find the right address yet.
                Reached::Nowhere if session.is_some() => Outcome::Dropped,
                Reached::Nowhere => Outcome::Ended(why_not.unwrap_or(Ended::Unreachable)),
            };
        };
        let ended = match outcome {
            Outcome::Ended(ended) => Some(ended),
            Outcome::NotThere(_) => unreachable!("the loop above tries the next address"),
            Outcome::Dropped if session.is_none() => Some(Ended::Lost),
            Outcome::Dropped => {
                let since = *dropped_at.get_or_insert_with(|| (config.clock)());
                let left = (since + config.grace).saturating_duration_since((config.clock)());
                if left.is_zero() {
                    Some(Ended::Lost)
                } else {
                    // The last try comes as the grace runs out.
                    let wait = (config.limits.backoff)(attempt).min(left);
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

/// The more telling of two reasons no address was the device: the other
/// device's own reason, then a connection that closed, then none answering.
fn more_telling(old: Option<Ended>, new: Ended) -> Ended {
    let rank = |e: &Ended| match e {
        Ended::Target(_) => 2,
        Ended::Lost => 1,
        _ => 0,
    };
    match old {
        Some(old) if rank(&old) >= rank(&new) => old,
        _ => new,
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

/// How a connection attempt ended.
enum Reached {
    /// Connected to the address at this index.
    Stream(TcpStream, usize),
    Nowhere,
    /// This device left meanwhile.
    Left,
}

/// The first of `addrs` that takes a connection. Leaving stops it at once.
async fn connect_any(addrs: &[SocketAddr], inbox: &mut mpsc::UnboundedReceiver<Input>) -> Reached {
    for (at, addr) in addrs.iter().enumerate() {
        let attempt = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr));
        tokio::pin!(attempt);
        loop {
            tokio::select! {
                result = &mut attempt => {
                    if let Ok(Ok(stream)) = result {
                        return Reached::Stream(stream, at);
                    }
                    break;
                }
                input = inbox.recv() => match input {
                    None => return Reached::Left,
                    Some(Input::Leave(done)) => {
                        let _ = done.send(());
                        return Reached::Left;
                    }
                    // Dropping a request answers it with NotConnected.
                    Some(_) => {}
                },
            }
        }
    }
    Reached::Nowhere
}

enum Waiting {
    Command(oneshot::Sender<Result<u64, LinkError>>),
    Catalog(oneshot::Sender<Page>),
}

impl Waiting {
    fn fail(self, error: LinkError) {
        match self {
            Waiting::Command(reply) => {
                let _ = reply.send(Err(error));
            }
            Waiting::Catalog(reply) => {
                let _ = reply.send(Err(error));
            }
        }
    }
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
        (config.clock)(),
    ) {
        Ok(started) => started,
        Err(reason) => return Outcome::Ended(Ended::Target(reason)),
    };
    let (reads_tx, mut reads) = mpsc::unbounded_channel();
    let writer: Writer = conn::spawn(stream, (), reads_tx);
    let _ = writer.send(first);
    let opened = (config.clock)();
    let mut last_heard = opened;
    let mut last_sent = opened;
    let mut verified = false;
    // What's waiting for an answer, and until when.
    let mut waiting: HashMap<u64, (Waiting, Instant)> = HashMap::new();
    // A resume that goes wrong before the session is back can try again,
    // within the grace, rather than end the session.
    let resuming = session.is_some();
    // A resume skips the code, which was compared already. But a target
    // that restarted no longer knows the session, takes it as a new
    // request and asks again, and then the user needs this code.
    let mut code_for_a_new_request: Option<Phase> = None;

    let finish = |waiting: HashMap<u64, (Waiting, Instant)>| {
        for (_, (w, _)) in waiting {
            w.fail(LinkError::NotConnected);
        }
    };

    loop {
        tokio::select! {
            read = reads.recv() => {
                let frame = match read {
                    Some(((), Read::Frame(frame))) => frame,
                    _ => {
                        finish(waiting);
                        return if verified {
                            Outcome::Dropped
                        } else {
                            Outcome::NotThere(Ended::Lost)
                        };
                    }
                };
                last_heard = (config.clock)();
                let output = controller.receive(&frame, last_heard);
                for bytes in output.send {
                    let _ = writer.send(bytes);
                    last_sent = (config.clock)();
                }
                for event in output.events {
                    match event {
                        Event::Verified { code, peer } => {
                            verified = true;
                            let verifying = Phase::Verifying {
                                code: code.to_string(),
                                name: peer.name,
                                features: peer.features,
                            };
                            if resuming {
                                code_for_a_new_request = Some(verifying);
                            } else {
                                host.phase(link, device, &verifying);
                            }
                        }
                        Event::Pending { expires_in } => {
                            if let Some(verifying) = code_for_a_new_request.take() {
                                host.phase(link, device, &verifying);
                            }
                            host.phase(
                                link,
                                device,
                                &Phase::Pending { expires_in_ms: u64::from(expires_in) * 1000 },
                            );
                        }
                        Event::Connected { session_id, state } => {
                            *session = Some(session_id);
                            *session_back = true;
                            host.phase(link, device, &Phase::Connected);
                            host.state(link, device, &state);
                        }
                        Event::State(state) => host.state(link, device, &state),
                        Event::Reply { request, result } => {
                            if let Some((Waiting::Command(reply), _)) = waiting.remove(&request) {
                                let _ = reply.send(result.map_err(LinkError::Refused));
                            }
                        }
                        Event::Page { request, items, next } => {
                            if let Some((Waiting::Catalog(reply), _)) = waiting.remove(&request) {
                                let _ = reply.send(Ok((items, next)));
                            }
                        }
                        Event::Error(code) => {
                            // The other device can send these as often as it likes.
                            tracing::debug!("[remote] {device} reported {code:?}");
                        }
                        Event::Transfer(event) => host.transfer(link, device, &event),
                        Event::Closed(reason) if !verified => {
                            // Another device is at this address, which it
                            // may have taken over, or claims the target's id
                            // or breaks the handshake.
                            finish(waiting);
                            return Outcome::NotThere(Ended::Target(reason));
                        }
                        Event::Closed(reason) => {
                            finish(waiting);
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
                Some(Input::Command(_, reply)) if waiting.len() >= config.limits.waiting => {
                    let _ = reply.send(Err(LinkError::Busy));
                }
                Some(Input::Catalog(_, reply)) if waiting.len() >= config.limits.waiting => {
                    let _ = reply.send(Err(LinkError::Busy));
                }
                Some(Input::Command(command, reply)) => match controller.command(command) {
                    Ok((id, bytes)) => {
                        let _ = writer.send(bytes);
                        last_sent = (config.clock)();
                        let until = last_sent + config.limits.request;
                        waiting.insert(id, (Waiting::Command(reply), until));
                    }
                    Err(_) => {
                        let _ = reply.send(Err(LinkError::NotConnected));
                    }
                },
                Some(Input::AskProviders(names, reply)) => {
                    let asked = controller.ask_providers(names).map(|bytes| {
                        let _ = writer.send(bytes);
                        last_sent = (config.clock)();
                    });
                    let _ = reply.send(asked);
                }
                Some(Input::SendProviders(grant, providers)) => {
                    let out = controller.send_providers(&grant, providers, (config.clock)());
                    pass_on(out, &writer, &mut last_sent, config, host, link, device);
                }
                Some(Input::AskHistory(direction, what, counts, reply)) => {
                    let asked = controller.ask_history(direction, what, counts).map(|bytes| {
                        let _ = writer.send(bytes);
                        last_sent = (config.clock)();
                    });
                    let _ = reply.send(asked);
                }
                Some(Input::SendExport(transfer, export)) => {
                    let out = controller.send_export(&transfer, *export, (config.clock)());
                    pass_on(out, &writer, &mut last_sent, config, host, link, device);
                }
                Some(Input::StartImport(transfer)) => {
                    let out = controller.start_import(&transfer, (config.clock)());
                    pass_on(out, &writer, &mut last_sent, config, host, link, device);
                }
                Some(Input::Imported(transfer, result)) => {
                    let out = controller.imported(&transfer, *result);
                    pass_on(out, &writer, &mut last_sent, config, host, link, device);
                }
                Some(Input::CancelTransfer) => {
                    let out = controller.cancel_transfer();
                    pass_on(out, &writer, &mut last_sent, config, host, link, device);
                }
                Some(Input::Catalog(query, reply)) => match controller.catalog(query) {
                    Ok((id, bytes)) => {
                        let _ = writer.send(bytes);
                        last_sent = (config.clock)();
                        let until = last_sent + config.limits.request;
                        waiting.insert(id, (Waiting::Catalog(reply), until));
                    }
                    Err(_) => {
                        let _ = reply.send(Err(LinkError::NotConnected));
                    }
                },
            },
            () = tokio::time::sleep(config.limits.nap.min(config.limits.ping)) => {}
        }
        let now = (config.clock)();
        // The core gives up on a handshake or an answer that takes too long.
        let given_up = controller.tick(now);
        for bytes in given_up.send {
            let _ = writer.send(bytes);
        }
        // A transfer running out of time ends only the transfer.
        let mut closed = false;
        for event in given_up.events {
            match event {
                Event::Transfer(event) => host.transfer(link, device, &event),
                _ => closed = true,
            }
        }
        if closed {
            finish(waiting);
            if !verified {
                return Outcome::NotThere(Ended::Unreachable);
            }
            if resuming {
                return Outcome::Dropped;
            }
            return Outcome::Ended(Ended::Target(CloseReason::Timeout));
        }
        if !verified && now.duration_since(opened) >= config.limits.handshake {
            finish(waiting);
            return Outcome::NotThere(Ended::Unreachable);
        }
        let late: Vec<u64> = waiting
            .iter()
            .filter(|(_, (_, until))| *until <= now)
            .map(|(&id, _)| id)
            .collect();
        for id in late {
            if let Some((w, _)) = waiting.remove(&id) {
                w.fail(LinkError::TimedOut);
            }
        }
        if verified && now.duration_since(last_heard) >= IDLE_TIMEOUT {
            finish(waiting);
            return Outcome::Dropped;
        }
        if now.duration_since(last_sent) >= config.limits.ping
            && let Some(bytes) = controller.ping()
        {
            let _ = writer.send(bytes);
            last_sent = now;
        }
    }
}

/// Sends what a transfer step produced, and tells the host its events.
fn pass_on(
    out: mvp_core::remote::controller::Output,
    writer: &Writer,
    last_sent: &mut Instant,
    config: &LinkConfig,
    host: &Arc<dyn LinkHost>,
    link: u64,
    device: &DeviceId,
) {
    for bytes in out.send {
        let _ = writer.send(bytes);
        *last_sent = (config.clock)();
    }
    for event in out.events {
        if let Event::Transfer(event) = event {
            host.transfer(link, device, &event);
        }
    }
}

#[cfg(test)]
#[path = "link_tests.rs"]
mod tests;
