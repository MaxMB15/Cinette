// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The engine against a real, headless mpv playing generated local files.

use super::{MpvEngine, PlayerState};
use crate::test_support::{
    after_seconds, headless, wait_for, wait_for_position, wait_until, wav, y4m, MediaDir, Reply,
    Server, POSITION_SLACK,
};
use libmpv2::Mpv;

/// A subtitle file with one cue.
const SRT: &str = "1\n00:00:00,000 --> 00:00:09,000\nHello\n";

/// An engine with a headless mpv, plus `extra` options.
fn engine(extra: &[(&str, &str)]) -> MpvEngine {
    let mut engine = MpvEngine::new();
    if let Err(e) = engine.create(&headless(extra)) {
        panic!("create mpv: {e}");
    }
    engine
}

/// Loads `path` the way `MpvState` does and waits until it plays.
fn start(engine: &mut MpvEngine, path: &str, start_pos: Option<f64>) -> PlayerState {
    engine.loadfile(path, start_pos).expect("loadfile");
    engine.set_current_url(path);
    wait_for("playback to start", || {
        let state = engine.get_state();
        state.playback_started.then_some(state)
    })
}

/// The engine's player, for reading properties the state doesn't report.
fn mpv(engine: &MpvEngine) -> &Mpv {
    engine.mpv.as_ref().expect("an mpv instance")
}

#[test]
fn create_names_the_option_mpv_rejects() {
    let mut engine = MpvEngine::new();
    let error = engine
        .create(&headless(&[("no-such-option", "1")]))
        .err()
        .expect("an unknown option fails");
    assert!(
        error.starts_with("mpv init: option no-such-option: "),
        "{error}"
    );
    // Linux also names the libmpv file, since a different one is the usual
    // reason mpv rejects an option.
    #[cfg(target_os = "linux")]
    assert!(error.contains(", libmpv \""), "{error}");
    assert!(engine.mpv.is_none());
}

#[test]
fn every_command_needs_a_player() {
    let mut engine = MpvEngine::new();
    let missing = Err("no mpv instance".to_string());
    assert_eq!(engine.play(), missing);
    assert_eq!(engine.pause(), missing);
    assert_eq!(engine.seek(5.0), missing);
    assert_eq!(engine.seek_relative(-5.0), missing);
    assert_eq!(engine.set_video_enabled(false), missing);
    assert_eq!(engine.set_volume(50.0), missing);
    assert_eq!(engine.sub_add("/subs/en.srt", true), missing);
    assert_eq!(engine.sub_remove(-1), missing);
    assert_eq!(engine.set_sub_pos(90.0), missing);
    assert_eq!(engine.set_sub_delay(0.5), missing);
    assert_eq!(
        engine.loadfile("http://example.test/live.ts", None),
        missing
    );
    assert_eq!(
        engine.create_event_client().err(),
        Some("no mpv instance".to_string())
    );
    #[cfg(target_os = "linux")]
    assert_eq!(engine.configure_audio(), missing);

    let state = engine.get_state();
    assert_eq!(state.current_url, None);
    assert_eq!(state.volume, 100.0);
    assert!(!state.is_playing && !state.is_paused);
    assert!(!state.playback_started && !state.open_failed);
    // Nothing has played, so the audio check waits for a later poll.
    assert_eq!(state.position, 0.0);
    assert!(!engine.audio_logged_playing);
}

#[test]
fn plays_a_local_file_with_its_audio_track() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let mut engine = engine(&[]);

    let state = start(&mut engine, &path, None);
    assert_eq!(state.current_url.as_deref(), Some(path.as_str()));
    assert!(state.is_playing && !state.is_paused && !state.open_failed);
    assert!((state.duration - 10.0).abs() < 0.01, "{}", state.duration);

    // The first poll with a position checks that audio is selected, and
    // leaves a selected track alone.
    wait_until("the position to move", || engine.get_state().position > 0.0);
    assert!(engine.audio_logged_playing);
    assert_eq!(mpv(&engine).get_property::<String>("aid").unwrap(), "1");
}

#[test]
fn resumes_a_load_at_its_start_position() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    // Paused, so the position stays where the load put it.
    let mut engine = engine(&[("pause", "yes")]);

    let state = start(&mut engine, &path, Some(4.0));
    assert!(
        (state.position - 4.0).abs() < POSITION_SLACK,
        "{}",
        state.position
    );
    assert!(state.is_paused && !state.is_playing);
}

#[test]
fn starts_from_the_beginning_inside_the_first_second() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let mut engine = engine(&[("pause", "yes")]);

    let state = start(&mut engine, &path, Some(0.5));
    assert!(state.position < POSITION_SLACK, "{}", state.position);
}

