// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The decisions the macOS backend makes about Bonjour's answers: what an
//! error means, when to try again and whether local network access looks
//! denied. They need no Bonjour, so they live here, where the tests on Linux
//! run them too.

use std::time::{Duration, Instant};

/// How long to wait before trying an operation again after Bonjour failed
/// it, for example because mDNSResponder restarted or macOS refused local
/// network access before the user answered its alert.
pub(crate) const RETRY_AFTER: Duration = Duration::from_secs(5);

/// How long a refusal counts as current. Every operation it refused is tried
/// again after [`RETRY_AFTER`], and gets refused again straight away while
/// access is still denied, so this covers a few missed retries.
pub(crate) const DENIED_FOR: Duration = Duration::from_secs(15);

/// `kDNSServiceErr_ServiceNotRunning`: mDNSResponder isn't there, or the
/// connection to it broke.
pub(crate) const SERVICE_NOT_RUNNING: i32 = -65563;
/// `kDNSServiceErr_DefunctConnection`: the socket to mDNSResponder went bad.
pub(crate) const DEFUNCT_CONNECTION: i32 = -65569;
/// `kDNSServiceErr_PolicyDenied`: macOS refused local network access.
pub(crate) const POLICY_DENIED: i32 = -65570;

/// What a Bonjour error means for the operations that share its connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Failure {
    /// The connection to mDNSResponder broke, which ends every operation on
    /// it. They all start again on a new connection.
    Connection,
    /// macOS refused local network access. The user can allow it at any
    /// time, so the operation is tried again.
    Denied,
    /// Only this operation failed.
    Other,
}

impl Failure {
    pub(crate) fn of(err: i32) -> Self {
        match err {
            SERVICE_NOT_RUNNING | DEFUNCT_CONNECTION => Self::Connection,
            POLICY_DENIED => Self::Denied,
            _ => Self::Other,
        }
    }

    /// Whether a browse or advertisement that failed this way as it started
    /// is kept and tried again, rather than refused. Any other error there
    /// means the request itself was bad, which trying again won't fix.
    pub(crate) fn passes(self) -> bool {
        self != Self::Other
    }
}

/// Whether a retry set for `at` is due.
pub(crate) fn due(at: Option<Instant>, now: Instant) -> bool {
    at.is_some_and(|at| at <= now)
}

/// The `poll` timeout in milliseconds until the earliest deadline, rounded
/// up so the wait doesn't end just before it. -1, which waits for ever, when
/// there's none.
pub(crate) fn poll_timeout(now: Instant, deadlines: impl IntoIterator<Item = Instant>) -> i32 {
    deadlines.into_iter().min().map_or(-1, |at| {
        let ms = at.saturating_duration_since(now).as_nanos().div_ceil(1_000_000);
        i32::try_from(ms).unwrap_or(i32::MAX)
    })
}

/// Whether macOS lets the app reach the local network, as far as Bonjour
/// has said. There's no API to ask, so this follows what operations get
/// back: a refusal marks access denied, and any answer marks it allowed.
/// Access also counts as allowed once nothing has been refused for
/// [`DENIED_FOR`], since a browse that's allowed but finds nothing gets no
/// answer at all.
#[derive(Debug)]
pub(crate) struct Access {
    refused_at: Option<Instant>,
}

impl Access {
    /// Access that counts as allowed, until something is refused.
    pub(crate) const fn new() -> Self {
        Self { refused_at: None }
    }

    /// An operation was refused. True when access didn't already count as
    /// denied, so the refusal is logged once and not on every retry.
    pub(crate) fn refused(&mut self, now: Instant) -> bool {
        let news = !self.denied(now);
        self.refused_at = Some(now);
        news
    }

    /// An operation got an answer.
    pub(crate) fn answered(&mut self) {
        self.refused_at = None;
    }

    pub(crate) fn denied(&self, now: Instant) -> bool {
        self.refused_at
            .is_some_and(|at| now.saturating_duration_since(at) < DENIED_FOR)
    }
}

/// The port in an SRV record's data: priority, weight, then port, each two
/// bytes in network order, then the target host.
pub(crate) fn srv_port(rdata: &[u8]) -> Option<u16> {
    match rdata {
        [_, _, _, _, high, low, ..] => Some(u16::from_be_bytes([*high, *low])),
        _ => None,
    }
}

/// Whether an SRV record a lookup reports means the instance moved to
/// another host or port, so it must be resolved again. That's when it
/// differs from the last record the lookup reported, or names another port
/// than the last resolve gave. The lookup's first record usually matches
/// the resolve that came before it.
pub(crate) fn srv_moved(last: Option<&[u8]>, rdata: &[u8], port: u16) -> bool {
    last.is_some_and(|last| last != rdata) || srv_port(rdata).is_some_and(|p| p != port)
}
