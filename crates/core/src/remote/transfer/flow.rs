// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The steps of one transfer inside a control session, on each side.
//!
//! The controller asks with a `request` that names what it wants. The
//! target's user allows or denies it in a dialog of its own, which Always
//! allow never skips. On Allow the target answers `granted` with a one-time
//! id, and the data follows in chunks that the receiver acknowledges, at
//! most [`WINDOW`] unanswered at a time. The side that writes keeps every
//! chunk until the last one, then writes them all at once, so a transfer cut
//! off on the way leaves both devices as they were.
//!
//! - **History, "send":** the controller's history goes to the target.
//! - **History, "import":** the target's history goes to the controller.
//!   The target exports on Allow, and the grant carries the counts for the
//!   controller's preview. The data only goes once the controller sends
//!   `transferStart`.
//! - **Providers:** the controller names the providers it wants to send.
//!   After Allow, it sends their settings, logins included, and the target
//!   saves them as its own.
//!
//! A refused or failed transfer never ends the control session.

use super::chunks::{self, Assembler, Chunk};
use super::merge::Report;
use super::refs::Salt;
use super::{Counts, Export, What};
use crate::remote::message::{ErrorCode, Message, RequestKind};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fmt;
use std::time::{Duration, Instant};
use zeroize::Zeroize;

/// How long a grant waits for the transfer to start.
pub const GRANT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the receiver waits for the next chunk, or the sender for an
/// acknowledgement or the result.
pub const STEP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long one side waits while the other writes what it was sent, such
/// as a large history or providers whose lists have to load.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(600);
/// The longest a transfer may take from its grant to its last chunk or
/// part, however steadily they come.
pub const TRANSFER_LIMIT: Duration = Duration::from_secs(600);
/// How long a controller waits for the answer to its request: the
/// target's dialog, and a little more.
pub const ASK_TIMEOUT: Duration = Duration::from_secs(45);
/// The length of a transfer or grant id: 16 random bytes in hex.
pub const ID_LEN: usize = 32;

/// Whether a transfer id from the other side has the form this side makes.
/// Anything else is ignored without an answer.
pub fn valid_id(id: &str) -> bool {
    id.len() == ID_LEN && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// How many chunks may wait for an acknowledgement at once.
pub const WINDOW: usize = 4;
/// The most providers one request can name.
pub const MAX_PROVIDERS: usize = 32;
/// The longest provider name a request can carry, in bytes.
pub const MAX_PROVIDER_NAME: usize = 128;
/// The longest URL, username or password a sent provider can have, in bytes.
pub const MAX_PROVIDER_FIELD: usize = 4096;

/// Which way history goes, from the controller's side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// The controller's history goes to the target.
    Send,
    /// The target's history comes to the controller.
    Import,
}

/// What sort of provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    M3u,
    Xtream,
}

/// A provider as a request names it, before any login goes out.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderName {
    pub name: String,
    pub kind: ProviderKind,
}

/// A provider's settings, logins included. They're cleared from memory when
/// the value is dropped, and never printed.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub name: String,
    pub kind: ProviderKind,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epg_url: Option<String>,
}

impl ProviderSettings {
    pub fn named(&self) -> ProviderName {
        ProviderName {
            name: self.name.clone(),
            kind: self.kind,
        }
    }

    fn fits(&self) -> bool {
        let field = |s: &Option<String>| s.as_ref().is_none_or(|s| s.len() <= MAX_PROVIDER_FIELD);
        !self.url.trim().is_empty()
            && self.url.len() <= MAX_PROVIDER_FIELD
            && field(&self.username)
            && field(&self.password)
            && field(&self.epg_url)
    }
}

impl fmt::Debug for ProviderSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderSettings")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl Drop for ProviderSettings {
    // mutants: skip FnValue: clearing memory that's freed right after can't be seen from a test.
    fn drop(&mut self) {
        self.url.zeroize();
        self.username.zeroize();
        self.password.zeroize();
        self.epg_url.zeroize();
    }
}

/// What became of one sent provider on the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderOutcome {
    Added,
    /// The target already has that account.
    Exists,
    /// Its list didn't load on the target, so it wasn't saved.
    Failed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    pub name: String,
    pub outcome: ProviderOutcome,
    /// What the user sees when it failed. Never a URL or a login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The name it was saved under, when another provider had its name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_as: Option<String>,
}

/// What a controller asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum Asked {
    History {
        direction: Direction,
        what: What,
        /// The controller's own counts, for the dialog. Only for "send".
        counts: Option<Counts>,
    },
    Providers(Vec<ProviderName>),
}

/// Whether a provider name can go in a request: not blank, within
/// [`MAX_PROVIDER_NAME`], with no outer spaces and no control or format
/// characters, so the other device's dialog shows it as it is.
pub fn provider_name_ok(name: &str) -> bool {
    let shown = |c: char| {
        !c.is_control()
            && !matches!(c, '\u{2028}' | '\u{2029}')
            && !crate::remote::settings::is_format(c)
    };
    name.len() <= MAX_PROVIDER_NAME
        && !name.trim().is_empty()
        && name.trim() == name
        && name.chars().all(shown)
}

impl Asked {
    pub fn kind(&self) -> RequestKind {
        match self {
            Asked::History { .. } => RequestKind::History,
            Asked::Providers(_) => RequestKind::Providers,
        }
    }

    /// The `request` message for it.
    pub fn request(&self, id: u64) -> Message {
        let (direction, what, counts, providers) = match self {
            Asked::History {
                direction,
                what,
                counts,
            } => (Some(*direction), Some(*what), *counts, None),
            Asked::Providers(names) => (None, None, None, Some(names.clone())),
        };
        Message::Request {
            kind: self.kind(),
            resume: None,
            id: Some(id),
            direction,
            what,
            counts,
            providers,
        }
    }

