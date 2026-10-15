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
    hand_off(app, item, SAVE_INTERVAL);
}

/// The work of [`hand_off_progress`], saving every `interval`. Returns the
/// thread that saves, so a test can wait for it to stop.
fn hand_off<R: Runtime>(
    app: AppHandle<R>,
    item: Option<ProgressItem>,
    interval: Duration,
) -> Option<std::thread::JoinHandle<()>> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let item = item?;
    tracing::debug!("[Progress] saving {} from Rust", item.key);
    let saving = std::thread::spawn(move || track(&app, item, generation, interval));
    Some(saving)
}

/// Saves `item`'s position every `interval` until mpv moves on or a newer
/// hand-over replaces `generation`.
fn track<R: Runtime>(app: &AppHandle<R>, item: ProgressItem, generation: u64, interval: Duration) {
    let mut tracker = Tracker {
        item,
        last: None,
        misses: 0,
    };
    while GENERATION.load(Ordering::SeqCst) == generation && tracker.tick(app) {
        std::thread::sleep(interval);
    }
}

struct Tracker {
    item: ProgressItem,
    /// The position and duration saved last.
    last: Option<(f64, f64)>,
    /// Ticks in a row that mpv wasn't playing the item.
    misses: u32,
}

impl Tracker {
    /// Checks what mpv is playing and handles it as `saw` does.
    fn tick<R: Runtime>(&mut self, app: &AppHandle<R>) -> bool {
        let s = app.state::<MpvState>().get_state();
        self.saw(app, s.current_url.as_deref(), s.position, s.duration)
    }

