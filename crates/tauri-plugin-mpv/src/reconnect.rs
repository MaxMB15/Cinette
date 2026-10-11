// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Background watcher that auto-recovers playback after network outages.
//!
//! ## Failure signals
//!
//! Network problems manifest several ways inside libmpv. We listen for all
//! of them — duplicated signals are deduplicated by `next_retry_at`:
//!
//! 1. **Soft stall (FFmpeg silently retrying).** With
//!    `stream-lavf-o=reconnect=1,reconnect_streamed=1`, FFmpeg retries the
//!    underlying HTTP read forever — the demuxer never raises an error and
//!    the only outward sign is that mpv's demuxer cache drains and
//!    `paused-for-cache` flips to `true`. This is the COMMON case during
//!    Wi-Fi drops / network switches.
//!
//!    We observe `paused-for-cache` and emit `mpv://buffering` /
//!    `mpv://buffered` so the UI can show a connection-issues overlay
//!    within seconds. No `loadfile` is re-issued — FFmpeg's own reconnect
//!    handles recovery.
//!
//! 2. **Hard failure (`EndFile(Error)` or libmpv2-swallowed equivalent).**
//!    Some providers force-close the connection, return 5xx, or libmpv's
//!    own `network-timeout` fires before FFmpeg's reconnect could establish
//!    a session. The demuxer raises `MPV_EVENT_END_FILE` with
//!    `reason == MPV_END_FILE_REASON_ERROR`. **Important quirk:** libmpv2's
//!    `wait_event` wrapper short-circuits *any* `END_FILE` whose
//!    `end_file.error` is non-zero into an opaque `Err(Error::Raw(...))` —
//!    the `Event::EndFile(reason)` arm never runs in that case. mpv sets
//!    `end_file.error` on most abnormal ends (premature truncation, network
//!    error, decode-pipeline shutdown), so the `Event::EndFile(Error)` arm
//!    fires far less often than naïve reading of the libmpv docs suggests.
//!
//! 3. **Premature EOF.** FFmpeg's HTTP demuxer can also exhaust its retry
//!    budget while the connection itself ended "cleanly" (server closed the
//!    socket, or `Content-Length` claimed more bytes than were delivered).
//!    With `keep-open=yes` mpv parks at the truncation point; pressing play
//!    just bounces back to paused because there is nothing left to read.
//!
//! ## Why we observe `eof-reached` and `idle-active`
//!
//! Because libmpv2 silently drops most error-flavoured `EndFile` events
//! (see (2) above), relying on `Event::EndFile` alone leaves the watcher
//! blind during exactly the scenarios it's supposed to recover from. To
//! sidestep that limitation we observe two boolean properties whose
//! `PropertyChange` events are NOT gated by `event.error`:
//!
//! - `eof-reached` flips to `true` whenever the demuxer reaches EOF —
//!   premature or otherwise. Combined with a `time-pos` vs `duration`
//!   check, it gives us a reliable "stream ran out" signal even when
//!   `EndFile` is squelched.
//! - `idle-active` flips to `true` when mpv unloads the file entirely
//!   (the hard-error path with `keep-open=yes`: errors quit, EOF doesn't).
//!   We treat it as a trigger only after we've seen real playback
//!   (`last_known_pos > 1.0`) so the property's initial transient during
//!   startup doesn't fire a false alarm.
//!
//! Whichever signal arrives first arms the retry; subsequent duplicates
//! are no-ops thanks to the `next_retry_at` guard.
//!
//! ## Lifecycle
//!
//! - One monitor thread per `load()`. Spawned at the end of `load_impl` once
//!   playback has actually started.
//! - The thread owns its own `Mpv` client handle (independent event queue,
//!   but full command capability — it can re-issue `loadfile`).
//! - **Cancellation is driven by an explicit `Arc<AtomicBool>` kill flag**,
//!   tripped by `MpvState::cancel_reconnect_monitor` before the parent `Mpv`
//!   is dropped (i.e. before every `stop()` and the start of every new
//!   `load()`). We cannot rely on `MPV_EVENT_SHUTDOWN` for teardown because
//!   per the libmpv docs the client handle returned by `mpv_create_client`
//!   holds a *strong* reference to the player core — so dropping the parent
//!   `Mpv` alone does NOT trigger Shutdown until the client is also dropped.
//!   Leaving the watcher alive after teardown would leak the libmpv core,
//!   the macOS hardware decoder, and the audio device into the next load.
//! - The thread checks `kill.load(Acquire)` at the top of every loop
//!   iteration (and the `wait_event(1.0)` 1-second timeout bounds the worst
//!   case latency on a cancellation). When the flag is set, the thread
//!   returns, drops its client, and the core is finally released.

