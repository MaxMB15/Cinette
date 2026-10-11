// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Saves the resume point for the playing movie or episode while the player
//! page can't. The page saves it itself while it's open and visible. iOS
//! stops the page's timers once the app is in the background, though audio
//! keeps playing, and the page saves nothing after the player closes with
//! the item still playing. For those times the page hands the item over
//! here, and takes it back when it's visible again.

use crate::commands::AppState;
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{command, AppHandle, Manager, Runtime};
use tauri_plugin_mpv::MpvState;

/// Same as `PROGRESS_SAVE_INTERVAL` in `VideoPlayer.tsx`.
const SAVE_INTERVAL: Duration = Duration::from_secs(5);
/// Same as `MIN_RESUME_SECONDS` in `lib/playback.ts`.
const MIN_RESUME_SECONDS: f64 = 30.0;
/// Ticks in a row that mpv may play something else before the thread stops.
/// The item may still be loading when the page hands it over, and a
/// reconnect reloads it, so a short gap doesn't mean mpv moved on.
const MAX_MISSES: u32 = 6;

/// Bumped on every hand-over, so the thread for an older one stops.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressItem {
    /// The resume key, from `playbackKey` in `lib/playback.ts`.
    key: String,
    /// The URL mpv loaded for it. Nothing is saved once mpv plays another.
    url: String,
    /// The resume point the load started at, until playback reaches it.
    pending_start: Option<f64>,
}

/// Same as `isFinished` in `lib/playback.ts`.
fn is_finished(position: f64, duration: f64) -> bool {
    duration > 0.0 && (position >= duration * 0.95 || duration - position < 30.0)
}

/// Starts saving `item`'s position every few seconds, or stops when it's
/// `None`. Stops by itself once mpv has moved on to something else.
#[command]
pub fn hand_off_progress<R: Runtime>(app: AppHandle<R>, item: Option<ProgressItem>) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(item) = item else { return };
    tracing::debug!("[Progress] saving {} from Rust", item.key);
    std::thread::spawn(move || {
        let mut tracker = Tracker {
            item,
            last: None,
            misses: 0,
        };
        while GENERATION.load(Ordering::SeqCst) == generation && tracker.tick(&app) {
            std::thread::sleep(SAVE_INTERVAL);
        }
    });
}

struct Tracker {
    item: ProgressItem,
    /// The position and duration saved last.
    last: Option<(f64, f64)>,
    /// Ticks in a row that mpv wasn't playing the item.
    misses: u32,
}

impl Tracker {
    /// Saves the position if it moved, like `flushProgress` in
    /// `VideoPlayer.tsx`. Returns false once mpv has stopped playing the
    /// item.
    fn tick<R: Runtime>(&mut self, app: &AppHandle<R>) -> bool {
        let s = app.state::<MpvState>().get_state();
        if s.current_url.as_deref() != Some(self.item.url.as_str()) {
            if self.missed() {
                return true;
            }
            tracing::debug!("[Progress] {} is no longer playing", self.item.key);
            return false;
        }
        self.misses = 0;
        let (position, duration) = (s.position, s.duration);
        if duration <= 0.0 || position <= 1.0 {
            return true;
        }
        if let Some(start) = self.item.pending_start {
            if position < start - 5.0 {
                return true;
            }
            self.item.pending_start = None;
        }
        if self.last == Some((position, duration)) {
            return true;
        }
        self.last = Some((position, duration));

        let state = app.state::<AppState>();
        let Ok(cache) = state.cache.lock() else {
            return true;
        };
        let key = &self.item.key;
        let result = if is_finished(position, duration) || position < MIN_RESUME_SECONDS {
            cache.delete_playback_position(key)
        } else {
            cache.save_playback_position(key, position, duration)
        };
        if let Err(e) = result {
            tracing::warn!("[Progress] saving {key} failed: {e}");
        }
        true
    }

    /// Counts a tick where mpv wasn't playing the item. False once that has
    /// happened `MAX_MISSES` times in a row.
    fn missed(&mut self) -> bool {
        self.misses += 1;
        self.misses < MAX_MISSES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_a_few_ticks_for_the_item_to_play() {
        let mut tracker = Tracker {
            item: ProgressItem {
                key: "movie:test".into(),
                url: "http://example.com/movie.mkv".into(),
                pending_start: None,
            },
            last: None,
            misses: 0,
        };
        for _ in 1..MAX_MISSES {
            assert!(tracker.missed());
        }
        assert!(!tracker.missed());
    }

    #[test]
    fn finished_near_the_end() {
        assert!(is_finished(5700.0, 6000.0));
        assert!(is_finished(580.0, 600.0));
        assert!(!is_finished(3000.0, 6000.0));
        assert!(!is_finished(10.0, 0.0));
    }
}