    /// Reads a `request` for history or providers. `None` when it's
    /// incomplete or asks for nothing.
    pub fn from_request(message: &Message) -> Option<(u64, Asked)> {
        let Message::Request {
            kind,
            id: Some(id),
            direction,
            what,
            counts,
            providers,
            ..
        } = message
        else {
            return None;
        };
        let asked = match kind {
            RequestKind::History => {
                let what = (*what)?;
                if what.is_empty() {
                    return None;
                }
                let direction = (*direction)?;
                Asked::History {
                    direction,
                    what,
                    counts: counts.filter(|_| direction == Direction::Send),
                }
            }
            RequestKind::Providers => {
                let names = providers.as_ref()?;
                let fits = |p: &ProviderName| provider_name_ok(&p.name);
                if names.is_empty() || names.len() > MAX_PROVIDERS || !names.iter().all(fits) {
                    return None;
                }
                Asked::Providers(names.clone())
            }
            RequestKind::Control => return None,
        };
        Some((*id, asked))
    }
}

/// How far a transfer has got, for the UI on either side.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "state",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Progress {
    /// Chunks sent and acknowledged, out of all of them.
    Sending { done: u32, total: u32 },
    /// Chunks received so far. The total isn't known until the last.
    Receiving { received: u32 },
    /// Every chunk is in. Saving.
    Saving,
    /// Written on the other device.
    Done(Box<Report>),
    /// Providers saved on the target.
    ProvidersDone(Vec<ProviderResult>),
    /// It stopped before the end, and nothing was written.
    Failed(ErrorCode),
}

/// Something one side of a transfer needs done.
#[derive(Debug, PartialEq)]
pub enum Step {
    Send(Box<Message>),
    /// Save this device's playback position, then export its history under
    /// `salt` with only `what`, and pass it to `exported`.
    Export {
        transfer: String,
        salt: Salt,
        what: What,
    },
    /// Match the export against this device's catalog under `salt`, write
    /// it in one transaction, and pass the report to `imported`.
    Import {
        transfer: String,
        salt: Salt,
        export: Box<Export>,
    },
    /// Save these providers as this device's own, and pass the results to
    /// `providers_saved`.
    SaveProviders {
        grant: String,
        providers: Vec<ProviderSettings>,
    },
    Progress {
        transfer: String,
        kind: RequestKind,
        progress: Progress,
    },
}

fn send(message: Message) -> Step {
    Step::Send(Box::new(message))
}

/// A new random grant id.
pub fn new_grant() -> String {
    crate::remote::to_hex(&crate::remote::random_bytes::<16>())
}

/// Sends chunks as acknowledgements come back.
#[derive(Debug)]
pub struct Sender {
    transfer: String,
    queue: VecDeque<Chunk>,
    total: u32,
    sent: u32,
    acked: u32,
    deadline: Instant,
}

/// This device's clock, in Unix seconds, for the times in a transfer. The
/// rest of the protocol only needs `Instant`s.
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

impl Sender {
    /// Splits the export now, so the first chunk carries this device's
    /// clock as it goes out.
    fn new(transfer: String, export: &Export, now: Instant) -> Self {
        let (chunks, _) = chunks::split(export, unix_now());
        Self {
            transfer,
            total: u32::try_from(chunks.len()).unwrap_or(u32::MAX),
            queue: chunks.into(),
            sent: 0,
            acked: 0,
            deadline: now + STEP_TIMEOUT,
        }
    }

    /// Sends what the window has room for.
    fn fill(&mut self, steps: &mut Vec<Step>) {
        while (self.sent - self.acked) < WINDOW as u32 {
            let Some(chunk) = self.queue.pop_front() else {
                break;
            };
            self.sent += 1;
            steps.push(send(Message::TransferChunk {
                transfer: self.transfer.clone(),
                chunk,
            }));
        }
    }

    /// An acknowledgement. `Err` when it doesn't fit what was sent.
    fn ack(&mut self, seq: u32, now: Instant, steps: &mut Vec<Step>) -> Result<(), ()> {
        if seq != self.acked || self.acked >= self.sent {
            return Err(());
        }
        self.acked += 1;
        self.deadline = now + STEP_TIMEOUT;
        self.fill(steps);
        Ok(())
    }

    fn all_acked(&self) -> bool {
        self.acked == self.total
    }
}

/// Keeps chunks until the last one, and takes only what was granted.
#[derive(Debug)]
pub struct Receiver {
    transfer: String,
    salt: Salt,
    /// What the user allowed.
    what: What,
    /// The counts the dialog or preview showed, when there were some.
    counts: Option<Counts>,
    assembler: Assembler,
    received: u32,
    deadline: Instant,
    /// The end of [`TRANSFER_LIMIT`].
    until: Instant,
}

/// What became of a chunk.
enum Received {
    More(Message),
    Last(Message, Box<Export>),
    Broken(ErrorCode),
}

/// The most an export may carry of a count it announced: a little more,
/// since it may have watched something since.
fn allowed(announced: u32) -> u32 {
    announced.saturating_add(announced / 10).saturating_add(50)
}

/// Whether an export carries only the parts the user allowed, and not
/// far more than the counts they were shown.
fn fits_grant(export: &Export, what: What, counts: Option<Counts>) -> bool {
    let kinds = export.items.iter().all(|i| {
        (what.history || (i.watched.is_none() && i.position.is_none()))
            && (what.favorites || !i.favorite)
    }) && (what.pins || export.pins.is_empty());
    let sizes = counts.is_none_or(|c| {
        let got = export.counts();
        got.history <= allowed(c.history)
            && got.positions <= allowed(c.positions)
            && got.favorites <= allowed(c.favorites)
            && got.pins <= allowed(c.pins)
    });
    kinds && sizes
}