use libmpv2::{
    events::{Event, PropertyData},
    mpv_end_file_reason, EndFileReason, Format, Mpv,
};
use serde::Serialize;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

/// Maximum backoff between consecutive reconnect attempts.
///
/// Each `loadfile` call itself can block for up to `reconnect_delay_max`
/// seconds (5 s, set on the FFmpeg lavf options) while ffmpeg retries the
/// HTTP handshake, so total time between attempts is roughly
/// `BACKOFF_CAP_SECS + 5 s`.
const BACKOFF_CAP_SECS: u64 = 30;

/// Give up after this many consecutive failed reconnect attempts. Without a
/// cap, a permanently broken URL (404, DNS gone, user is genuinely offline)
/// would spin the watcher thread forever. With `MAX_ATTEMPTS=10` and the
/// backoff schedule (0, 1, 2, 4, 8, 16, 30, 30, 30, 30 s) the user waits
/// up to about 2 minutes before we surface "stream unavailable" to the UI.
const MAX_ATTEMPTS: u32 = 10;

/// Slack (in seconds) when checking whether an EOF is "premature".
///
/// On a normal end-of-file, mpv may fire `EndFile(Eof)` a few hundred
/// milliseconds before `time-pos` reaches the very last sample. Treating
/// anything less than `duration - PREMATURE_EOF_SLACK_SECS` as premature
/// gives us a safe window: we won't accidentally re-trigger reconnect on a
/// VOD that finished playing, but anything that ends materially short of
/// the declared duration is recognised as a network-induced truncation.
const PREMATURE_EOF_SLACK_SECS: f64 = 5.0;

/// How much `time-pos` must advance after `PlaybackRestart` before we
/// consider a reconnect attempt successful. `FileLoaded` alone is not a
/// reliable signal because mpv emits it once metadata is parsed — long
/// before any actual frames are decoded, and even when the underlying
/// socket is already dead (mpv may have cached headers from the previous
/// attempt). Requiring real playback advance ensures the UI doesn't dismiss
/// the "reconnecting" banner prematurely.
const RECOVERY_CONFIRM_ADVANCE_SECS: f64 = 1.0;

/// If `PlaybackRestart` fires but `time-pos` fails to advance by
/// `RECOVERY_CONFIRM_ADVANCE_SECS` within this window, treat the recovery
/// as stalled and trigger another reconnect attempt. Without this safety
/// net, an mpv instance that loads metadata but can't fetch payload bytes
/// (which is what the user's logs show) would sit forever between
/// PlaybackRestart and EOF — no event would fire to drive recovery forward.
const RECOVERY_STALL_TIMEOUT_SECS: u64 = 15;

/// Tauri event emitted when the monitor begins recovering from a hard error.
/// Payload: `{ "url": string, "attempt": number }`.
const EVENT_RECONNECTING: &str = "mpv://reconnecting";

/// Tauri event emitted when playback successfully resumes after a reconnect.
/// Payload: `{ "url": string }`.
const EVENT_RECONNECTED: &str = "mpv://reconnected";

/// Tauri event emitted when `paused-for-cache` becomes `true` — i.e. mpv's
/// demuxer cache has drained and playback is stalled waiting for more data.
/// This is the first observable sign of a soft network stall while FFmpeg
/// silently retries the underlying HTTP read. Payload: `{ "url": string }`.
const EVENT_BUFFERING: &str = "mpv://buffering";

