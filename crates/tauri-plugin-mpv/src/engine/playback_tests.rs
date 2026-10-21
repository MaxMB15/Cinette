// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The engine against a real, headless mpv playing generated local files.

use super::{MediaInfo, MpvEngine, PlayerState};
use crate::test_support::{
    after_seconds, headless, wait_for, wait_for_position, wait_until, wav, y4m, Hook, MediaDir,
    Reply, Server, POSITION_SLACK,
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

/// Loads `path` on the player while it plays another file, as a reconnect
/// does, and waits until the new file plays. `start` can't tell, since mpv
/// reports the old file until the new one opens.
fn reload(engine: &MpvEngine, path: &str) {
    engine.loadfile(path, None).expect("loadfile");
    let name = path.rsplit('/').next().unwrap();
    wait_until("the new file to play", || {
        let mpv = mpv(engine);
        mpv.get_property::<String>("filename")
            .is_ok_and(|n| n == name)
            && mpv
                .get_property::<bool>("seeking")
                .is_ok_and(|seeking| !seeking)
    });
}

/// The engine's player, for reading properties the state doesn't report.
fn mpv(engine: &MpvEngine) -> &Mpv {
    engine.mpv.as_ref().expect("an mpv instance")
}

/// How many tracks the file that plays has, of every kind.
fn track_count(engine: &MpvEngine) -> i64 {
    mpv(engine).get_property::<i64>("track-list/count").unwrap()
}

/// The id of the selected subtitle track, or "no".
fn selected_sub(engine: &MpvEngine) -> String {
    mpv(engine).get_property::<String>("sid").unwrap()
}

/// The file of the selected subtitle track, or nothing when none is selected.
fn selected_sub_file(engine: &MpvEngine) -> String {
    mpv(engine)
        .get_property::<String>("current-tracks/sub/external-filename")
        .unwrap_or_default()
}

/// Whether mpv draws the subtitles.
fn sub_visible(engine: &MpvEngine) -> bool {
    mpv(engine).get_property::<bool>("sub-visibility").unwrap()
}

/// Loads `path` and waits until mpv stops it at `on_preloaded`. mpv has read
/// `sub-files` by then, and has the file open only after the hook. Returns
/// the hook and the id that lets the load go on.
fn hold_after_the_list(engine: &mut MpvEngine, path: &str) -> (Hook, u64) {
    let hook = Hook::new(mpv(engine), c"on_preloaded");
    engine.loadfile(path, None).expect("loadfile");
    engine.set_current_url(path);
    let id = hook.wait();
    (hook, id)
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
fn create_sets_the_window_options() {
    let engine = engine(&[
        ("osc", "yes"),
        ("ytdl", "no"),
        ("input-default-bindings", "yes"),
        ("input-vo-keyboard", "yes"),
    ]);
    let mpv = mpv(&engine);
    assert!(mpv.get_property::<bool>("input-default-bindings").unwrap());
    assert!(mpv.get_property::<bool>("input-vo-keyboard").unwrap());
    // `osc` and `ytdl` only exist when libmpv has Lua, and `create` skips
    // them when it doesn't.
    if mpv.get_property::<String>("option-info/osc/name").is_ok() {
        assert!(mpv.get_property::<bool>("osc").unwrap());
        assert_eq!(mpv.get_property::<String>("ytdl").unwrap(), "no");
    }
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
    assert_eq!(engine.restore_subtitles("/subs/en.srt", true, 0.0), missing);
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
fn sets_the_subtitle_delay() {
    let engine = engine(&[]);
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
    // The new track takes the place of the one in use, and one mpv
    // shouldn't draw is still selected.
    engine.sub_add(&format!("memory://{SRT}"), false).unwrap();
    assert_eq!(tracks(&engine), 2);
    assert_eq!(selected(&engine), "2");
    assert!(!visible(&engine));

    // A file mpv can't add leaves the track in use. When mpv was to draw the
    // new one, the track in use stays as it was, which here is hidden.
    assert!(engine.sub_add(&media.missing("gone.srt"), true).is_err());
    assert_eq!(selected(&engine), "2");
    assert!(!visible(&engine));

    // When the overlay was to draw the new one, mpv hides the track in use,
    // since the overlay already draws the new subtitles.
    engine.sub_add(&subtitles, true).unwrap();
    assert_eq!(selected(&engine), "3");
    assert!(visible(&engine));
    assert!(engine.sub_add(&media.missing("gone.srt"), false).is_err());
    assert_eq!(selected(&engine), "3");
    assert!(!visible(&engine));
    assert_eq!(tracks(&engine), 2);

    // -1 removes the selected track and an id removes that one.
    engine.sub_remove(-1).unwrap();
    assert_eq!(tracks(&engine), 1);
    engine.sub_add(&subtitles, true).unwrap();
    let id: i64 = selected(&engine).parse().unwrap();
    engine.sub_remove(id).unwrap();
    assert_eq!(tracks(&engine), 1);

    assert!(engine.sub_remove(99).is_err());
}

#[test]
fn a_reload_keeps_the_added_subtitles() {
    let media = MediaDir::new();
    let one = media.file("one.wav", &wav(10));
    let two = media.file("two.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);
    start(&mut engine, &one, None);
    let tracks = |engine: &MpvEngine| mpv(engine).get_property::<i64>("track-list/count").unwrap();
    let selected = |engine: &MpvEngine| mpv(engine).get_property::<String>("sid").unwrap();

    // A reconnect loads the stream again on the same player.
    engine.sub_add(&subtitles, false).unwrap();
    engine.set_sub_delay(0.5).unwrap();
    reload(&engine, &two);
    assert_eq!(tracks(&engine), 2);
    assert_eq!(selected(&engine), "1");
    assert!(!mpv(&engine).get_property::<bool>("sub-visibility").unwrap());
    assert_eq!(mpv(&engine).get_property::<f64>("sub-delay").unwrap(), 0.5);

    // Adding to the list doesn't add the file to the stream that plays.
    engine.sub_add(&subtitles, true).unwrap();
    assert_eq!(tracks(&engine), 2);

    // A removed track stays out.
    engine.sub_remove(-1).unwrap();
    reload(&engine, &one);
    assert_eq!(tracks(&engine), 1);
    assert_eq!(selected(&engine), "no");
}

#[test]
fn a_new_player_starts_with_the_restored_subtitles() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let tracks = |engine: &MpvEngine| mpv(engine).get_property::<i64>("track-list/count").unwrap();

    let mut first = engine(&[("pause", "yes")]);
    first.restore_subtitles(&subtitles, false, -1.5).unwrap();
    start(&mut first, &path, None);
    assert_eq!(tracks(&first), 2);
    assert_eq!(mpv(&first).get_property::<String>("sid").unwrap(), "1");
    assert!(!mpv(&first).get_property::<bool>("sub-visibility").unwrap());
    assert_eq!(mpv(&first).get_property::<f64>("sub-delay").unwrap(), -1.5);

    // A file that's gone by then doesn't stop the stream.
    let mut second = engine(&[("pause", "yes")]);
    second
        .restore_subtitles(&media.missing("gone.srt"), true, 0.0)
        .unwrap();
    start(&mut second, &path, None);
    assert_eq!(tracks(&second), 1);
    assert!(mpv(&second).get_property::<bool>("sub-visibility").unwrap());
}

#[test]
fn adds_a_subtitle_when_the_file_starts() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let tracks = |engine: &MpvEngine| mpv(engine).get_property::<i64>("track-list/count").unwrap();
    let selected = |engine: &MpvEngine| mpv(engine).get_property::<String>("sid").unwrap();
    let visible = |engine: &MpvEngine| mpv(engine).get_property::<bool>("sub-visibility").unwrap();
    // The file of the selected subtitle track, or nothing when none is selected.
    let selected_file = |engine: &MpvEngine| {
        mpv(engine)
            .get_property::<String>("current-tracks/sub/external-filename")
            .unwrap_or_default()
    };

    // Before any file, mpv draws the track only when it was asked to.
    let mut first = engine(&[("pause", "yes"), ("sub-visibility", "no")]);
    first.sub_add(&subtitles, true).unwrap();
    start(&mut first, &path, None);
    assert_eq!(tracks(&first), 2);
    assert_eq!(selected(&first), "1");
    assert!(visible(&first));

    // mpv refuses a track after a `loadfile` until it starts to open the
    // file, and a pick can come after `MpvState::load` returns but before
    // then.
    let mut second = engine(&[("pause", "yes")]);
    second.loadfile(&path, None).unwrap();
    second.sub_add(&subtitles, false).unwrap();
    second.set_current_url(&path);
    wait_until("playback to start", || second.get_state().playback_started);
    assert_eq!(tracks(&second), 2);
    assert_eq!(selected(&second), "1");
    assert!(!visible(&second));

    // Nor while it closes the file that plays to load another, as a
    // reconnect does. The new file can open first and add the track from
    // `sub-files`. The add then puts a copy in its place, which mpv numbers
    // 2, so only the file and the count say it worked.
    let other = media.file("other.wav", &wav(10));
    second.loadfile(&other, None).unwrap();
    second.sub_add(&subtitles, true).unwrap();
    wait_until("the new file to play", || {
        mpv(&second)
            .get_property::<String>("filename")
            .is_ok_and(|n| n == "other.wav")
            && mpv(&second)
                .get_property::<bool>("seeking")
                .is_ok_and(|s| !s)
    });
    assert_eq!(tracks(&second), 2);
    assert!(selected_file(&second).ends_with("/en.srt"));
    assert!(visible(&second));

    // While it opens the file, here until the server sends the stream, mpv
    // takes the track and then adds the file again from `sub-files`.
    let (send, held) = std::sync::mpsc::channel();
    let server = Server::start(wav(10), vec![Reply::HoldAfter(0, held)]);
    let mut third = engine(&[("pause", "yes"), ("sub-visibility", "no")]);
    third.loadfile(&server.url(), None).unwrap();
    third.set_current_url(&server.url());
    wait_until("mpv to ask for the stream", || {
        !server.requests().is_empty()
    });
    third.sub_add(&subtitles, true).unwrap();
    send.send(()).unwrap();
    wait_until("playback to start", || third.get_state().playback_started);
    assert_eq!(tracks(&third), 2);
    assert_eq!(selected(&third), "1");
    assert!(visible(&third));
}

#[test]
fn adds_a_subtitle_mpv_opened_the_file_without() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes"), ("sub-visibility", "no")]);

    // The pick comes after mpv read the list, so the file opens without it.
    let (hook, id) = hold_after_the_list(&mut engine, &path);
    engine.sub_add(&subtitles, true).unwrap();
    hook.resume(id);

    // The poll that first sees the file open adds the track and selects it.
    wait_until("playback to start", || engine.get_state().playback_started);
    assert_eq!(track_count(&engine), 2);
    assert_eq!(selected_sub(&engine), "1");
    assert!(selected_sub_file(&engine).ends_with("/en.srt"));
    assert!(sub_visible(&engine));

    // Later polls don't add it again.
    engine.get_state();
    assert_eq!(track_count(&engine), 2);
}

#[test]
fn adds_a_subtitle_mpv_reloaded_the_stream_without() {
    let media = MediaDir::new();
    let one = media.file("one.wav", &wav(10));
    let two = media.file("two.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);
    start(&mut engine, &one, None);

    // A reconnect loads the stream again on the same player, and the engine
    // still reports that playback has started.
    let hook = Hook::new(mpv(&engine), c"on_preloaded");
    engine.loadfile(&two, None).unwrap();
    let id = hook.wait();
    engine.sub_add(&subtitles, true).unwrap();
    hook.resume(id);
    wait_until("the new file to play", || {
        mpv(&engine)
            .get_property::<String>("filename")
            .is_ok_and(|n| n == "two.wav")
            && mpv(&engine)
                .get_property::<bool>("seeking")
                .is_ok_and(|seeking| !seeking)
    });

    engine.get_state();
    assert_eq!(track_count(&engine), 2);
    assert_eq!(selected_sub(&engine), "1");
}

#[test]
fn a_subtitle_mpv_missed_takes_the_place_of_the_one_in_use() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let first = media.file("first.srt", SRT.as_bytes());
    let second = media.file("second.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);
    engine.restore_subtitles(&first, true, 0.0).unwrap();

    // mpv opens the file with the restored subtitles, and the overlay is to
    // draw the ones picked while it opened it.
    let (hook, id) = hold_after_the_list(&mut engine, &path);
    engine.sub_add(&second, false).unwrap();
    hook.resume(id);

    wait_until("playback to start", || engine.get_state().playback_started);
    assert_eq!(track_count(&engine), 2);
    assert!(selected_sub_file(&engine).ends_with("/second.srt"));
    assert!(!sub_visible(&engine));
}

#[test]
fn leaves_a_subtitle_mpv_added_as_it_opened_the_file() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);

    // At `on_load`, mpv has started to open the file but hasn't read the
    // list yet. It adds the file from the list, and the polls don't add it
    // a second time.
    let hook = Hook::new(mpv(&engine), c"on_load");
    engine.loadfile(&path, None).unwrap();
    engine.set_current_url(&path);
    let id = hook.wait();
    engine.sub_add(&subtitles, true).unwrap();
    // A poll before the file is open leaves the file to mpv.
    engine.get_state();
    hook.resume(id);

    wait_until("playback to start", || engine.get_state().playback_started);
    engine.get_state();
    assert_eq!(track_count(&engine), 2);
    assert_eq!(selected_sub(&engine), "1");
}