impl Receiver {
    fn new(transfer: String, salt: Salt, what: What, counts: Option<Counts>, now: Instant) -> Self {
        Self {
            transfer,
            salt,
            what,
            counts,
            assembler: Assembler::new(),
            received: 0,
            deadline: now + GRANT_TIMEOUT,
            until: now + TRANSFER_LIMIT,
        }
    }

    fn push(&mut self, chunk: Chunk, bytes: usize, now: Instant) -> Received {
        let seq = chunk.seq;
        let ack = Message::TransferAck {
            transfer: self.transfer.clone(),
            seq,
        };
        match self.assembler.push(chunk, bytes, unix_now()) {
            Ok(None) => {
                self.received += 1;
                self.deadline = now + STEP_TIMEOUT;
                Received::More(ack)
            }
            Ok(Some(export)) if fits_grant(&export, self.what, self.counts) => {
                Received::Last(ack, Box::new(export))
            }
            Ok(Some(_)) => Received::Broken(ErrorCode::Invalid),
            Err(chunks::AssembleError::TooLarge) => Received::Broken(ErrorCode::TooLarge),
            Err(_) => Received::Broken(ErrorCode::Invalid),
        }
    }

    fn deadline(&self) -> Instant {
        self.deadline.min(self.until)
    }

    /// Nothing has come yet.
    fn untouched(&self) -> bool {
        self.received == 0
    }
}

fn progress(transfer: &str, kind: RequestKind, progress: Progress) -> Step {
    Step::Progress {
        transfer: transfer.to_string(),
        kind,
        progress,
    }
}

fn transfer_error(transfer: &str, code: ErrorCode) -> Step {
    send(Message::TransferError {
        transfer: transfer.to_string(),
        code,
    })
}

/// The target's side of one transfer.
#[derive(Debug)]
pub enum TargetFlow {
    /// Waiting for the user to answer the dialog.
    Asking { id: u64, asked: Asked },
    /// History coming from the controller.
    Receiving(Box<Receiver>),
    /// Writing it.
    Importing { transfer: String },
    /// Exporting history for the controller.
    Exporting {
        id: u64,
        transfer: String,
        salt: Salt,
        deadline: Instant,
    },
    /// Exported, until the controller says to start. It's split into
    /// chunks only then, so its clock is the time it goes.
    Ready {
        transfer: String,
        export: Box<Export>,
        deadline: Instant,
    },
    /// Sending history to the controller.
    Sending(Box<Sender>),
    /// All sent, waiting for the controller's result.
    Finishing { transfer: String, deadline: Instant },
    /// Waiting for the providers' settings.
    Providers {
        grant: String,
        names: Vec<ProviderName>,
        received: Vec<ProviderSettings>,
        next_part: u32,
        deadline: Instant,
        /// The end of [`TRANSFER_LIMIT`].
        until: Instant,
    },
    /// Saving the providers.
    Saving { grant: String },
}

impl TargetFlow {
    /// The request waiting for an answer, once the dialog is up.
    pub fn asked(&self) -> Option<&Asked> {
        match self {
            TargetFlow::Asking { asked, .. } => Some(asked),
            _ => None,
        }
    }

    /// The user allowed the request. `None` when there's nothing more to do.
    pub fn granted(self, now: Instant, steps: &mut Vec<Step>) -> Option<TargetFlow> {
        let TargetFlow::Asking { id, asked } = self else {
            return Some(self);
        };
        let transfer = new_grant();
        let salt = Salt::generate();
        match asked {
            Asked::History {
                direction: Direction::Send,
                what,
                counts,
            } => {
                steps.push(send(Message::Granted {
                    re: id,
                    transfer: transfer.clone(),
                    salt: Some(salt.to_hex()),
                    counts: None,
                }));
                Some(TargetFlow::Receiving(Box::new(Receiver::new(
                    transfer, salt, what, counts, now,
                ))))
            }
            Asked::History {
                direction: Direction::Import,
                what,
                ..
            } => {
                steps.push(Step::Export {
                    transfer: transfer.clone(),
                    salt,
                    what,
                });
                Some(TargetFlow::Exporting {
                    id,
                    transfer,
                    salt,
                    deadline: now + GRANT_TIMEOUT,
                })
            }
            Asked::Providers(names) => {
                steps.push(send(Message::Granted {
                    re: id,
                    transfer: transfer.clone(),
                    salt: None,
                    counts: None,
                }));
                Some(TargetFlow::Providers {
                    grant: transfer,
                    names,
                    received: Vec::new(),
                    next_part: 0,
                    deadline: now + GRANT_TIMEOUT,
                    until: now + TRANSFER_LIMIT,
                })
            }
        }
    }

    /// The user didn't allow it, for this reason.
    pub fn refused(self, code: ErrorCode, steps: &mut Vec<Step>) {
        if let TargetFlow::Asking { id, .. } = self {
            steps.push(send(Message::Error { re: Some(id), code }));
        }
    }

