// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::test_support::TestApp;
use serde_json::json;
// Only the command tests use it, and they don't build for iOS.
#[cfg(not(target_os = "ios"))]
use tauri::async_runtime::block_on;

fn report(status: &str) -> Report {
    Report {
        status: status.into(),
        position: 12.0,
        duration: Some(3600.0),
        external: true,
        error: None,
        subtitles: Vec::new(),
        subtitle: None,
        audio: Vec::new(),
        audio_track: None,
    }
}

fn failed(domain: &str, code: i64, http_status: Option<u16>) -> Report {
    Report {
        error: Some(ReportError {
            domain: domain.into(),
            code,
            http_status,
        }),
        ..report("failed")
    }
}

fn track(label: &str) -> Track {
    Track {
        label: label.into(),
        language: None,
    }
}

fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

#[test]
fn maps_avplayer_statuses() {
    let now = Instant::now();
    let cases = [
        ("opening", Status::Opening),
        ("playing", Status::Playing),
        ("paused", Status::Paused),
        ("waiting", Status::Buffering),
        ("ended", Status::Ended),
        ("failed", Status::Error),
        ("something new", Status::Error),
    ];
    for (status, expected) in cases {
        let state = Tracker::new(false).update(&report(status), now);
        assert_eq!(state.status, expected, "{status}");
    }
}

#[test]
fn reads_position_duration_and_tracks() {
    let mut r = report("playing");
    r.subtitles = vec![track("English"), track("French")];
    r.subtitle = Some(1);
    r.audio = vec![track("Main")];
    r.audio_track = Some(0);
    let state = Tracker::new(false).update(&r, Instant::now());
    assert_eq!(state.position, 12.0);
    assert_eq!(state.duration, 3600.0);
    assert_eq!(state.subtitles, r.subtitles);
    assert_eq!(state.subtitle_id.as_deref(), Some("1"));
    assert_eq!(state.audio_id.as_deref(), Some("0"));
    assert_eq!(state.connection, Connection::Connected);
    assert_eq!(state.error, None);
}

#[test]
fn drops_a_selection_outside_the_list_and_a_negative_position() {
    let mut r = report("playing");
    r.subtitles = vec![track("English")];
    r.subtitle = Some(1);
    r.audio_track = Some(0);
    r.position = -0.5;
    let state = Tracker::new(false).update(&r, Instant::now());
    assert_eq!(state.subtitle_id, None);
    assert_eq!(state.audio_id, None);
    assert_eq!(state.position, 0.0);
}

#[test]
fn live_has_no_duration_and_never_ends() {
    let mut live = Tracker::new(true);
    let now = Instant::now();
    assert_eq!(live.update(&report("playing"), now).duration, 0.0);
    let ended = live.update(&report("ended"), now);
    assert_eq!(ended.status, Status::Error);
    assert_eq!(ended.error.unwrap().code, "failed");
}

#[test]
fn an_unknown_or_endless_duration_is_zero() {
    let now = Instant::now();
    for duration in [
        None,
        Some(f64::NAN),
        Some(f64::INFINITY),
        Some(0.0),
        Some(-1.0),
    ] {
        let r = Report {
            duration,
            ..report("playing")
        };
        assert_eq!(
            Tracker::new(false).update(&r, now).duration,
            0.0,
            "{duration:?}"
        );
    }
}

#[test]
fn a_failure_before_the_item_is_ready_is_open_failed() {
    let now = Instant::now();
    let mut tracker = Tracker::new(false);
    tracker.update(&report("opening"), now);
    let state = tracker.update(&failed("NSURLErrorDomain", -1004, None), now);
    assert_eq!(
        state.error,
        Some(PlaybackError {
            code: "openFailed",
            unsupported: false,
            not_picked: false,
        })
    );
}

#[test]
fn a_failure_after_playing_is_failed() {
    let now = Instant::now();
    let mut tracker = Tracker::new(false);
    tracker.update(&report("playing"), now);
    let state = tracker.update(&failed("NSURLErrorDomain", -1005, None), now);
    assert_eq!(state.error.unwrap().code, "failed");
}

