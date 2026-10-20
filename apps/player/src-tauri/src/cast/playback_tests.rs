// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The cast commands on a mock app, casting to fake receivers on loopback.

use std::net::SocketAddr;
use std::sync::mpsc;

use mvp_core::http::test_server::{refused_url, route, serve_once, serve_routes};
use mvp_core::models::channel::Channel;
use serde_json::{json, Value};
use tauri::{Listener, Manager};

use super::fake_receiver::{self, next_of};
use super::receivers::CastReceiver;
use super::update;
use crate::downloads::test_support::add_channel;
use crate::test_support::TestApp;

/// Lists a receiver at `addr` as `cast:<id>`.
fn add_receiver(app: &TestApp, id: &str, addr: SocketAddr) {
    let receiver = CastReceiver {
        id: format!("cast:{id}"),
        name: id.into(),
        model: "Chromecast".into(),
        status: None,
        available: true,
        addr: addr.ip(),
        port: addr.port(),
    };
    update(&app.handle(), |registry| {
        registry.found(id.into(), receiver)
    });
}

fn channel(id: &str, url: &str, content_type: &str) -> Channel {
    Channel {
        id: id.into(),
        name: "Evening News".into(),
        url: url.into(),
        content_type: content_type.into(),
        ..Channel::default()
    }
}

/// A live channel's `.m3u8` that redirects to a playlist on another host,
/// as Xtream panels do, both with CORS headers. Returns the original link.
fn redirected_playlist(cors: bool) -> String {
    let allow = if cors {
        "\r\nAccess-Control-Allow-Origin: *"
    } else {
        ""
    };
    let (target, _) = serve_routes(vec![
        route(
            ".m3u8",
            &format!("200 OK{allow}"),
            "#EXTM3U\n#EXTINF:4.0,\ns.ts\n",
        ),
        route("/s.ts", &format!("200 OK{allow}"), "ab"),
    ]);
    let moved =
        format!("302 Found\r\nLocation: {target}/hls/token-for-this-address/index.m3u8{allow}");
    let (panel, _) = serve_routes(vec![route("/live/", &moved, "")]);
    format!("{panel}/live/u/SECRET/7.m3u8")
}

fn direct(container: &str) -> Value {
    json!({ "via": "direct", "source": 0, "container": container })
}

/// Collects the `cast://update` events.
fn updates(app: &TestApp) -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    app.handle()
        .listen_any(super::playback::UPDATE_EVENT, move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).unwrap());
        });
    rx
}

/// Casts `channel` by `route`, after listing its own URL as the formats
/// command does, with that list's generation in the route.
fn load(
    app: &TestApp,
    receiver: &str,
    channel: &Channel,
    mut route: Value,
    start_at: Option<f64>,
) -> Result<Value, Value> {
    let handle = app.handle();
    let streams = handle.state::<crate::streams::StreamsState>();
    let generation = streams.remember(&channel.id, vec![channel.url.clone()]);
    if let Some(route) = route.as_object_mut() {
        route.entry("generation").or_insert(json!(generation));
    }
    app.invoke(
        "cast_load",
        json!({ "receiverId": receiver, "channel": channel, "route": route, "startAt": start_at }),
    )
}

