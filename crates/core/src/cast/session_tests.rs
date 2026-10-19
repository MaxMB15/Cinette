// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::frame::{CastMessage, FrameError, Payload};
use super::message::{
    LoadRequest, MediaTrack, StreamType, TextTrack, NS_CONNECTION, NS_HEARTBEAT, NS_MEDIA,
    NS_RECEIVER,
};
use super::session::{
    CloseReason, CommandError, Event, IdleReason, MediaState, Output, PlayerState, Session, Volume,
    LAUNCH_TIMEOUT, LOAD_TIMEOUT, PING_INTERVAL, SILENCE_LIMIT, STATUS_INTERVAL,
};

const SENDER: &str = "sender-1";

/// A command's request id and frame.
type Sent = (u64, Vec<u8>);

/// A frame from `source` to this sender.
fn from(source: &str, namespace: &str, body: Value) -> Vec<u8> {
    CastMessage::text(source, SENDER, namespace, body.to_string()).encode()
}

/// Each frame as (destination, namespace, JSON).
fn sent(frames: &[Vec<u8>]) -> Vec<(String, String, Value)> {
    frames
        .iter()
        .map(|f| {
            let message = CastMessage::decode(&f[4..]).unwrap();
            assert_eq!(message.source, SENDER);
            let Payload::Text(text) = message.payload else {
                panic!("binary frame")
            };
            (
                message.destination,
                message.namespace,
                serde_json::from_str(&text).unwrap(),
            )
        })
        .collect()
}

fn types(frames: &[Vec<u8>]) -> Vec<String> {
    sent(frames)
        .into_iter()
        .map(|(to, _, body)| format!("{to} {}", body["type"].as_str().unwrap()))
        .collect()
}

fn receiver_status(apps: Value) -> Vec<u8> {
    from(
        "receiver-0",
        NS_RECEIVER,
        json!({ "type": "RECEIVER_STATUS", "requestId": 0,
                "status": { "applications": apps, "volume": { "level": 0.5, "muted": false } } }),
    )
}

fn dmr(session: &str) -> Value {
    json!([{ "appId": "CC1AD845", "sessionId": session, "transportId": "t1", "displayName": "Default Media Receiver" }])
}

fn media_status(request_id: u64, entries: Value) -> Vec<u8> {
    from(
        "t1",
        NS_MEDIA,
        json!({ "type": "MEDIA_STATUS", "requestId": request_id, "status": entries }),
    )
}

fn playing(id: i64, time: f64) -> Value {
    json!([{ "mediaSessionId": id, "playerState": "PLAYING", "currentTime": time,
             "supportedMediaCommands": 15,
             "media": { "duration": 3600.0, "streamType": "BUFFERED", "tracks": [] } }])
}

fn load_request() -> LoadRequest {
    LoadRequest {
        url: "http://host/movie/user/secret/1.mp4".into(),
        content_type: "video/mp4".into(),
        stream_type: StreamType::Buffered,
        hls_ts_segments: false,
        title: "A film".into(),
        image: None,
        start_at: Some(42.5),
        text_tracks: vec![],
        active_track_ids: vec![],
    }
}

/// A session whose receiver app is ready, at `now`.
fn ready(now: Instant) -> Session {
    let (mut session, _) = Session::start(SENDER.into(), now);
    let out = session.receive(&receiver_status(dmr("s1")), now);
    assert!(out.events.contains(&Event::Ready {
        session_id: "s1".into()
    }));
    session
}

/// A ready session that's playing media 7.
fn with_media(now: Instant) -> Session {
    let mut session = ready(now);
    session.receive(&media_status(0, playing(7, 10.0)), now);
    session
}

fn media_event(out: &Output) -> MediaState {
    out.events
        .iter()
        .find_map(|e| match e {
            Event::Media(Some(m)) => Some(m.clone()),
            _ => None,
        })
        .expect("a media event")
}

#[test]
fn starts_by_connecting_and_asking_for_the_status() {
    let (session, first) = Session::start(SENDER.into(), Instant::now());
    let first = sent(&first);
    assert_eq!(first[0].0, "receiver-0");
    assert_eq!(first[0].1, NS_CONNECTION);
    assert_eq!(first[0].2["type"], "CONNECT");
    assert_eq!(first[1].1, NS_RECEIVER);
    assert_eq!(first[1].2, json!({ "type": "GET_STATUS", "requestId": 1 }));
    assert!(session.session_id().is_none());
    assert!(!session.is_closed());
}

