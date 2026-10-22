// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What a Mac's AVPlayer does as its item plays, since macOS never says
//! which receiver the picker chose, or whether it chose one. The video
//! counts as on a receiver only while `isExternalPlaybackActive` says so.
//! `macos.rs` reads AVPlayer and does what [`Pick::step`] returns, so the
//! rules can be tested where AVPlayer can't run.

use std::time::{Duration, Instant};

#[cfg(test)]
#[path = "pick_tests.rs"]
mod tests;

/// How long after the item is ready AVPlayer may take to reach a receiver
/// before the pick counts as none. Apple gives no bound. A Mac that sends
/// to an Apple TV shows as external within a second or two, and a TV that
/// wakes from standby can take longer. Waiting costs little, since the
/// player stays muted here and mpv starts again where it was, so this
/// errs long. The device checks in the pull request time it on a TV.
pub const PICK_LIMIT: Duration = Duration::from_secs(10);

/// What AVPlayer should do after a reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    /// Quiet, so nothing plays on the Mac's own speakers.
    pub muted: bool,
    /// The video just left the receiver. AVPlayer would carry on here.
    pub pause: bool,
    /// No receiver took the video in time.
    pub not_picked: bool,
    /// The item just got ready, this long after the load.
    pub ready_after: Option<Duration>,
    /// The video just reached a receiver for the first time, this long
    /// after the load.
    pub reached_after: Option<Duration>,
    /// `isExternalPlaybackActive` changed with this reading.
    pub changed: bool,
}

/// One item's pick.
#[derive(Debug)]
pub struct Pick {
    /// When the item was loaded, which the times in a [`Step`] count from.
    loaded_at: Instant,
    ready_at: Option<Instant>,
    /// The video is on a receiver now.
    external: bool,
    /// The video reached a receiver at some point.
    reached: bool,
}

impl Pick {
    /// The pick of an item loaded at `now`.
    pub fn loaded(now: Instant) -> Self {
        Self {
            loaded_at: now,
            ready_at: None,
            external: false,
            reached: false,
        }
    }

    /// Takes a reading of the item, `ready` to play and `external` or not,
    /// at `now`.
    pub fn step(&mut self, ready: bool, external: bool, now: Instant) -> Step {
        let since_load = now.saturating_duration_since(self.loaded_at);
        let ready_after = (ready && self.ready_at.is_none()).then_some(since_load);
        if ready_after.is_some() {
            self.ready_at = Some(now);
        }
        let left = self.external && !external;
        let changed = self.external != external;
        let reached_after = (external && !self.reached).then_some(since_load);
        self.external = external;
        self.reached |= external;
        let waited = self
            .ready_at
            .is_some_and(|at| now.saturating_duration_since(at) >= PICK_LIMIT);
        Step {
            muted: !external,
            pause: left,
            not_picked: !self.reached && waited,
            ready_after,
            reached_after,
            changed,
        }
    }
}