#[test]
fn a_401_or_403_is_refused() {
    let now = Instant::now();
    for status in [401, 403] {
        let state =
            Tracker::new(false).update(&failed("CoreMediaErrorDomain", -12938, Some(status)), now);
        assert_eq!(state.error.unwrap().code, "refused", "{status}");
    }
    let state = Tracker::new(false).update(&failed("CoreMediaErrorDomain", -12938, Some(404)), now);
    assert_eq!(state.error.unwrap().code, "openFailed");
}

#[test]
fn marks_formats_the_receiver_cant_play() {
    let now = Instant::now();
    let unsupported = [
        ("AVFoundationErrorDomain", -11828),
        ("AVFoundationErrorDomain", -11829),
        ("AVFoundationErrorDomain", -11833),
        ("AVFoundationErrorDomain", -11821),
        ("CoreMediaErrorDomain", -12927),
        ("CoreMediaErrorDomain", -12847),
    ];
    for (domain, code) in unsupported {
        let state = Tracker::new(false).update(&failed(domain, code, None), now);
        assert!(state.error.unwrap().unsupported, "{domain} {code}");
    }
    let reachable = [
        ("AVFoundationErrorDomain", -11800),
        ("CoreMediaErrorDomain", -12938),
        ("NSURLErrorDomain", -11828),
    ];
    for (domain, code) in reachable {
        let state = Tracker::new(false).update(&failed(domain, code, None), now);
        assert!(!state.error.unwrap().unsupported, "{domain} {code}");
    }
    // A failure with no error at all is neither.
    let state = Tracker::new(false).update(&report("failed"), now);
    assert!(!state.error.unwrap().unsupported);
}

#[test]
fn the_video_leaving_the_receiver_is_lost_for_good() {
    let now = Instant::now();
    let mut tracker = Tracker::new(false);
    let mut r = report("opening");
    r.external = false;
    // Before the video ever reached the receiver, that's just opening.
    assert_eq!(tracker.update(&r, now).connection, Connection::Connected);
    assert_eq!(
        tracker.update(&report("playing"), now).connection,
        Connection::Connected
    );
    let mut here = report("playing");
    here.external = false;
    assert_eq!(tracker.update(&here, now).connection, Connection::Lost);
    // Even if the route comes back, this item is over.
    assert_eq!(
        tracker.update(&report("playing"), now).connection,
        Connection::Lost
    );
}

#[test]
fn waiting_without_progress_reconnects_then_is_lost() {
    let start = Instant::now();
    let mut tracker = Tracker::new(false);
    tracker.update(&report("playing"), start);
    let waiting = report("waiting");
    assert_eq!(
        tracker.update(&waiting, start).connection,
        Connection::Connected
    );
    assert_eq!(
        tracker.update(&waiting, start + secs(9)).connection,
        Connection::Connected
    );
    assert_eq!(
        tracker.update(&waiting, start + secs(10)).connection,
        Connection::Reconnecting
    );
    assert_eq!(
        tracker.update(&waiting, start + secs(29)).connection,
        Connection::Reconnecting
    );
    assert_eq!(
        tracker.update(&waiting, start + secs(30)).connection,
        Connection::Lost
    );
}

#[test]
fn progress_or_playing_resets_the_wait() {
    let start = Instant::now();
    let mut tracker = Tracker::new(false);
    tracker.update(&report("playing"), start);
    let waiting = report("waiting");
    tracker.update(&waiting, start);
    // A little further on: still waiting, but it moved, so the clock restarts.
    let moved = Report {
        position: 13.0,
        ..report("waiting")
    };
    assert_eq!(
        tracker.update(&moved, start + secs(12)).connection,
        Connection::Connected
    );
    assert_eq!(
        tracker.update(&moved, start + secs(21)).connection,
        Connection::Connected
    );
    assert_eq!(
        tracker.update(&moved, start + secs(22)).connection,
        Connection::Reconnecting
    );
    tracker.update(&report("playing"), start + secs(23));
    assert_eq!(
        tracker.update(&waiting, start + secs(24)).connection,
        Connection::Connected
    );
}