#[test]
fn launches_the_default_media_receiver_then_loads() {
    let now = Instant::now();
    let (mut session, _) = Session::start(SENDER.into(), now);
    let queued = session.load(load_request(), now).unwrap();
    assert!(queued.send.is_empty());

    let out = session.receive(&receiver_status(json!([])), now);
    let launch = sent(&out.send);
    assert_eq!(launch.len(), 1);
    assert_eq!(launch[0].2["type"], "LAUNCH");
    assert_eq!(launch[0].2["appId"], "CC1AD845");
    assert_eq!(
        out.events,
        vec![Event::Volume(Volume {
            level: 0.5,
            muted: false,
            fixed: false
        })]
    );

    // A status from before the launch took effect changes nothing.
    let out = session.receive(
        &receiver_status(json!([{ "appId": "OTHER", "sessionId": "x", "transportId": "y" }])),
        now,
    );
    assert!(out.send.is_empty());

    let out = session.receive(&receiver_status(dmr("s1")), now);
    assert_eq!(
        out.events[1],
        Event::Ready {
            session_id: "s1".into()
        }
    );
    assert_eq!(
        types(&out.send),
        vec!["t1 CONNECT", "t1 GET_STATUS", "t1 LOAD"]
    );
    assert_eq!(session.session_id(), Some("s1"));
}

#[test]
fn joins_a_receiver_app_that_already_runs() {
    let now = Instant::now();
    let (mut session, _) = Session::start(SENDER.into(), now);
    let out = session.receive(&receiver_status(dmr("s1")), now);
    assert_eq!(types(&out.send), vec!["t1 CONNECT", "t1 GET_STATUS"]);
    // Once ready, a load goes straight out.
    let out = session.load(load_request(), now).unwrap();
    assert_eq!(types(&out.send), vec!["t1 LOAD"]);
}

#[test]
fn a_launch_error_or_timeout_ends_the_session() {
    let now = Instant::now();
    let (mut session, _) = Session::start(SENDER.into(), now);
    session.receive(&receiver_status(json!([])), now);
    let out = session.receive(
        &from(
            "receiver-0",
            NS_RECEIVER,
            json!({ "type": "LAUNCH_ERROR", "reason": "NOT_FOUND" }),
        ),
        now,
    );
    assert_eq!(
        out.events,
        vec![Event::Closed(CloseReason::LaunchFailed(Some(
            "NOT_FOUND".into()
        )))]
    );
    assert!(session.is_closed());

    let (mut session, _) = Session::start(SENDER.into(), now);
    session.receive(&receiver_status(json!([])), now);
    // Keep the connection alive with pongs while the launch takes too long.
    let later = now + LAUNCH_TIMEOUT - Duration::from_millis(1);
    session.receive(
        &from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" })),
        later,
    );
    assert!(session.tick(later).events.is_empty());
    let out = session.tick(now + LAUNCH_TIMEOUT);
    assert_eq!(
        out.events,
        vec![Event::Closed(CloseReason::LaunchFailed(None))]
    );
}

#[test]
fn rejoins_only_the_same_receiver_app() {
    let now = Instant::now();
    let (mut session, _) = Session::rejoin(SENDER.into(), "s1".into(), now);
    let out = session.receive(&receiver_status(dmr("s1")), now);
    assert_eq!(types(&out.send), vec!["t1 CONNECT", "t1 GET_STATUS"]);

    let (mut session, _) = Session::rejoin(SENDER.into(), "s1".into(), now);
    let out = session.receive(&receiver_status(dmr("s2")), now);
    assert_eq!(
        out.events.last(),
        Some(&Event::Closed(CloseReason::AppStopped))
    );
    assert!(out.send.is_empty());

    let (mut session, _) = Session::rejoin(SENDER.into(), "s1".into(), now);
    let out = session.receive(&receiver_status(json!([])), now);
    assert_eq!(
        out.events.last(),
        Some(&Event::Closed(CloseReason::AppStopped))
    );
}

#[test]
fn the_load_message_carries_only_what_playback_needs() {
    let now = Instant::now();
    let mut session = ready(now);
    let mut request = load_request();
    request.image = Some("http://logos.example/a.png".into());
    request.text_tracks = vec![TextTrack {
        id: 1,
        url: "http://192.168.1.5:4000/cast/abc/subs.vtt".into(),
        content_type: "text/vtt".into(),
        name: "English".into(),
        language: Some("en".into()),
    }];
    request.active_track_ids = vec![1];
    let out = session.load(request, now).unwrap();
    let (_, namespace, load) = sent(&out.send).remove(0);
    assert_eq!(namespace, NS_MEDIA);
    assert_eq!(
        load,
        json!({
            "type": "LOAD", "requestId": 3, "autoplay": true, "currentTime": 42.5,
            "activeTrackIds": [1],
            "media": {
                "contentId": "http://host/movie/user/secret/1.mp4",
                "contentUrl": "http://host/movie/user/secret/1.mp4",
                "contentType": "video/mp4",
                "streamType": "BUFFERED",
                "metadata": { "metadataType": 0, "title": "A film",
                              "images": [{ "url": "http://logos.example/a.png" }] },
                "tracks": [{ "trackId": 1, "type": "TEXT", "subtype": "SUBTITLES",
                             "trackContentId": "http://192.168.1.5:4000/cast/abc/subs.vtt",
                             "trackContentType": "text/vtt", "name": "English", "language": "en" }]
            }
        })
    );
}

