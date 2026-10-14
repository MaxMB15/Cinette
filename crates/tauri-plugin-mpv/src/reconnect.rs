// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Background watcher that reloads a stream after a network failure.
//!
//! Each `load` spawns one watcher thread with its own mpv client. The client
//! has its own event queue but shares the player core, so its `loadfile`
//! replaces the main player's file.
//!
//! A soft stall is FFmpeg retrying the read on its own, through the
//! `stream-lavf-o` reconnect options. The only sign is that the demuxer
//! cache drains and `paused-for-cache` turns on. The watcher sends
//! `mpv://buffering` and `mpv://buffered` for it and leaves recovery to
//! FFmpeg.
//!
//! A hard failure ends the file. That is an `EndFile` with an error reason,
//! or an `EndFile(Eof)` well short of the duration, which is how mpv reports
//! a server closing the connection early. libmpv2 turns every `END_FILE`
//! that carries an error code into an `Err` from `wait_event`, so most of
//! these never arrive as `EndFile`. The watcher also observes `eof-reached`
//! and `idle-active`, which mpv sets whatever the error code. The first
//! trigger arms the retry and `next_retry_at` makes the rest no-ops.
//!
//! Each reload sends `mpv://reconnecting`. The first goes out at once, then
//! the wait doubles from 1 second up to `BACKOFF_CAP_SECS`. A reload counts
//! as recovered, and sends `mpv://reconnected`, once `time-pos` moves
//! `RECOVERY_CONFIRM_ADVANCE_SECS` past where playback restarted. After
//! `MAX_ATTEMPTS` the watcher sends `mpv://load-failed` and stops reloading.
//! It keeps running until the kill flag or a shutdown, so a fallback window
//! closed after that is still reported.
//!
//! When mpv shuts down by itself, which only happens when the user closes
//! the fallback window, the watcher stops playback and sends
//! `mpv://window-closed`.

use crate::loadfile::{loadfile, resume_option};
use crate::log_url::origin_for_log;
use crate::mpv::MpvState;
use libmpv2::{
    events::{Event, PropertyData},
    mpv_end_file_reason, EndFileReason, Format, Mpv,
};
use serde::Serialize;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Longest wait between reloads, in seconds.
const BACKOFF_CAP_SECS: u64 = 30;

/// Reloads before the watcher gives up. Without a limit a dead URL would be
/// retried forever. With the backoff, ten reloads take at least two and a
/// half minutes.
const MAX_ATTEMPTS: u32 = 10;

/// How far short of `duration` an end of file can stop and still count as
/// the real end, in seconds. mpv can end a file a few hundred milliseconds
/// before `time-pos` reaches the duration.
const PREMATURE_EOF_SLACK_SECS: f64 = 5.0;

/// How far `time-pos` must move past the restart point before a reload
/// counts as recovered, in seconds. mpv sends `FileLoaded` once the headers
/// parse, even when the socket is already dead, so only real playback shows
/// that data is flowing again.
const RECOVERY_CONFIRM_ADVANCE_SECS: f64 = 1.0;

/// How long a reload may sit at its restart point before the watcher tries
/// again, in seconds. mpv can load the headers and then wait for data that
/// never comes, with no event to say so.
const RECOVERY_STALL_TIMEOUT_SECS: u64 = 15;

/// Sent when the watcher schedules a reload. The payload is
/// `{ "url": string, "attempt": number }`.
const EVENT_RECONNECTING: &str = "mpv://reconnecting";

/// Sent once a reload is playing again. The payload is `{ "url": string }`.
const EVENT_RECONNECTED: &str = "mpv://reconnected";

/// Sent when the cache runs dry and mpv pauses to wait for data. It is the
/// first sign of a soft stall. The payload is `{ "url": string }`.
const EVENT_BUFFERING: &str = "mpv://buffering";

/// Sent when the cache refills after `mpv://buffering`. The payload is
/// `{ "url": string }`.
const EVENT_BUFFERED: &str = "mpv://buffered";

