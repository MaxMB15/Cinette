// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! AirPlay video through AVPlayer.
//!
//! mpv can't send video over AirPlay, so while AirPlay plays, AVPlayer
//! plays instead and mpv is stopped. Apps can't list AirPlay receivers: the
//! user picks one in the system route picker, and the app learns which from
//! the audio route. The Swift side (`ios/Sources/AirPlay.swift`) owns the
//! player, the picker and the route detector. It reports AVPlayer's state
//! as JSON, which [`Tracker`] turns into the state the frontend shows.
//!
//! The stream URL comes from the app crate through [`load`] and goes
//! straight to Swift. It never reaches the frontend, an event or a log.
//!
//! Only iOS has AirPlay so far. Elsewhere every command fails with
//! [`UNAVAILABLE`].

use crate::lock::lock_or_recover;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{command, AppHandle, Emitter, Manager, Runtime, State};

#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "ios")]
use ios as backend;
#[cfg(not(target_os = "ios"))]
mod unavailable;
#[cfg(not(target_os = "ios"))]
use unavailable as backend;
#[cfg(test)]
mod tests;

/// What every command says on a platform without AirPlay.
pub const UNAVAILABLE: &str = "AirPlay isn't available on this device";

/// Whether an AirPlay receiver is in reach, so the picker shows its row.
pub const EVENT_AVAILABLE: &str = "airplay://available";
/// The AirPlay receiver the audio route goes to, or `null` when it's this
/// device. A [`Route`].
pub const EVENT_ROUTE: &str = "airplay://route";
/// The system route picker closed.
pub const EVENT_PICKER_CLOSED: &str = "airplay://picker-closed";
/// A new [`AirPlayState`].
pub const EVENT_STATE: &str = "airplay://state";

/// How long AVPlayer may wait for data before the receiver counts as
/// reconnecting, and then as lost. The same times as Cast.
const RECONNECTING_AFTER: Duration = Duration::from_secs(10);
const LOST_AFTER: Duration = Duration::from_secs(30);

/// An AirPlay receiver, from the audio route. iOS gives no model and no
/// address, only a name and a uid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Route {
    /// `airplay:<uid>`.
    pub id: String,
    pub name: String,
}

impl Route {
    pub fn new(uid: &str, name: &str) -> Self {
        Self {
            id: format!("airplay:{uid}"),
            name: name.to_string(),
        }
    }
}

/// One of AVPlayer's subtitle or audio options.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Track {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// What Swift reports about AVPlayer, as JSON.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// `opening` until the item is ready, then `playing`, `paused` or
    /// `waiting`, `ended` at the end, `failed` when the item failed.
    pub status: String,
    /// Seconds into the item.
    pub position: f64,
    /// Seconds, or `null` while AVPlayer doesn't know or the item is live.
    pub duration: Option<f64>,
    /// `isExternalPlaybackActive`: the video is on the receiver.
    pub external: bool,
    #[serde(default)]
    pub error: Option<ReportError>,
    #[serde(default)]
    pub subtitles: Vec<Track>,
    #[serde(default)]
    pub subtitle: Option<usize>,
    #[serde(default)]
    pub audio: Vec<Track>,
    #[serde(default)]
    pub audio_track: Option<usize>,
}

/// AVPlayerItem's error, by domain and code only. Its message can hold the
/// URL, so Swift never sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportError {
    pub domain: String,
    pub code: i64,
    /// The HTTP status in the item's error log, when there is one.
    #[serde(default)]
    pub http_status: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Idle,
    Opening,
    Playing,
    Paused,
    Buffering,
    Ended,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Connection {
    Connected,
    Reconnecting,
    Lost,
}

/// `PlaybackError` in `src/lib/destination.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackError {
    /// `openFailed`, `refused` or `failed`.
    pub code: &'static str,
    /// The receiver couldn't play the stream as it is, so converting it
    /// might work.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unsupported: bool,
}

/// What the frontend shows, in the terms of `PlaybackState`. The frontend
/// adds the item and the time it got this.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AirPlayState {
    pub status: Status,
    pub position: f64,
    /// 0 for live.
    pub duration: f64,
    pub subtitles: Vec<Track>,
    pub subtitle_id: Option<String>,
    pub audio: Vec<Track>,
    pub audio_id: Option<String>,
    pub connection: Connection,
    pub error: Option<PlaybackError>,
}

impl AirPlayState {
    pub fn idle() -> Self {
        Self {
            status: Status::Idle,
            position: 0.0,
            duration: 0.0,
            subtitles: Vec::new(),
            subtitle_id: None,
            audio: Vec::new(),
            audio_id: None,
            connection: Connection::Connected,
            error: None,
        }
    }
}

/// HTTP statuses that mean the provider turned the login down.
const REFUSED_STATUSES: [u16; 2] = [401, 403];