#[test]
fn live_hls_with_ts_segments_says_so_and_never_seeks() {
    let now = Instant::now();
    let mut session = ready(now);
    let request = LoadRequest {
        url: "http://host/live/u/p/1.m3u8".into(),
        content_type: "application/x-mpegurl".into(),
        stream_type: StreamType::Live,
        hls_ts_segments: true,
        start_at: Some(30.0),
        text_tracks: vec![TextTrack {
            id: 2,
            url: "u".into(),
            content_type: "text/vtt".into(),
            name: "n".into(),
            language: None,
        }],
        ..load_request()
    };
    let out = session.load(request, now).unwrap();
    let load = &sent(&out.send)[0].2;
    assert_eq!(load["media"]["streamType"], "LIVE");
    assert_eq!(load["media"]["hlsSegmentFormat"], "ts");
    assert_eq!(load["media"]["hlsVideoSegmentFormat"], "mpeg2_ts");
    assert!(load.get("currentTime").is_none());
    assert!(load["media"]["metadata"].get("images").is_none());
    assert!(load["media"]["tracks"][0].get("language").is_none());
}

#[test]
fn a_load_request_hides_its_urls_when_printed() {
    let mut request = load_request();
    request.text_tracks.push(TextTrack {
        id: 1,
        url: "http://192.168.1.5/cast/token/subs.vtt".into(),
        content_type: "text/vtt".into(),
        name: "n".into(),
        language: None,
    });
    let shown = format!("{request:?}");
    assert!(!shown.contains("secret"), "{shown}");
    assert!(!shown.contains("token"), "{shown}");
    assert!(shown.contains("A film"));
}

#[test]
fn reads_the_media_status() {
    let now = Instant::now();
    let mut session = ready(now);
    let out = session.receive(
        &media_status(
            0,
            json!([{ "mediaSessionId": 7, "playerState": "PAUSED", "currentTime": 12.5,
                     "supportedMediaCommands": 1, "activeTrackIds": [2],
                     "media": { "duration": 100.0, "streamType": "BUFFERED",
                                "tracks": [{ "trackId": 2, "type": "AUDIO", "name": "English", "language": "en" }] } }]),
        ),
        now,
    );
    assert_eq!(
        media_event(&out),
        MediaState {
            media_session_id: 7,
            player: PlayerState::Paused,
            current_time: 12.5,
            duration: Some(100.0),
            live: false,
            can_pause: true,
            can_seek: false,
            tracks: vec![MediaTrack {
                track_id: 2,
                kind: "AUDIO".into(),
                name: Some("English".into()),
                language: Some("en".into()),
            }],
            active_track_ids: vec![2],
        }
    );

    // A later status without `media` or tracks keeps what the last one said.
    let out = session.receive(
        &media_status(0, json!([{ "mediaSessionId": 7, "playerState": "PLAYING", "currentTime": 13.0, "supportedMediaCommands": 3 }])),
        now,
    );
    let state = media_event(&out);
    assert_eq!(state.player, PlayerState::Playing);
    assert_eq!(state.duration, Some(100.0));
    assert!(!state.live);
    assert_eq!(state.tracks.len(), 1);
    assert_eq!(state.active_track_ids, vec![2]);
    assert!(state.can_seek);

    // New media starts from nothing.
    let out = session.receive(
        &media_status(
            0,
            json!([{ "mediaSessionId": 8, "playerState": "BUFFERING" }]),
        ),
        now,
    );
    let state = media_event(&out);
    assert_eq!(state.duration, None);
    assert!(state.tracks.is_empty());
    assert!(state.active_track_ids.is_empty());
    assert!(!state.can_pause);
}

#[test]
fn a_live_stream_has_no_duration() {
    let now = Instant::now();
    let mut session = ready(now);
    let out = session.receive(
        &media_status(0, json!([{ "mediaSessionId": 1, "playerState": "PLAYING", "media": { "duration": -1.0, "streamType": "LIVE" } }])),
        now,
    );
    let state = media_event(&out);
    assert!(state.live);
    assert_eq!(state.duration, None);
    let out = session.receive(
        &media_status(
            0,
            json!([{ "mediaSessionId": 1, "playerState": "PLAYING" }]),
        ),
        now,
    );
    assert!(media_event(&out).live);
    // A duration of 0 means none for a file too.
    let out = session.receive(
        &media_status(0, json!([{ "mediaSessionId": 2, "playerState": "PLAYING", "media": { "duration": 0.0 } }])),
        now,
    );
    assert_eq!(media_event(&out).duration, None);
}

#[test]
fn reads_each_player_state() {
    let now = Instant::now();
    let mut session = ready(now);
    let cases = [
        ("PLAYING", None, PlayerState::Playing),
        ("PAUSED", None, PlayerState::Paused),
        ("BUFFERING", None, PlayerState::Buffering),
        ("LOADING", None, PlayerState::Buffering),
        (
            "IDLE",
            Some("FINISHED"),
            PlayerState::Idle(IdleReason::Finished),
        ),
        (
            "IDLE",
            Some("CANCELLED"),
            PlayerState::Idle(IdleReason::Cancelled),
        ),
        (
            "IDLE",
            Some("INTERRUPTED"),
            PlayerState::Idle(IdleReason::Interrupted),
        ),
        ("IDLE", Some("ERROR"), PlayerState::Idle(IdleReason::Error)),
        ("IDLE", None, PlayerState::Idle(IdleReason::None)),
    ];
    for (state, reason, expected) in cases {
        let out = session.receive(
            &media_status(
                0,
                json!([{ "mediaSessionId": 1, "playerState": state, "idleReason": reason }]),
            ),
            now,
        );
        assert_eq!(media_event(&out).player, expected, "{state} {reason:?}");
    }
    let out = session.receive(&media_status(0, json!([])), now);
    assert_eq!(out.events, vec![Event::Media(None)]);
    assert_eq!(session.play(), Err(CommandError::NoMedia));
}

