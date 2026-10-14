// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Loads through `MpvState` with a fake renderer and a headless mpv.
//!
//! The tests go through `load_with` and `load_embedded` with headless options
//! for both the embedded player and the fallback window, since the real
//! fallback opens a window and plays sound.
//!
//! On Linux a load also asks the session bus to keep the screen on. CI has
//! no session bus, so the request fails and playback carries on. On a
//! desktop the request holds only until the test app drops and stops the
//! player.

#![cfg(any(target_os = "macos", target_os = "linux"))]

use super::{KeptSubtitles, MpvState};
use crate::test_support::{
    headless, headless_options, load_headless, reload_headless, wait_until, wav, y4m, FakeRenderer,
    MediaDir, SharedLog, TestApp,
};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

const RENDER_FALLBACK: &str = "mpv://render-fallback";
const FIRST_FRAME: &str = "mpv://first-frame";
const WINDOW_CLOSED: &str = "mpv://window-closed";

/// A subtitle file with one cue.
const SRT: &[u8] = b"1\n00:00:00,000 --> 00:00:09,000\nHello\n";

/// Loads `url` through a new fake renderer and returns what it records.
fn load(app: &TestApp, url: &str) -> SharedLog {
    let (renderer, log) = FakeRenderer::working();
    load_headless(&app.state(), &app.handle(), url, None, Ok(renderer)).expect("load");
    log
}

/// The kill flag of the running watcher.
fn watcher_kill(state: &MpvState) -> Arc<AtomicBool> {
    state
        .reconnect_kill
        .lock()
        .unwrap()
        .clone()
        .expect("a reconnect watcher")
}

/// Reads a property of the loaded player through a client of its own.
fn property(state: &MpvState, name: &str) -> String {
    let client = state.inner.lock().unwrap().create_event_client();
    client
        .expect("a loaded player")
        .get_property::<String>(name)
        .unwrap()
}

/// Reads a number property of the loaded player.
fn number(state: &MpvState, name: &str) -> f64 {
    let client = state.inner.lock().unwrap().create_event_client();
    client
        .expect("a loaded player")
        .get_property::<f64>(name)
        .unwrap()
}

fn wait_for_playback(state: &MpvState) {
    wait_until("playback to start", || state.get_state().playback_started);
}

#[test]
fn an_embedded_load_plays_through_the_renderer() {
    let app = TestApp::new();
    let events = app.record(&[RENDER_FALLBACK]);
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let state = app.state();
    state.set_bounds(10.0, 20.0, 640.0, 360.0);

    let log = load(&app, &path);
    {
        let log = log.lock().unwrap();
        assert!(log.attached && !log.dropped);
        assert_eq!(log.frames, [[10.0, 20.0, 640.0, 360.0]]);
    }
    assert!(!state.fallback_active.load(Ordering::Acquire));
    assert!(!watcher_kill(&state).load(Ordering::Acquire));
    wait_until("playback to start", || state.get_state().playback_started);
    assert_eq!(
        state.get_state().current_url.as_deref(),
        Some(path.as_str())
    );
    assert!(!state.get_state().fallback_active);
    assert!(events.payloads(RENDER_FALLBACK).is_empty());
}

#[test]
fn the_first_frame_tells_the_frontend_to_clear_the_web_view() {
    let app = TestApp::new();
    let events = app.record(&[FIRST_FRAME]);
    let media = MediaDir::new();
    let log = load(&app, &media.file("tone.wav", &wav(10)));
    let first_frame = log.lock().unwrap().first_frame.take();
    let first_frame = first_frame.expect("a first frame callback");
    assert!(events.payloads(FIRST_FRAME).is_empty());

    first_frame();
    assert_eq!(events.wait_for(FIRST_FRAME), json!(null));
}

#[test]
fn falls_back_when_the_renderer_cannot_be_made() {
    let app = TestApp::new();
    let events = app.record(&[RENDER_FALLBACK]);
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let state = app.state();

    load_headless(&state, &app.handle(), &path, None, Err("no window".into())).unwrap();
    assert!(state.fallback_active.load(Ordering::Acquire));
    assert_eq!(
        events.wait_for(RENDER_FALLBACK),
        json!({ "reason": "no window" })
    );
    assert!(state.renderer.lock().unwrap().is_none());
    assert!(!watcher_kill(&state).load(Ordering::Acquire));
    wait_until("playback to start", || state.get_state().playback_started);
    assert!(state.get_state().fallback_active);

    state.stop();
    assert!(!state.get_state().fallback_active);
}

