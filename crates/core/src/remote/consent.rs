// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Requests waiting for the user on the target to allow or deny them.
//!
//! Only the first request is on screen. A few more wait behind it, and every
//! request runs out [`CONSENT_TIMEOUT`] after it arrived. Nothing but Allow
//! grants anything: a denial, a dismissed dialog, a request that ran out or
//! one the controller withdrew all refuse. After a denial, the same device
//! is refused without a dialog for [`DENIAL_COOLDOWN`], so it can't keep a
//! dialog on screen. The target also blocks a device denied control until
//! the user unblocks it; a dismissed dialog refuses only that request.
//!
//! A device can make up a new id for each request, so a denial, or a
//! request that ran out, also turns away every new request for a while,
//! from any device, with [`CloseReason::Busy`]. That's [`DENIAL_BACKOFF`] at
//! first, twice as long after each one that follows, and never more than
//! [`DENIAL_COOLDOWN`]. Without it for a request that ran out, a device
//! could keep a dialog up for good by asking again each time.
//! Allowing a request, or a cooldown's time with no denial after the wait
//! ends, starts it again from the beginning. Requests already waiting stay.

use super::handshake::{Peer, VerificationCode};
use super::identity::DeviceId;
use super::message::{CloseReason, RequestKind};
use super::ConnId;
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// How long a request waits for an answer.
pub const CONSENT_TIMEOUT: Duration = Duration::from_secs(30);
/// The request on screen and the ones behind it.
pub const MAX_WAITING: usize = 4;
/// How long a denied device is refused without a dialog.
pub const DENIAL_COOLDOWN: Duration = Duration::from_secs(60);
/// How long every new request is refused after the first denial.
pub const DENIAL_BACKOFF: Duration = Duration::from_secs(5);

pub type RequestId = u64;

/// A request for the user to answer.
#[derive(Debug, Clone)]
pub struct ConsentRequest {
    pub id: RequestId,
    pub conn: ConnId,
    pub peer: Peer,
    pub code: VerificationCode,
    pub kind: RequestKind,
    pub expires_at: Instant,
}

/// What the user did with the dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Answer {
    Allow,
    Deny,
    /// Closed the dialog without choosing.
    Dismiss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Granted,
    Refused(CloseReason),
}

/// A request that has its answer.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub request: ConsentRequest,
    pub outcome: Outcome,
}

#[derive(Debug, Default)]
pub struct ConsentQueue {
    waiting: VecDeque<ConsentRequest>,
    denied_until: HashMap<DeviceId, Instant>,
    /// Denials since the backoff last started again.
    denials: u32,
    /// Until when every new request is refused.
    quiet_until: Option<Instant>,
    next_id: RequestId,
}