/// Tauri event emitted when `paused-for-cache` returns to `false` (cache
/// refilled, playback resumed). Payload: `{ "url": string }`.
const EVENT_BUFFERED: &str = "mpv://buffered";

/// Tauri event emitted when reconnect attempts are exhausted (URL is
/// permanently unreachable). The user must take action to recover (retry
/// from the UI, switch network, etc.). Payload: `{ "url": string }`.
const EVENT_LOAD_FAILED: &str = "mpv://load-failed";

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

/// Spawn the background watcher. The caller is responsible for setting
/// `kill` to true (and for not reusing the same flag across spawns)
/// **before** the parent `Mpv` is destroyed — otherwise the still-alive
/// client handle keeps the libmpv core alive (per the libmpv docs:
/// regular clients from `mpv_create_client` hold a strong reference to
/// the player core). Leaking the core causes hardware-decoder and audio
/// device contention with the next loaded stream.
pub fn spawn<R: Runtime>(client: Mpv, url: String, app: AppHandle<R>, kill: Arc<AtomicBool>) {
    let watcher = Watcher {
        client,
        url,
        app,
        kill,
        attempt: 0,
        next_retry_at: None,
        buffering_emitted: false,
        last_known_pos: None,
        recovery_baseline: None,
        recovery_started_at: None,
    };
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
        // FileLoaded is not a sign of recovery. mpv sends it once the headers
        // parse, even when the socket is already dead.
        Some(Ok(_)) | None => Signal::Nothing,
        Some(Err(e)) => Signal::WaitFailed(e),
    }
}

/// State for one watcher thread. Each `load` starts a new one.
struct Watcher<R: Runtime> {
    client: Mpv,
    url: String,
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
}

impl<R: Runtime> Watcher<R> {
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
        tracing::info!("[MPV reconnect] watcher started for url={}", self.url);

