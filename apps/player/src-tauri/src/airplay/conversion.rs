// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The order of converted AirPlay loads, apart from the platform, so it can
//! be tested anywhere. iOS runs it with `hls_out`'s conversions, and macOS
//! with the bundled ffmpeg's.
//!
//! - One load runs at a time. A load or a stop that comes later makes an
//!   older load give up, so quick seeks collapse into the last one.
//! - A new conversion opens its source only after the old one has hung up
//!   on the provider, since many accounts allow one connection.
//! - A conversion is kept only once the receiver was told to play it, and
//!   one that a stop overtook is dropped.
//! - When a kept conversion ends on its own with an error, or a live one
//!   ends at all, the player hears why.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use tokio::sync::watch;

use crate::convert::hls::{Ended, HlsError};

#[cfg(test)]
#[path = "conversion_tests.rs"]
mod tests;

/// What a load answers when a later load or a stop overtook it.
pub const SUPERSEDED: &str = "superseded";

/// How long a new conversion waits for the old one to close its source.
const CLOSE_LIMIT: Duration = Duration::from_secs(5);

/// A running conversion, as this module needs it.
pub trait Running: Send + Sync + 'static {
    /// Changes from `None` when the conversion has ended and closed its
    /// source.
    fn ended(&self) -> watch::Receiver<Option<Ended>>;
    /// Whether the receiver plays, which runs the conversion's pacer.
    fn set_playing(&self, playing: bool);
}

/// The `PlaybackError` code the player shows for a conversion that ended
/// with `error`.
pub fn error_code(error: HlsError) -> &'static str {
    match error {
        HlsError::Refused => "refused",
        _ => "failed",
    }
}

/// The converted loads of one device.
pub struct Conversions<R: Running> {
    /// Counts loads and stops. A load gives up once it's no longer the
    /// latest.
    generation: AtomicU64,
    /// Held by the load that runs.
    turn: tokio::sync::Mutex<()>,
    /// The conversion the receiver plays.
    current: Mutex<Option<R>>,
    /// The `ended` of conversions that were dropped, until they close.
    closing: Mutex<Vec<watch::Receiver<Option<Ended>>>>,
    /// Tells the player that the conversion it plays failed, by code.
    fail: Box<dyn Fn(&'static str) + Send + Sync>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl<R: Running> Conversions<R> {
    pub fn new(fail: impl Fn(&'static str) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(0),
            turn: tokio::sync::Mutex::new(()),
            current: Mutex::new(None),
            closing: Mutex::new(Vec::new()),
            fail: Box::new(fail),
        })
    }

    fn latest(&self, generation: u64) -> Result<(), String> {
        if self.generation.load(Ordering::SeqCst) == generation {
            Ok(())
        } else {
            Err(SUPERSEDED.to_string())
        }
    }

    /// Drops `running`, which stops it, and keeps its `ended` until it
    /// has closed.
    fn close(&self, running: R) {
        let ended = running.ended();
        drop(running);
        lock(&self.closing).push(ended);
    }

    fn stop_current(&self) {
        let current = lock(&self.current).take();
        if let Some(running) = current {
            self.close(running);
        }
    }

    /// Waits, up to [`CLOSE_LIMIT`], for every dropped conversion to close.
    async fn wait_closed(&self) {
        let closing = std::mem::take(&mut *lock(&self.closing));
        let all = async {
            for mut ended in closing {
                // A dropped sender means the thread is gone too.
                let _ = ended.wait_for(Option::is_some).await;
            }
        };
        let _ = tokio::time::timeout(CLOSE_LIMIT, all).await;
    }

    /// Starts a conversion with `start` and has the receiver play it with
    /// `play`, after stopping the one before. `live` conversions that end
    /// at all are reported. Answers [`SUPERSEDED`] when a later load or a
    /// stop came first.
    pub async fn load<S, P>(self: &Arc<Self>, live: bool, start: S, play: P) -> Result<(), String>
    where
        S: Future<Output = Result<R, HlsError>> + Send,
        P: FnOnce(&R) -> Result<(), String> + Send,
    {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _turn = self.turn.lock().await;
        self.latest(generation)?;
        self.stop_current();
        self.wait_closed().await;
        self.latest(generation)?;
        let started = start.await;
        let running = match started {
            Ok(running) => running,
            Err(e) => {
                self.latest(generation)?;
                tracing::warn!("[AirPlay] the conversion didn't start: {e}");
                return Err(e.for_player());
            }
        };
        if let Err(e) = self.latest(generation).and_then(|()| play(&running)) {
            self.close(running);
            return Err(e);
        }
        let ended = running.ended();
        *lock(&self.current) = Some(running);
        self.watch(generation, live, ended);
        Ok(())
    }

    /// Reports the conversion of `generation` when it ends on its own.
    fn watch(
        self: &Arc<Self>,
        generation: u64,
        live: bool,
        mut ended: watch::Receiver<Option<Ended>>,
    ) {
        let this: Weak<Self> = Arc::downgrade(self);
        tokio::spawn(async move {
            let result = match ended.wait_for(Option::is_some).await {
                Ok(result) => *result,
                Err(_) => return,
            };
            let Some(this) = this.upgrade() else { return };
            if this.latest(generation).is_err() {
                return;
            }
            let failure = match result {
                Some(Err(e)) => Some(e),
                // A live channel has no end, so the provider stopped it.
                Some(Ok(())) if live => Some(HlsError::Unreachable),
                _ => None,
            };
            if let Some(e) = failure {
                tracing::warn!("[AirPlay] the conversion ended: {e}");
                (this.fail)(error_code(e));
            }
        });
    }

    /// Stops the conversion, and any load still starting one, and waits
    /// up to [`CLOSE_LIMIT`] for them to close their source, so whatever
    /// plays next isn't a second connection to the provider.
    pub async fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.stop_current();
        let closed = async {
            // A load that's starting drops what it started once it ends.
            let _turn = self.turn.lock().await;
            self.wait_closed().await;
        };
        let _ = tokio::time::timeout(CLOSE_LIMIT, closed).await;
    }

    /// Passes the receiver's state on: only `playing` runs the pacer.
    pub fn set_status(&self, status: &str) {
        if let Some(running) = lock(&self.current).as_ref() {
            running.set_playing(status == "playing");
        }
    }

    /// Whether a conversion is kept, for the tests.
    #[cfg(test)]
    fn has_current(&self) -> bool {
        lock(&self.current).is_some()
    }
}