    /// Saves the position if it moved, like `flushProgress` in
    /// `VideoPlayer.tsx`, given the URL mpv is playing and where it is in
    /// it. Returns false once mpv has stopped playing the item.
    fn saw<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
        url: Option<&str>,
        position: f64,
        duration: f64,
    ) -> bool {
        if url != Some(self.item.url.as_str()) {
            if self.missed() {
                return true;
            }
            tracing::debug!("[Progress] {} is no longer playing", self.item.key);
            return false;
        }
        self.misses = 0;
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

/// A probe for the Changed code check, which no test runs yet.
#[allow(dead_code)]
fn gate_probe(a: u32) -> u32 {
    a * 3 + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{poison, TestApp};
    use std::sync::{mpsc, Mutex, PoisonError};
    use std::time::Instant;

    const KEY: &str = "movie:dune";
    const URL: &str = "http://example.test/dune.mkv";

    /// Held by the tests that read or bump `GENERATION`, which every
    /// hand-over in the process shares.
    static HAND_OVERS: Mutex<()> = Mutex::new(());

    fn item(pending_start: Option<f64>) -> ProgressItem {
        ProgressItem {
            key: KEY.into(),
            url: URL.into(),
            pending_start,
        }
    }

    fn tracker(pending_start: Option<f64>) -> Tracker {
        Tracker {
            item: item(pending_start),
            last: None,
            misses: 0,
        }
    }

    /// The position and length saved for the item.
    fn saved(app: &TestApp) -> Option<(f64, f64)> {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        let saved = cache.get_playback_position(KEY).unwrap();
        saved.map(|p| (p.position_seconds, p.duration_seconds))
    }

    /// Runs `track` on a thread of its own and says whether it returned in
    /// time, so a test that goes wrong fails rather than hangs.
    fn track_returns(app: &TestApp, generation: u64, interval: Duration) -> bool {
        let (done, returned) = mpsc::channel();
        let handle = app.handle();
        std::thread::spawn(move || {
            track(&handle, item(None), generation, interval);
            let _ = done.send(());
        });
        returned.recv_timeout(Duration::from_secs(10)).is_ok()
    }

    #[test]
    fn saves_the_position_while_the_item_plays() {
        let app = TestApp::new();
        let mut tracker = tracker(None);
        assert!(tracker.saw(&app.handle(), Some(URL), 600.0, 6000.0));
        assert_eq!(saved(&app), Some((600.0, 6000.0)));
        assert!(tracker.saw(&app.handle(), Some(URL), 605.0, 6000.0));
        assert_eq!(saved(&app), Some((605.0, 6000.0)));
    }

    #[test]
    fn saves_nothing_before_the_item_has_a_position_and_a_length() {
        let app = TestApp::new();
        let mut tracker = tracker(None);
        assert!(tracker.saw(&app.handle(), Some(URL), 1.0, 6000.0));
        assert!(tracker.saw(&app.handle(), Some(URL), 600.0, 0.0));
        assert_eq!(saved(&app), None);
    }

    #[test]
    fn waits_for_playback_to_reach_the_resume_point() {
        let app = TestApp::new();
        let handle = app.handle();
        let mut tracker = tracker(Some(3000.0));
        // Until the seek to the resume point lands, mpv reports where the
        // load began, and saving that would lose the resume point.
        assert!(tracker.saw(&handle, Some(URL), 600.0, 6000.0));
        assert_eq!(saved(&app), None);
        // A seek can land a little short, so five seconds before the resume
        // point counts as reaching it, as it does on the page.
        assert!(tracker.saw(&handle, Some(URL), 2995.0, 6000.0));
        assert_eq!(saved(&app), Some((2995.0, 6000.0)));
        // From there on, an earlier position is the viewer seeking back.
        assert!(tracker.saw(&handle, Some(URL), 600.0, 6000.0));
        assert_eq!(saved(&app), Some((600.0, 6000.0)));
    }

    #[test]
    fn an_unchanged_position_isnt_saved_again() {
        let app = TestApp::new();
        let handle = app.handle();
        let mut tracker = tracker(None);
        assert!(tracker.saw(&handle, Some(URL), 600.0, 6000.0));
        {
            let state = app.state();
            let cache = state.cache.lock().unwrap();
            cache.delete_playback_position(KEY).unwrap();
        }
        // A paused player reports the same place every tick.
        assert!(tracker.saw(&handle, Some(URL), 600.0, 6000.0));
        assert_eq!(saved(&app), None);
    }

    #[test]
    fn a_finished_or_barely_started_item_has_no_resume_point() {
        let app = TestApp::new();
        let handle = app.handle();
        let mut tracker = tracker(None);
        for (position, duration) in [(5900.0, 6000.0), (20.0, 6000.0)] {
            assert!(tracker.saw(&handle, Some(URL), 600.0, 6000.0));
            assert_eq!(saved(&app), Some((600.0, 6000.0)));
            assert!(tracker.saw(&handle, Some(URL), position, duration));
            assert_eq!(saved(&app), None, "{position} of {duration}");
        }
    }

    /// The page offers to resume from 30 seconds in, so that's kept too.
    #[test]
    fn thirty_seconds_in_is_far_enough_to_resume() {
        let app = TestApp::new();
        let mut tracker = tracker(None);
        assert!(tracker.saw(&app.handle(), Some(URL), 30.0, 6000.0));
        assert_eq!(saved(&app), Some((30.0, 6000.0)));
    }

    #[test]
    fn a_reading_of_the_item_starts_the_miss_count_over() {
        let app = TestApp::new();
        let handle = app.handle();
        let other = Some("http://example.test/arrival.mkv");
        let mut tracker = tracker(None);
        for _ in 1..MAX_MISSES {
            assert!(tracker.saw(&handle, other, 600.0, 6000.0));
        }
        assert!(tracker.saw(&handle, Some(URL), 1.0, 6000.0));
        for _ in 1..MAX_MISSES {
            assert!(tracker.saw(&handle, None, 0.0, 0.0));
        }
        assert!(!tracker.saw(&handle, None, 0.0, 0.0));
        assert_eq!(saved(&app), None);
    }

    #[test]
    fn an_idle_player_counts_as_a_miss() {
        let app = TestApp::new();
        let mut tracker = tracker(None);
        for _ in 1..MAX_MISSES {
            assert!(tracker.tick(&app.handle()));
        }
        assert!(!tracker.tick(&app.handle()));
    }

    #[test]
    fn a_poisoned_cache_skips_the_save_and_tracking_goes_on() {
        let app = TestApp::new();
        let state = app.state();
        poison(&state.cache);
        let mut tracker = tracker(None);
        assert!(tracker.saw(&app.handle(), Some(URL), 600.0, 6000.0));
        state.cache.clear_poison();
        assert_eq!(saved(&app), None);
    }

    #[test]
    fn a_save_that_fails_doesnt_stop_the_tracking() {
        let app = TestApp::new();
        let mut tracker = tracker(None);
        // SQLite stores NaN as NULL, which the saved length can't be.
        assert!(tracker.saw(&app.handle(), Some(URL), 600.0, f64::NAN));
        assert_eq!(saved(&app), None);
    }

    #[test]
    fn tracking_ends_once_mpv_has_moved_on() {
        let _lock = HAND_OVERS.lock().unwrap_or_else(PoisonError::into_inner);
        let app = TestApp::new();
        let current = GENERATION.load(Ordering::SeqCst);
        assert!(track_returns(&app, current, Duration::ZERO));
        assert_eq!(GENERATION.load(Ordering::SeqCst), current);
    }

    #[test]
    fn tracking_for_a_replaced_hand_over_stops_before_its_first_tick() {
        let _lock = HAND_OVERS.lock().unwrap_or_else(PoisonError::into_inner);
        let app = TestApp::new();
        let before = GENERATION.load(Ordering::SeqCst);
        hand_off_progress(app.handle(), Some(item(None)));
        let handed = GENERATION.load(Ordering::SeqCst);
        assert_eq!(handed, before + 1);
        hand_off_progress(app.handle(), None);
        assert_eq!(GENERATION.load(Ordering::SeqCst), before + 2);
        // With an hour between ticks, `track` only returns in time if it
        // checks the generation before it ticks and sleeps.
        assert!(track_returns(&app, handed, Duration::from_secs(60 * 60)));
    }

    /// The item may still be loading when the page hands it over, so an idle
    /// player gets a tick for each allowed miss before the thread stops.
    #[test]
    fn a_hand_over_keeps_checking_for_a_few_ticks_before_it_stops() {
        let _lock = HAND_OVERS.lock().unwrap_or_else(PoisonError::into_inner);
        let app = TestApp::new();
        let interval = Duration::from_millis(20);
        let started = Instant::now();

        let saving = hand_off(app.handle(), Some(item(None)), interval).unwrap();
        // Joined on a thread of its own, so a thread that never stops fails
        // the test rather than hanging it.
        let (done, joined) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(saving.join().is_ok());
        });
        assert_eq!(joined.recv_timeout(Duration::from_secs(10)), Ok(true));

        assert!(started.elapsed() >= interval * (MAX_MISSES - 1));
    }

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
        // A short clip is finished in its last 30 seconds, before it's 95% in.
        assert!(is_finished(375.0, 400.0));
        assert!(!is_finished(370.0, 400.0));
        assert!(!is_finished(3000.0, 6000.0));
        assert!(!is_finished(10.0, 0.0));
    }

    #[test]
    fn gate_probe_computes_its_value() {
        assert_eq!(super::gate_probe(2), 7);
    }
}