#[test]
fn pause_and_play_switch_the_player() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let mut engine = engine(&[]);
    start(&mut engine, &path, None);

    engine.pause().unwrap();
    let state = engine.get_state();
    assert!(state.is_paused && !state.is_playing);

    engine.play().unwrap();
    let state = engine.get_state();
    assert!(!state.is_paused && state.is_playing);
}

#[test]
fn seeks_to_a_position_and_by_an_offset() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let mut engine = engine(&[("pause", "yes")]);
    start(&mut engine, &path, None);

    engine.seek(6.0).unwrap();
    wait_for_position(6.0, || engine.get_state().position);
    engine.seek_relative(-2.5).unwrap();
    wait_for_position(3.5, || engine.get_state().position);
}

#[test]
fn reports_the_end_only_once_playback_reaches_it() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    // Paused from the start, so nothing plays before the first check.
    let mut engine = engine(&[("pause", "yes")]);
    start(&mut engine, &path, Some(8.5));

    // A pause in the last seconds isn't the end.
    wait_for_position(8.5, || engine.get_state().position);
    let state = engine.get_state();
    assert!(state.is_paused && !state.reached_end, "{state:?}");

    engine.play().unwrap();
    wait_until("the end of the file", || engine.get_state().reached_end);
    // keep-open pauses on the last frame once the audio drains, and the end
    // stays reported while it holds there.
    wait_until("a pause on the last frame", || {
        let state = engine.get_state();
        state.is_paused && !state.is_playing && state.reached_end
    });

    // Three seconds from the end, so only mpv clearing `eof-reached` can turn
    // the end off.
    engine.seek(7.0).unwrap();
    wait_until("a seek back to clear the end", || {
        !engine.get_state().reached_end
    });
}

#[test]
fn a_stream_that_closes_early_hasnt_reached_its_end() {
    // The connection closes six seconds into twenty. mpv reports the end of
    // the file, but `reconnect.rs` reloads a stream like this one.
    let server = Server::start(wav(20), vec![Reply::CutAfter(after_seconds(6))]);
    let url = server.url();
    let mut engine = engine(&[("speed", "4")]);
    start(&mut engine, &url, None);

    wait_until("the stream to close", || {
        mpv(&engine)
            .get_property::<bool>("eof-reached")
            .unwrap_or(false)
    });
    let state = engine.get_state();
    assert!(!state.reached_end, "{state:?}");
}

#[test]
fn keeps_the_volume_inside_the_player_range() {
    let mut engine = engine(&[]);
    for (asked, set) in [(42.0, 42.0), (200.0, 150.0), (-1.0, 0.0)] {
        engine.set_volume(asked).unwrap();
        assert_eq!(engine.get_state().volume, set, "asked for {asked}");
    }
}

#[test]
fn keeps_the_subtitle_position_on_screen_and_sets_the_delay() {
    let engine = engine(&[]);
    for (asked, set) in [(80.0, 80.0), (72.6, 73.0), (200.0, 150.0), (-5.0, 0.0)] {
        engine.set_sub_pos(asked).unwrap();
        let pos = mpv(&engine).get_property::<f64>("sub-pos").unwrap();
        assert_eq!(pos, set, "asked for {asked}");
    }
    engine.set_sub_delay(-1.5).unwrap();
    assert_eq!(mpv(&engine).get_property::<f64>("sub-delay").unwrap(), -1.5);
}

#[test]
fn turns_video_off_and_back_on() {
    let media = MediaDir::new();
    let path = media.file("blank.y4m", &y4m(4));
    let mut engine = engine(&[("pause", "yes")]);
    start(&mut engine, &path, None);
    let vid = |engine: &MpvEngine| mpv(engine).get_property::<String>("vid").unwrap();
    assert_eq!(vid(&engine), "1");

    engine.set_video_enabled(false).unwrap();
    assert_eq!(vid(&engine), "no");
    engine.set_video_enabled(true).unwrap();
    wait_until("the video track to come back", || vid(&engine) == "1");
}

