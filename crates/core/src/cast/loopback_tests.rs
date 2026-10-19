// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A sender and a fake receiver over loopback TCP. The app adds TLS around
//! the same bytes.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::frame::{CastMessage, FrameReader, Payload};
use super::message::{LoadRequest, StreamType, NS_MEDIA, NS_RECEIVER};
use super::session::{CloseReason, Event, PlayerState, Session};

/// Answers like the Default Media Receiver: nothing running at first, then
/// the app after a launch, then the media after a load.
fn fake_receiver(mut stream: TcpStream) {
    let mut reader = FrameReader::default();
    let mut buf = [0u8; 4096];
    let mut launched = false;
    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        reader.push(&buf[..n]);
        while let Some(message) = reader.next_message() {
            let message = message.unwrap();
            let Payload::Text(text) = &message.payload else {
                continue;
            };
            let body: Value = serde_json::from_str(text).unwrap();
            let id = body["requestId"].as_u64().unwrap_or(0);
            let reply = |source: &str, namespace: &str, body: Value| {
                CastMessage::text(source, &message.source, namespace, body.to_string()).encode()
            };
            let apps = |launched: bool| {
                if launched {
                    json!([{ "appId": "CC1AD845", "sessionId": "s1", "transportId": "web-1" }])
                } else {
                    json!([])
                }
            };
            let media = |state: &str| {
                json!([{ "mediaSessionId": 1, "playerState": state, "currentTime": 42.5,
                         "supportedMediaCommands": 3,
                         "media": { "duration": 600.0, "streamType": "BUFFERED" } }])
            };
            let answer = match (message.namespace.as_str(), body["type"].as_str().unwrap()) {
                (NS_RECEIVER, "GET_STATUS") => Some(reply(
                    "receiver-0",
                    NS_RECEIVER,
                    json!({ "type": "RECEIVER_STATUS", "requestId": id, "status": { "applications": apps(launched) } }),
                )),
                (NS_RECEIVER, "LAUNCH") => {
                    launched = true;
                    Some(reply(
                        "receiver-0",
                        NS_RECEIVER,
                        json!({ "type": "RECEIVER_STATUS", "requestId": id, "status": { "applications": apps(launched) } }),
                    ))
                }
                (NS_MEDIA, "GET_STATUS") => Some(reply(
                    "web-1",
                    NS_MEDIA,
                    json!({ "type": "MEDIA_STATUS", "requestId": id, "status": [] }),
                )),
                (NS_MEDIA, "LOAD") => {
                    assert_eq!(body["media"]["contentId"], "http://example.invalid/1.mp4");
                    Some(reply(
                        "web-1",
                        NS_MEDIA,
                        json!({ "type": "MEDIA_STATUS", "requestId": id, "status": media("PLAYING") }),
                    ))
                }
                (NS_MEDIA, "PAUSE") => Some(reply(
                    "web-1",
                    NS_MEDIA,
                    json!({ "type": "MEDIA_STATUS", "requestId": id, "status": media("PAUSED") }),
                )),
                (_, "CLOSE") if message.destination == "receiver-0" => return,
                _ => None,
            };
            if let Some(answer) = answer {
                stream.write_all(&answer).unwrap();
            }
        }
    }
}

#[test]
fn launches_loads_pauses_and_stops_over_a_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let receiver = thread::spawn(move || fake_receiver(listener.accept().unwrap().0));

    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let (mut session, first) = Session::start("sender-7".into(), Instant::now());
    for frame in first {
        stream.write_all(&frame).unwrap();
    }
    let request = LoadRequest {
        url: "http://example.invalid/1.mp4".into(),
        content_type: "video/mp4".into(),
        stream_type: StreamType::Buffered,
        hls_ts_segments: false,
        title: "Test".into(),
        image: None,
        start_at: None,
        text_tracks: vec![],
        active_track_ids: vec![],
    };
    for frame in session.load(request, Instant::now()).unwrap().send {
        stream.write_all(&frame).unwrap();
    }

    let mut events = Vec::new();
    let mut paused = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline {
        let out = match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => session.receive(&buf[..n], Instant::now()),
            Err(_) => session.tick(Instant::now()),
        };
        for frame in out.send {
            stream.write_all(&frame).unwrap();
        }
        events.extend(out.events);
        let playing = events.iter().any(
            |e| matches!(e, Event::Media(Some(m)) if m.player == PlayerState::Playing && m.current_time == 42.5),
        );
        if playing && !paused {
            paused = true;
            stream.write_all(&session.pause().unwrap().1).unwrap();
        }
        let is_paused = events
            .iter()
            .any(|e| matches!(e, Event::Media(Some(m)) if m.player == PlayerState::Paused));
        if is_paused {
            break;
        }
    }
    assert!(
        events.contains(&Event::Ready {
            session_id: "s1".into()
        }),
        "{events:?}"
    );
    assert!(paused, "{events:?}");

    let out = session.stop();
    for frame in out.send {
        stream.write_all(&frame).unwrap();
    }
    assert_eq!(out.events, vec![Event::Closed(CloseReason::Stopped)]);
    receiver.join().unwrap();
}