impl ConsentQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a request. A device asking again replaces its earlier request,
    /// which comes back as cancelled. Refuses a device denied a moment ago,
    /// any request right after a denial, and any request when the queue is
    /// full.
    pub fn submit(
        &mut self,
        now: Instant,
        conn: ConnId,
        peer: Peer,
        code: VerificationCode,
        kind: RequestKind,
    ) -> Result<(RequestId, Vec<Resolved>), CloseReason> {
        if self
            .denied_until
            .get(&peer.id)
            .is_some_and(|&until| now < until)
        {
            return Err(CloseReason::Denied);
        }
        if self.quiet_until.is_some_and(|until| now < until) {
            return Err(CloseReason::Busy);
        }
        let earlier = self.waiting.iter().position(|r| r.peer.id == peer.id);
        let others = self.waiting.len() - usize::from(earlier.is_some());
        if others >= MAX_WAITING {
            return Err(CloseReason::Busy);
        }
        let replaced: Vec<Resolved> = earlier
            .and_then(|i| self.waiting.remove(i))
            .map(|request| Resolved {
                request,
                outcome: Outcome::Refused(CloseReason::Cancelled),
            })
            .into_iter()
            .collect();
        self.next_id += 1;
        let id = self.next_id;
        self.waiting.push_back(ConsentRequest {
            id,
            conn,
            peer,
            code,
            kind,
            expires_at: now + CONSENT_TIMEOUT,
        });
        Ok((id, replaced))
    }

    /// The request to show, if any.
    pub fn showing(&self) -> Option<&ConsentRequest> {
        self.waiting.front()
    }

    pub fn len(&self) -> usize {
        self.waiting.len()
    }

    pub fn is_empty(&self) -> bool {
        self.waiting.is_empty()
    }

    /// The user's answer to a request. A request that already ran out, or
    /// isn't known, gets `None`, so a late tap on Allow grants nothing.
    pub fn answer(&mut self, id: RequestId, answer: Answer, now: Instant) -> Option<Resolved> {
        let i = self.waiting.iter().position(|r| r.id == id)?;
        if now >= self.waiting[i].expires_at {
            return None;
        }
        let request = self.waiting.remove(i).expect("the index was just found");
        let outcome = match answer {
            Answer::Allow => {
                self.denials = 0;
                self.quiet_until = None;
                Outcome::Granted
            }
            Answer::Deny => {
                self.denied_until
                    .insert(request.peer.id.clone(), now + DENIAL_COOLDOWN);
                self.back_off(now);
                Outcome::Refused(CloseReason::Denied)
            }
            Answer::Dismiss => Outcome::Refused(CloseReason::Denied),
        };
        Some(Resolved { request, outcome })
    }

    /// Refuses new requests for a while after a denial or a request that
    /// ran out.
    fn back_off(&mut self, now: Instant) {
        if self
            .quiet_until
            .is_some_and(|until| now >= until + DENIAL_COOLDOWN)
        {
            self.denials = 0;
        }
        // 5 s, 10 s, 20 s, 40 s, then the cooldown.
        let wait = DENIAL_BACKOFF
            .saturating_mul(1 << self.denials.min(4))
            .min(DENIAL_COOLDOWN);
        self.denials = self.denials.saturating_add(1);
        self.quiet_until = Some(now + wait);
    }

    /// Forgets a denial of `device`, so it can ask again at once.
    pub fn forgive(&mut self, device: &DeviceId) {
        self.denied_until.remove(device);
    }

    /// The controller on `conn` stopped asking or hung up.
    pub fn withdraw(&mut self, conn: ConnId) -> Option<Resolved> {
        let i = self.waiting.iter().position(|r| r.conn == conn)?;
        let request = self.waiting.remove(i).expect("the index was just found");
        Some(Resolved {
            request,
            outcome: Outcome::Refused(CloseReason::Cancelled),
        })
    }

    /// Takes out the requests that ran out, and backs off as for a denial.
    pub fn expire(&mut self, now: Instant) -> Vec<Resolved> {
        // Only forgets denials whose cooldown is over. Keeping one until the
        // moment after it ends changes nothing, since `submit` already lets
        // the device in then.
        // mutants: skip BinaryOperator: <= only keeps a denial that no longer refuses anything.
        self.denied_until.retain(|_, until| now < *until);
        let (gone, kept): (Vec<_>, Vec<_>) =
            self.waiting.drain(..).partition(|r| now >= r.expires_at);
        self.waiting = kept.into();
        if !gone.is_empty() {
            self.back_off(now);
        }
        gone.into_iter()
            .map(|request| Resolved {
                request,
                outcome: Outcome::Refused(CloseReason::Expired),
            })
            .collect()
    }

    /// Refuses everything waiting, as when remote control is turned off.
    pub fn refuse_all(&mut self, reason: CloseReason) -> Vec<Resolved> {
        self.waiting
            .drain(..)
            .map(|request| Resolved {
                request,
                outcome: Outcome::Refused(reason),
            })
            .collect()
    }

    /// Refuses the requests `which` picks, and keeps the rest.
    pub fn refuse_where(
        &mut self,
        reason: CloseReason,
        which: impl Fn(&ConsentRequest) -> bool,
    ) -> Vec<Resolved> {
        let (gone, kept): (Vec<_>, Vec<_>) = self.waiting.drain(..).partition(|r| which(r));
        self.waiting = kept.into();
        gone.into_iter()
            .map(|request| Resolved {
                request,
                outcome: Outcome::Refused(reason),
            })
            .collect()
    }

    /// When the next request runs out.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.waiting.iter().map(|r| r.expires_at).min()
    }
}

#[cfg(test)]
mod tests;