#[test]
fn adds_and_removes_subtitle_tracks() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);
    start(&mut engine, &path, None);
    let tracks = |engine: &MpvEngine| mpv(engine).get_property::<i64>("track-list/count").unwrap();
    let selected = |engine: &MpvEngine| mpv(engine).get_property::<String>("sid").unwrap();
    let visible = |engine: &MpvEngine| mpv(engine).get_property::<bool>("sub-visibility").unwrap();

    // An absolute path is passed on as a file URL.
    engine.sub_add(&subtitles, true).unwrap();
    assert_eq!(tracks(&engine), 2);
    assert_eq!(selected(&engine), "1");
    assert!(visible(&engine));

    // Anything else, such as subtitles held in memory, goes through as is.
    // A track mpv shouldn't draw is still selected.
    engine.sub_add(&format!("memory://{SRT}"), false).unwrap();
    assert_eq!(tracks(&engine), 3);
    assert_eq!(selected(&engine), "2");
    assert!(!visible(&engine));

    // -1 removes the selected track and an id removes that one.
    engine.sub_remove(-1).unwrap();
    assert_eq!(tracks(&engine), 2);
    engine.sub_remove(1).unwrap();
    assert_eq!(tracks(&engine), 1);

    assert!(engine.sub_remove(99).is_err());

    // mpv sets whether it draws subtitles before it adds the track, so a
    // track the overlay draws never shows for a frame. A failed add still
    // sets it.
    assert!(engine.sub_add(&media.missing("gone.srt"), true).is_err());
    assert!(visible(&engine));
    assert!(engine.sub_add(&media.missing("gone.srt"), false).is_err());
    assert!(!visible(&engine));
    assert_eq!(tracks(&engine), 1);
}

#[test]
fn stop_forgets_the_stream_and_the_player() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let mut engine = engine(&[]);
    start(&mut engine, &path, None);

    engine.stop();
    let state = engine.get_state();
    assert_eq!(state.current_url, None);
    assert!(!state.is_playing && !state.playback_started);
    assert_eq!(engine.play(), Err("no mpv instance".to_string()));
}

#[test]
fn reports_a_file_that_fails_to_open() {
    let media = MediaDir::new();
    let path = media.missing("gone.wav");
    let mut engine = engine(&[]);

    engine.loadfile(&path, None).unwrap();
    engine.set_current_url(&path);
    let state = wait_for("the load to fail", || {
        let state = engine.get_state();
        state.open_failed.then_some(state)
    });
    assert!(!state.playback_started);
}

#[test]
fn an_event_client_drives_the_same_player() {
    let mut engine = engine(&[]);
    let client = engine.create_event_client().unwrap();
    client.set_property("volume", 37.0).unwrap();
    assert_eq!(engine.get_state().volume, 37.0);
}

#[test]
fn leaves_audio_off_when_no_audio_output_is_open() {
    let media = MediaDir::new();
    let video = media.file("blank.y4m", &y4m(4));
    let audio = media.file("tone.wav", &wav(4));
    // With audio turned off no output opens, which is how a machine with no
    // sound device looks to the engine.
    let mut engine = engine(&[("aid", "no"), ("audio-files", audio.as_str())]);
    start(&mut engine, &video, None);

    wait_until("the position to move", || engine.get_state().position > 0.0);
    assert!(engine.audio_logged_playing);
    assert_eq!(
        mpv(&engine)
            .get_property::<i64>("track-list/count")
            .unwrap(),
        2
    );
    assert_eq!(mpv(&engine).get_property::<String>("aid").unwrap(), "no");
}

#[test]
fn turns_audio_back_on_when_an_output_is_open() {
    let media = MediaDir::new();
    let audio = media.file("tone.wav", &wav(4));
    // The filter graph sends the file's audio track to the output itself, so
    // an output is open while `aid` reads `no`. That is the state the engine
    // repairs. Setting `aid` writes the option, which is where the test sees
    // the engine's choice.
    let mut engine = engine(&[("lavfi-complex", "[aid1] anull [ao]")]);
    start(&mut engine, &audio, None);
    let player = mpv(&engine);
    player.set_property("options/aid", "no").unwrap();
    assert_eq!(player.get_property::<String>("aid").unwrap(), "no");
    assert_eq!(player.get_property::<String>("current-ao").unwrap(), "null");
    assert_eq!(player.get_property::<i64>("track-list/count").unwrap(), 1);

    engine.ensure_audio_selected();
    assert_eq!(
        player.get_property::<String>("options/aid").unwrap(),
        "auto"
    );
}

/// Linux sets the audio properties after mpv starts, since some builds
/// reject them as options.
#[cfg(target_os = "linux")]
#[test]
fn configure_audio_turns_sound_on_at_full_volume() {
    let engine = engine(&[]);
    let player = mpv(&engine);
    player.set_property("aid", "no").unwrap();
    player.set_property("mute", true).unwrap();
    player.set_property("volume", 20.0).unwrap();

    engine.configure_audio().unwrap();
    assert_eq!(player.get_property::<String>("aid").unwrap(), "auto");
    assert!(!player.get_property::<bool>("mute").unwrap());
    assert_eq!(player.get_property::<f64>("volume").unwrap(), 100.0);
}