#[test]
fn reports_a_failed_load_once() {
    let now = Instant::now();
    let mut session = ready(now);
    let out = session.load(load_request(), now).unwrap();
    let id = sent(&out.send)[0].2["requestId"].as_u64().unwrap();
    // Another request's failure isn't the load's.
    let failed = |id: u64| {
        from(
            "t1",
            NS_MEDIA,
            json!({ "type": "LOAD_FAILED", "requestId": id, "detailedErrorCode": 104 }),
        )
    };
    assert!(session.receive(&failed(id + 1), now).events.is_empty());
    let out = session.receive(&failed(id), now);
    assert_eq!(
        out.events,
        vec![Event::LoadFailed {
            detailed_error_code: Some(104)
        }]
    );
    assert!(session.receive(&failed(id), now).events.is_empty());
    // And it doesn't time out afterwards.
    session.receive(
        &from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" })),
        now + LOAD_TIMEOUT,
    );
    assert!(session.tick(now + LOAD_TIMEOUT).events.is_empty());
}

#[test]
fn a_load_without_an_answer_times_out() {
    let now = Instant::now();
    let mut session = ready(now);
    session.load(load_request(), now).unwrap();
    let keep_alive = |s: &mut Session, at| {
        s.receive(
            &from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" })),
            at,
        );
    };
    let before = now + LOAD_TIMEOUT - Duration::from_millis(1);
    keep_alive(&mut session, before);
    assert!(session.tick(before).events.is_empty());
    keep_alive(&mut session, now + LOAD_TIMEOUT);
    let out = session.tick(now + LOAD_TIMEOUT);
    assert_eq!(
        out.events,
        vec![Event::LoadFailed {
            detailed_error_code: None
        }]
    );
    keep_alive(&mut session, now + LOAD_TIMEOUT * 2);
    assert!(session.tick(now + LOAD_TIMEOUT * 2).events.is_empty());
}

#[test]
fn a_status_answers_the_load() {
    let now = Instant::now();
    let later = now + LOAD_TIMEOUT;
    let pong = from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" }));

    // The answer to the load request.
    let mut session = with_media(now);
    let id = sent(&session.load(load_request(), now).unwrap().send)[0].2["requestId"]
        .as_u64()
        .unwrap();
    session.receive(
        &media_status(id, json!([{ "mediaSessionId": 8, "playerState": "IDLE" }])),
        now,
    );
    session.receive(&pong, later);
    assert!(session.tick(later).events.is_empty());

    // New media playing, reported without the request id.
    let mut session = with_media(now);
    session.load(load_request(), now).unwrap();
    session.receive(&media_status(0, playing(8, 0.0)), now);
    session.receive(&pong, later);
    assert!(session.tick(later).events.is_empty());

    // The media from before the load, still playing, isn't an answer.
    let mut session = with_media(now);
    session.load(load_request(), now).unwrap();
    session.receive(&media_status(0, playing(7, 11.0)), now);
    session.receive(&pong, later);
    assert_eq!(
        session.tick(later).events,
        vec![Event::LoadFailed {
            detailed_error_code: None
        }]
    );

    // Nor is new media that's idle.
    let mut session = ready(now);
    session.load(load_request(), now).unwrap();
    session.receive(
        &media_status(0, json!([{ "mediaSessionId": 9, "playerState": "IDLE" }])),
        now,
    );
    session.receive(&pong, later);
    assert_eq!(
        session.tick(later).events,
        vec![Event::LoadFailed {
            detailed_error_code: None
        }]
    );
}

#[test]
fn a_cancelled_load_ends_quietly() {
    let now = Instant::now();
    let later = now + LOAD_TIMEOUT;
    let pong = from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" }));
    let cancel = |source: &str, id: u64| {
        from(
            source,
            NS_MEDIA,
            json!({ "type": "LOAD_CANCELLED", "requestId": id }),
        )
    };
    let load = |session: &mut Session| {
        sent(&session.load(load_request(), now).unwrap().send)[0].2["requestId"]
            .as_u64()
            .unwrap()
    };

    let mut session = ready(now);
    let id = load(&mut session);
    assert!(session.receive(&cancel("t1", id), now).events.is_empty());
    session.receive(&pong, later);
    assert!(session.tick(later).events.is_empty());

    // Another request's cancellation, or one from outside the app, isn't the load's.
    for (source, other) in [("t1", 1), ("t9", 0)] {
        let mut session = ready(now);
        let id = load(&mut session);
        session.receive(&cancel(source, id + other), now);
        session.receive(&pong, later);
        assert_eq!(
            session.tick(later).events,
            vec![Event::LoadFailed {
                detailed_error_code: None
            }],
            "{source}"
        );
    }
}