    /// The export for an import is ready, or couldn't be made.
    pub fn exported(
        self,
        transfer: &str,
        export: Result<Export, ErrorCode>,
        now: Instant,
        steps: &mut Vec<Step>,
    ) -> Option<TargetFlow> {
        match self {
            TargetFlow::Exporting {
                id,
                transfer: t,
                salt,
                ..
            } if t == transfer => match export {
                Ok(export) if !chunks::within_limits(&export) => {
                    steps.push(send(Message::Error {
                        re: Some(id),
                        code: ErrorCode::TooLarge,
                    }));
                    None
                }
                Ok(export) => {
                    steps.push(send(Message::Granted {
                        re: id,
                        transfer: t.clone(),
                        salt: Some(salt.to_hex()),
                        counts: Some(export.counts()),
                    }));
                    Some(TargetFlow::Ready {
                        transfer: t,
                        export: Box::new(export),
                        deadline: now + GRANT_TIMEOUT,
                    })
                }
                Err(code) => {
                    steps.push(send(Message::Error { re: Some(id), code }));
                    None
                }
            },
            other => Some(other),
        }
    }

    /// The import was written, or failed.
    pub fn imported(
        self,
        transfer: &str,
        result: Result<Report, ErrorCode>,
        steps: &mut Vec<Step>,
    ) -> Option<TargetFlow> {
        match self {
            TargetFlow::Importing { transfer: t } if t == transfer => {
                match result {
                    Ok(report) => {
                        steps.push(send(Message::TransferDone {
                            transfer: t.clone(),
                            report: report.clone(),
                        }));
                        steps.push(progress(
                            &t,
                            RequestKind::History,
                            Progress::Done(Box::new(report)),
                        ));
                    }
                    Err(code) => {
                        steps.push(transfer_error(&t, code));
                        steps.push(progress(&t, RequestKind::History, Progress::Failed(code)));
                    }
                }
                None
            }
            other => Some(other),
        }
    }

    /// The providers were saved.
    pub fn providers_saved(
        self,
        grant: &str,
        results: Vec<ProviderResult>,
        steps: &mut Vec<Step>,
    ) -> Option<TargetFlow> {
        match self {
            TargetFlow::Saving { grant: g } if g == grant => {
                steps.push(send(Message::ProvidersAdded {
                    grant: g.clone(),
                    results: results.clone(),
                }));
                steps.push(progress(
                    &g,
                    RequestKind::Providers,
                    Progress::ProvidersDone(results),
                ));
                None
            }
            other => Some(other),
        }
    }

    /// A transfer message from the controller. `bytes` is the size of the
    /// frame it came in. Returns `Err` with the flow unchanged when the
    /// message isn't part of a transfer.
    pub fn receive(
        self,
        message: Message,
        bytes: usize,
        now: Instant,
        steps: &mut Vec<Step>,
    ) -> Result<Option<TargetFlow>, Box<(TargetFlow, Message)>> {
        let id_of = |m: &Message| match m {
            Message::TransferChunk { transfer, .. }
            | Message::TransferStart { transfer }
            | Message::TransferAck { transfer, .. }
            | Message::TransferDone { transfer, .. }
            | Message::TransferError { transfer, .. }
            | Message::TransferCancel { transfer } => Some(transfer.clone()),
            Message::ProvidersSend { grant, .. } => Some(grant.clone()),
            _ => None,
        };
        let Some(id) = id_of(&message) else {
            return Err(Box::new((self, message)));
        };
        if self.transfer() != Some(id.as_str()) {
            // Not this transfer: maybe one that ended a moment ago.
            if !matches!(
                message,
                Message::TransferError { .. } | Message::TransferCancel { .. }
            ) {
                steps.push(transfer_error(&id, ErrorCode::Invalid));
            }
            return Ok(Some(self));
        }
        // Once this device is writing what it was sent, nothing the other
        // side says stops it; the result goes back when it's done.
        if self.writing() {
            return Ok(Some(self));
        }
        let kind = self.kind();
        let fail = |steps: &mut Vec<Step>, code| {
            steps.push(transfer_error(&id, code));
            steps.push(progress(&id, kind, Progress::Failed(code)));
            Ok(None)
        };
        match (self, message) {
            (_, Message::TransferCancel { .. }) => {
                steps.push(progress(&id, kind, Progress::Failed(ErrorCode::Cancelled)));
                Ok(None)
            }
            (_, Message::TransferError { code, .. }) => {
                steps.push(progress(&id, kind, Progress::Failed(code)));
                Ok(None)
            }
            (TargetFlow::Receiving(mut receiver), Message::TransferChunk { chunk, .. }) => {
                match receiver.push(chunk, bytes, now) {
                    Received::More(ack) => {
                        steps.push(send(ack));
                        steps.push(progress(
                            &id,
                            kind,
                            Progress::Receiving {
                                received: receiver.received,
                            },
                        ));
                        Ok(Some(TargetFlow::Receiving(receiver)))
                    }
                    Received::Last(ack, export) => {
                        steps.push(send(ack));
                        steps.push(progress(&id, kind, Progress::Saving));
                        steps.push(Step::Import {
                            transfer: id.clone(),
                            salt: receiver.salt,
                            export,
                        });
                        Ok(Some(TargetFlow::Importing { transfer: id }))
                    }
                    Received::Broken(code) => fail(steps, code),
                }
            }
            (TargetFlow::Ready { export, .. }, Message::TransferStart { .. }) => {
                let mut sender = Box::new(Sender::new(id.clone(), &export, now));
                sender.fill(steps);
                steps.push(progress(
                    &id,
                    kind,
                    Progress::Sending {
                        done: 0,
                        total: sender.total,
                    },
                ));
                Ok(Some(TargetFlow::Sending(sender)))
            }
            (TargetFlow::Sending(mut sender), Message::TransferAck { seq, .. }) => {
                if sender.ack(seq, now, steps).is_err() {
                    return fail(steps, ErrorCode::Invalid);
                }
                steps.push(progress(
                    &id,
                    kind,
                    Progress::Sending {
                        done: sender.acked,
                        total: sender.total,
                    },
                ));
                if sender.all_acked() {
                    Ok(Some(TargetFlow::Finishing {
                        transfer: id,
                        deadline: now + WRITE_TIMEOUT,
                    }))
                } else {
                    Ok(Some(TargetFlow::Sending(sender)))
                }
            }
            (TargetFlow::Finishing { .. }, Message::TransferDone { report, .. }) => {
                steps.push(progress(&id, kind, Progress::Done(Box::new(report))));
                Ok(None)
            }
            (
                TargetFlow::Providers {
                    grant,
                    names,
                    mut received,
                    next_part,
                    until,
                    ..
                },
                Message::ProvidersSend {
                    part,
                    last,
                    providers,
                    ..
                },
            ) => {
                // Every part carries at least one provider, so there are
                // never more parts than providers named.
                let mut fine = part == next_part && !providers.is_empty();
                for p in providers {
                    fine = fine
                        && p.fits()
                        && names.contains(&p.named())
                        && !received.iter().any(|r| r.named() == p.named());
                    if fine {
                        received.push(p);
                    }
                }
                if !fine {
                    return fail(steps, ErrorCode::Invalid);
                }
                if last {
                    steps.push(progress(&grant, kind, Progress::Saving));
                    steps.push(Step::SaveProviders {
                        grant: grant.clone(),
                        providers: received,
                    });
                    return Ok(Some(TargetFlow::Saving { grant }));
                }
                Ok(Some(TargetFlow::Providers {
                    grant,
                    names,
                    received,
                    next_part: next_part + 1,
                    deadline: now + STEP_TIMEOUT,
                    until,
                }))
            }
            // A step that doesn't fit where the transfer is.
            _ => fail(steps, ErrorCode::Invalid),
        }
    }