/// Sent after the last reload fails. The watcher stops reloading, so
/// recovery is up to the user. The payload is `{ "url": string }`.
const EVENT_LOAD_FAILED: &str = "mpv://load-failed";

/// Sent when mpv shuts down without being told to. Only the fallback window
/// does that, when the user closes it or presses `q`. The watcher has
/// stopped playback by then, and the frontend leaves the player. The payload
/// is `{ "url": string }`.
const EVENT_WINDOW_CLOSED: &str = "mpv://window-closed";

/// Properties the watcher observes, with the `reply_userdata` id for each.
/// The ids only need to be unique within this client.
const OBSERVED: [(&str, Format, u64); 4] = [
    // A drained cache is the only sign of a stall while FFmpeg's own
    // reconnect retries the read.
    ("paused-for-cache", Format::Flag, 1),
    // Where a reload resumes, and how the watcher sees that a reload worked.
    ("time-pos", Format::Double, 2),
    // Backups for the end of file events that libmpv2 turns into errors.
    ("eof-reached", Format::Flag, 3),
    ("idle-active", Format::Flag, 4),
];

#[derive(Clone, Serialize)]
struct ReconnectingPayload<'a> {
    url: &'a str,
    attempt: u32,
}

#[derive(Clone, Serialize)]
struct UrlPayload<'a> {
    url: &'a str,
}

/// Starts a watcher thread for `url` on `client`, a client of the player
/// that is playing it.
///
/// Set `kill` before destroying the parent `Mpv`, and use a new flag for
/// each spawn. A client from `mpv_create_client` holds a strong reference
/// to the player core, so destroying the parent alone doesn't stop the
/// thread. A watcher left running keeps the core, the hardware decoder and
/// the audio device busy while the next stream loads. The thread checks
/// `kill` at least once a second.
pub fn spawn<R: Runtime>(client: Mpv, url: String, app: AppHandle<R>, kill: Arc<AtomicBool>) {
    let watcher = Watcher::new(client, url, app, kill);
    if let Err(e) = std::thread::Builder::new()
        .name("mpv-reconnect".into())
        .spawn(move || watcher.run())
    {
        tracing::warn!("[MPV reconnect] failed to spawn watcher thread: {e}");
    }
}

/// The parts of an mpv event the watcher acts on, copied out of the event so
/// its borrow of the client ends before the handlers run.
#[derive(Debug, PartialEq)]
enum Signal {
    Shutdown,
    EndFile(EndFileReason),
    PlaybackRestart,
    PausedForCache(bool),
    TimePos(f64),
    EofReached(bool),
    IdleActive(bool),
    WaitFailed(libmpv2::Error),
    /// A timeout, or an event the watcher doesn't act on.
    Nothing,
}

fn signal(event: Option<libmpv2::Result<Event<'_>>>) -> Signal {
    match event {
        Some(Ok(Event::Shutdown)) => Signal::Shutdown,
        Some(Ok(Event::EndFile(reason))) => Signal::EndFile(reason),
        Some(Ok(Event::PlaybackRestart)) => Signal::PlaybackRestart,
        Some(Ok(Event::PropertyChange { name, change, .. })) => match (name, change) {
            ("paused-for-cache", PropertyData::Flag(paused)) => Signal::PausedForCache(paused),
            ("time-pos", PropertyData::Double(pos)) => Signal::TimePos(pos),
            ("eof-reached", PropertyData::Flag(eof)) => Signal::EofReached(eof),
            ("idle-active", PropertyData::Flag(idle)) => Signal::IdleActive(idle),
            _ => Signal::Nothing,
        },
        // FileLoaded doesn't prove a reload worked. See
        // `RECOVERY_CONFIRM_ADVANCE_SECS`.
        Some(Ok(_)) | None => Signal::Nothing,
        Some(Err(e)) => Signal::WaitFailed(e),
    }
}

