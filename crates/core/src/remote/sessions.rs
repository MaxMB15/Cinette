// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The controllers a target has let in.
//!
//! Sessions live in memory only, so quitting the app ends them all. A
//! session whose connection drops waits [`RESUME_GRACE`] for the same
//! controller to come back. After that it has ended, and the controller has
//! to ask again.

use super::handshake::Peer;
use super::message::CloseReason;
use super::ConnId;
use std::time::{Duration, Instant};

/// The most controllers one target takes.
pub const MAX_SESSIONS: usize = 8;
/// How long a dropped session can be resumed.
pub const RESUME_GRACE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub peer: Peer,
    pub started: Instant,
    /// The connection it runs on, or `None` while it's dropped.
    pub conn: Option<ConnId>,
    /// When the connection dropped.
    pub dropped_at: Option<Instant>,
}

/// There's no session to resume: it never existed, belongs to another
/// device, or ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("no session to resume")]
pub struct NoSession;

#[derive(Debug, Default)]
pub struct Sessions {
    list: Vec<Session>,
}

impl Sessions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> &[Session] {
        &self.list
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// Starts a session for a controller that was let in. A controller that
    /// already has one, say a dropped one, gets a new session in its place.
    /// Also returns the connection the replaced session was on, if it still
    /// had one, which should be closed.
    pub fn open(
        &mut self,
        peer: Peer,
        conn: ConnId,
        now: Instant,
    ) -> Result<(Session, Option<ConnId>), CloseReason> {
        let replaced = self.list.iter().position(|s| s.peer.id == peer.id);
        if replaced.is_none() && self.list.len() >= MAX_SESSIONS {
            return Err(CloseReason::Busy);
        }
        let old = replaced.and_then(|i| self.list.remove(i).conn);
        let session = Session {
            id: super::to_hex(&super::random_bytes::<16>()),
            peer,
            started: now,
            conn: Some(conn),
            dropped_at: None,
        };
        self.list.push(session.clone());
        Ok((session, old))
    }

    pub fn by_conn(&self, conn: ConnId) -> Option<&Session> {
        self.list.iter().find(|s| s.conn == Some(conn))
    }

    /// The connection dropped. The session waits to be resumed.
    pub fn detach(&mut self, conn: ConnId, now: Instant) -> Option<&Session> {
        let session = self.list.iter_mut().find(|s| s.conn == Some(conn))?;
        session.conn = None;
        session.dropped_at = Some(now);
        Some(session)
    }

    /// Moves a session to a new connection from the same device, which may
    /// have a new name since. Returns the connection it was on, if it still
    /// had one, which should be closed. `Err` when there's no such session
    /// for that device.
    pub fn resume(
        &mut self,
        id: &str,
        peer: &Peer,
        conn: ConnId,
        now: Instant,
    ) -> Result<Option<ConnId>, NoSession> {
        let session = self
            .list
            .iter_mut()
            .find(|s| s.id == id && s.peer.id == peer.id)
            .ok_or(NoSession)?;
        if session
            .dropped_at
            .is_some_and(|at| now.duration_since(at) >= RESUME_GRACE)
        {
            return Err(NoSession);
        }
        let old = session.conn.replace(conn);
        session.dropped_at = None;
        session.peer = peer.clone();
        Ok(old)
    }

    /// The device on `conn` has a new name. True when a session took it.
    pub fn rename(&mut self, conn: ConnId, name: String) -> bool {
        match self.list.iter_mut().find(|s| s.conn == Some(conn)) {
            Some(session) => {
                session.peer.name = name;
                true
            }
            None => false,
        }
    }

    pub fn end(&mut self, id: &str) -> Option<Session> {
        let i = self.list.iter().position(|s| s.id == id)?;
        Some(self.list.remove(i))
    }

    pub fn end_all(&mut self) -> Vec<Session> {
        std::mem::take(&mut self.list)
    }

    /// Ends the sessions that stayed dropped too long.
    pub fn expire(&mut self, now: Instant) -> Vec<Session> {
        let (gone, kept) = std::mem::take(&mut self.list).into_iter().partition(|s| {
            s.dropped_at
                .is_some_and(|at| now.duration_since(at) >= RESUME_GRACE)
        });
        self.list = kept;
        gone
    }

    /// When the next dropped session ends.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.list
            .iter()
            .filter_map(|s| s.dropped_at)
            .map(|at| at + RESUME_GRACE)
            .min()
    }
}

#[cfg(test)]
mod tests;