/// AVFoundation and Core Media codes for a stream the receiver can't
/// decode or open, as opposed to one it couldn't reach.
const UNSUPPORTED_AV_CODES: [i64; 4] = [
    -11828, // AVErrorFileFormatNotRecognized
    -11829, // AVErrorFailedToParse
    -11833, // AVErrorDecoderNotFound
    -11821, // AVErrorDecodeFailed
];
const UNSUPPORTED_CM_CODES: [i64; 2] = [
    -12927, // kCMFormatDescriptionError / unsupported media in a playlist
    -12847, // the receiver can't play the media's format
];

fn is_unsupported(error: &ReportError) -> bool {
    match error.domain.as_str() {
        "AVFoundationErrorDomain" => UNSUPPORTED_AV_CODES.contains(&error.code),
        "CoreMediaErrorDomain" => UNSUPPORTED_CM_CODES.contains(&error.code),
        _ => false,
    }
}

/// Turns Swift's reports into the frontend's state, for one item. It
/// remembers what a single report can't say: whether the item ever got
/// ready, whether the video ever reached the receiver, and how long
/// AVPlayer has waited without progress.
#[derive(Debug)]
pub struct Tracker {
    live: bool,
    ready: bool,
    external_seen: bool,
    /// Where the wait started, and the position then.
    waiting_since: Option<(Instant, f64)>,
    lost: bool,
}

impl Tracker {
    pub fn new(live: bool) -> Self {
        Self {
            live,
            ready: false,
            external_seen: false,
            waiting_since: None,
            lost: false,
        }
    }

    pub fn update(&mut self, report: &Report, now: Instant) -> AirPlayState {
        let mut state = AirPlayState {
            status: Status::Opening,
            position: report.position.max(0.0),
            duration: match report.duration {
                Some(d) if !self.live && d.is_finite() => d.max(0.0),
                _ => 0.0,
            },
            subtitle_id: report
                .subtitle
                .filter(|&i| i < report.subtitles.len())
                .map(|i| i.to_string()),
            subtitles: report.subtitles.clone(),
            audio_id: report
                .audio_track
                .filter(|&i| i < report.audio.len())
                .map(|i| i.to_string()),
            audio: report.audio.clone(),
            connection: Connection::Connected,
            error: None,
        };
        if report.external {
            self.external_seen = true;
        } else if self.external_seen {
            // The video left the receiver: the TV went off, another device
            // took it, or the user picked this device in Control Center.
            // AVPlayer would carry on here, which Swift stops.
            self.lost = true;
        }
        state.status = match report.status.as_str() {
            "opening" => Status::Opening,
            "playing" => Status::Playing,
            "paused" => Status::Paused,
            "waiting" => Status::Buffering,
            // A live stream never ends. If AVPlayer says it did, the
            // stream stopped coming.
            "ended" if self.live => Status::Error,
            "ended" => Status::Ended,
            _ => Status::Error,
        };
        if !matches!(state.status, Status::Opening | Status::Error) {
            self.ready = true;
        }
        if state.status == Status::Error {
            state.error = Some(self.error(report.error.as_ref()));
        }
        self.track_waiting(&mut state, report.position, now);
        if self.lost {
            state.connection = Connection::Lost;
        }
        state
    }

    fn error(&self, error: Option<&ReportError>) -> PlaybackError {
        let refused = error
            .and_then(|e| e.http_status)
            .is_some_and(|s| REFUSED_STATUSES.contains(&s));
        let code = if refused {
            "refused"
        } else if self.ready {
            "failed"
        } else {
            "openFailed"
        };
        PlaybackError {
            code,
            unsupported: error.is_some_and(is_unsupported),
        }
    }

    /// Buffering with no progress for [`RECONNECTING_AFTER`] is
    /// `reconnecting`, and for [`LOST_AFTER`] it's `lost`. Opening counts
    /// too, since a receiver that went away never gets the item ready.
    fn track_waiting(&mut self, state: &mut AirPlayState, position: f64, now: Instant) {
        if !matches!(state.status, Status::Buffering | Status::Opening) {
            self.waiting_since = None;
            return;
        }
        let since = match self.waiting_since {
            Some((since, at)) if (position - at).abs() < 0.5 => since,
            _ => {
                self.waiting_since = Some((now, position));
                now
            }
        };
        let waited = now.saturating_duration_since(since);
        if waited >= LOST_AFTER {
            self.lost = true;
        } else if waited >= RECONNECTING_AFTER && self.ready {
            state.connection = Connection::Reconnecting;
        }
    }
}

/// Tauri managed state: the item AirPlay plays, if any.
#[derive(Default)]
pub struct AirPlay {
    tracker: Mutex<Option<Tracker>>,
    last: Mutex<Option<AirPlayState>>,
}