/// State for one watcher thread. Each `load` starts a new one.
struct Watcher<R: Runtime> {
    client: Mpv,
    url: String,
    /// `url` cut down to its origin for log lines, since the full URL can
    /// hold the login.
    log_origin: String,
    app: AppHandle<R>,
    kill: Arc<AtomicBool>,
    /// Retries armed since playback last recovered. Zero while healthy.
    attempt: u32,
    /// When the next `loadfile` goes out. While it is set, further triggers
    /// for the same failure are ignored.
    next_retry_at: Option<Instant>,
    /// Whether the frontend was last sent `mpv://buffering`, so repeated
    /// property changes don't send the same event again.
    buffering_emitted: bool,
    /// The latest playback position, used to resume after a reload.
    last_known_pos: Option<f64>,
    /// Position at the first `PlaybackRestart` after a reload. The reload
    /// counts as recovered once `time-pos` gets
    /// `RECOVERY_CONFIRM_ADVANCE_SECS` past it.
    recovery_baseline: Option<f64>,
    /// When `recovery_baseline` was set, for `RECOVERY_STALL_TIMEOUT_SECS`.
    recovery_started_at: Option<Instant>,
    /// `MAX_ATTEMPTS` ran out and `mpv://load-failed` went out. Only a
    /// shutdown counts after that.
    gave_up: bool,
}

impl<R: Runtime> Watcher<R> {
    /// A watcher for a stream that is healthy so far. Tests build one this
    /// way and run it on a thread of their own.
    fn new(client: Mpv, url: String, app: AppHandle<R>, kill: Arc<AtomicBool>) -> Self {
        Self {
            client,
            log_origin: origin_for_log(&url),
            url,
            app,
            kill,
            attempt: 0,
            next_retry_at: None,
            buffering_emitted: false,
            last_known_pos: None,
            recovery_baseline: None,
            recovery_started_at: None,
            gave_up: false,
        }
    }

    fn run(mut self) {
        // Best effort. Without it the event stream is only noisier.
        if let Err(e) = self.client.disable_deprecated_events() {
            tracing::trace!("[MPV reconnect] disable_deprecated_events: {e}");
        }
        for (name, format, id) in OBSERVED {
            if let Err(e) = self.client.observe_property(name, format, id) {
                tracing::warn!("[MPV reconnect] observe {name} failed: {e}");
            }
        }
        tracing::info!("[MPV reconnect] watcher started for {}", self.log_origin);

        loop {
            // MpvState sets this before it destroys the parent mpv. Returning
            // drops this client, which would otherwise keep the core alive.
            if self.kill.load(Ordering::Acquire) {
                tracing::info!("[MPV reconnect] kill flag set, exiting watcher");
                return;
            }

            // The timeout keeps the retry timers running while mpv is quiet.
            let next = signal(self.client.wait_event(1.0));
            if self.on_signal(next).is_break() {
                return;
            }
        }
    }

    /// Acts on one signal from mpv, then sends a reload that is due. Breaks
    /// when the watcher should exit. Tests call it with signals of their own.
    fn on_signal(&mut self, signal: Signal) -> ControlFlow<()> {
        match signal {
            Signal::Shutdown => {
                // MpvState sets the kill flag before it destroys the player,
                // so without it mpv quit by itself. Playback stops here, since
                // the player page may not be open to stop it.
                if !self.kill.load(Ordering::Acquire)
                    && self
                        .app
                        .try_state::<MpvState>()
                        .is_some_and(|state| state.stop_after_quit(&self.kill))
                {
                    tracing::info!("[MPV reconnect] mpv quit by itself, the window was closed");
                    let _ = self
                        .app
                        .emit(EVENT_WINDOW_CLOSED, UrlPayload { url: &self.url });
                }
                tracing::info!("[MPV reconnect] received Shutdown, exiting watcher");
                return ControlFlow::Break(());
            }
            _ if self.gave_up => return ControlFlow::Continue(()),
            Signal::PausedForCache(paused) => self.on_paused_for_cache(paused),
            Signal::EndFile(reason) => {
                let Some(label) = self.end_file_trigger(reason) else {
                    return ControlFlow::Continue(());
                };
                self.arm_retry(label);
            }
            Signal::EofReached(true) if self.next_retry_at.is_none() && self.is_premature_eof() => {
                tracing::warn!(
                    "[MPV reconnect] eof-reached=true (premature), likely a swallowed EndFile; arming retry ({})",
                    self.log_origin
                );
                self.arm_retry("eof-reached (premature)");
            }
            // mpv goes idle on startup too, before anything has played,
            // so only count it once playback got going.
            Signal::IdleActive(true) if self.next_retry_at.is_none() && self.had_playback() => {
                tracing::warn!(
                    "[MPV reconnect] idle-active=true after playback, mpv unloaded the file; arming retry ({})",
                    self.log_origin
                );
                self.arm_retry("idle-active");
            }
            Signal::PlaybackRestart if self.attempt > 0 && self.recovery_baseline.is_none() => {
                self.start_recovery_check();
            }
            Signal::TimePos(pos) => self.on_time_pos(pos),
            Signal::WaitFailed(e) => {
                // Usually an end of file that libmpv2 turned into an
                // error. The same failure also sets `eof-reached` or
                // `idle-active`, which arm the retry, so this only logs.
                tracing::warn!("[MPV reconnect] wait_event Err (likely a swallowed EndFile): {e}");
            }
            _ => {}
        }

        if self.recovery_stalled() {
            self.arm_retry("recovery stalled");
        }
        if self
            .next_retry_at
            .is_some_and(|when| Instant::now() >= when)
        {
            self.reload();
        }
        ControlFlow::Continue(())
    }