#[test]
fn half_a_second_of_progress_counts() {
    let start = Instant::now();
    let mut tracker = Tracker::new(false);
    tracker.update(&report("playing"), start);
    tracker.update(&report("waiting"), start);
    let moved = Report {
        position: 12.5,
        ..report("waiting")
    };
    assert_eq!(
        tracker.update(&moved, start + secs(12)).connection,
        Connection::Connected
    );
}

#[test]
fn starts_vod_where_asked_and_live_at_the_edge() {
    assert_eq!(start_position(Some(41.5), false), 41.5);
    assert_eq!(start_position(None, false), 0.0);
    assert_eq!(start_position(Some(41.5), true), 0.0);
}

#[test]
fn a_receiver_that_never_gets_the_item_ready_is_lost_without_reconnecting() {
    let start = Instant::now();
    let mut tracker = Tracker::new(false);
    let opening = report("opening");
    tracker.update(&opening, start);
    assert_eq!(
        tracker.update(&opening, start + secs(15)).connection,
        Connection::Connected
    );
    assert_eq!(
        tracker.update(&opening, start + secs(30)).connection,
        Connection::Lost
    );
}

#[test]
fn reports_only_changes_and_only_while_an_item_is_tracked() {
    let airplay = AirPlay::default();
    let now = Instant::now();
    assert_eq!(airplay.report(&report("playing"), now), None);
    assert_eq!(airplay.state(), AirPlayState::idle());
    airplay.begin(Tracker::new(false));
    let first = airplay
        .report(&report("playing"), now)
        .expect("a first state");
    assert_eq!(first.status, Status::Playing);
    assert_eq!(airplay.report(&report("playing"), now), None);
    assert_eq!(airplay.state(), first);
    let paused = airplay.report(&report("paused"), now).expect("a change");
    assert_eq!(paused.status, Status::Paused);
    airplay.end();
    assert_eq!(airplay.state(), AirPlayState::idle());
    assert_eq!(airplay.report(&report("playing"), now), None);
}

#[test]
fn a_new_item_starts_fresh() {
    let airplay = AirPlay::default();
    let now = Instant::now();
    airplay.begin(Tracker::new(false));
    let mut here = report("playing");
    airplay.report(&report("playing"), now);
    here.external = false;
    assert_eq!(
        airplay.report(&here, now).unwrap().connection,
        Connection::Lost
    );
    airplay.begin(Tracker::new(true));
    let state = airplay.report(&report("playing"), now).unwrap();
    assert_eq!(state.connection, Connection::Connected);
    assert_eq!(state.duration, 0.0);
}

#[test]
fn emits_the_state_from_swifts_json() {
    let app = TestApp::new();
    let events = app.record(&[EVENT_STATE]);
    let handle = app.handle();
    handle.state::<AirPlay>().begin(Tracker::new(false));
    let json = json!({
        "status": "playing",
        "position": 41.5,
        "duration": 5400.0,
        "external": true,
        "subtitles": [{ "label": "English", "language": "en" }],
        "subtitle": 0,
        "audio": [],
        "audioTrack": null,
    });
    handle_report(&handle, &json.to_string(), Instant::now());
    let state = events.wait_for(EVENT_STATE);
    assert_eq!(
        state,
        json!({
            "status": "playing",
            "position": 41.5,
            "duration": 5400.0,
            "subtitles": [{ "label": "English", "language": "en" }],
            "subtitleId": "0",
            "audio": [],
            "audioId": null,
            "connection": "connected",
            "error": null,
        })
    );
}

#[test]
fn serializes_an_error_with_its_code() {
    let mut tracker = Tracker::new(false);
    let state = tracker.update(
        &failed("AVFoundationErrorDomain", -11828, None),
        Instant::now(),
    );
    assert_eq!(
        serde_json::to_value(state.error).unwrap(),
        json!({ "code": "openFailed", "unsupported": true })
    );
    let state = tracker.update(&failed("NSURLErrorDomain", -1004, None), Instant::now());
    assert_eq!(
        serde_json::to_value(state.error).unwrap(),
        json!({ "code": "openFailed" })
    );
}