    /// The transfer's id, once granted.
    pub fn transfer(&self) -> Option<&str> {
        match self {
            TargetFlow::Asking { .. } => None,
            TargetFlow::Receiving(r) => Some(&r.transfer),
            TargetFlow::Sending(sender) => Some(&sender.transfer),
            TargetFlow::Ready { transfer, .. }
            | TargetFlow::Importing { transfer }
            | TargetFlow::Exporting { transfer, .. }
            | TargetFlow::Finishing { transfer, .. } => Some(transfer),
            TargetFlow::Providers { grant, .. } | TargetFlow::Saving { grant } => Some(grant),
        }
    }

    /// This device has everything it was sent and is writing it.
    pub fn writing(&self) -> bool {
        matches!(
            self,
            TargetFlow::Importing { .. } | TargetFlow::Saving { .. }
        )
    }

    /// Granted, but the controller hasn't started on it yet, so a cancel
    /// can just drop it.
    pub fn untouched(&self) -> bool {
        match self {
            TargetFlow::Receiving(r) => r.untouched(),
            TargetFlow::Providers { next_part, .. } => *next_part == 0,
            TargetFlow::Exporting { .. } | TargetFlow::Ready { .. } => true,
            _ => false,
        }
    }

    /// Whether `message` is the next step of this transfer, which the rate
    /// limit doesn't count, since the window already paces it.
    pub fn expects(&self, message: &Message) -> bool {
        let Some(id) = self.transfer() else {
            return false;
        };
        match (self, message) {
            (TargetFlow::Receiving(_), Message::TransferChunk { transfer, .. })
            | (TargetFlow::Ready { .. }, Message::TransferStart { transfer })
            | (TargetFlow::Sending(_), Message::TransferAck { transfer, .. })
            | (TargetFlow::Finishing { .. }, Message::TransferDone { transfer, .. })
            | (
                TargetFlow::Providers { .. },
                Message::ProvidersSend {
                    grant: transfer, ..
                },
            ) => transfer == id,
            _ => false,
        }
    }

    pub fn kind(&self) -> RequestKind {
        match self {
            TargetFlow::Asking { asked, .. } => asked.kind(),
            TargetFlow::Providers { .. } | TargetFlow::Saving { .. } => RequestKind::Providers,
            _ => RequestKind::History,
        }
    }

    /// When [`TargetFlow::tick`] has something to do. Nothing while this
    /// device or its user is working on it.
    pub fn deadline(&self) -> Option<Instant> {
        match self {
            TargetFlow::Receiving(r) => Some(r.deadline()),
            TargetFlow::Sending(sender) => Some(sender.deadline),
            TargetFlow::Providers {
                deadline, until, ..
            } => Some((*deadline).min(*until)),
            TargetFlow::Exporting { deadline, .. }
            | TargetFlow::Ready { deadline, .. }
            | TargetFlow::Finishing { deadline, .. } => Some(*deadline),
            _ => None,
        }
    }

    /// Ends a transfer that waited too long.
    pub fn tick(self, now: Instant, steps: &mut Vec<Step>) -> Option<TargetFlow> {
        if self.deadline().is_none_or(|d| now < d) {
            return Some(self);
        }
        // The controller hasn't heard of the transfer yet: its request is
        // what ran out.
        if let TargetFlow::Exporting { id, .. } = self {
            steps.push(send(Message::Error {
                re: Some(id),
                code: ErrorCode::Expired,
            }));
            return None;
        }
        let id = self.transfer().unwrap_or_default().to_string();
        steps.push(transfer_error(&id, ErrorCode::Expired));
        steps.push(progress(
            &id,
            self.kind(),
            Progress::Failed(ErrorCode::Expired),
        ));
        None
    }
}

