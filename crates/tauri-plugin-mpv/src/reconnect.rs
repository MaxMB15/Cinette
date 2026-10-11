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
    mpv_end_file_reason, Format, Mpv,
};
use serde::Serialize;
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

/// `reply_userdata` tags used for `observe_property`. Values are arbitrary;
/// they just need to be stable + unique within the client so PropertyChange
/// events can be routed correctly.
const OBSERVE_ID_PAUSED_FOR_CACHE: u64 = 1;
const OBSERVE_ID_TIME_POS: u64 = 2;
const OBSERVE_ID_EOF_REACHED: u64 = 3;
const OBSERVE_ID_IDLE_ACTIVE: u64 = 4;

#[derive(Clone, Serialize)]
struct ReconnectingPayload<'a> {
    url: &'a str,
    attempt: u32,
}

#[derive(Clone, Serialize)]
struct ReconnectedPayload<'a> {
    url: &'a str,
}

#[derive(Clone, Serialize)]
struct BufferingPayload<'a> {
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
    if let Err(e) = std::thread::Builder::new()
        .name("mpv-reconnect".into())
        .spawn(move || run(client, url, app, kill))
    {
        tracing::warn!("[MPV reconnect] failed to spawn watcher thread: {e}");
    }
}

fn run<R: Runtime>(mut client: Mpv, url: String, app: AppHandle<R>, kill: Arc<AtomicBool>) {
    // We only care about a small subset of events. Disabling deprecated events
    // is best-effort — losing it just means a slightly noisier event stream.
    if let Err(e) = client.disable_deprecated_events() {
        tracing::trace!("[MPV reconnect] disable_deprecated_events: {e}");
    }
    // Observe paused-for-cache. This is THE signal that the underlying
    // network stream has stalled while FFmpeg's lavf reconnect is silently
    // retrying — without observing this property the watcher would only
    // ever react to hard `EndFile(Error)` events, which (deliberately)
    // FFmpeg's reconnect logic prevents from firing for the common case.
    if let Err(e) = client.observe_property(
        "paused-for-cache",
        Format::Flag,
        OBSERVE_ID_PAUSED_FOR_CACHE,
    ) {
        tracing::warn!("[MPV reconnect] observe paused-for-cache failed: {e}");
    }
    // Track time-pos so we can resume from the last known position on a
    // premature-EOF reconnect. Observing as Double (rather than polling) is
    // cheap — mpv emits at most a few changes per second.
    if let Err(e) = client.observe_property("time-pos", Format::Double, OBSERVE_ID_TIME_POS) {
        tracing::warn!("[MPV reconnect] observe time-pos failed: {e}");
    }
    // Observe eof-reached as a backup trigger. libmpv2's wait_event wrapper
    // silently collapses many `EndFile` events into `Err(Error::Raw(...))`
    // (any event whose end_file.error is non-zero), so the `Event::EndFile`
    // arm misses most network-induced terminations. `eof-reached` is a
    // plain boolean PropertyChange that is NOT gated by event.error, so it
    // travels through reliably whenever the demuxer hits EOF.
    if let Err(e) = client.observe_property("eof-reached", Format::Flag, OBSERVE_ID_EOF_REACHED) {
        tracing::warn!("[MPV reconnect] observe eof-reached failed: {e}");
    }
    // Observe idle-active for the same reason: when `keep-open=yes` decides
    // to unload the file (error path), mpv goes idle and we need to know.
    if let Err(e) = client.observe_property("idle-active", Format::Flag, OBSERVE_ID_IDLE_ACTIVE) {
        tracing::warn!("[MPV reconnect] observe idle-active failed: {e}");
    }
    tracing::info!("[MPV reconnect] watcher started for url={}", url);

    // State machine:
    //   attempt == 0 → playback is healthy; do nothing on tick
    //   attempt >= 1 → an EndFile(Error) was observed and we are in the
    //                  retry loop until either FileLoaded or Shutdown
    let mut attempt: u32 = 0;
    let mut next_retry_at: Option<Instant> = None;
    // Tracks the last value emitted to the frontend so we don't spam events
    // on every duplicate PropertyChange.
    let mut buffering_emitted = false;
    // Most recent observed `time-pos`. Used as the resume point on a
    // premature-EOF reconnect. `None` means we haven't seen any playback
    // yet (so reconnecting will simply restart from the beginning).
    let mut last_known_pos: Option<f64> = None;
    // Two-signal recovery confirmation state.
    //
    // - `Some(baseline)`: `PlaybackRestart` has fired since the most recent
    //   `loadfile` retry. We're waiting for `time-pos` to advance past
    //   `baseline + RECOVERY_CONFIRM_ADVANCE_SECS` before declaring success.
    // - `None`: either we're not in a recovery cycle, or the retry's
    //   `PlaybackRestart` hasn't arrived yet.
    //
    // Cleared on: confirmed recovery, EndFile during recovery, or stall.
    let mut recovery_baseline: Option<f64> = None;
    // Wall-clock instant when the most recent `PlaybackRestart` was observed
    // during a recovery cycle. Drives `RECOVERY_STALL_TIMEOUT_SECS` — if
    // `time-pos` doesn't advance fast enough, we re-arm the retry path.
    let mut recovery_started_at: Option<Instant> = None;

    loop {
        // Cooperative cancellation: MpvState::stop / MpvState::load set this
        // flag before destroying the parent mpv so we can drop our client and
        // release the player core promptly (rather than waiting for Shutdown,
        // which only fires once the core is being torn down).
        if kill.load(Ordering::Acquire) {
            tracing::info!("[MPV reconnect] kill flag set — exiting watcher");
            return;
        }

        // Poll with a 1 s timeout so backoff timers stay responsive even
        // when mpv is silent (between attempts during a long outage).
        match client.wait_event(1.0) {
            Some(Ok(Event::Shutdown)) => {
                tracing::info!("[MPV reconnect] received Shutdown — exiting watcher");
                return;
            }
            Some(Ok(Event::PropertyChange {
                name: "paused-for-cache",
                change: PropertyData::Flag(paused),
                ..
            })) => {
                if paused && !buffering_emitted {
                    tracing::warn!(
                        "[MPV reconnect] paused-for-cache=true — cache drained, likely network stall ({})",
                        url
                    );
                    let _ = app.emit(EVENT_BUFFERING, BufferingPayload { url: &url });
                    buffering_emitted = true;
                } else if !paused && buffering_emitted {
                    tracing::info!(
                        "[MPV reconnect] paused-for-cache=false — cache refilled ({})",
                        url
                    );
                    let _ = app.emit(EVENT_BUFFERED, BufferingPayload { url: &url });
                    buffering_emitted = false;
                }
            }
            Some(Ok(Event::EndFile(reason))) => {
                let label = match reason {
                    r if r == mpv_end_file_reason::Error => "EndFile(Error)",
                    r if r == mpv_end_file_reason::Eof => {
                        // mpv considers a connection that closed unexpectedly
                        // (server hangup, "Stream ends prematurely") to be a
                        // clean EOF rather than an error. Distinguish it from
                        // a genuine end-of-file by checking how far we got.
                        if is_premature_eof(&client, &url) {
                            "EndFile(Eof premature)"
                        } else {
                            tracing::info!(
                                "[MPV reconnect] EndFile(Eof) at end of stream — not reconnecting"
                            );
                            continue;
                        }
                    }
                    _ => {
                        tracing::debug!(
                            "[MPV reconnect] EndFile (reason={}) — not auto-reconnecting",
                            reason
                        );
                        continue;
                    }
                };
                if next_retry_at.is_some() {
                    tracing::debug!(
                        "[MPV reconnect] {} arrived but retry already armed — dedup skip",
                        label
                    );
                    continue;
                }
                if arm_retry(
                    label,
                    &mut attempt,
                    &mut next_retry_at,
                    &mut recovery_baseline,
                    &mut recovery_started_at,
                    &url,
                    &app,
                ) {
                    return;
                }
            }
            Some(Ok(Event::PropertyChange {
                name: "eof-reached",
                change: PropertyData::Flag(eof),
                ..
            })) => {
                // Backup trigger for cases where libmpv2 swallowed the
                // matching EndFile event (see module docs). Only react to
                // the false→true transition AND only when no retry is
                // already in flight (dedup against the EndFile arm above).
                if eof && next_retry_at.is_none() && is_premature_eof(&client, &url) {
                    tracing::warn!(
                        "[MPV reconnect] eof-reached=true (premature) — likely a swallowed EndFile, arming retry ({})",
                        url
                    );
                    if arm_retry(
                        "eof-reached (premature)",
                        &mut attempt,
                        &mut next_retry_at,
                        &mut recovery_baseline,
                        &mut recovery_started_at,
                        &url,
                        &app,
                    ) {
                        return;
                    }
                }
            }
            Some(Ok(Event::PropertyChange {
                name: "idle-active",
                change: PropertyData::Flag(idle),
                ..
            })) => {
                // mpv unloaded the file — happens on hard errors with
                // keep-open=yes. Only treat as a trigger if we actually had
                // playback running (otherwise it's the no-op startup transition).
                let had_playback = last_known_pos.map(|p| p > 1.0).unwrap_or(false);
                if idle && next_retry_at.is_none() && had_playback {
                    tracing::warn!(
                        "[MPV reconnect] idle-active=true after playback — mpv unloaded the file, arming retry ({})",
                        url
                    );
                    if arm_retry(
                        "idle-active",
                        &mut attempt,
                        &mut next_retry_at,
                        &mut recovery_baseline,
                        &mut recovery_started_at,
                        &url,
                        &app,
                    ) {
                        return;
                    }
                }
            }
            Some(Ok(Event::FileLoaded)) => {
                // INTENTIONALLY a no-op for recovery purposes. `FileLoaded`
                // fires once metadata is parsed (and can even fire when the
                // socket is already dead, using cached headers). We confirm
                // recovery via `PlaybackRestart` + `time-pos` advance below
                // instead — see `RECOVERY_CONFIRM_ADVANCE_SECS`.
            }
            Some(Ok(Event::PlaybackRestart)) => {
                // PlaybackRestart marks "decoder ready, about to render first
                // frame". Use it as the baseline anchor — we'll confirm the
                // reconnect once `time-pos` advances past it by ≥1 s.
                if attempt > 0 && recovery_baseline.is_none() {
                    let pos = client
                        .get_property::<f64>("time-pos")
                        .ok()
                        .filter(|p| p.is_finite())
                        .unwrap_or_else(|| last_known_pos.unwrap_or(0.0));
                    tracing::debug!(
                        "[MPV reconnect] PlaybackRestart — recovery baseline={:.3}",
                        pos
                    );
                    recovery_baseline = Some(pos);
                    recovery_started_at = Some(Instant::now());
                }
            }
            Some(Ok(Event::PropertyChange {
                name: "time-pos",
                change: PropertyData::Double(pos),
                ..
            })) => {
                // Cache the most recent playback position so we can resume
                // from there on a premature-EOF reconnect (VOD only — for a
                // live stream there's nothing to seek to and `start=` is
                // ignored by mpv).
                if pos.is_finite() && pos > 0.0 {
                    last_known_pos = Some(pos);
                }
                // Recovery confirmation: real playback advance past the
                // PlaybackRestart baseline means frames are actually flowing.
                if let Some(baseline) = recovery_baseline {
                    if pos.is_finite() && pos >= baseline + RECOVERY_CONFIRM_ADVANCE_SECS {
                        tracing::info!(
                            "[MPV reconnect] confirmed recovery: pos={:.3} advanced past baseline {:.3} (after {} attempt(s))",
                            pos,
                            baseline,
                            attempt
                        );
                        let _ = app.emit(EVENT_RECONNECTED, ReconnectedPayload { url: &url });
                        attempt = 0;
                        next_retry_at = None;
                        recovery_baseline = None;
                        recovery_started_at = None;
                    }
                }
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => {
                // libmpv2 short-circuits any event whose `event.error` (or
                // `end_file.error` for EndFile) is non-zero into Err — most
                // commonly an `EndFile(Error)` we'd otherwise want to react
                // to. We don't trigger from here directly because the same
                // failure also flips `eof-reached` or `idle-active`, but
                // log at warn so the cause is visible in field logs.
                tracing::warn!("[MPV reconnect] wait_event Err (likely a swallowed EndFile): {e}");
            }
            None => {} // timeout — fall through to retry check
        }

        // Recovery stall detector: PlaybackRestart fired (baseline set) but
        // time-pos has not advanced past it within the timeout window. mpv is
        // wedged in "loaded but not rendering" state — typically because the
        // decoder is waiting for data that will never arrive. Force another
        // retry rather than sit on a frozen frame indefinitely.
        if let Some(start) = recovery_started_at {
            if start.elapsed() >= Duration::from_secs(RECOVERY_STALL_TIMEOUT_SECS) {
                if arm_retry(
                    "recovery stalled",
                    &mut attempt,
                    &mut next_retry_at,
                    &mut recovery_baseline,
                    &mut recovery_started_at,
                    &url,
                    &app,
                ) {
                    return;
                }
            }
        }

        // Retry tick: if a backoff has elapsed, fire the next loadfile.
        if let Some(when) = next_retry_at {
            if Instant::now() >= when {
                next_retry_at = None;
                // Discard any pending recovery state from the previous
                // attempt — a fresh retry starts from a fresh baseline.
                recovery_baseline = None;
                recovery_started_at = None;
                let resume_arg = last_known_pos
                    .filter(|p| *p > 1.0)
                    .map(|p| format!("start=+{p:.3}"));
                tracing::info!(
                    "[MPV reconnect] re-issuing loadfile (attempt #{}, resume={:?}) for {}",
                    attempt,
                    resume_arg,
                    url
                );
                // `loadfile` via a client handle still drives the primary
                // player (clients share the same playlist/playback core).
                // The render context stays attached, so video resumes
                // without rebuilding the renderer.
                //
                // Pass per-file options as the 4th argument so VOD content
                // resumes from `last_known_pos` rather than restarting from
                // 00:00. For live streams (no `time-pos` observed) we omit
                // the options arg — mpv ignores `start=` on non-seekable
                // input anyway, but skipping it keeps the command tidy.
                let result = if let Some(ref opts) = resume_arg {
                    client.command("loadfile", &[&url, "replace", "0", opts])
                } else {
                    client.command("loadfile", &[&url, "replace"])
                };
                if let Err(e) = result {
                    tracing::warn!("[MPV reconnect] loadfile re-issue failed: {e}");
                    // Schedule another attempt; we'll keep trying until the
                    // parent mpv is destroyed (Shutdown breaks the loop).
                    let secs = 1u64 << (attempt - 1).min(6);
                    next_retry_at =
                        Some(Instant::now() + Duration::from_secs(secs.min(BACKOFF_CAP_SECS)));
                }
            }
        }
    }
}

/// Decide whether a `MPV_END_FILE_REASON_EOF` was actually the end of the
/// stream or a network-induced truncation. We treat it as premature when:
///
/// - duration is unknown / zero (a live stream — EOF should never happen)
/// - OR `time-pos` ended materially short of `duration`
///
/// Either case means playback stopped before it should have, which (with
/// `keep-open=yes`) leaves the player frozen at the truncation point and
/// "play" toggles bounce back to paused. Triggering a reconnect is the only
/// way out.
/// Increment the attempt counter, emit `mpv://reconnecting` (or
/// `mpv://load-failed` when the budget is exhausted), and schedule the
/// next retry tick. Returns `true` if the caller should exit the watcher
/// thread (i.e. attempts were exhausted).
///
/// Centralised so the EndFile arm, the eof-reached / idle-active backups,
/// and the recovery-stall detector all behave identically — they were
/// previously three near-duplicate code paths that drifted independently.
fn arm_retry<R: Runtime>(
    label: &str,
    attempt: &mut u32,
    next_retry_at: &mut Option<Instant>,
    recovery_baseline: &mut Option<f64>,
    recovery_started_at: &mut Option<Instant>,
    url: &str,
    app: &AppHandle<R>,
) -> bool {
    // Any pending recovery is invalidated — playback never made real
    // progress past the prior baseline, so discard it.
    *recovery_baseline = None;
    *recovery_started_at = None;

    *attempt = attempt.saturating_add(1);
    tracing::warn!(
        "[MPV reconnect] {} (attempt #{}/{}) for {}",
        label,
        *attempt,
        MAX_ATTEMPTS,
        url
    );
    if *attempt > MAX_ATTEMPTS {
        tracing::error!(
            "[MPV reconnect] giving up after {} attempts for {}",
            MAX_ATTEMPTS,
            url
        );
        let _ = app.emit(EVENT_LOAD_FAILED, ReconnectedPayload { url });
        return true;
    }
    let _ = app.emit(
        EVENT_RECONNECTING,
        ReconnectingPayload {
            url,
            attempt: *attempt,
        },
    );
    // First retry is immediate; subsequent attempts back off exponentially
    // (1 s, 2 s, 4 s, ...) capped at `BACKOFF_CAP_SECS`.
    let backoff = if *attempt == 1 {
        Duration::from_secs(0)
    } else {
        let secs = 1u64 << ((*attempt - 2).min(6));
        Duration::from_secs(secs.min(BACKOFF_CAP_SECS))
    };
    *next_retry_at = Some(Instant::now() + backoff);
    false
}

fn is_premature_eof(client: &Mpv, url: &str) -> bool {
    let pos = client.get_property::<f64>("time-pos").ok();
    let duration = client.get_property::<f64>("duration").ok();
    let premature = match (pos, duration) {
        (Some(p), Some(d)) if d > 0.0 => p < d - PREMATURE_EOF_SLACK_SECS,
        // No duration => live stream / unknown total. EOF is always
        // unexpected here, so treat as premature.
        _ => true,
    };
    tracing::debug!(
        "[MPV reconnect] EndFile(Eof) premature-check: pos={:?} duration={:?} premature={} url={}",
        pos,
        duration,
        premature,
        url
    );
    premature
}
