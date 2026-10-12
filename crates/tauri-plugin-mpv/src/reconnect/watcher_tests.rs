// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The watcher against a headless mpv and streams from a loopback server
//! that cut out, stall or fail the way real servers do.

use super::*;
use crate::test_support::{
    player, wait_until, wav, MediaDir, Reply, Server, TestApp, WAV_BYTES_PER_SEC, WAV_HEADER_LEN,
};
use serde_json::json;
use std::sync::mpsc;
use std::thread::JoinHandle;
use tauri::test::MockRuntime;

/// Plays streams four times as fast, so seconds of audio take a fraction of
/// that. Recovery is measured in stream time, so the logic is the same.
const SPEED: (&str, &str) = ("speed", "4");

/// A URL that is never fetched.
const UNUSED_URL: &str = "http://example.test/live/1.ts";

/// Where a WAV body is cut after `seconds` of audio. Six seconds is more than
/// FFmpeg reads to work out the format, so the stream starts playing.
fn after_seconds(seconds: usize) -> usize {
    WAV_HEADER_LEN + seconds * WAV_BYTES_PER_SEC
}

/// A watcher for `url` on a new client of `player`.
fn watcher(app: &TestApp, player: &Mpv, url: &str) -> Watcher<MockRuntime> {
    let client = player.create_client(None).expect("create a client");
    Watcher::new(
        client,
        url.to_string(),
        app.handle(),
        Arc::new(AtomicBool::new(false)),
    )
}

/// A watcher running on a thread of its own, as `spawn` runs it. Dropping
/// it sets the kill flag, so a failed test doesn't leave it running.
struct Running {
    thread: Option<JoinHandle<()>>,
    kill: Arc<AtomicBool>,
}

impl Running {
    fn start(watcher: Watcher<MockRuntime>) -> Self {
        let kill = watcher.kill.clone();
        let thread = std::thread::spawn(move || watcher.run());
        Self {
            thread: Some(thread),
            kill,
        }
    }

    fn wait_for_exit(mut self) {
        let thread = self.thread.take().unwrap();
        wait_until("the watcher to exit", || thread.is_finished());
        thread.join().expect("the watcher thread panicked");
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.kill.store(true, Ordering::Release);
    }
}