#[test]
fn falls_back_when_the_renderer_cannot_attach() {
    let app = TestApp::new();
    let events = app.record(&[RENDER_FALLBACK]);
    let media = MediaDir::new();
    let state = app.state();
    let (renderer, log) = FakeRenderer::failing("no GL context");

    load_headless(
        &state,
        &app.handle(),
        &media.file("tone.wav", &wav(10)),
        None,
        Ok(renderer),
    )
    .unwrap();
    assert_eq!(
        events.wait_for(RENDER_FALLBACK),
        json!({ "reason": "no GL context" })
    );
    assert!(log.lock().unwrap().dropped);
    assert!(state.renderer.lock().unwrap().is_none());
    assert!(state.fallback_active.load(Ordering::Acquire));
    wait_until("playback to start", || state.get_state().playback_started);
}

#[test]
fn mpv_draws_the_subtitles_the_frontend_does_not() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT);
    let state = app.state();
    let visible = || property(&state, "sub-visibility");

    // Over the embedded video, the frontend draws the subtitles it can read.
    load(&app, &path);
    wait_until("playback to start", || state.get_state().playback_started);
    state.sub_add(&subtitles, true).unwrap();
    assert_eq!(property(&state, "sid"), "1");
    assert_eq!(visible(), "no");
    state.sub_add(&subtitles, false).unwrap();
    assert_eq!(property(&state, "sid"), "2");
    assert_eq!(visible(), "yes");

    // It can't draw over the fallback window, so mpv draws them all there.
    load_headless(&state, &app.handle(), &path, None, Err("no window".into())).unwrap();
    wait_until("playback to start", || state.get_state().playback_started);
    state.sub_add(&subtitles, true).unwrap();
    assert_eq!(property(&state, "sid"), "1");
    assert_eq!(visible(), "yes");
}

#[test]
fn a_load_for_the_same_item_keeps_its_subtitles() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT);
    let state = app.state();
    load(&app, &path);
    wait_for_playback(&state);
    state.sub_add(&subtitles, true).unwrap();
    state.set_sub_delay(0.5).unwrap();

    // A retry that ends up in the fallback window, where mpv draws them.
    reload_headless(&state, &app.handle(), &path, Err("no window".into())).unwrap();
    wait_for_playback(&state);
    assert_eq!(property(&state, "sid"), "1");
    assert_eq!(property(&state, "sub-visibility"), "yes");
    assert_eq!(number(&state, "sub-delay"), 0.5);

    // Back over the embedded video, the frontend draws them again.
    let (renderer, _log) = FakeRenderer::working();
    reload_headless(&state, &app.handle(), &path, Ok(renderer)).unwrap();
    wait_for_playback(&state);
    assert_eq!(property(&state, "sid"), "1");
    assert_eq!(property(&state, "sub-visibility"), "no");
    assert_eq!(number(&state, "sub-delay"), 0.5);

    // Another item starts without them.
    load(&app, &path);
    wait_for_playback(&state);
    assert_eq!(property(&state, "sid"), "no");
    assert_eq!(number(&state, "sub-delay"), 0.0);
    assert_eq!(*state.subtitles.lock().unwrap(), KeptSubtitles::default());
}

#[test]
fn keeps_no_subtitles_that_were_removed_or_never_added() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT);
    let state = app.state();
    let reload = || {
        let (renderer, _log) = FakeRenderer::working();
        reload_headless(&state, &app.handle(), &path, Ok(renderer)).unwrap();
        wait_for_playback(&state);
    };
    load(&app, &path);
    wait_for_playback(&state);

    state.sub_add(&subtitles, false).unwrap();
    state.sub_remove(-1).unwrap();
    reload();
    assert_eq!(property(&state, "sid"), "no");

    assert!(state.sub_add(&media.missing("gone.srt"), false).is_err());
    reload();
    assert_eq!(property(&state, "sid"), "no");

    state.sub_add(&subtitles, false).unwrap();
    state.stop();
    reload();
    assert_eq!(property(&state, "sid"), "no");
}

#[test]
fn closing_the_fallback_window_stops_playback() {
    let app = TestApp::new();
    let events = app.record(&[WINDOW_CLOSED]);
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let state = app.state();
    load_headless(&state, &app.handle(), &path, None, Err("no window".into())).unwrap();
    wait_for_playback(&state);
    state.sub_add(&media.file("en.srt", SRT), true).unwrap();

    // mpv runs `quit` when the user closes its window.
    let client = state.inner.lock().unwrap().create_event_client().unwrap();
    client.command("quit", &[]).unwrap();
    drop(client);
    assert_eq!(events.wait_for(WINDOW_CLOSED), json!({ "url": path }));
    let polled = state.get_state();
    assert_eq!(polled.current_url, None);
    assert!(!polled.is_playing && !polled.fallback_active);
    assert!(state.reconnect_kill.lock().unwrap().is_none());
    assert!(!state.idle_inhibitor.is_active());
    assert_eq!(*state.subtitles.lock().unwrap(), KeptSubtitles::default());
}