#[test]
fn drops_a_report_that_doesnt_parse() {
    let app = TestApp::new();
    let handle = app.handle();
    handle.state::<AirPlay>().begin(Tracker::new(false));
    handle_report(&handle, "{ not json", Instant::now());
    handle_report(&handle, r#"{"status":"playing"}"#, Instant::now());
    assert_eq!(handle.state::<AirPlay>().state(), AirPlayState::idle());
}

#[test]
fn route_ids_carry_the_uid() {
    assert_eq!(
        Route::new("A1:B2-airplay", "Living Room TV"),
        Route {
            id: "airplay:A1:B2-airplay".into(),
            name: "Living Room TV".into()
        }
    );
}

#[test]
#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn every_command_fails_where_there_is_no_airplay() {
    let app = TestApp::new();
    let unavailable = Err(UNAVAILABLE.to_string());
    assert_eq!(block_on(airplay_set_detection(true)), unavailable);
    assert_eq!(block_on(airplay_choose(0.0, 0.0, 10.0, 10.0)), unavailable);
    assert_eq!(block_on(airplay_get_route()), Err(UNAVAILABLE.to_string()));
    assert_eq!(block_on(airplay_play()), unavailable);
    assert_eq!(block_on(airplay_pause()), unavailable);
    assert_eq!(block_on(airplay_seek(10.0)), unavailable);
    assert_eq!(block_on(airplay_select_subtitle(Some(0))), unavailable);
    assert_eq!(block_on(airplay_select_audio(0)), unavailable);
    assert_eq!(block_on(airplay_stop(app.handle())), unavailable);
    assert_eq!(
        load(
            &app.handle(),
            "http://127.0.0.1:1/x.m3u8",
            "Channel",
            Some(5.0),
            false,
            None
        ),
        unavailable
    );
    // Nothing started tracking.
    assert_eq!(
        app.handle()
            .state::<AirPlay>()
            .report(&report("playing"), Instant::now()),
        None
    );
    assert_eq!(
        block_on(airplay_get_state(app.handle().state())),
        Ok(AirPlayState::idle())
    );
}

/// On a Mac, the commands hand their work to the main thread and return.
/// A test's main thread never runs that work, so what shows is what they
/// do here: a load starts tracking the item, and a stop ends it.
#[test]
#[cfg(target_os = "macos")]
fn on_a_mac_the_commands_queue_their_work_and_track_the_item() {
    let app = TestApp::new();
    let handle = app.handle();
    assert_eq!(block_on(airplay_set_detection(true)), Ok(()));
    assert_eq!(block_on(airplay_choose(0.0, 0.0, 10.0, 10.0)), Ok(()));
    // Nothing was picked.
    assert_eq!(block_on(airplay_get_route()), Ok(None));
    assert_eq!(
        load(
            &handle,
            "http://127.0.0.1:1/x.m3u8",
            "Channel",
            Some(5.0),
            false,
            None
        ),
        Ok(())
    );
    assert!(handle
        .state::<AirPlay>()
        .report(&report("playing"), Instant::now())
        .is_some());
    assert_eq!(block_on(airplay_play()), Ok(()));
    assert_eq!(block_on(airplay_pause()), Ok(()));
    assert_eq!(block_on(airplay_seek(10.0)), Ok(()));
    // There's no track choice on a Mac yet, and choosing does nothing.
    assert_eq!(block_on(airplay_select_subtitle(Some(0))), Ok(()));
    assert_eq!(block_on(airplay_select_audio(0)), Ok(()));
    assert_eq!(block_on(airplay_stop(handle.clone())), Ok(()));
    assert_eq!(
        block_on(airplay_get_state(handle.state())),
        Ok(AirPlayState::idle())
    );
}

#[test]
fn a_converted_stream_counts_from_where_it_started() {
    let converted = Converted {
        offset: 600.0,
        duration: Some(5400.0),
    };
    let mut tracker = Tracker::converted(false, converted);
    let r = Report {
        duration: Some(30.0),
        ..report("playing")
    };
    let state = tracker.update(&r, Instant::now());
    assert_eq!(state.position, 612.0);
    assert_eq!(state.duration, 5400.0);
    // A live conversion has no length, and a negative offset is none.
    let mut live = Tracker::converted(
        true,
        Converted {
            offset: -5.0,
            duration: Some(10.0),
        },
    );
    let state = live.update(&report("playing"), Instant::now());
    assert_eq!(state.position, 12.0);
    assert_eq!(state.duration, 0.0);
    // A length that went wrong reads as none.
    let mut odd = Tracker::converted(
        false,
        Converted {
            offset: 0.0,
            duration: Some(-1.0),
        },
    );
    assert_eq!(odd.update(&report("playing"), Instant::now()).duration, 0.0);
}