    fn on_paused_for_cache(&mut self, paused: bool) {
        if paused && !self.buffering_emitted {
            tracing::warn!(
                "[MPV reconnect] paused-for-cache=true, cache drained; likely a network stall ({})",
                self.log_origin
            );
            let _ = self
                .app
                .emit(EVENT_BUFFERING, UrlPayload { url: &self.url });
            self.buffering_emitted = true;
        } else if !paused && self.buffering_emitted {
            tracing::info!(
                "[MPV reconnect] paused-for-cache=false, cache refilled ({})",
                self.log_origin
            );
            let _ = self.app.emit(EVENT_BUFFERED, UrlPayload { url: &self.url });
            self.buffering_emitted = false;
        }
    }

    /// Returns the retry label when this end of file should arm a retry.
    fn end_file_trigger(&self, reason: EndFileReason) -> Option<&'static str> {
        let label = match reason {
            r if r == mpv_end_file_reason::Error => "EndFile(Error)",
            r if r == mpv_end_file_reason::Eof => {
                // mpv reports a connection the server closed early as a clean
                // end of file, so check how far playback got.
                if !self.is_premature_eof() {
                    tracing::info!(
                        "[MPV reconnect] EndFile(Eof) at end of stream, not reconnecting"
                    );
                    return None;
                }
                "EndFile(Eof premature)"
            }
            _ => {
                tracing::debug!(
                    "[MPV reconnect] EndFile (reason={}), not auto-reconnecting",
                    reason
                );
                return None;
            }
        };
        if self.next_retry_at.is_some() {
            tracing::debug!(
                "[MPV reconnect] {} arrived but a retry is already armed, skipping",
                label
            );
            return None;
        }
        Some(label)
    }

    fn is_premature_eof(&self) -> bool {
        let pos = self.client.get_property::<f64>("time-pos").ok();
        let duration = self.client.get_property::<f64>("duration").ok();
        let premature = ended_early(pos, duration);
        tracing::debug!(
            "[MPV reconnect] EndFile(Eof) premature-check: pos={:?} duration={:?} premature={} origin={}",
            pos,
            duration,
            premature,
            self.log_origin
        );
        premature
    }

    fn had_playback(&self) -> bool {
        self.last_known_pos.is_some_and(|p| p > 1.0)
    }

    /// `PlaybackRestart` means the decoder is about to show its first frame,
    /// so the position here is the baseline for confirming the reload.
    fn start_recovery_check(&mut self) {
        let pos = self
            .client
            .get_property::<f64>("time-pos")
            .ok()
            .filter(|p| p.is_finite())
            .unwrap_or_else(|| self.last_known_pos.unwrap_or(0.0));
        tracing::debug!(
            "[MPV reconnect] PlaybackRestart, recovery baseline={:.3}",
            pos
        );
        self.recovery_baseline = Some(pos);
        self.recovery_started_at = Some(Instant::now());
    }

    fn on_time_pos(&mut self, pos: f64) {
        if pos.is_finite() && pos > 0.0 {
            self.last_known_pos = Some(pos);
        }
        let Some(baseline) = self.recovery_baseline else {
            return;
        };
        if recovery_confirmed(baseline, pos) {
            tracing::info!(
                "[MPV reconnect] confirmed recovery: pos={:.3} advanced past baseline {:.3} (after {} attempt(s))",
                pos,
                baseline,
                self.attempt
            );
            let _ = self
                .app
                .emit(EVENT_RECONNECTED, UrlPayload { url: &self.url });
            self.attempt = 0;
            self.next_retry_at = None;
            self.recovery_baseline = None;
            self.recovery_started_at = None;
        }
    }

    /// A reload that restarted playback but hasn't moved for
    /// `RECOVERY_STALL_TIMEOUT_SECS` is waiting for data that won't come.
    fn recovery_stalled(&self) -> bool {
        self.recovery_started_at.is_some_and(|start| {
            start.elapsed() >= Duration::from_secs(RECOVERY_STALL_TIMEOUT_SECS)
        })
    }

    /// Counts an attempt, sends `mpv://reconnecting` and schedules the
    /// reload. Once `MAX_ATTEMPTS` are used up it sends `mpv://load-failed`
    /// instead and gives up.
    fn arm_retry(&mut self, label: &str) {
        // Playback never got past the old baseline, so drop it.
        self.recovery_baseline = None;
        self.recovery_started_at = None;

        self.attempt = self.attempt.saturating_add(1);
        tracing::warn!(
            "[MPV reconnect] {} (attempt #{}/{}) for {}",
            label,
            self.attempt,
            MAX_ATTEMPTS,
            self.log_origin
        );
        if self.attempt > MAX_ATTEMPTS {
            tracing::error!(
                "[MPV reconnect] giving up after {} attempts for {}",
                MAX_ATTEMPTS,
                self.log_origin
            );
            let _ = self
                .app
                .emit(EVENT_LOAD_FAILED, UrlPayload { url: &self.url });
            self.gave_up = true;
            self.next_retry_at = None;
            return;
        }
        let _ = self.app.emit(
            EVENT_RECONNECTING,
            ReconnectingPayload {
                url: &self.url,
                attempt: self.attempt,
            },
        );
        self.next_retry_at = Some(Instant::now() + retry_delay(self.attempt));
    }

    fn reload(&mut self) {
        self.next_retry_at = None;
        self.recovery_baseline = None;
        self.recovery_started_at = None;
        let resume_arg = resume_option(self.last_known_pos);
        tracing::info!(
            "[MPV reconnect] re-issuing loadfile (attempt #{}, resume={:?}) for {}",
            self.attempt,
            resume_arg,
            self.log_origin
        );
        // A client shares the player core, so this replaces the main
        // player's file and the renderer stays attached.
        if let Err(e) = loadfile(&self.client, &self.url, resume_arg.as_deref()) {
            tracing::warn!("[MPV reconnect] loadfile re-issue failed: {e}");
            // A failed command isn't a new attempt, so wait as long as the
            // next attempt would.
            self.next_retry_at = Some(Instant::now() + retry_delay(self.attempt + 1));
        }
    }
}