#[test]
fn only_the_app_reports_load_and_playback_failures() {
    let now = Instant::now();
    let mut session = with_media(now);
    let id = sent(&session.load(load_request(), now).unwrap().send)[0].2["requestId"]
        .as_u64()
        .unwrap();
    for body in [
        json!({ "type": "LOAD_FAILED", "requestId": id }),
        json!({ "type": "ERROR", "detailedErrorCode": 103 }),
        json!({ "type": "INVALID_REQUEST", "requestId": 9 }),
    ] {
        let out = session.receive(&from("t9", NS_MEDIA, body.clone()), now);
        assert!(out.events.is_empty(), "{body}");
    }
    // The load is still waiting for its answer.
    let out = session.receive(
        &from(
            "t1",
            NS_MEDIA,
            json!({ "type": "LOAD_FAILED", "requestId": id }),
        ),
        now,
    );
    assert_eq!(
        out.events,
        vec![Event::LoadFailed {
            detailed_error_code: None
        }]
    );
}

#[test]
fn media_commands_go_to_the_app_with_the_media_session() {
    let now = Instant::now();
    let mut session = with_media(now);
    let checks: [(Result<Sent, CommandError>, Value); 4] = [
        (session.play(), json!({ "type": "PLAY" })),
        (session.pause(), json!({ "type": "PAUSE" })),
        (
            session.seek(90.5),
            json!({ "type": "SEEK", "currentTime": 90.5 }),
        ),
        (
            session.set_tracks(&[1, 3]),
            json!({ "type": "EDIT_TRACKS_INFO", "activeTrackIds": [1, 3] }),
        ),
    ];
    let mut last = 0;
    for (result, mut expected) in checks {
        let (id, frame) = result.unwrap();
        assert!(id > last);
        last = id;
        expected["mediaSessionId"] = json!(7);
        expected["requestId"] = json!(id);
        let (to, namespace, body) = sent(&[frame]).remove(0);
        assert_eq!((to.as_str(), namespace.as_str()), ("t1", NS_MEDIA));
        assert_eq!(body, expected);
    }
}

#[test]
fn commands_wait_for_the_app_and_the_media() {
    let now = Instant::now();
    let (mut session, _) = Session::start(SENDER.into(), now);
    assert_eq!(session.play(), Err(CommandError::NotReady));
    // The receiver's volume doesn't need the app.
    assert!(session.set_volume(0.3).is_ok());
    session.receive(&receiver_status(dmr("s1")), now);
    assert_eq!(session.pause(), Err(CommandError::NoMedia));
    session.stop();
    assert_eq!(session.play(), Err(CommandError::Closed));
    assert_eq!(session.set_volume(0.3), Err(CommandError::Closed));
    assert_eq!(session.load(load_request(), now), Err(CommandError::Closed));
}

#[test]
fn sets_the_receivers_volume_between_0_and_1() {
    let now = Instant::now();
    let mut session = ready(now);
    for (asked, sent_level) in [(0.25, 0.25), (1.5, 1.0), (-1.0, 0.0)] {
        let (_, frame) = session.set_volume(asked).unwrap();
        let (to, namespace, body) = sent(&[frame]).remove(0);
        assert_eq!(
            (to.as_str(), namespace.as_str()),
            ("receiver-0", NS_RECEIVER)
        );
        assert_eq!(body["type"], "SET_VOLUME");
        assert_eq!(body["volume"], json!({ "level": sent_level }));
    }
}

#[test]
fn reads_a_fixed_volume() {
    let now = Instant::now();
    let (mut session, _) = Session::start(SENDER.into(), now);
    let status = from(
        "receiver-0",
        NS_RECEIVER,
        json!({ "type": "RECEIVER_STATUS", "status": { "applications": dmr("s1"),
                "volume": { "level": 1.0, "muted": true, "controlType": "fixed" } } }),
    );
    let out = session.receive(&status, now);
    assert_eq!(
        out.events[0],
        Event::Volume(Volume {
            level: 1.0,
            muted: true,
            fixed: true
        })
    );
    // A status without the volume reports none, and one without the level is full.
    let out = session.receive(
        &from(
            "receiver-0",
            NS_RECEIVER,
            json!({ "type": "RECEIVER_STATUS", "status": { "applications": dmr("s1") } }),
        ),
        now,
    );
    assert!(out.events.is_empty());
    let out = session.receive(
        &from("receiver-0", NS_RECEIVER, json!({ "type": "RECEIVER_STATUS", "status": { "applications": dmr("s1"), "volume": {} } })),
        now,
    );
    assert_eq!(
        out.events,
        vec![Event::Volume(Volume {
            level: 1.0,
            muted: false,
            fixed: false
        })]
    );
}