fn control(app: &TestApp, receiver: &str, action: Value) -> Result<Value, Value> {
    app.invoke(
        "cast_control",
        json!({ "receiverId": receiver, "action": action }),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn plays_an_item_directly_and_controls_it() {
    let app = TestApp::new();
    let events = updates(&app);
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let link = redirected_playlist(true);
    let movie = channel("m-1", &link, "movie");
    add_channel(&app, &movie);

    load(&app, "cast:tv", &movie, direct("hls-ts"), Some(30.0)).unwrap();
    let loaded = next_of(&mut got, "LOAD").await;
    let media = &loaded.body["media"];
    // The original link, not where it redirects.
    assert_eq!(media["contentId"], link.as_str());
    assert_eq!(media["contentType"], "application/x-mpegURL");
    assert_eq!(media["hlsSegmentFormat"], "ts");
    assert_eq!(media["streamType"], "BUFFERED");
    assert_eq!(media["metadata"]["title"], "Evening News");
    assert_eq!(loaded.body["currentTime"], 30.0);
    assert_eq!(loaded.namespace, mvp_core::cast::message::NS_MEDIA);

    // Controls work once the receiver says what it plays.
    let mut seen = Vec::new();
    while !seen
        .iter()
        .any(|e: &Value| e["update"]["kind"] == "media" && !e["update"]["media"].is_null())
    {
        seen.push(
            events
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap(),
        );
    }
    control(&app, "cast:tv", json!({ "action": "pause" })).unwrap();
    next_of(&mut got, "PAUSE").await;
    control(&app, "cast:tv", json!({ "action": "play" })).unwrap();
    next_of(&mut got, "PLAY").await;
    control(&app, "cast:tv", json!({ "action": "seek", "to": 12.5 })).unwrap();
    assert_eq!(next_of(&mut got, "SEEK").await.body["currentTime"], 12.5);
    control(
        &app,
        "cast:tv",
        json!({ "action": "volume", "level": 0.75 }),
    )
    .unwrap();
    assert_eq!(
        next_of(&mut got, "SET_VOLUME").await.body["volume"]["level"],
        0.75
    );
    // Another receiver isn't being cast to.
    assert_eq!(
        control(&app, "cast:other", json!({ "action": "play" })),
        Err(json!("notConnected"))
    );

    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    next_of(&mut got, "STOP").await;
    assert_eq!(
        control(&app, "cast:tv", json!({ "action": "play" })),
        Err(json!("notConnected"))
    );

    // The frontend heard all of it, tagged with the receiver.
    let mut kinds: Vec<String> = seen
        .iter()
        .map(|e| e["update"]["kind"].as_str().unwrap().to_string())
        .collect();
    while let Ok(event) = events.recv_timeout(std::time::Duration::from_secs(5)) {
        assert_eq!(event["receiverId"], "cast:tv");
        let kind = event["update"]["kind"].as_str().unwrap().to_string();
        let closed = kind == "closed";
        kinds.push(kind);
        if closed {
            break;
        }
    }
    for kind in ["ready", "media", "volume", "closed"] {
        assert!(kinds.iter().any(|k| k == kind), "{kind} in {kinds:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_channel_starts_at_the_live_edge_with_its_logo_when_it_may_leave() {
    let app = TestApp::new();
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let mut live = channel("l-1", "http://192.0.2.1/live/u/SECRET/7.ts", "live");
    live.logo_url = Some("https://logos.example/news.png".into());
    add_channel(&app, &live);
    load(&app, "cast:tv", &live, direct("ts"), Some(30.0)).unwrap();
    let loaded = next_of(&mut got, "LOAD").await;
    assert_eq!(loaded.body["media"]["streamType"], "LIVE");
    assert_eq!(loaded.body["media"]["contentType"], "video/mp2t");
    assert_eq!(loaded.body.get("currentTime"), None);
    assert_eq!(
        loaded.body["media"]["metadata"]["images"][0]["url"],
        "https://logos.example/news.png"
    );

    // A logo with a query could carry a login, so it stays here.
    live.logo_url = Some("https://logos.example/news.png?token=SECRET".into());
    load(&app, "cast:tv", &live, direct("mkv"), None).unwrap();
    let loaded = next_of(&mut got, "LOAD").await;
    assert_eq!(loaded.body["media"]["contentType"], "video/x-matroska");
    assert_eq!(loaded.body["media"]["metadata"].get("images"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_direct_playlist_is_checked_when_it_is_cast() {
    let app = TestApp::new();
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let not_playlist = serve_once("200 OK\r\nAccess-Control-Allow-Origin: *", "<html>");
    let missing = serve_once("404 Not Found", "");
    let refused = serve_once("403 Forbidden", "");
    for (base, expected) in [
        (not_playlist, "notPlaylist"),
        (missing, "notPlaylist"),
        (refused, "refused"),
    ] {
        let live = channel("l-1", &format!("{base}/live/u/SECRET/7.m3u8"), "live");
        add_channel(&app, &live);
        assert_eq!(
            load(&app, "cast:tv", &live, direct("hls-ts"), None),
            Err(json!(expected))
        );
    }
    let live = channel("l-2", &redirected_playlist(false), "live");
    add_channel(&app, &live);
    assert_eq!(
        load(&app, "cast:tv", &live, direct("hls-fmp4"), None),
        Err(json!("cors"))
    );
    // Nothing reached the receiver.
    assert!(got.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn says_why_a_receiver_couldnt_be_cast_to() {
    let app = TestApp::new();
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    assert_eq!(
        load(&app, "cast:none", &movie, direct("mp4"), None),
        Err(json!("notFound"))
    );

    // Nothing listens there, so it's marked unavailable.
    let closed: SocketAddr = refused_url().trim_start_matches("http://").parse().unwrap();
    add_receiver(&app, "gone", closed);
    assert_eq!(
        load(&app, "cast:gone", &movie, direct("mp4"), None),
        Err(json!("unreachable"))
    );
    let handle = app.handle();
    let receivers = handle.state::<super::CastReceivers>();
    assert!(!receivers.registry().get("cast:gone").unwrap().available);

    let (addr, _, _got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    // A URL that its list doesn't have, or a list that a newer one replaced.
    let route = json!({ "via": "direct", "source": 3, "container": "mp4" });
    assert_eq!(
        load(&app, "cast:tv", &movie, route, None),
        Err(json!("stale"))
    );
    let route = json!({ "via": "direct", "generation": 0, "source": 0, "container": "mp4" });
    assert_eq!(
        load(&app, "cast:tv", &movie, route, None),
        Err(json!("stale"))
    );
    assert!(load(&app, "cast:tv", &movie, json!({ "via": "elsewhere" }), None).is_err());
    assert!(control(&app, "cast:tv", json!({ "action": "dance" })).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_receiver_with_another_certificate_than_before_is_refused() {
    let app = TestApp::new();
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    let (first, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", first);
    load(&app, "cast:tv", &movie, direct("mp4"), None).unwrap();
    next_of(&mut got, "LOAD").await;
    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();

    // Something else now answers at the receiver's address.
    let (other, _, _) = fake_receiver::start().await;
    add_receiver(&app, "tv", other);
    assert_eq!(
        load(&app, "cast:tv", &movie, direct("mp4"), None),
        Err(json!("notPinned"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn casting_to_another_receiver_ends_the_first_cast() {
    let app = TestApp::new();
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    let (first, _, mut first_got) = fake_receiver::start().await;
    let (second, _, mut second_got) = fake_receiver::start().await;
    add_receiver(&app, "a", first);
    add_receiver(&app, "b", second);
    load(&app, "cast:a", &movie, direct("mp4"), None).unwrap();
    next_of(&mut first_got, "LOAD").await;
    load(&app, "cast:b", &movie, direct("mp4"), None).unwrap();
    next_of(&mut second_got, "LOAD").await;
    next_of(&mut first_got, "STOP").await;
    // A second load to the same receiver keeps its connection.
    load(&app, "cast:b", &movie, direct("mp4"), Some(5.0)).unwrap();
    assert_eq!(
        next_of(&mut second_got, "LOAD").await.body["currentTime"],
        5.0
    );
    assert_eq!(
        control(&app, "cast:a", json!({ "action": "play" })),
        Err(json!("notConnected"))
    );
}

/// A second of 16-bit mono WAV at 8192 Hz, which the sidecar decodes. The
/// test server sends text, and every byte of this one is ASCII.
fn wav16() -> String {
    let samples: u32 = 8192 * 2;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(36 + samples).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    // The format chunk's length, then PCM, one channel, the sample rate,
    // the byte rate, the bytes per sample and the bits per sample.
    for (value, size) in [
        (16, 4),
        (1, 2),
        (1, 2),
        (8192, 4),
        (16384, 4),
        (2, 2),
        (16, 2),
    ] {
        bytes.extend_from_slice(&u32::to_le_bytes(value)[..size]);
    }
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&samples.to_le_bytes());
    bytes.resize(bytes.len() + samples as usize, b'@');
    String::from_utf8(bytes).expect("every byte is ASCII")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_converted_route_serves_the_receiver_from_this_computer() {
    let app = TestApp::new();
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let (source, _) = serve_routes(vec![route("/movie/", "200 OK", wav16())]);
    let movie = channel("m-1", &format!("{source}/movie/1.wav"), "movie");
    add_channel(&app, &movie);
    let route = json!({ "via": "converted", "source": 0, "container": "mkv", "video": "copy", "audio": "aac" });
    let support = crate::convert::support::support(&app.handle()).await;
    let result = load(&app, "cast:tv", &movie, route, Some(0.5));
    if support.convert {
        result.unwrap();
        let loaded = next_of(&mut got, "LOAD").await;
        let media = &loaded.body["media"];
        assert_eq!(media["contentType"], "video/x-matroska");
        assert_eq!(media["streamType"], "LIVE");
        assert_eq!(loaded.body.get("currentTime"), None);
        let url = media["contentId"].as_str().unwrap();
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        assert!(url.ends_with("/stream.mkv"), "{url}");
        // The receiver gets this computer's address, never the source's.
        assert!(!url.contains("/movie/"), "{url}");
    } else {
        // The pinned sidecar has no AAC encoder until build 3.
        assert_eq!(result, Err(json!("noConverter")));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_converted_route_says_when_the_provider_refuses() {
    let app = TestApp::new();
    let (addr, _, _got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let movie = channel(
        "m-1",
        &format!("{}/1.mkv", serve_once("403 Forbidden", "")),
        "movie",
    );
    add_channel(&app, &movie);
    let route = json!({ "via": "converted", "source": 0, "container": "mkv", "video": "none", "audio": "none" });
    assert_eq!(
        load(&app, "cast:tv", &movie, route, None),
        Err(json!("refused"))
    );
    let unreachable = channel("m-2", &format!("{}/1.mkv", refused_url()), "movie");
    add_channel(&app, &unreachable);
    let route = json!({ "via": "converted", "source": 0, "container": "mkv", "video": "copy", "audio": "copy" });
    assert_eq!(
        load(&app, "cast:tv", &unreachable, route, None),
        Err(json!("unreachable"))
    );
}

#[test]
fn the_receiver_is_told_the_type_of_each_container() {
    use super::playback::content_type;
    use mvp_core::streams::format::Container;
    assert_eq!(
        content_type(Container::HlsTs),
        ("application/x-mpegURL", true)
    );
    assert_eq!(
        content_type(Container::HlsFmp4),
        ("application/x-mpegURL", false)
    );
    assert_eq!(content_type(Container::Mp4), ("video/mp4", false));
    assert_eq!(content_type(Container::Mkv), ("video/x-matroska", false));
    assert_eq!(content_type(Container::Ts), ("video/mp2t", false));
    assert_eq!(
        content_type(Container::Other),
        ("application/octet-stream", false)
    );
}