/// The controller's side of one transfer.
#[derive(Debug)]
pub enum ControllerFlow {
    /// Asked; waiting for the target's user.
    Asking {
        id: u64,
        asked: Asked,
        deadline: Instant,
    },
    /// "Send": granted, waiting for this device's export.
    Exporting { transfer: String, deadline: Instant },
    /// "Send": sending.
    Sending(Box<Sender>),
    /// "Send": all sent, waiting for the target's result.
    Finishing { transfer: String, deadline: Instant },
    /// "Import": granted, showing the preview until the user starts it.
    Preview {
        transfer: String,
        salt: Salt,
        what: What,
        counts: Counts,
        deadline: Instant,
    },
    /// "Import": receiving.
    Receiving(Box<Receiver>),
    /// "Import": writing it here.
    Importing { transfer: String, deadline: Instant },
    /// Providers: granted, waiting for their settings from this device.
    ProvidersGranted {
        grant: String,
        names: Vec<ProviderName>,
        deadline: Instant,
    },
    /// Providers: sent, waiting for the target's results.
    ProvidersSent { grant: String, deadline: Instant },
}

/// What the controller's UI should hear about a transfer.
#[derive(Debug, Clone, PartialEq)]
pub enum ControllerEvent {
    /// The target's user is deciding, for this many seconds at most.
    Pending { expires_in: u32 },
    /// "Send" was allowed. Export this device's history under `salt` and
    /// pass it to `send_export`.
    ExportNeeded {
        transfer: String,
        salt: Salt,
        what: What,
    },
    /// "Import" was allowed. Show these counts and start it with
    /// `start_import`, or cancel.
    Preview { transfer: String, counts: Counts },
    /// "Import" arrived. Match it here under `salt`, write it, and pass the
    /// report to `imported`.
    ImportReady {
        transfer: String,
        salt: Salt,
        export: Box<Export>,
    },
    /// Providers were allowed. Pass their settings to `send_providers`.
    ProvidersGranted { grant: String },
    /// The target refused, or the request couldn't be made.
    Refused(ErrorCode),
    Progress {
        transfer: String,
        progress: Progress,
    },
}

/// What the controller has to do.
#[derive(Debug, Default, PartialEq)]
pub struct ControllerOut {
    pub send: Vec<Message>,
    pub events: Vec<ControllerEvent>,
}

impl ControllerOut {
    fn progress(&mut self, transfer: &str, progress: Progress) {
        self.events.push(ControllerEvent::Progress {
            transfer: transfer.to_string(),
            progress,
        });
    }

    fn fail(&mut self, transfer: &str, code: ErrorCode, tell: bool) {
        if tell {
            self.send.push(Message::TransferError {
                transfer: transfer.to_string(),
                code,
            });
        }
        self.progress(transfer, Progress::Failed(code));
    }

    fn absorb(&mut self, steps: Vec<Step>) {
        for step in steps {
            if let Step::Send(m) = step {
                self.send.push(*m);
            }
        }
    }
}

impl ControllerFlow {
    /// Starts asking. The answer has [`ASK_TIMEOUT`] to come.
    pub fn asking(id: u64, asked: Asked, now: Instant) -> Self {
        ControllerFlow::Asking {
            id,
            asked,
            deadline: now + ASK_TIMEOUT,
        }
    }

    pub fn transfer(&self) -> Option<&str> {
        match self {
            ControllerFlow::Asking { .. } => None,
            ControllerFlow::Sending(s) => Some(&s.transfer),
            ControllerFlow::Receiving(r) => Some(&r.transfer),
            ControllerFlow::Exporting { transfer, .. }
            | ControllerFlow::Finishing { transfer, .. }
            | ControllerFlow::Preview { transfer, .. }
            | ControllerFlow::Importing { transfer, .. } => Some(transfer),
            ControllerFlow::ProvidersGranted { grant, .. }
            | ControllerFlow::ProvidersSent { grant, .. } => Some(grant),
        }
    }

    /// The target has everything and is writing it, or this device is.
    fn writing(&self) -> bool {
        matches!(
            self,
            ControllerFlow::Finishing { .. }
                | ControllerFlow::Importing { .. }
                | ControllerFlow::ProvidersSent { .. }
        )
    }