/// Wait before reload number `attempt`. The first goes out at once, then
/// the wait doubles from 1 second up to `BACKOFF_CAP_SECS`.
fn retry_delay(attempt: u32) -> Duration {
    if attempt <= 1 {
        return Duration::ZERO;
    }
    let secs = 1u64 << (attempt - 2).min(6);
    Duration::from_secs(secs.min(BACKOFF_CAP_SECS))
}

/// Whether an end of file came before the stream's real end.
///
/// Without both a position and a positive duration, as on a live stream,
/// any end of file counts as early.
pub(crate) fn ended_early(pos: Option<f64>, duration: Option<f64>) -> bool {
    match (pos, duration) {
        (Some(p), Some(d)) if d > 0.0 => p < d - PREMATURE_EOF_SLACK_SECS,
        _ => true,
    }
}

fn recovery_confirmed(baseline: f64, pos: f64) -> bool {
    pos.is_finite() && pos >= baseline + RECOVERY_CONFIRM_ADVANCE_SECS
}

#[cfg(test)]
mod watcher_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_doubles_up_to_the_cap() {
        let secs: Vec<u64> = (1..=11).map(|a| retry_delay(a).as_secs()).collect();
        assert_eq!(secs, [0, 1, 2, 4, 8, 16, 30, 30, 30, 30, 30]);
    }

    #[test]
    fn failed_loadfile_waits_like_the_next_attempt() {
        let secs: Vec<u64> = (1..=8).map(|a| retry_delay(a + 1).as_secs()).collect();
        assert_eq!(secs, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn end_of_file_near_the_duration_is_the_real_end() {
        assert!(!ended_early(Some(100.0), Some(100.0)));
        assert!(!ended_early(Some(96.0), Some(100.0)));
        assert!(!ended_early(Some(95.0), Some(100.0)));
    }

    #[test]
    fn end_of_file_short_of_the_duration_is_early() {
        assert!(ended_early(Some(94.9), Some(100.0)));
        assert!(ended_early(Some(10.0), Some(100.0)));
    }

    #[test]
    fn end_of_file_without_a_duration_is_early() {
        assert!(ended_early(Some(10.0), None));
        assert!(ended_early(Some(10.0), Some(0.0)));
        assert!(ended_early(None, Some(100.0)));
        assert!(ended_early(None, None));
    }

    #[test]
    fn recovery_needs_a_second_of_progress() {
        assert!(!recovery_confirmed(10.0, 10.5));
        assert!(recovery_confirmed(10.0, 11.0));
        assert!(!recovery_confirmed(10.0, f64::NAN));
        assert!(!recovery_confirmed(10.0, f64::INFINITY));
    }

    #[test]
    fn signal_reads_the_observed_properties() {
        let change = |name, change| {
            signal(Some(Ok(Event::PropertyChange {
                name,
                change,
                reply_userdata: 0,
            })))
        };
        assert_eq!(
            change("paused-for-cache", PropertyData::Flag(true)),
            Signal::PausedForCache(true)
        );
        assert_eq!(
            change("time-pos", PropertyData::Double(12.5)),
            Signal::TimePos(12.5)
        );
        assert_eq!(
            change("eof-reached", PropertyData::Flag(true)),
            Signal::EofReached(true)
        );
        assert_eq!(
            change("idle-active", PropertyData::Flag(false)),
            Signal::IdleActive(false)
        );
        assert_eq!(
            change("time-pos", PropertyData::Flag(true)),
            Signal::Nothing
        );
        assert_eq!(
            change("volume", PropertyData::Double(50.0)),
            Signal::Nothing
        );
    }

    #[test]
    fn signal_reads_events_and_errors() {
        assert_eq!(signal(Some(Ok(Event::Shutdown))), Signal::Shutdown);
        assert_eq!(
            signal(Some(Ok(Event::EndFile(mpv_end_file_reason::Error)))),
            Signal::EndFile(mpv_end_file_reason::Error)
        );
        assert_eq!(
            signal(Some(Ok(Event::PlaybackRestart))),
            Signal::PlaybackRestart
        );
        assert_eq!(signal(Some(Ok(Event::FileLoaded))), Signal::Nothing);
        assert_eq!(signal(None), Signal::Nothing);
        assert_eq!(
            signal(Some(Err(libmpv2::Error::Raw(-13)))),
            Signal::WaitFailed(libmpv2::Error::Raw(-13))
        );
    }

    #[test]
    fn every_observed_property_has_its_own_id() {
        let mut ids: Vec<u64> = OBSERVED.iter().map(|(_, _, id)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), OBSERVED.len());
    }
}