#[test]
fn answers_pings_and_pings_every_five_seconds() {
    let now = Instant::now();
    let mut session = ready(now);
    let out = session.receive(
        &from("receiver-0", NS_HEARTBEAT, json!({ "type": "PING" })),
        now,
    );
    let pong = sent(&out.send);
    assert_eq!(pong[0].0, "receiver-0");
    assert_eq!(pong[0].2, json!({ "type": "PONG" }));

    let almost = now + PING_INTERVAL - Duration::from_millis(1);
    assert!(session.tick(almost).send.is_empty());
    let out = session.tick(now + PING_INTERVAL);
    assert_eq!(sent(&out.send)[0].2, json!({ "type": "PING" }));
    assert!(session.tick(now + PING_INTERVAL).send.is_empty());
}

#[test]
fn ten_quiet_seconds_end_the_session() {
    let now = Instant::now();
    let mut session = ready(now);
    let almost = now + SILENCE_LIMIT - Duration::from_millis(1);
    assert!(session.tick(almost).events.is_empty());
    // Anything received starts the count again.
    session.receive(
        &from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" })),
        almost,
    );
    assert!(session.tick(now + SILENCE_LIMIT).events.is_empty());
    let out = session.tick(almost + SILENCE_LIMIT);
    assert_eq!(out.events, vec![Event::Closed(CloseReason::Timeout)]);
    assert!(out.send.is_empty());
    assert!(session.tick(almost + SILENCE_LIMIT * 2).events.is_empty());
}

#[test]
fn asks_for_the_status_while_playing() {
    let now = Instant::now();
    let mut session = with_media(now);
    let pong = from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" }));
    let at = now + STATUS_INTERVAL;
    session.receive(&pong, at);
    let out = session.tick(at);
    assert!(types(&out.send).contains(&"t1 GET_STATUS".to_string()));
    let almost = at + STATUS_INTERVAL - Duration::from_millis(1);
    session.receive(&pong, almost);
    assert!(!types(&session.tick(almost).send).contains(&"t1 GET_STATUS".to_string()));

    // Not while paused.
    let paused = json!([{ "mediaSessionId": 7, "playerState": "PAUSED" }]);
    session.receive(&media_status(0, paused), almost);
    let later = at + STATUS_INTERVAL * 2;
    session.receive(&pong, later);
    assert!(!types(&session.tick(later).send).contains(&"t1 GET_STATUS".to_string()));
}

#[test]
fn the_receiver_app_going_away_ends_the_session() {
    let now = Instant::now();
    // Another app took over.
    let mut session = with_media(now);
    let other = json!([{ "appId": "233637DE", "sessionId": "yt", "transportId": "t9" }]);
    let out = session.receive(&receiver_status(other), now);
    assert_eq!(
        out.events.last(),
        Some(&Event::Closed(CloseReason::AppStopped))
    );

    // The same app, a new session: someone else launched it again.
    let mut session = with_media(now);
    let out = session.receive(&receiver_status(dmr("s2")), now);
    assert_eq!(
        out.events.last(),
        Some(&Event::Closed(CloseReason::AppStopped))
    );

    // The same session is fine.
    let mut session = with_media(now);
    let out = session.receive(&receiver_status(dmr("s1")), now);
    assert!(!session.is_closed());
    assert_eq!(out.events.len(), 1);

    // The app closed its connection to this sender.
    let mut session = with_media(now);
    let close = |source: &str| from(source, NS_CONNECTION, json!({ "type": "CLOSE" }));
    assert!(session.receive(&close("t9"), now).events.is_empty());
    let out = session.receive(&close("t1"), now);
    assert_eq!(out.events, vec![Event::Closed(CloseReason::AppStopped)]);

    // The receiver closed it.
    let mut session = with_media(now);
    let out = session.receive(&close("receiver-0"), now);
    assert_eq!(out.events, vec![Event::Closed(CloseReason::AppStopped)]);
}

#[test]
fn stop_ends_everything() {
    let now = Instant::now();
    let mut session = with_media(now);
    let out = session.stop();
    let frames = sent(&out.send);
    assert_eq!(
        types(&out.send),
        vec!["t1 STOP", "receiver-0 STOP", "t1 CLOSE", "receiver-0 CLOSE"]
    );
    assert_eq!(frames[0].2["mediaSessionId"], 7);
    assert_eq!(frames[1].2["sessionId"], "s1");
    assert_eq!(out.events, vec![Event::Closed(CloseReason::Stopped)]);
    assert!(session.is_closed());
    assert_eq!(session.stop(), Output::default());
    assert_eq!(
        session.receive(&receiver_status(dmr("s1")), now),
        Output::default()
    );
    assert_eq!(session.tick(now + SILENCE_LIMIT), Output::default());

    // Before anything loaded, only the app stops.
    let mut session = ready(now);
    assert_eq!(
        types(&session.stop().send),
        vec!["receiver-0 STOP", "t1 CLOSE", "receiver-0 CLOSE"]
    );
    // Before the app is ready, only the connection closes.
    let (mut session, _) = Session::start(SENDER.into(), now);
    assert_eq!(types(&session.stop().send), vec!["receiver-0 CLOSE"]);
}