        loop {
            // MpvState sets this before it destroys the parent mpv. Returning
            // drops this client, which would otherwise keep the core alive.
            if self.kill.load(Ordering::Acquire) {
                tracing::info!("[MPV reconnect] kill flag set — exiting watcher");
                return;
            }

            // The timeout keeps the retry timers running while mpv is quiet.
            match signal(self.client.wait_event(1.0)) {
                Signal::Shutdown => {
                    tracing::info!("[MPV reconnect] received Shutdown — exiting watcher");
                    return;
                }
                Signal::PausedForCache(paused) => self.on_paused_for_cache(paused),
                Signal::EndFile(reason) => {
                    let Some(label) = self.end_file_trigger(reason) else {
                        continue;
                    };
                    if self.arm_retry(label).is_break() {
                        return;
                    }
                }
                Signal::EofReached(true)
                    if self.next_retry_at.is_none() && self.is_premature_eof() =>
                {
                    tracing::warn!(
                        "[MPV reconnect] eof-reached=true (premature) — likely a swallowed EndFile, arming retry ({})",
                        self.url
                    );
                    if self.arm_retry("eof-reached (premature)").is_break() {
                        return;
                    }
                }
                // mpv goes idle on startup too, before anything has played,
                // so only count it once playback got going.
                Signal::IdleActive(true) if self.next_retry_at.is_none() && self.had_playback() => {
                    tracing::warn!(
                        "[MPV reconnect] idle-active=true after playback — mpv unloaded the file, arming retry ({})",
                        self.url
                    );
                    if self.arm_retry("idle-active").is_break() {
                        return;
                    }
                }
                Signal::PlaybackRestart if self.attempt > 0 && self.recovery_baseline.is_none() => {
                    self.start_recovery_check();
                }
                Signal::TimePos(pos) => self.on_time_pos(pos),
                Signal::WaitFailed(e) => {
                    // Usually an end of file that libmpv2 turned into an
                    // error. The same failure also sets `eof-reached` or
                    // `idle-active`, which arm the retry, so this only logs.
                    tracing::warn!(
                        "[MPV reconnect] wait_event Err (likely a swallowed EndFile): {e}"
                    );
                }
                _ => {}
            }

            if self.recovery_stalled() && self.arm_retry("recovery stalled").is_break() {
                return;
            }
            if self
                .next_retry_at
                .is_some_and(|when| Instant::now() >= when)
            {
                self.reload();
            }
        }
    }

    fn on_paused_for_cache(&mut self, paused: bool) {
        if paused && !self.buffering_emitted {
            tracing::warn!(
                "[MPV reconnect] paused-for-cache=true — cache drained, likely network stall ({})",
                self.url
            );
            let _ = self
                .app
                .emit(EVENT_BUFFERING, UrlPayload { url: &self.url });
            self.buffering_emitted = true;
        } else if !paused && self.buffering_emitted {
            tracing::info!(
                "[MPV reconnect] paused-for-cache=false — cache refilled ({})",
                self.url
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
                        "[MPV reconnect] EndFile(Eof) at end of stream — not reconnecting"
                    );
                    return None;
                }
                "EndFile(Eof premature)"
            }
            _ => {
                tracing::debug!(
                    "[MPV reconnect] EndFile (reason={}) — not auto-reconnecting",
                    reason
                );
                return None;
            }
        };
        if self.next_retry_at.is_some() {
            tracing::debug!(
                "[MPV reconnect] {} arrived but retry already armed — dedup skip",
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
            "[MPV reconnect] EndFile(Eof) premature-check: pos={:?} duration={:?} premature={} url={}",
            pos,
            duration,
            premature,
            self.url
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
            "[MPV reconnect] PlaybackRestart — recovery baseline={:.3}",
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
    /// instead and breaks.
    fn arm_retry(&mut self, label: &str) -> ControlFlow<()> {
        // Playback never got past the old baseline, so drop it.
        self.recovery_baseline = None;
        self.recovery_started_at = None;

        self.attempt = self.attempt.saturating_add(1);
        tracing::warn!(
            "[MPV reconnect] {} (attempt #{}/{}) for {}",
            label,
            self.attempt,
            MAX_ATTEMPTS,
            self.url
        );
        if self.attempt > MAX_ATTEMPTS {
            tracing::error!(
                "[MPV reconnect] giving up after {} attempts for {}",
                MAX_ATTEMPTS,
                self.url
            );
            let _ = self
                .app
                .emit(EVENT_LOAD_FAILED, UrlPayload { url: &self.url });
            return ControlFlow::Break(());
        }
        let _ = self.app.emit(
            EVENT_RECONNECTING,
            ReconnectingPayload {
                url: &self.url,
                attempt: self.attempt,
            },
        );
        self.next_retry_at = Some(Instant::now() + retry_delay(self.attempt));
        ControlFlow::Continue(())
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
            self.url
        );
        // A client shares the player core, so this replaces the main
        // player's file and the renderer stays attached.
        let result = match &resume_arg {
            Some(opts) => self
                .client
                .command("loadfile", &[&self.url, "replace", "0", opts]),
            None => self.client.command("loadfile", &[&self.url, "replace"]),
        };
        if let Err(e) = result {
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
fn ended_early(pos: Option<f64>, duration: Option<f64>) -> bool {
    match (pos, duration) {
        (Some(p), Some(d)) if d > 0.0 => p < d - PREMATURE_EOF_SLACK_SECS,
        _ => true,
    }
}

fn recovery_confirmed(baseline: f64, pos: f64) -> bool {
    pos.is_finite() && pos >= baseline + RECOVERY_CONFIRM_ADVANCE_SECS
}

/// The per-file `loadfile` option that resumes from the last position, once
/// playback has passed the first second.
fn resume_option(last_known_pos: Option<f64>) -> Option<String> {
    last_known_pos
        .filter(|p| *p > 1.0)
        .map(|p| format!("start=+{p:.3}"))
}

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
    fn resume_starts_after_the_first_second() {
        assert_eq!(resume_option(None), None);
        assert_eq!(resume_option(Some(1.0)), None);
        assert_eq!(resume_option(Some(1.5)).as_deref(), Some("start=+1.500"));
        assert_eq!(
            resume_option(Some(754.12345)).as_deref(),
            Some("start=+754.123")
        );
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