#[test]
fn adds_no_missed_subtitle_once_it_was_removed() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);

    // There's no track to remove yet, so mpv turns the removal down.
    let (hook, id) = hold_after_the_list(&mut engine, &path);
    engine.sub_add(&subtitles, true).unwrap();
    assert!(engine.sub_remove(-1).is_err());
    hook.resume(id);

    wait_until("playback to start", || engine.get_state().playback_started);
    engine.get_state();
    assert_eq!(track_count(&engine), 1);
    assert_eq!(selected_sub(&engine), "no");
}

#[test]
fn adds_no_missed_subtitle_to_another_stream() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let other = media.file("other.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);

    // `MpvState` plays another stream in a new player.
    let (hook, _) = hold_after_the_list(&mut engine, &path);
    engine.sub_add(&subtitles, true).unwrap();
    if let Err(e) = engine.create(&headless(&[("pause", "yes")])) {
        panic!("create mpv: {e}");
    }
    drop(hook);
    start(&mut engine, &other, None);
    engine.get_state();
    assert_eq!(track_count(&engine), 1);
    assert_eq!(selected_sub(&engine), "no");
}

#[test]
fn a_pick_after_the_file_opens_replaces_the_missed_one() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let first = media.file("first.srt", SRT.as_bytes());
    let second = media.file("second.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);

    // The second pick comes once the file is open, before any poll.
    let (hook, id) = hold_after_the_list(&mut engine, &path);
    engine.sub_add(&first, true).unwrap();
    hook.resume(id);
    wait_until("the file to open", || {
        mpv(&engine)
            .get_property::<bool>("seeking")
            .is_ok_and(|seeking| !seeking)
    });
    engine.sub_add(&second, true).unwrap();

    engine.get_state();
    assert_eq!(track_count(&engine), 2);
    assert!(selected_sub_file(&engine).ends_with("/second.srt"));
}