#[test]
fn ignores_messages_meant_for_others_or_from_the_wrong_source() {
    let now = Instant::now();
    let mut session = ready(now);
    let elsewhere = CastMessage::text(
        "t1",
        "sender-2",
        NS_MEDIA,
        json!({ "type": "MEDIA_STATUS", "status": [] }).to_string(),
    );
    assert!(session.receive(&elsewhere.encode(), now).events.is_empty());
    // Media from something that isn't the app.
    let stranger = CastMessage::text(
        "t9",
        SENDER,
        NS_MEDIA,
        json!({ "type": "MEDIA_STATUS", "status": [] }).to_string(),
    );
    assert!(session.receive(&stranger.encode(), now).events.is_empty());
    // A receiver status from the app instead of the receiver.
    let fake = from(
        "t1",
        NS_RECEIVER,
        json!({ "type": "RECEIVER_STATUS", "status": { "applications": [] } }),
    );
    assert!(session.receive(&fake, now).events.is_empty());
    assert!(!session.is_closed());
    let fake = from("t1", NS_RECEIVER, json!({ "type": "LAUNCH_ERROR" }));
    assert!(session.receive(&fake, now).events.is_empty());
    // Before the app is ready, nothing counts as media.
    let (mut early, _) = Session::start(SENDER.into(), now);
    assert!(early
        .receive(&media_status(0, playing(1, 0.0)), now)
        .events
        .is_empty());
    // A broadcast counts.
    let broadcast = CastMessage::text(
        "t1",
        "*",
        NS_MEDIA,
        json!({ "type": "MEDIA_STATUS", "status": [] }).to_string(),
    );
    assert_eq!(
        session.receive(&broadcast.encode(), now).events,
        vec![Event::Media(None)]
    );
    // Binary payloads, unknown types and broken JSON are skipped.
    let binary = CastMessage {
        payload: Payload::Binary(vec![1]),
        ..CastMessage::text("t1", SENDER, NS_MEDIA, String::new())
    };
    assert!(session.receive(&binary.encode(), now).events.is_empty());
    assert!(session
        .receive(
            &from("t1", NS_MEDIA, json!({ "type": "QUEUE_CHANGE" })),
            now
        )
        .events
        .is_empty());
    let broken = CastMessage::text("t1", SENDER, NS_MEDIA, "{not json".into());
    assert!(session.receive(&broken.encode(), now).events.is_empty());
    let no_status = from("t1", NS_MEDIA, json!({ "type": "MEDIA_STATUS" }));
    assert!(session.receive(&no_status, now).events.is_empty());
    assert!(!session.is_closed());
}

#[test]
fn reports_playback_errors_and_rejected_commands() {
    let now = Instant::now();
    let mut session = with_media(now);
    let out = session.receive(
        &from(
            "t1",
            NS_MEDIA,
            json!({ "type": "ERROR", "detailedErrorCode": 103 }),
        ),
        now,
    );
    assert_eq!(
        out.events,
        vec![Event::PlaybackError {
            detailed_error_code: Some(103)
        }]
    );
    let out = session.receive(
        &from(
            "t1",
            NS_MEDIA,
            json!({ "type": "INVALID_REQUEST", "requestId": 9, "reason": "INVALID_COMMAND" }),
        ),
        now,
    );
    assert_eq!(
        out.events,
        vec![Event::Rejected {
            request_id: 9,
            reason: Some("INVALID_COMMAND".into())
        }]
    );
    let out = session.receive(
        &from(
            "t1",
            NS_MEDIA,
            json!({ "type": "INVALID_PLAYER_STATE", "requestId": 10 }),
        ),
        now,
    );
    assert_eq!(
        out.events,
        vec![Event::Rejected {
            request_id: 10,
            reason: None
        }]
    );
}

#[test]
fn a_broken_frame_ends_the_session() {
    let now = Instant::now();
    let mut session = ready(now);
    let mut bytes = media_status(0, playing(1, 0.0));
    // Followed by a frame whose body is a group field.
    bytes.extend_from_slice(&[0, 0, 0, 1, 0x0b]);
    bytes.extend_from_slice(&media_status(0, playing(2, 0.0)));
    let out = session.receive(&bytes, now);
    assert_eq!(out.events.len(), 2);
    assert_eq!(
        out.events[1],
        Event::Closed(CloseReason::Protocol(FrameError::WireType))
    );
    assert!(session.is_closed());
}

/// The request ids of a media `GET_STATUS` and a `LOAD` among `frames`.
fn status_and_load_ids(frames: &[Vec<u8>]) -> (u64, u64) {
    let sent = sent(frames);
    let id = |kind: &str| {
        sent.iter()
            .find(|(_, ns, body)| ns == NS_MEDIA && body["type"] == kind)
            .and_then(|(_, _, body)| body["requestId"].as_u64())
            .unwrap()
    };
    (id("GET_STATUS"), id("LOAD"))
}