    /// A message from the target that may be about this transfer. `Err`
    /// gives it back when it isn't.
    pub fn receive(
        self,
        message: Message,
        bytes: usize,
        now: Instant,
        out: &mut ControllerOut,
    ) -> Result<Option<ControllerFlow>, Box<(ControllerFlow, Message)>> {
        match (self, message) {
            (
                ControllerFlow::Asking {
                    id,
                    asked,
                    deadline,
                },
                Message::Pending { re, expires_in },
            ) if re == Some(id) => {
                let most = crate::remote::consent::CONSENT_TIMEOUT.as_secs() as u32;
                out.events.push(ControllerEvent::Pending {
                    expires_in: expires_in.min(most),
                });
                Ok(Some(ControllerFlow::Asking {
                    id,
                    asked,
                    deadline,
                }))
            }
            (ControllerFlow::Asking { id, .. }, Message::Error { re: Some(re), code })
                if re == id =>
            {
                out.events.push(ControllerEvent::Refused(code));
                Ok(None)
            }
            (
                ControllerFlow::Asking { id, asked, .. },
                Message::Granted {
                    re,
                    transfer,
                    salt,
                    counts,
                },
            ) if re == id => {
                let salt = salt.as_deref().and_then(Salt::from_hex);
                match (asked, salt) {
                    (
                        Asked::History {
                            direction: Direction::Send,
                            what,
                            ..
                        },
                        Some(salt),
                    ) => {
                        out.events.push(ControllerEvent::ExportNeeded {
                            transfer: transfer.clone(),
                            salt,
                            what,
                        });
                        Ok(Some(ControllerFlow::Exporting {
                            transfer,
                            deadline: now + GRANT_TIMEOUT,
                        }))
                    }
                    (
                        Asked::History {
                            direction: Direction::Import,
                            what,
                            ..
                        },
                        Some(salt),
                    ) => {
                        let counts = counts.unwrap_or_default();
                        out.events.push(ControllerEvent::Preview {
                            transfer: transfer.clone(),
                            counts,
                        });
                        Ok(Some(ControllerFlow::Preview {
                            transfer,
                            salt,
                            what,
                            counts,
                            deadline: now + GRANT_TIMEOUT,
                        }))
                    }
                    (Asked::Providers(names), _) => {
                        out.events.push(ControllerEvent::ProvidersGranted {
                            grant: transfer.clone(),
                        });
                        Ok(Some(ControllerFlow::ProvidersGranted {
                            grant: transfer,
                            names,
                            deadline: now + GRANT_TIMEOUT,
                        }))
                    }
                    // A history grant without a salt.
                    (_, None) => {
                        out.fail(&transfer, ErrorCode::Invalid, true);
                        Ok(None)
                    }
                }
            }
            (flow, message) => {
                let about = match &message {
                    Message::TransferChunk { transfer, .. }
                    | Message::TransferAck { transfer, .. }
                    | Message::TransferDone { transfer, .. }
                    | Message::TransferError { transfer, .. }
                    | Message::TransferCancel { transfer } => Some(transfer.clone()),
                    Message::ProvidersAdded { grant, .. } => Some(grant.clone()),
                    _ => None,
                };
                let Some(id) = about.filter(|id| flow.transfer() == Some(id.as_str())) else {
                    return Err(Box::new((flow, message)));
                };
                Ok(flow.step(id, message, bytes, now, out))
            }
        }
    }

    fn step(
        self,
        id: String,
        message: Message,
        bytes: usize,
        now: Instant,
        out: &mut ControllerOut,
    ) -> Option<ControllerFlow> {
        // While this device writes what it was sent, nothing the target
        // says stops it.
        if matches!(self, ControllerFlow::Importing { .. }) {
            return Some(self);
        }
        match (self, message) {
            (_, Message::TransferCancel { .. }) => {
                out.fail(&id, ErrorCode::Cancelled, false);
                None
            }
            (_, Message::TransferError { code, .. }) => {
                out.fail(&id, code, false);
                None
            }
            (ControllerFlow::Sending(mut sender), Message::TransferAck { seq, .. }) => {
                let mut steps = Vec::new();
                if sender.ack(seq, now, &mut steps).is_err() {
                    out.fail(&id, ErrorCode::Invalid, true);
                    return None;
                }
                out.absorb(steps);
                out.progress(
                    &id,
                    Progress::Sending {
                        done: sender.acked,
                        total: sender.total,
                    },
                );
                if sender.all_acked() {
                    out.progress(&id, Progress::Saving);
                    Some(ControllerFlow::Finishing {
                        transfer: id,
                        deadline: now + WRITE_TIMEOUT,
                    })
                } else {
                    Some(ControllerFlow::Sending(sender))
                }
            }
            (ControllerFlow::Finishing { .. }, Message::TransferDone { report, .. }) => {
                out.progress(&id, Progress::Done(Box::new(report)));
                None
            }
            (ControllerFlow::Receiving(mut receiver), Message::TransferChunk { chunk, .. }) => {
                match receiver.push(chunk, bytes, now) {
                    Received::More(ack) => {
                        out.send.push(ack);
                        out.progress(
                            &id,
                            Progress::Receiving {
                                received: receiver.received,
                            },
                        );
                        Some(ControllerFlow::Receiving(receiver))
                    }
                    Received::Last(ack, export) => {
                        out.send.push(ack);
                        out.progress(&id, Progress::Saving);
                        out.events.push(ControllerEvent::ImportReady {
                            transfer: id.clone(),
                            salt: receiver.salt,
                            export,
                        });
                        Some(ControllerFlow::Importing {
                            transfer: id,
                            deadline: now + WRITE_TIMEOUT,
                        })
                    }
                    Received::Broken(code) => {
                        out.fail(&id, code, true);
                        None
                    }
                }
            }
            (ControllerFlow::ProvidersSent { .. }, Message::ProvidersAdded { results, .. }) => {
                out.progress(&id, Progress::ProvidersDone(results));
                None
            }
            _ => {
                out.fail(&id, ErrorCode::Invalid, true);
                None
            }
        }
    }

    /// "Send": this device's export, or why there isn't one.
    pub fn send_export(
        self,
        transfer: &str,
        export: Result<Export, ErrorCode>,
        now: Instant,
        out: &mut ControllerOut,
    ) -> Option<ControllerFlow> {
        match self {
            ControllerFlow::Exporting { transfer: t, .. } if t == transfer => match export {
                Ok(export) if !chunks::within_limits(&export) => {
                    out.fail(transfer, ErrorCode::TooLarge, true);
                    None
                }
                Ok(export) => {
                    let mut sender = Sender::new(t, &export, now);
                    let mut steps = Vec::new();
                    sender.fill(&mut steps);
                    out.absorb(steps);
                    out.progress(
                        transfer,
                        Progress::Sending {
                            done: 0,
                            total: sender.total,
                        },
                    );
                    Some(ControllerFlow::Sending(Box::new(sender)))
                }
                Err(code) => {
                    out.fail(transfer, code, true);
                    None
                }
            },
            other => Some(other),
        }
    }