#[test]
fn removes_a_subtitle_track_by_id_while_another_is_selected() {
    let media = MediaDir::new();
    let path = media.file("tone.wav", &wav(10));
    let subtitles = media.file("en.srt", SRT.as_bytes());
    let mut engine = engine(&[("pause", "yes")]);
    start(&mut engine, &path, None);
    let tracks = |engine: &MpvEngine| mpv(engine).get_property::<i64>("track-list/count").unwrap();
    let selected = |engine: &MpvEngine| mpv(engine).get_property::<String>("sid").unwrap();

    // The engine takes out the track in use when it adds one, so mpv adds
    // the second track itself and track 1 stays.
    engine.sub_add(&subtitles, true).unwrap();
    mpv(&engine)
        .command("sub-add", &[&format!("memory://{SRT}"), "select"])
        .unwrap();
    assert_eq!(tracks(&engine), 3);
    assert_eq!(selected(&engine), "2");

    // Removing track 1 leaves the selected track alone.
    engine.sub_remove(1).unwrap();
    assert_eq!(tracks(&engine), 2);
    assert_eq!(selected(&engine), "2");
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
fn reports_waiting_while_a_stream_stalls() {
    // The server holds the stream twelve seconds in, until the test lets it
    // go. mpv fills some of its cache before playback starts.
    let (resume, held) = std::sync::mpsc::channel();
    let server = Server::start(wav(20), vec![Reply::HoldAfter(after_seconds(12), held)]);
    let mut engine = engine(&[("speed", "4")]);
    start(&mut engine, &server.url(), None);

    let state = wait_for("the stream to stall", || {
        let state = engine.get_state();
        state.waiting.then_some(state)
    });
    assert!(state.is_playing && !state.is_paused, "{state:?}");

    resume.send(()).unwrap();
    wait_until("the stream to play on", || {
        let state = engine.get_state();
        !state.waiting && state.position > 12.5
    });

    // mpv's core is idle while paused too, but that isn't waiting.
    engine.pause().unwrap();
    assert!(mpv(&engine).get_property::<bool>("core-idle").unwrap());
    assert!(!engine.get_state().waiting);
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

#[test]
fn reports_what_the_item_is_made_of() {
    let media = MediaDir::new();
    let mut engine = engine(&[("pause", "yes")]);
    assert_eq!(engine.media_info(), MediaInfo::default());

    let audio = media.file("tone.wav", &wav(4));
    start(&mut engine, &audio, None);
    assert_eq!(
        engine.media_info(),
        MediaInfo {
            file_format: Some("wav".into()),
            video_codec: None,
            audio_codec: Some("pcm_s16le".into()),
            interlaced: false,
            hdr: false,
        }
    );

    let video = media.file("blank.y4m", &y4m(4));
    reload(&engine, &video);
    let info = wait_for("a video frame", || {
        let info = engine.media_info();
        info.video_codec.is_some().then_some(info)
    });
    assert_eq!(info.file_format.as_deref(), Some("yuv4mpegpipe"));
    assert_eq!(info.video_codec.as_deref(), Some("rawvideo"));
    assert_eq!(info.audio_codec, None);
    assert!(!info.interlaced);
    assert!(!info.hdr);
}

#[test]
fn pq_and_hlg_are_hdr() {
    for (gamma, hdr) in [
        ("pq", true),
        ("hlg", true),
        ("bt.1886", false),
        ("srgb", false),
        ("auto", false),
    ] {
        assert_eq!(super::hdr_gamma(gamma), hdr, "{gamma}");
    }
}

#[test]
fn media_info_is_empty_without_an_instance() {
    assert_eq!(MpvEngine::new().media_info(), MediaInfo::default());
}

#[test]
fn reports_interlaced_video() {
    let media = MediaDir::new();
    let mut engine = engine(&[("pause", "yes")]);
    // The same blank video, marked top field first.
    let mut bytes = y4m(4);
    let header_end = bytes.iter().position(|&b| b == b'\n').unwrap();
    let header = String::from_utf8(bytes[..header_end].to_vec())
        .unwrap()
        .replace(" Ip ", " It ");
    bytes.splice(..header_end, header.into_bytes());
    let video = media.file("interlaced.y4m", &bytes);
    start(&mut engine, &video, None);
    wait_until("the frame to show as interlaced", || {
        engine.media_info().interlaced
    });
}