#[test]
fn a_reply_to_another_request_doesnt_answer_the_load() {
    // The receiver already plays something when the session joins it, and
    // the load goes out with the media GET_STATUS.
    let now = Instant::now();
    let (mut session, _) = Session::start(SENDER.into(), now);
    session.load(load_request(), now).unwrap();
    let out = session.receive(&receiver_status(dmr("s1")), now);
    let (status_id, load_id) = status_and_load_ids(&out.send);
    session.receive(&media_status(status_id, playing(7, 10.0)), now);
    let failed = from(
        "t1",
        NS_MEDIA,
        json!({ "type": "LOAD_FAILED", "requestId": load_id, "detailedErrorCode": 104 }),
    );
    assert_eq!(
        session.receive(&failed, now).events,
        vec![Event::LoadFailed {
            detailed_error_code: Some(104)
        }]
    );
}

#[test]
fn a_load_the_receiver_turns_down_fails_at_once() {
    let now = Instant::now();
    let later = now + LOAD_TIMEOUT;
    let pong = from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" }));
    let load = |session: &mut Session| {
        sent(&session.load(load_request(), now).unwrap().send)[0].2["requestId"]
            .as_u64()
            .unwrap()
    };

    let mut session = with_media(now);
    let id = load(&mut session);
    let invalid = json!({ "type": "INVALID_REQUEST", "requestId": id, "reason": "INVALID_PARAMS" });
    assert_eq!(
        session.receive(&from("t1", NS_MEDIA, invalid), now).events,
        vec![Event::LoadFailed {
            detailed_error_code: None
        }]
    );
    // No second failure when the time runs out.
    session.receive(&pong, later);
    assert!(session.tick(later).events.is_empty());

    // An ERROR about the load fails it with its code.
    let mut session = with_media(now);
    let id = load(&mut session);
    let error = json!({ "type": "ERROR", "requestId": id, "detailedErrorCode": 110 });
    assert_eq!(
        session.receive(&from("t1", NS_MEDIA, error), now).events,
        vec![Event::LoadFailed {
            detailed_error_code: Some(110)
        }]
    );

    // Another request turned down, or an error in playback, is reported as
    // it is, and the load keeps waiting.
    let mut session = with_media(now);
    let id = load(&mut session);
    let other = json!({ "type": "INVALID_REQUEST", "requestId": id + 1, "reason": "X" });
    assert_eq!(
        session.receive(&from("t1", NS_MEDIA, other), now).events,
        vec![Event::Rejected {
            request_id: id + 1,
            reason: Some("X".into())
        }]
    );
    let playback = json!({ "type": "ERROR", "detailedErrorCode": 103 });
    assert_eq!(
        session.receive(&from("t1", NS_MEDIA, playback), now).events,
        vec![Event::PlaybackError {
            detailed_error_code: Some(103)
        }]
    );
    session.receive(&pong, later);
    assert_eq!(
        session.tick(later).events,
        vec![Event::LoadFailed {
            detailed_error_code: None
        }]
    );
}

#[test]
fn printing_the_output_hides_the_frames() {
    let now = Instant::now();
    let mut session = ready(now);
    let out = session.load(load_request(), now).unwrap();
    let printed = format!("{out:?}");
    assert!(printed.contains("send_sizes"), "{printed}");
    assert!(!printed.contains("secret"), "{printed}");
    // Not even as the bytes of "secret".
    assert!(!printed.contains("115, 101, 99"), "{printed}");
    assert_eq!(
        format!("{:?}", Output::default()),
        "Output { send_sizes: [], events: [] }"
    );
}

#[test]
fn a_receiver_that_never_gives_a_usable_status_times_out() {
    let now = Instant::now();
    let (mut session, _) = Session::start(SENDER.into(), now);
    let pong = from("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" }));
    let almost = now + LAUNCH_TIMEOUT - Duration::from_secs(1);
    session.receive(&pong, almost);
    assert!(session.tick(almost).events.is_empty());
    let late = now + LAUNCH_TIMEOUT;
    session.receive(&pong, late);
    assert_eq!(
        session.tick(late).events,
        vec![Event::Closed(CloseReason::Timeout)]
    );
}

#[test]
fn an_app_entry_it_cant_read_doesnt_hide_the_rest() {
    let now = Instant::now();
    let (mut session, _) = Session::start(SENDER.into(), now);
    let apps = json!([
        { "appId": "E8C28D3C", "displayName": "Backdrop" },
        { "appId": "CC1AD845", "sessionId": "s1", "transportId": "t1" }
    ]);
    let out = session.receive(&receiver_status(apps), now);
    assert!(out.events.contains(&Event::Ready {
        session_id: "s1".into()
    }));
}

#[test]
fn a_null_time_or_request_id_reads_as_zero() {
    let now = Instant::now();
    let mut session = ready(now);
    let status = from(
        "t1",
        NS_MEDIA,
        json!({ "type": "MEDIA_STATUS", "requestId": null, "status": [{
            "mediaSessionId": 3, "playerState": "PLAYING", "currentTime": null,
            "supportedMediaCommands": null }] }),
    );
    let media = media_event(&session.receive(&status, now));
    assert_eq!(media.current_time, 0.0);
    assert!(!media.can_pause);
}