    /// "Import": the user confirmed the preview.
    pub fn start_import(
        self,
        transfer: &str,
        now: Instant,
        out: &mut ControllerOut,
    ) -> Option<ControllerFlow> {
        match self {
            ControllerFlow::Preview {
                transfer: t,
                salt,
                what,
                counts,
                ..
            } if t == transfer => {
                out.send.push(Message::TransferStart {
                    transfer: t.clone(),
                });
                out.progress(&t, Progress::Receiving { received: 0 });
                let mut receiver = Receiver::new(t, salt, what, Some(counts), now);
                receiver.deadline = now + STEP_TIMEOUT;
                Some(ControllerFlow::Receiving(Box::new(receiver)))
            }
            other => Some(other),
        }
    }

    /// "Import": written here, or failed.
    pub fn imported(
        self,
        transfer: &str,
        result: Result<Report, ErrorCode>,
        out: &mut ControllerOut,
    ) -> Option<ControllerFlow> {
        match self {
            ControllerFlow::Importing { transfer: t, .. } if t == transfer => {
                match result {
                    Ok(report) => {
                        out.send.push(Message::TransferDone {
                            transfer: t.clone(),
                            report: report.clone(),
                        });
                        out.progress(&t, Progress::Done(Box::new(report)));
                    }
                    Err(code) => out.fail(&t, code, true),
                }
                None
            }
            other => Some(other),
        }
    }

    /// Providers: their settings, in as many messages as the frame needs.
    pub fn send_providers(
        self,
        grant: &str,
        providers: Vec<ProviderSettings>,
        now: Instant,
        out: &mut ControllerOut,
    ) -> Option<ControllerFlow> {
        match self {
            ControllerFlow::ProvidersGranted {
                grant: g, names, ..
            } if g == grant => {
                // Only the providers the target allowed, each once, so a
                // login no one picked never goes out.
                let mut picked: Vec<ProviderSettings> = Vec::new();
                for p in providers {
                    if names.contains(&p.named()) && !picked.iter().any(|q| q.named() == p.named())
                    {
                        picked.push(p);
                    }
                }
                if picked.is_empty() {
                    out.fail(&g, ErrorCode::Invalid, true);
                    return None;
                }
                let parts = provider_parts(picked);
                let count = parts.len();
                for (part, providers) in parts.into_iter().enumerate() {
                    out.send.push(Message::ProvidersSend {
                        grant: g.clone(),
                        part: part as u32,
                        last: part + 1 == count,
                        providers,
                    });
                }
                out.progress(&g, Progress::Saving);
                Some(ControllerFlow::ProvidersSent {
                    grant: g,
                    deadline: now + WRITE_TIMEOUT,
                })
            }
            other => Some(other),
        }
    }

    /// The user cancelled. Tells the target, if it has heard of it. Once
    /// either side has everything and is writing it, it's too late: the
    /// transfer goes on, and its result comes as usual.
    pub fn cancel(self, out: &mut ControllerOut) -> Option<ControllerFlow> {
        if self.writing() {
            return Some(self);
        }
        match &self {
            ControllerFlow::Asking { .. } => out.send.push(Message::Cancel),
            flow => {
                if let Some(id) = flow.transfer() {
                    out.send.push(Message::TransferCancel {
                        transfer: id.to_string(),
                    });
                    out.progress(id, Progress::Failed(ErrorCode::Cancelled));
                }
            }
        }
        None
    }

    /// The connection went: the transfer can't go on, unless this device
    /// is writing what it has, which ends by itself.
    pub fn lost(self, out: &mut ControllerOut) -> Option<ControllerFlow> {
        if matches!(self, ControllerFlow::Importing { .. }) {
            return Some(self);
        }
        match self.transfer() {
            Some(id) => out.progress(id, Progress::Failed(ErrorCode::Cancelled)),
            None => out
                .events
                .push(ControllerEvent::Refused(ErrorCode::Cancelled)),
        }
        None
    }

    pub fn deadline(&self) -> Option<Instant> {
        match self {
            ControllerFlow::Sending(s) => Some(s.deadline),
            ControllerFlow::Receiving(r) => Some(r.deadline()),
            ControllerFlow::Asking { deadline, .. }
            | ControllerFlow::Exporting { deadline, .. }
            | ControllerFlow::Finishing { deadline, .. }
            | ControllerFlow::Preview { deadline, .. }
            | ControllerFlow::Importing { deadline, .. }
            | ControllerFlow::ProvidersGranted { deadline, .. }
            | ControllerFlow::ProvidersSent { deadline, .. } => Some(*deadline),
        }
    }

    pub fn tick(self, now: Instant, out: &mut ControllerOut) -> Option<ControllerFlow> {
        if self.deadline().is_none_or(|d| now < d) {
            return Some(self);
        }
        match self.transfer() {
            Some(id) => out.fail(id, ErrorCode::Expired, true),
            // No answer to the request: stop asking.
            None => {
                out.send.push(Message::Cancel);
                out.events
                    .push(ControllerEvent::Refused(ErrorCode::Expired));
            }
        }
        None
    }
}

/// Splits providers into messages that fit a frame.
fn provider_parts(providers: Vec<ProviderSettings>) -> Vec<Vec<ProviderSettings>> {
    let mut parts: Vec<Vec<ProviderSettings>> = vec![Vec::new()];
    let mut used = 0;
    for p in providers {
        let len = serde_json::to_vec(&p)
            .expect("provider settings always serialize")
            .len()
            + 1;
        let current = parts.last_mut().expect("there's always a part");
        if used + len > chunks::CHUNK_BYTES && !current.is_empty() {
            parts.push(Vec::new());
            used = 0;
        }
        parts.last_mut().expect("there's always a part").push(p);
        used += len;
    }
    parts
}

#[cfg(test)]
mod tests;