#[test]
fn a_quit_leaves_a_newer_stream_alone() {
    let app = TestApp::new();
    let events = app.record(&[WINDOW_CLOSED]);
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let state = app.state();
    load(&app, &path);
    let old_kill = watcher_kill(&state);

    // The next load trips the old watcher's flag first.
    load(&app, &path);
    assert!(!state.stop_after_quit(&old_kill));
    assert_eq!(
        state.get_state().current_url.as_deref(),
        Some(path.as_str())
    );

    assert!(state.stop_after_quit(&watcher_kill(&state)));
    assert_eq!(state.get_state().current_url, None);
    assert!(events.payloads(WINDOW_CLOSED).is_empty());
}

/// A renderer whose `attach` fails has to go while the core it was made for
/// is still alive, and before the fallback creates the next core. The
/// fallback asks for its options in between, so the test checks both there.
#[test]
fn drops_a_renderer_that_cannot_attach_before_the_fallback_starts() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let state = app.state();
    let (renderer, log) = FakeRenderer::failing("no GL context");
    let core_alive_at_drop = Arc::new(Mutex::new(None));
    let handle = app.handle();
    let seen = core_alive_at_drop.clone();
    log.lock().unwrap().on_drop = Some(Box::new(move || {
        let state = handle.state::<MpvState>();
        let alive = state.inner.lock().unwrap().create_event_client().is_ok();
        *seen.lock().unwrap() = Some(alive);
    }));
    let mut dropped_before_fallback = None;

    state
        .load_with(true, false, || {
            let embedded = (renderer, headless_options().to_vec());
            state.load_embedded(&path, None, &app.handle(), Ok(embedded), || {
                dropped_before_fallback = Some(log.lock().unwrap().dropped);
                headless_options().to_vec()
            })
        })
        .unwrap();
    assert_eq!(dropped_before_fallback, Some(true));
    assert_eq!(*core_alive_at_drop.lock().unwrap(), Some(true));
}

#[test]
fn falls_back_when_mpv_rejects_an_embedded_option() {
    let app = TestApp::new();
    let events = app.record(&[RENDER_FALLBACK]);
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let state = app.state();
    let (renderer, log) = FakeRenderer::working();
    let embedded = (renderer, headless(&[("no-such-option", "1")]));

    state
        .load_with(true, false, || {
            state.load_embedded(&path, None, &app.handle(), Ok(embedded), || {
                headless_options().to_vec()
            })
        })
        .unwrap();
    let reason = events.wait_for(RENDER_FALLBACK)["reason"].clone();
    let reason = reason.as_str().unwrap();
    assert!(
        reason.starts_with("mpv init: option no-such-option: "),
        "{reason}"
    );
    let log = log.lock().unwrap();
    assert!(!log.attached && log.dropped);
    assert!(state.fallback_active.load(Ordering::Acquire));
}

#[test]
fn a_load_fails_when_the_fallback_cannot_start_either() {
    let app = TestApp::new();
    let events = app.record(&[RENDER_FALLBACK]);
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let state = app.state();

    let result = state.load_with(true, false, || {
        state.load_embedded(&path, None, &app.handle(), Err("no window".into()), || {
            headless(&[("no-such-option", "1")])
        })
    });
    let error = result.unwrap_err();
    assert!(
        error.starts_with("mpv init: option no-such-option: "),
        "{error}"
    );
    assert!(!state.fallback_active.load(Ordering::Acquire));
    assert!(events.payloads(RENDER_FALLBACK).is_empty());
    assert!(state.reconnect_kill.lock().unwrap().is_none());
    assert_eq!(state.get_state().current_url, None);
    assert!(!state.idle_inhibitor.is_active());
}

#[test]
fn a_load_mpv_refuses_tears_down_the_renderer() {
    let app = TestApp::new();
    let state = app.state();
    let (renderer, log) = FakeRenderer::working();

    // mpv can't take a URL with a NUL in it, so loadfile fails after the
    // renderer is attached.
    let error = load_headless(
        &state,
        &app.handle(),
        "http://example.test/a\0b",
        None,
        Ok(renderer),
    )
    .unwrap_err();
    assert!(error.starts_with("loadfile: "), "{error}");
    assert!(log.lock().unwrap().attached);
    assert!(log.lock().unwrap().dropped);
    assert!(state.renderer.lock().unwrap().is_none());
    assert!(state.reconnect_kill.lock().unwrap().is_none());
    assert_eq!(state.get_state().current_url, None);
    assert_eq!(state.play(), Err("no mpv instance".to_string()));
    assert!(!state.idle_inhibitor.is_active());
}