#[test]
fn a_converted_stream_without_a_length_uses_avplayers() {
    let mut tracker = Tracker::converted(
        false,
        Converted {
            offset: 10.0,
            duration: None,
        },
    );
    assert_eq!(
        tracker.update(&report("playing"), Instant::now()).duration,
        3600.0
    );
}

#[test]
fn a_failed_conversion_ends_the_item_where_it_was() {
    let airplay = AirPlay::default();
    let now = Instant::now();
    airplay.begin(Tracker::new(false));
    let playing = airplay.report(&report("playing"), now).unwrap();
    let failed = airplay.fail("refused");
    assert_eq!(failed.status, Status::Error);
    assert_eq!(
        failed.error,
        Some(PlaybackError {
            code: "refused",
            unsupported: false,
            not_picked: false,
        })
    );
    // Everything else stays as AVPlayer last had it.
    assert_eq!(failed.position, playing.position);
    assert_eq!(failed.duration, playing.duration);
    assert_eq!(airplay.state(), failed);
    // AVPlayer playing out what it has doesn't hide the failure.
    assert_eq!(airplay.report(&report("playing"), now), None);
    assert_eq!(airplay.state(), failed);
}

#[test]
fn a_failure_with_nothing_tracked_starts_from_idle() {
    let airplay = AirPlay::default();
    let failed = airplay.fail("failed");
    assert_eq!(
        failed,
        AirPlayState {
            status: Status::Error,
            error: Some(PlaybackError {
                code: "failed",
                unsupported: false,
                not_picked: false,
            }),
            ..AirPlayState::idle()
        }
    );
}

#[test]
fn emits_a_failed_conversion() {
    let app = TestApp::new();
    let events = app.record(&[EVENT_STATE]);
    let handle = app.handle();
    handle.state::<AirPlay>().begin(Tracker::new(true));
    fail_converted(&handle, "failed");
    let state = events.wait_for(EVENT_STATE);
    assert_eq!(state["status"], json!("error"));
    assert_eq!(state["error"], json!({ "code": "failed" }));
}

#[test]
fn a_receiver_that_never_took_the_video_ends_the_item_as_not_picked() {
    let airplay = AirPlay::default();
    let now = Instant::now();
    let load = airplay.begin(Tracker::new(false));
    let opening = airplay.report(&report("opening"), now).unwrap();
    let state = airplay.not_picked(load).unwrap();
    assert_eq!(state.status, Status::Error);
    assert_eq!(
        state.error,
        Some(PlaybackError {
            code: "openFailed",
            unsupported: false,
            not_picked: true,
        })
    );
    assert_eq!(state.position, opening.position);
    // Nothing tracked now, so a late report changes nothing.
    assert_eq!(airplay.report(&report("playing"), now), None);
    assert_eq!(airplay.state(), state);
    assert_eq!(airplay.not_picked(load), None);
}

#[test]
fn no_pick_for_an_earlier_load_leaves_the_new_one_playing() {
    let airplay = AirPlay::default();
    let now = Instant::now();
    let first = airplay.begin(Tracker::new(false));
    let second = airplay.begin(Tracker::new(false));
    assert_ne!(first, second);
    assert_eq!(airplay.not_picked(first), None);
    let playing = airplay.report(&report("playing"), now).unwrap();
    assert_eq!(playing.status, Status::Playing);
    assert_eq!(airplay.not_picked(second).unwrap().status, Status::Error);
}

#[test]
fn drops_a_report_about_an_earlier_load() {
    let airplay = AirPlay::default();
    let now = Instant::now();
    let first = airplay.begin(Tracker::new(false));
    let second = airplay.begin(Tracker::new(false));
    // The old item had played on, and the new one is still opening.
    assert_eq!(
        airplay.report_from(Some(first), &report("playing"), now),
        None
    );
    assert_eq!(airplay.state(), AirPlayState::idle());
    let state = airplay.report_from(Some(second), &report("playing"), now);
    assert_eq!(state.unwrap().status, Status::Playing);
    // A report without a load, as Swift's are, is about the item tracked.
    assert_eq!(
        airplay.report(&report("paused"), now).unwrap().status,
        Status::Paused
    );
}

