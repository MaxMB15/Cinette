// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The commands, called on a mock app the way the frontend calls them.
//!
//! `mpv_load` isn't called here. The mock app has no window to embed the
//! video in, so it would open the real fallback window and play sound.
//! Streams are loaded through `test_support::load_headless` instead.

use super::*;
use crate::mpv::NOT_PLAYING;
use crate::test_support::TestApp;
use tauri::async_runtime::block_on;

const NO_PLAYER: &str = "no mpv instance";

fn get_state(app: &TestApp) -> PlayerState {
    block_on(mpv_get_state(app.handle(), app.state())).unwrap()
}

#[test]
fn reports_an_empty_player_before_anything_loads() {
    let app = TestApp::new();
    let state = get_state(&app);
    assert_eq!(state.current_url, None);
    assert_eq!(state.volume, 100.0);
    assert!(!state.is_playing && !state.is_paused);
    assert!(!state.playback_started && !state.open_failed);
}

#[test]
fn playback_commands_fail_with_nothing_loaded() {
    let app = TestApp::new();
    let (h, s) = (|| app.handle(), || app.state());
    let failed = Err(NO_PLAYER.to_string());
    assert_eq!(block_on(mpv_play(h(), s())), failed);
    assert_eq!(block_on(mpv_pause(h(), s())), failed);
    assert_eq!(block_on(mpv_seek(h(), s(), 30.0)), failed);
    assert_eq!(block_on(mpv_set_volume(h(), s(), 50.0)), failed);
    // Subtitles are always for a stream, and none plays.
    let url = || "http://host.test/live/1.ts".to_string();
    let not_playing = Err(NOT_PLAYING.to_string());
    assert_eq!(
        block_on(mpv_sub_add(h(), s(), "/subs/en.srt".into(), true, url())),
        not_playing
    );
    assert_eq!(
        block_on(mpv_sub_remove(h(), s(), -1, Some(url()))),
        not_playing
    );
    assert_eq!(block_on(mpv_sub_remove(h(), s(), -1, None)), failed);
    assert_eq!(block_on(mpv_set_sub_pos(90.0, s())), failed);
    assert_eq!(block_on(mpv_set_sub_delay(0.5, s())), failed);
    // Stopping nothing is fine, so the frontend can always call it.
    assert_eq!(block_on(mpv_stop(h(), s())), Ok(()));
}

#[test]
fn lock_screen_details_are_accepted_on_the_desktop() {
    let app = TestApp::new();
    let info = mpv_set_media_info(
        app.handle(),
        app.state(),
        Some("News".into()),
        true,
        Some("http://logos.example.test/news.png".into()),
    );
    assert_eq!(block_on(info), Ok(()));
    let skips = mpv_set_skip_intervals(app.handle(), app.state(), 10.0, 30.0);
    assert_eq!(block_on(skips), Ok(()));
    assert_eq!(get_state(&app).current_url, None);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod with_a_stream {
    use super::*;
    use crate::test_support::{
        load_headless, wait_for_position, wait_until, wav, FakeRenderer, MediaDir,
    };

    #[test]
    fn commands_drive_the_loaded_stream() {
        let app = TestApp::new();
        let (h, s) = (|| app.handle(), || app.state());
        let media = MediaDir::new();
        let path = media.file("tone.wav", &wav(10));
        let subtitles = "memory://1\n00:00:00,000 --> 00:00:09,000\nHello\n".to_string();

        // Bounds sent before the load reach the renderer the load makes.
        block_on(mpv_set_bounds(h(), s(), 0.0, 0.0, 640.0, 360.0)).unwrap();
        let (renderer, log) = FakeRenderer::working();
        load_headless(&s(), &h(), &path, None, Ok(renderer)).unwrap();
        assert_eq!(log.lock().unwrap().frames, [[0.0, 0.0, 640.0, 360.0]]);
        wait_until("playback to start", || get_state(&app).playback_started);
        assert_eq!(get_state(&app).current_url.as_deref(), Some(path.as_str()));

        block_on(mpv_pause(h(), s())).unwrap();
        assert!(get_state(&app).is_paused);
        block_on(mpv_seek(h(), s(), 5.0)).unwrap();
        wait_for_position(5.0, || get_state(&app).position);
        block_on(mpv_set_volume(h(), s(), 30.0)).unwrap();
        assert_eq!(get_state(&app).volume, 30.0);
        block_on(mpv_play(h(), s())).unwrap();
        assert!(get_state(&app).is_playing);

        block_on(mpv_sub_add(h(), s(), subtitles, true, path.clone())).unwrap();
        block_on(mpv_set_sub_pos(80.0, s())).unwrap();
        block_on(mpv_set_sub_delay(-0.5, s())).unwrap();
        block_on(mpv_sub_remove(h(), s(), -1, Some(path.clone()))).unwrap();

        block_on(mpv_set_visible(h(), s(), false)).unwrap();
        block_on(mpv_set_bounds(h(), s(), 8.0, 8.0, 320.0, 180.0)).unwrap();
        {
            let log = log.lock().unwrap();
            assert_eq!(log.visible, [false]);
            assert_eq!(log.frames.last(), Some(&[8.0, 8.0, 320.0, 180.0]));
        }

        block_on(mpv_stop(h(), s())).unwrap();
        assert_eq!(get_state(&app).current_url, None);
        assert!(log.lock().unwrap().dropped);
    }
}