#[test]
fn a_new_load_retires_the_last_stream() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let state = app.state();
    let first = load(&app, &media.file("one.wav", &wav(10)));
    let first_kill = watcher_kill(&state);
    let second_path = media.file("two.wav", &wav(10));

    let second = load(&app, &second_path);
    assert!(first_kill.load(Ordering::Acquire));
    assert!(first.lock().unwrap().dropped);
    assert!(!second.lock().unwrap().dropped);
    let second_kill = watcher_kill(&state);
    assert!(!Arc::ptr_eq(&first_kill, &second_kill));
    assert!(!second_kill.load(Ordering::Acquire));
    assert_eq!(
        state.get_state().current_url.as_deref(),
        Some(second_path.as_str())
    );
}

#[test]
fn stop_ends_the_stream_and_its_watcher() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let state = app.state();
    let log = load(&app, &media.file("tone.wav", &wav(10)));
    let kill = watcher_kill(&state);

    state.stop();
    assert!(kill.load(Ordering::Acquire));
    assert!(log.lock().unwrap().dropped);
    assert!(state.reconnect_kill.lock().unwrap().is_none());
    assert_eq!(state.get_state().current_url, None);
    assert!(!state.idle_inhibitor.is_active());
}

#[test]
fn hardware_decoding_follows_the_setting() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let state = app.state();
    for (enabled, expected) in [(true, "auto"), (false, "no")] {
        let (renderer, _log) = FakeRenderer::working();
        let embedded = (renderer, headless(&[("hwdec", "auto")]));
        state
            .load_with(enabled, false, || {
                state.load_embedded(&path, None, &app.handle(), Ok(embedded), || {
                    headless_options().to_vec()
                })
            })
            .unwrap();
        assert_eq!(
            property(&state, "hwdec"),
            expected,
            "hwdec enabled: {enabled}"
        );
    }
}

#[test]
fn turning_video_off_reaches_the_loaded_stream_only() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let state = app.state();

    // Asked before anything is loaded, so there is nothing to change and
    // the next stream still shows video.
    state.set_video_enabled(false);
    load(&app, &media.file("blank.y4m", &y4m(4)));
    wait_until("playback to start", || state.get_state().playback_started);
    assert_eq!(property(&state, "vid"), "1");

    state.set_video_enabled(false);
    assert_eq!(property(&state, "vid"), "no");
}

#[test]
fn the_renderer_follows_visibility_and_window_size() {
    let state = MpvState::new();
    let (renderer, log) = FakeRenderer::working();
    state.install_renderer(renderer);

    state.set_visible(false);
    state.set_visible(true);
    state.resize(1280, 720);
    let log = log.lock().unwrap();
    assert_eq!(log.visible, [false, true]);
    assert_eq!(log.sizes, [(1280, 720)]);
}

#[test]
fn play_and_pause_take_no_inhibit_without_a_stream() {
    let state = MpvState::new();
    assert!(state.play().is_err());
    assert!(!state.idle_inhibitor.is_active());
    assert!(state.pause().is_err());
    assert!(!state.idle_inhibitor.is_active());
}

#[test]
fn seeking_needs_a_stream() {
    let state = MpvState::new();
    let missing = Err("no mpv instance".to_string());
    assert_eq!(state.seek(30.0), missing);
    assert_eq!(state.seek_relative(-10.0), missing);
}

#[test]
fn keeps_no_delay_mpv_turned_down() {
    let state = MpvState::new();
    assert_eq!(state.set_sub_delay(1.5), Err("no mpv instance".to_string()));
    assert_eq!(*state.subtitles.lock().unwrap(), KeptSubtitles::default());
}

/// The inhibit is a power assertion on macOS. On Linux it goes over the
/// desktop's session bus, which CI doesn't have and a developer's machine
/// would really act on, so these checks only run on macOS.
#[cfg(target_os = "macos")]
#[test]
fn keeps_the_display_awake_only_while_playing() {
    let app = TestApp::new();
    let media = MediaDir::new();
    let state = app.state();
    load(&app, &media.file("tone.wav", &wav(10)));
    assert!(state.idle_inhibitor.is_active());

    state.pause().unwrap();
    assert!(!state.idle_inhibitor.is_active());
    state.play().unwrap();
    assert!(state.idle_inhibitor.is_active());
    state.stop();
    assert!(!state.idle_inhibitor.is_active());
}