impl AirPlay {
    /// Starts tracking a new item.
    pub fn begin(&self, live: bool) {
        *lock_or_recover(&self.tracker) = Some(Tracker::new(live));
        *lock_or_recover(&self.last) = None;
    }

    /// Stops tracking, after AirPlay stopped.
    pub fn end(&self) {
        *lock_or_recover(&self.tracker) = None;
        *lock_or_recover(&self.last) = Some(AirPlayState::idle());
    }

    /// The state for `report`, or `None` when no item is tracked or nothing
    /// changed since the last one.
    pub fn report(&self, report: &Report, now: Instant) -> Option<AirPlayState> {
        let state = lock_or_recover(&self.tracker).as_mut()?.update(report, now);
        let mut last = lock_or_recover(&self.last);
        if last.as_ref() == Some(&state) {
            return None;
        }
        *last = Some(state.clone());
        Some(state)
    }

    pub fn state(&self) -> AirPlayState {
        lock_or_recover(&self.last)
            .clone()
            .unwrap_or_else(AirPlayState::idle)
    }
}

/// Reads a report from Swift and emits the new state, if it changed. A
/// report that doesn't parse is dropped.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn handle_report<R: Runtime>(app: &AppHandle<R>, json: &str, now: Instant) {
    let report: Report = match serde_json::from_str(json) {
        Ok(report) => report,
        Err(e) => {
            tracing::warn!("[AirPlay] unreadable report from Swift: {e}");
            return;
        }
    };
    if let Some(state) = app.state::<AirPlay>().report(&report, now) {
        let _ = app.emit(EVENT_STATE, state);
    }
}

/// Plays `url` over AirPlay from `start_at` seconds, after mpv has stopped.
/// The receiver must already be chosen. `title` goes on the lock screen.
/// Called by the app crate, which resolves the channel's URL; the frontend
/// never sees it.
pub fn load<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    title: &str,
    start_at: Option<f64>,
    live: bool,
) -> Result<(), String> {
    backend::ensure()?;
    app.state::<AirPlay>().begin(live);
    backend::load(url, title, start_position(start_at, live), live)
}

/// Where AVPlayer starts: `start_at` for a movie or an episode, and the
/// live edge for a live channel.
fn start_position(start_at: Option<f64>, live: bool) -> f64 {
    start_at.filter(|_| !live).unwrap_or(0.0)
}

/// Turns receiver detection on while the player is open. It costs power,
/// so it's off otherwise.
#[command]
pub async fn airplay_set_detection(enabled: bool) -> Result<(), String> {
    backend::ensure()?;
    backend::set_detection(enabled);
    Ok(())
}

/// Opens the system route picker, anchored at a rect in the page's CSS
/// pixels (for the iPad's popover). The choice comes back as an
/// [`EVENT_ROUTE`], and the picker closing as [`EVENT_PICKER_CLOSED`].
#[command]
pub async fn airplay_choose(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    backend::ensure()?;
    backend::choose(x, y, width, height);
    Ok(())
}

/// The AirPlay receiver the audio route goes to now, if any.
#[command]
pub async fn airplay_get_route() -> Result<Option<Route>, String> {
    backend::ensure()?;
    Ok(backend::current_route())
}

#[command]
pub async fn airplay_play() -> Result<(), String> {
    backend::ensure()?;
    backend::play();
    Ok(())
}

#[command]
pub async fn airplay_pause() -> Result<(), String> {
    backend::ensure()?;
    backend::pause();
    Ok(())
}

#[command]
pub async fn airplay_seek(position: f64) -> Result<(), String> {
    backend::ensure()?;
    backend::seek(position);
    Ok(())
}

/// Picks a subtitle option by its place in the state's list, or none.
#[command]
pub async fn airplay_select_subtitle(index: Option<usize>) -> Result<(), String> {
    backend::ensure()?;
    backend::select_subtitle(index);
    Ok(())
}

/// Picks an audio option by its place in the state's list.
#[command]
pub async fn airplay_select_audio(index: usize) -> Result<(), String> {
    backend::ensure()?;
    backend::select_audio(index);
    Ok(())
}

/// Stops AVPlayer, which ends AirPlay video. The audio route stays on the
/// receiver until the user picks this device in the route picker.
#[command]
pub async fn airplay_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    backend::ensure()?;
    backend::stop();
    let airplay = app.state::<AirPlay>();
    airplay.end();
    let _ = app.emit(EVENT_STATE, airplay.state());
    Ok(())
}

#[command]
pub async fn airplay_get_state(state: State<'_, AirPlay>) -> Result<AirPlayState, String> {
    Ok(state.state())
}

/// Called once from plugin setup.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    app.manage(AirPlay::default());
    backend::install(app);
}