#[test]
fn emits_a_report_about_the_load_tracked_only() {
    let app = TestApp::new();
    let events = app.record(&[EVENT_STATE]);
    let app_handle = app.handle();
    let first = app_handle.state::<AirPlay>().begin(Tracker::new(false));
    let second = app_handle.state::<AirPlay>().begin(Tracker::new(false));
    handle_from(&app_handle, first, &report("paused"), Instant::now());
    handle_from(&app_handle, second, &report("playing"), Instant::now());
    let state = events.wait_for(EVENT_STATE);
    assert_eq!(state["status"], json!("playing"));
    assert_eq!(events.payloads(EVENT_STATE).len(), 1);
}

#[test]
fn a_mac_shows_opening_at_the_start_until_the_video_is_on_a_receiver() {
    let now = Instant::now();
    let converted = Converted {
        offset: 600.0,
        duration: Some(5400.0),
    };
    let mut tracker = Tracker::converted(false, converted).awaiting_receiver();
    let here = Report {
        position: 4.0,
        duration: Some(30.0),
        external: false,
        ..report("playing")
    };
    let state = tracker.update(&here, now);
    assert_eq!(state.status, Status::Opening);
    // Where it started, so no resume point moves on while it plays here.
    assert_eq!(state.position, 600.0);
    assert_eq!(state.duration, 5400.0);
    let there = Report {
        external: true,
        ..here.clone()
    };
    let state = tracker.update(&there, now);
    assert_eq!(state.status, Status::Playing);
    assert_eq!(state.position, 604.0);
    // A failure shows while it waits too.
    let mut tracker = Tracker::new(false).awaiting_receiver();
    let failed = Report {
        external: false,
        ..failed("AVFoundationErrorDomain", -11800, None)
    };
    let failed = tracker.update(&failed, now);
    assert_eq!(failed.status, Status::Error);
    // Elsewhere the receiver's position counts from the start.
    let mut tracker = Tracker::new(false);
    let state = tracker.update(&here, now);
    assert_eq!((state.status, state.position), (Status::Playing, 4.0));
}

#[test]
fn a_mac_that_waits_for_a_receiver_isnt_ready_yet() {
    // Waiting that long while opening is lost, but never reconnecting,
    // since the item never got ready as far as the tracker knows.
    let now = Instant::now();
    let here = Report {
        external: false,
        ..report("playing")
    };
    let mut tracker = Tracker::new(false).awaiting_receiver();
    tracker.update(&here, now);
    let later = tracker.update(&here, now + secs(15));
    assert_eq!(later.connection, Connection::Connected);
}

#[test]
fn emits_a_pick_that_found_no_receiver() {
    let app = TestApp::new();
    let events = app.record(&[EVENT_STATE, EVENT_ROUTE]);
    let handle = app.handle();
    let load = handle.state::<AirPlay>().begin(Tracker::new(false));
    // Nothing about an earlier load.
    assert!(!not_picked(&handle, load - 1));
    assert!(not_picked(&handle, load));
    // The route went with the pick.
    assert_eq!(events.wait_for(EVENT_ROUTE), json!(null));
    let state = events.wait_for(EVENT_STATE);
    assert_eq!(events.payloads(EVENT_STATE).len(), 1);
    assert_eq!(state["status"], json!("error"));
    assert_eq!(
        state["error"],
        json!({ "code": "openFailed", "notPicked": true })
    );
}

#[test]
fn emits_the_state_of_a_report_given_as_it_is() {
    let app = TestApp::new();
    let events = app.record(&[EVENT_STATE]);
    let app_handle = app.handle();
    app_handle.state::<AirPlay>().begin(Tracker::new(false));
    handle(&app_handle, &report("playing"), Instant::now());
    let state = events.wait_for(EVENT_STATE);
    assert_eq!(state["status"], json!("playing"));
}