fn names(events: &[(&'static str, serde_json::Value)]) -> Vec<&'static str> {
    events.iter().map(|(name, _)| *name).collect()
}

#[test]
fn reloads_a_dropped_stream_where_it_stopped() {
    // The connection drops six seconds in, the first reload gets a 404 and
    // the second gets the whole stream.
    let server = Server::start(
        wav(20),
        vec![Reply::CutAfter(after_seconds(6)), Reply::Status(404)],
    );
    let url = server.url();
    let app = TestApp::new();
    let events = app.record(&[EVENT_RECONNECTING, EVENT_RECONNECTED, EVENT_LOAD_FAILED]);
    let player = player(&[SPEED]);
    let running = Running::start(watcher(&app, &player, &url));

    player.command("loadfile", &[&url, "replace"]).unwrap();
    events.wait_for(EVENT_RECONNECTED);
    // mpv runs out of data a little before the cut, at about four and a half
    // seconds. Starting over would put this near one second.
    let pos = player.get_property::<f64>("time-pos").unwrap();
    assert!(pos > 3.0, "playing at {pos}");

    assert_eq!(
        names(&events.all()),
        [EVENT_RECONNECTING, EVENT_RECONNECTING, EVENT_RECONNECTED]
    );
    assert_eq!(
        events.payloads(EVENT_RECONNECTING),
        [
            json!({ "url": url, "attempt": 1 }),
            json!({ "url": url, "attempt": 2 }),
        ]
    );
    assert_eq!(events.payloads(EVENT_RECONNECTED), [json!({ "url": url })]);
    let requests = server.requests();
    assert!(requests.len() >= 3, "{requests:?}");

    player.command("quit", &[]).unwrap();
    running.wait_for_exit();
}

#[test]
fn gives_up_once_the_attempts_run_out() {
    let server = Server::start(wav(20), vec![Reply::CutAfter(after_seconds(6))]);
    let url = server.url();
    let app = TestApp::new();
    let events = app.record(&[EVENT_RECONNECTING, EVENT_LOAD_FAILED]);
    let player = player(&[SPEED]);
    player.command("loadfile", &[&url, "replace"]).unwrap();
    wait_until("the stream to drop", || {
        player.get_property::<bool>("eof-reached").unwrap_or(false)
    });

    // The watcher starts once the stream has dropped. Started earlier, it
    // would see the first second of playback as a recovery and start
    // counting again.
    let mut watcher = watcher(&app, &player, &url);
    watcher.attempt = MAX_ATTEMPTS;
    let running = Running::start(watcher);
    assert_eq!(events.wait_for(EVENT_LOAD_FAILED), json!({ "url": url }));
    running.wait_for_exit();
    assert_eq!(names(&events.all()), [EVENT_LOAD_FAILED]);
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn reports_a_stall_until_the_cache_refills() {
    // The server sends twelve seconds, then holds the connection open until
    // the test lets the rest through.
    let (release, held) = mpsc::channel();
    let server = Server::start(wav(20), vec![Reply::HoldAfter(after_seconds(12), held)]);
    let url = server.url();
    let app = TestApp::new();
    let events = app.record(&[EVENT_BUFFERING, EVENT_BUFFERED, EVENT_RECONNECTING]);
    let player = player(&[SPEED]);
    let running = Running::start(watcher(&app, &player, &url));

    player.command("loadfile", &[&url, "replace"]).unwrap();
    // mpv only pauses for the cache once playback has started.
    wait_until("playback to start", || {
        player
            .get_property::<f64>("playback-time")
            .is_ok_and(|time| time > 0.0)
    });
    assert_eq!(events.wait_for(EVENT_BUFFERING), json!({ "url": url }));
    assert!(events.payloads(EVENT_BUFFERED).is_empty());

    release.send(()).unwrap();
    assert_eq!(events.wait_for(EVENT_BUFFERED), json!({ "url": url }));
    // The same read carried on, so nothing was reloaded.
    assert!(events.payloads(EVENT_RECONNECTING).is_empty());
    assert_eq!(server.requests().len(), 1);

    player.command("quit", &[]).unwrap();
    running.wait_for_exit();
}

#[test]
fn reloads_again_when_a_reload_never_moves() {
    let server = Server::start(wav(10), Vec::new());
    let url = server.url();
    let app = TestApp::new();
    let events = app.record(&[EVENT_RECONNECTING, EVENT_RECONNECTED]);
    let player = player(&[SPEED]);
    let mut watcher = watcher(&app, &player, &url);
    // The first reload restarted playback long enough ago to count as stuck.
    let stuck_for = Duration::from_secs(RECOVERY_STALL_TIMEOUT_SECS + 1);
    watcher.attempt = 1;
    watcher.recovery_baseline = Some(0.0);
    watcher.recovery_started_at = Some(Instant::now().checked_sub(stuck_for).unwrap());
    let running = Running::start(watcher);

    events.wait_for(EVENT_RECONNECTED);
    assert_eq!(
        events.all(),
        [
            (EVENT_RECONNECTING, json!({ "url": url, "attempt": 2 })),
            (EVENT_RECONNECTED, json!({ "url": url })),
        ]
    );
    assert!(!server.requests().is_empty());

    player.command("quit", &[]).unwrap();
    running.wait_for_exit();
}

#[test]
fn exits_once_its_kill_flag_is_set() {
    let app = TestApp::new();
    let player = player(&[]);
    let watcher = watcher(&app, &player, UNUSED_URL);
    let kill = watcher.kill.clone();
    let running = Running::start(watcher);

    kill.store(true, Ordering::Release);
    running.wait_for_exit();
}

#[test]
fn exits_when_the_player_shuts_down() {
    let app = TestApp::new();
    let player = player(&[]);
    let running = Running::start(watcher(&app, &player, UNUSED_URL));

    player.command("quit", &[]).unwrap();
    running.wait_for_exit();
}

#[test]
fn only_an_error_or_an_early_end_arms_a_retry() {
    let app = TestApp::new();
    let player = player(&[]);
    let mut watcher = watcher(&app, &player, UNUSED_URL);

    // Nothing is loaded, so there is no position or duration, as on a live
    // stream, and any end of file is early.
    assert_eq!(
        watcher.end_file_trigger(mpv_end_file_reason::Error),
        Some("EndFile(Error)")
    );
    assert_eq!(
        watcher.end_file_trigger(mpv_end_file_reason::Eof),
        Some("EndFile(Eof premature)")
    );
    for reason in [
        mpv_end_file_reason::Stop,
        mpv_end_file_reason::Quit,
        mpv_end_file_reason::Redirect,
    ] {
        assert_eq!(watcher.end_file_trigger(reason), None, "reason {reason}");
    }

    // A retry that is already armed covers the same failure.
    watcher.next_retry_at = Some(Instant::now());
    assert_eq!(watcher.end_file_trigger(mpv_end_file_reason::Error), None);
    assert_eq!(watcher.end_file_trigger(mpv_end_file_reason::Eof), None);
}

#[test]
fn the_end_of_a_whole_file_is_not_a_failure() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let app = TestApp::new();
    let player = player(&[SPEED]);
    let watcher = watcher(&app, &player, &path);

    player
        .command("loadfile", &[&path, "replace", "0", "start=9"])
        .unwrap();
    wait_until("the end of the file", || {
        player.get_property::<bool>("eof-reached").unwrap_or(false)
    });
    assert!(!watcher.is_premature_eof());
    assert_eq!(watcher.end_file_trigger(mpv_end_file_reason::Eof), None);
}

#[test]
fn recovery_starts_from_the_last_position_when_mpv_has_none() {
    let app = TestApp::new();
    let player = player(&[]);
    let mut watcher = watcher(&app, &player, UNUSED_URL);

    watcher.last_known_pos = Some(12.0);
    watcher.start_recovery_check();
    assert_eq!(watcher.recovery_baseline, Some(12.0));
    assert!(watcher.recovery_started_at.is_some());

    watcher.last_known_pos = None;
    watcher.start_recovery_check();
    assert_eq!(watcher.recovery_baseline, Some(0.0));
}

#[test]
fn remembers_only_real_positions_for_the_resume() {
    let app = TestApp::new();
    let player = player(&[]);
    let mut watcher = watcher(&app, &player, UNUSED_URL);

    watcher.on_time_pos(42.5);
    // A reload starts at zero, and mpv can report a position it can't
    // work out.
    for pos in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        watcher.on_time_pos(pos);
        assert_eq!(watcher.last_known_pos, Some(42.5), "after {pos}");
    }
}

#[test]
fn sends_buffering_and_buffered_once_each() {
    let app = TestApp::new();
    let events = app.record(&[EVENT_BUFFERING, EVENT_BUFFERED]);
    let player = player(&[]);
    let mut watcher = watcher(&app, &player, UNUSED_URL);

    // A full cache before any stall says nothing.
    watcher.on_paused_for_cache(false);
    for paused in [true, true, false, false] {
        watcher.on_paused_for_cache(paused);
    }
    assert_eq!(
        events.all(),
        [
            (EVENT_BUFFERING, json!({ "url": UNUSED_URL })),
            (EVENT_BUFFERED, json!({ "url": UNUSED_URL })),
        ]
    );
}

#[test]
fn a_reload_mpv_refuses_waits_like_the_next_attempt() {
    let app = TestApp::new();
    let player = player(&[]);
    // mpv can't take a URL with a NUL in it.
    let mut watcher = watcher(&app, &player, "http://example.test/a\0b");
    watcher.attempt = 2;
    watcher.recovery_baseline = Some(3.0);

    let before = Instant::now();
    watcher.reload();
    let after = Instant::now();
    let retry_at = watcher.next_retry_at.expect("another reload is scheduled");
    assert!(retry_at >= before + retry_delay(3) && retry_at <= after + retry_delay(3));
    assert_eq!(watcher.recovery_baseline, None);
}
