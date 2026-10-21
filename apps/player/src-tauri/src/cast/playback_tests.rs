// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The cast commands on a mock app, casting to fake receivers on loopback.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

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
    let mut channel = Channel {
        name: "Evening News".into(),
        url: url.into(),
        content_type: content_type.into(),
        ..Channel::default()
    };
    // On a line of its own, which mutation testing leaves alone.
    channel.id = id.into();
    channel
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
        json!({ "receiverId": receiver, "channel": channel, "route": route, "startAt": start_at, "restart": false }),
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
    // The connection has a sender id of its own.
    let sender = loaded.source.strip_prefix("sender-").unwrap();
    assert_eq!(sender.len(), 8);
    assert!(sender.chars().all(|c| c.is_ascii_hexdigit()), "{sender}");

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

    // Letting go of the stream stops the media and keeps the cast.
    app.invoke("cast_release", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    let released = next_of(&mut got, "STOP").await;
    assert_eq!(released.namespace, mvp_core::cast::message::NS_MEDIA);
    control(&app, "cast:tv", json!({ "action": "play" })).unwrap();
    next_of(&mut got, "PLAY").await;
    assert_eq!(
        app.invoke("cast_release", json!({ "receiverId": "cast:other" })),
        Err(json!("notConnected"))
    );

    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    // It stops the media, then the receiver app.
    assert_eq!(
        next_of(&mut got, "STOP").await.namespace,
        mvp_core::cast::message::NS_MEDIA
    );
    assert_eq!(
        next_of(&mut got, "STOP").await.namespace,
        mvp_core::cast::message::NS_RECEIVER
    );
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
async fn a_new_cast_takes_the_certificate_the_receiver_has_now() {
    let app = TestApp::new();
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    // Receivers change their certificate after a few days or a restart.
    let acceptors = vec![fake_receiver::acceptor().0, fake_receiver::acceptor().0];
    let (addr, mut got) = fake_receiver::start_with(acceptors, Duration::ZERO).await;
    add_receiver(&app, "tv", addr);
    load(&app, "cast:tv", &movie, direct("mp4"), None).unwrap();
    assert_eq!(next_of(&mut got, "LOAD").await.connection, 0);
    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    load(&app, "cast:tv", &movie, direct("mp4"), None).unwrap();
    assert_eq!(next_of(&mut got, "LOAD").await.connection, 1);
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
    let connection = next_of(&mut second_got, "LOAD").await.connection;
    next_of(&mut first_got, "STOP").await;
    // Once the first cast's session has wound down, which leaves the
    // second as it is, a second load to the same receiver keeps its
    // connection.
    tokio::time::sleep(Duration::from_millis(500)).await;
    load(&app, "cast:b", &movie, direct("mp4"), Some(5.0)).unwrap();
    let again = next_of(&mut second_got, "LOAD").await;
    assert_eq!(again.body["currentTime"], 5.0);
    assert_eq!(again.connection, connection);
    assert_eq!(
        control(&app, "cast:a", json!({ "action": "play" })),
        Err(json!("notConnected"))
    );
}

/// Whether an ffmpeg with `url` among its arguments runs.
fn ffmpeg_runs_for(url: &str) -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", url])
        .status()
        .is_ok_and(|s| s.success())
}

/// Eight seconds of 16-bit mono WAV at 8192 Hz, which the sidecar decodes. The
/// test server sends text, and every byte of this one is ASCII.
fn wav16() -> String {
    wav16_lasting(8)
}

/// [`wav16`] lasting `seconds`, which keep its lengths ASCII when they're a
/// multiple of 4 below 512.
fn wav16_lasting(seconds: u32) -> String {
    let samples: u32 = seconds * 8192 * 2;
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
        // Letting go of the stream stops the converter, and so its
        // connection to the source, before it answers.
        let source_url = movie.url.clone();
        assert!(ffmpeg_runs_for(&source_url));
        app.invoke("cast_release", json!({ "receiverId": "cast:tv" }))
            .unwrap();
        assert!(!ffmpeg_runs_for(&source_url));
    } else {
        // The pinned sidecar has no AAC encoder until build 3.
        assert_eq!(result, Err(json!("noConverter")));
    }
}

/// Waits up to 10 s for the next `cast://update` of `kind`.
fn next_update(events: &mpsc::Receiver<Value>, kind: &str) -> Value {
    loop {
        let event = events
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("a {kind} within 10 s"));
        if event["update"]["kind"] == kind {
            return event;
        }
    }
}

/// Converts `channel` for the fake receiver `addr`, and returns the URL the
/// receiver was given.
async fn cast_converted(
    app: &TestApp,
    addr: SocketAddr,
    got: &mut tokio::sync::mpsc::UnboundedReceiver<fake_receiver::Got>,
    channel: &Channel,
) -> String {
    add_receiver(app, "tv", addr);
    add_channel(app, channel);
    let route = json!({ "via": "converted", "source": 0, "container": "mkv", "video": "copy", "audio": "aac" });
    load(app, "cast:tv", channel, route, None).unwrap();
    let loaded = next_of(got, "LOAD").await;
    loaded.body["media"]["contentId"]
        .as_str()
        .unwrap()
        .to_string()
}

/// This computer's loopback address, which the address tests take away.
const LOOPBACK: std::net::IpAddr = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);

/// Has casts on `app` check this computer's addresses every 50 ms with
/// `route` and `ours`.
fn check_addresses(
    app: &TestApp,
    route: fn(std::net::IpAddr) -> Result<std::net::IpAddr, crate::lan_server::NoRoute>,
    ours: fn(std::net::IpAddr) -> bool,
) {
    app.handle()
        .state::<super::playback::CastPlayback>()
        .check_addresses_with(route, ours, Duration::from_millis(50));
}

/// Loads `channel` again as the frontend does when it starts the stream
/// again by itself.
fn restart(app: &TestApp, channel: &Channel, route: Value) -> Result<Value, Value> {
    let generation = app
        .handle()
        .state::<crate::streams::StreamsState>()
        .remember(&channel.id, vec![channel.url.clone()]);
    let mut route = route;
    route["generation"] = json!(generation);
    app.invoke(
        "cast_load",
        json!({ "receiverId": "cast:tv", "channel": channel, "route": route,
                "startAt": null, "restart": true }),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_the_stream_again_on_the_new_address_after_a_move() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    // After a sleep on another network, the route to the receiver goes from
    // another address, and the old one is gone.
    check_addresses(
        &app,
        |_| Ok("192.0.2.7".parse().unwrap()),
        |ip| ip != LOOPBACK,
    );
    let events = updates(&app);
    let (addr, _, mut got) = fake_receiver::start().await;
    let (source, _) = serve_routes(vec![route("/movie/", "200 OK", wav16())]);
    let movie = channel("m-1", &format!("{source}/movie/1.wav"), "movie");
    cast_converted(&app, addr, &mut got, &movie).await;
    let moved = next_update(&events, "conversionStopped");
    assert_eq!(moved["receiverId"], "cast:tv");
    assert_eq!(moved["update"]["why"], "moved");
    // The session went from the old address too, so starting again opens a
    // new one, quietly: the receiver keeps its app, and the frontend sees
    // no end.
    restart(&app, &movie, converted()).unwrap();
    let loaded = next_of(&mut got, "LOAD").await;
    assert_eq!(loaded.connection, 1);
    assert!(!gets(&mut got, "STOP", Duration::from_millis(500)).await);
    while let Ok(event) = events.try_recv() {
        assert_ne!(event["update"]["kind"], "closed");
    }
}

#[test]
fn knows_which_addresses_are_this_computers() {
    assert!(super::playback::is_ours(LOOPBACK));
    // A documentation address no computer has.
    assert!(!super::playback::is_ours("192.0.2.7".parse().unwrap()));
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_session_while_its_address_is_still_this_computers() {
    let app = TestApp::new();
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let first = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    let second = channel("m-2", "http://192.0.2.1/2.mp4", "movie");
    add_channel(&app, &first);
    add_channel(&app, &second);
    // A new address alongside the old one, as when a cable is plugged in.
    check_addresses(&app, |_| Ok("192.0.2.7".parse().unwrap()), |_| true);
    load(&app, "cast:tv", &first, direct("mp4"), None).unwrap();
    next_of(&mut got, "LOAD").await;
    load(&app, "cast:tv", &second, direct("mp4"), None).unwrap();
    assert_eq!(next_of(&mut got, "LOAD").await.connection, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_an_address_gone_for_two_checks_starts_the_stream_again() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    let (source, _) = serve_routes(vec![route("/movie/", "200 OK", wav16())]);
    let movie = channel("m-1", &format!("{source}/movie/1.wav"), "movie");
    let quiet = |app: &TestApp| {
        let events = updates(app);
        async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            while let Ok(event) = events.try_recv() {
                assert_ne!(event["update"]["kind"], "conversionStopped");
            }
        }
    };
    // No route at all, for a moment without a network.
    check_addresses(
        &app,
        |_| Err(crate::lan_server::NoRoute),
        |ip| ip != LOOPBACK,
    );
    let checked = quiet(&app);
    cast_converted(&app, addr, &mut got, &movie).await;
    checked.await;
    // A new address alongside the old one.
    check_addresses(&app, |_| Ok("192.0.2.7".parse().unwrap()), |_| true);
    let checked = quiet(&app);
    load(&app, "cast:tv", &movie, converted(), Some(1.0)).unwrap();
    checked.await;
    // A route that changes and changes back, one check at a time.
    static FLIP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    check_addresses(
        &app,
        |_| {
            if FLIP.fetch_xor(true, Ordering::SeqCst) {
                Ok(LOOPBACK)
            } else {
                Ok("192.0.2.7".parse().unwrap())
            }
        },
        |ip| ip != LOOPBACK,
    );
    let checked = quiet(&app);
    load(&app, "cast:tv", &movie, converted(), Some(2.0)).unwrap();
    checked.await;
}

#[tokio::test(flavor = "multi_thread")]
async fn starting_again_never_opens_a_cast() {
    let app = TestApp::new();
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    // A cast that ended, or never was.
    assert_eq!(
        restart(&app, &movie, direct("mp4")),
        Err(json!("notConnected"))
    );
    assert!(!gets(&mut got, "CONNECT", Duration::from_millis(500)).await);
    // One that goes on takes it.
    load(&app, "cast:tv", &movie, direct("mp4"), None).unwrap();
    next_of(&mut got, "LOAD").await;
    restart(&app, &movie, direct("mp4")).unwrap();
    next_of(&mut got, "LOAD").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_for_a_live_channel_again_once_its_connection_ends() {
    let app = TestApp::new();
    if !crate::convert::support::support(&app.handle())
        .await
        .convert
    {
        return;
    }
    let events = updates(&app);
    let (addr, _, mut got) = fake_receiver::start().await;
    // A channel whose connection closes after eight seconds of sound.
    let (source, _) = serve_routes(vec![route("/live/", "200 OK", wav16())]);
    let live = channel("l-1", &format!("{source}/live/7.wav"), "live");
    cast_converted(&app, addr, &mut got, &live).await;
    let dropped = next_update(&events, "conversionStopped");
    assert_eq!(dropped["update"]["why"], "dropped");
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_serving_a_file_once_the_converter_has_finished_it() {
    let app = TestApp::new();
    if !crate::convert::support::support(&app.handle())
        .await
        .convert
    {
        return;
    }
    let events = updates(&app);
    let (addr, _, mut got) = fake_receiver::start().await;
    let (source, _) = serve_routes(vec![route("/movie/", "200 OK", wav16())]);
    let source_url = format!("{source}/movie/done.wav");
    let movie = channel("m-1", &source_url, "movie");
    let url = cast_converted(&app, addr, &mut got, &movie).await;
    // The file is read at its playing speed after a burst, so ffmpeg
    // finishes within its eight seconds.
    let start = std::time::Instant::now();
    while ffmpeg_runs_for(&source_url) {
        assert!(start.elapsed() < std::time::Duration::from_secs(20));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    // The receiver can still ask for what it hasn't got, and gets all of
    // it, from the header to the end.
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        mvp_core::http::test_server::client().get(&url).send(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), 200);
    let body = tokio::time::timeout(std::time::Duration::from_secs(10), response.bytes())
        .await
        .expect("the whole stream within 10 s")
        .unwrap();
    assert!(
        body.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "a Matroska header"
    );
    // Eight seconds of sound, in more than the header.
    assert!(body.len() > 4096, "{} bytes", body.len());
    // The cast still has it, and can ask for it again.
    control(&app, "cast:tv", json!({ "action": "play" })).unwrap();
    let again = mvp_core::http::test_server::client()
        .get(&url)
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 200);
    // Nothing told the frontend to start it again.
    while let Ok(event) = events.try_recv() {
        assert_ne!(event["update"]["kind"], "conversionStopped");
        assert_ne!(event["update"]["kind"], "conversionFailed");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn says_when_the_converter_stops_with_an_error_while_it_casts() {
    let app = TestApp::new();
    if !crate::convert::support::support(&app.handle())
        .await
        .convert
    {
        return;
    }
    let events = updates(&app);
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let (source, _) = serve_routes(vec![route("/movie/", "200 OK", wav16())]);
    let source_url = format!("{source}/movie/broken.wav");
    let movie = channel("m-1", &source_url, "movie");
    add_channel(&app, &movie);
    let route = json!({ "via": "converted", "source": 0, "container": "mkv", "video": "copy", "audio": "aac" });
    load(&app, "cast:tv", &movie, route, None).unwrap();
    next_of(&mut got, "LOAD").await;
    // ffmpeg ends with an error, as when the provider cuts it off.
    std::process::Command::new("pkill")
        .args(["-9", "-f", &source_url])
        .status()
        .unwrap();
    let failed = loop {
        let event = events
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the failure within 10 s");
        if event["update"]["kind"] == "conversionFailed" {
            break event;
        }
    };
    assert_eq!(failed["receiverId"], "cast:tv");
    assert_eq!(failed["update"]["refused"], false);
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

/// Lists `channel`'s URL as the formats command does, and starts casting
/// it by `route` on another thread, so the test can do something else
/// while it runs.
fn load_in_background(
    app: &TestApp,
    channel: &Channel,
    mut route: Value,
    start_at: Option<f64>,
) -> std::thread::JoinHandle<Result<Value, Value>> {
    let handle = app.handle();
    let streams = handle.state::<crate::streams::StreamsState>();
    let generation = streams.remember(&channel.id, vec![channel.url.clone()]);
    route["generation"] = json!(generation);
    let args = json!({ "receiverId": "cast:tv", "channel": channel, "route": route, "startAt": start_at, "restart": false });
    let handle = handle.clone();
    std::thread::spawn(move || crate::test_support::invoke_on(&handle, "cast_load", args))
}

/// Waits up to 10 s for `done`.
async fn wait_until(what: &str, done: impl Fn() -> bool) {
    let start = std::time::Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "{what} within 10 s"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Whether the receiver gets a message of `kind` within `within`.
async fn gets(
    got: &mut tokio::sync::mpsc::UnboundedReceiver<fake_receiver::Got>,
    kind: &str,
    within: Duration,
) -> bool {
    tokio::time::timeout(within, async {
        while let Some(message) = got.recv().await {
            if message.kind() == kind {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

/// A source on loopback that serves `body` to each connection, holding
/// back all but its first 44 bytes for `hold`, or until the reader hangs
/// up. It counts the connections,
/// and with `one_at_a_time` it refuses one with 403 Forbidden while another
/// is open, as accounts that allow one connection do.
fn counting_source(
    body: String,
    hold: Duration,
    one_at_a_time: bool,
) -> (String, Arc<AtomicUsize>) {
    refusing_source(body, hold, one_at_a_time, Vec::new())
}

/// How long a one-connection source waits for a closed connection to
/// count as closed before it turns the next away.
const FREED_WITHIN: Duration = Duration::from_secs(2);

/// A [`counting_source`] that also refuses the connections numbered in
/// `refused`, counting from 0.
fn refusing_source(
    body: String,
    hold: Duration,
    one_at_a_time: bool,
    refused: Vec<usize>,
) -> (String, Arc<AtomicUsize>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let connections = Arc::new(AtomicUsize::new(0));
    let open = Arc::new(AtomicUsize::new(0));
    let counted = connections.clone();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let number = counted.fetch_add(1, Ordering::SeqCst);
            let refuse = refused.contains(&number);
            let (body, open) = (body.clone(), open.clone());
            std::thread::spawn(move || {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                // A provider frees the slot once it sees the close, which the
                // thread here may only notice a moment after the reader
                // closed.
                let busy = one_at_a_time && {
                    let asked = std::time::Instant::now();
                    while open.load(Ordering::SeqCst) > 0 && asked.elapsed() < FREED_WITHIN {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    open.load(Ordering::SeqCst) > 0
                };
                if refuse || busy {
                    let _ =
                        stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
                    return;
                }
                open.fetch_add(1, Ordering::SeqCst);
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
                let sent = stream.write_all(head.as_bytes()).is_ok()
                    && stream.write_all(&body.as_bytes()[..44]).is_ok();
                // A read that ends at once is the reader hanging up.
                let hung_up = sent
                    && !hold.is_zero()
                    && stream.set_read_timeout(Some(hold)).is_ok()
                    && matches!(stream.read(&mut request), Ok(0));
                if sent && !hung_up {
                    let _ = stream.set_read_timeout(None);
                    let _ = stream.write_all(&body.as_bytes()[44..]);
                    // Stay open until the reader hangs up.
                    let _ = stream.read(&mut request);
                }
                open.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    (format!("http://{address}/movie/1.wav"), connections)
}

fn converted() -> Value {
    json!({ "via": "converted", "source": 0, "container": "mkv", "video": "copy", "audio": "aac" })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_while_it_connects_leaves_the_receiver_alone() {
    let app = TestApp::new();
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    // A receiver that takes a second to answer.
    let (addr, mut got) =
        fake_receiver::start_with(vec![fake_receiver::acceptor().0], Duration::from_secs(1)).await;
    add_receiver(&app, "tv", addr);
    let loading = load_in_background(&app, &movie, direct("mp4"), None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    assert_eq!(loading.join().unwrap(), Err(json!("superseded")));
    assert!(!gets(&mut got, "LOAD", Duration::from_secs(2)).await);
    assert_eq!(
        control(&app, "cast:tv", json!({ "action": "play" })),
        Err(json!("notConnected"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_while_the_converter_starts_ends_it() {
    let app = TestApp::new();
    if !crate::convert::support::support(&app.handle())
        .await
        .convert
    {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    // The source holds back its sound, so the converter waits on it.
    let (source, connections) = counting_source(wav16(), Duration::from_secs(3), false);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    let loading = load_in_background(&app, &movie, converted(), None);
    // The probe, then the converter.
    wait_until("the converter's connection", || {
        connections.load(Ordering::SeqCst) >= 2
    })
    .await;
    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    assert_eq!(loading.join().unwrap(), Err(json!("superseded")));
    wait_until("ffmpeg ends", || !ffmpeg_runs_for(&source)).await;
    assert!(!gets(&mut got, "LOAD", Duration::from_secs(1)).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_while_a_switch_looks_up_its_item_ends_the_cast() {
    let app = TestApp::new();
    if !crate::convert::support::support(&app.handle())
        .await
        .convert
    {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    load(&app, "cast:tv", &movie, direct("mp4"), None).unwrap();
    next_of(&mut got, "LOAD").await;
    // The next item's probe waits on its source.
    let (source, connections) = counting_source(wav16(), Duration::from_secs(3), false);
    let next = channel("m-2", &source, "movie");
    add_channel(&app, &next);
    let loading = load_in_background(&app, &next, converted(), None);
    wait_until("the probe's connection", || {
        connections.load(Ordering::SeqCst) >= 1
    })
    .await;
    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    assert_eq!(loading.join().unwrap(), Err(json!("superseded")));
    assert!(!gets(&mut got, "LOAD", Duration::from_secs(1)).await);
    assert_eq!(
        control(&app, "cast:tv", json!({ "action": "play" })),
        Err(json!("notConnected"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_newest_load_is_the_one_that_plays() {
    let app = TestApp::new();
    if !crate::convert::support::support(&app.handle())
        .await
        .convert
    {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let (source, connections) = counting_source(wav16(), Duration::from_secs(3), false);
    let slow = channel("m-1", &source, "movie");
    add_channel(&app, &slow);
    let quick = channel("m-2", "http://192.0.2.1/2.mp4", "movie");
    add_channel(&app, &quick);
    let first = load_in_background(&app, &slow, converted(), None);
    wait_until("the first load's probe", || {
        connections.load(Ordering::SeqCst) >= 1
    })
    .await;
    load(&app, "cast:tv", &quick, direct("mp4"), None).unwrap();
    assert_eq!(first.join().unwrap(), Err(json!("superseded")));
    let loaded = next_of(&mut got, "LOAD").await;
    assert_eq!(loaded.body["media"]["contentId"], "http://192.0.2.1/2.mp4");
    // Nothing from the older load comes after.
    assert!(!gets(&mut got, "LOAD", Duration::from_secs(1)).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seek_through_the_converter_closes_the_old_connection_first() {
    let app = TestApp::new();
    if !crate::convert::support::support(&app.handle())
        .await
        .convert
    {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    // An account that allows one connection, and a film longer than the
    // converter's first burst, so it reads at the film's pace and keeps its
    // connection open.
    let (source, connections) = counting_source(wav16_lasting(24), Duration::ZERO, true);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    load(&app, "cast:tv", &movie, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    // The probe, then the converter, which still reads.
    assert_eq!(connections.load(Ordering::SeqCst), 2);
    assert!(ffmpeg_runs_for(&source));
    load(&app, "cast:tv", &movie, converted(), Some(2.0)).unwrap();
    next_of(&mut got, "LOAD").await;
    // The same item keeps its plan, so only the new converter connects.
    assert_eq!(connections.load(Ordering::SeqCst), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_receiver_that_couldnt_be_reached_can_be_tried_again_later() {
    let app = TestApp::new();
    let handle = app.handle();
    let receivers = handle.state::<super::CastReceivers>();
    receivers.set_unreachable_for(Duration::from_millis(300));
    // Nothing listens at this address any more.
    let gone = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    add_receiver(&app, "tv", gone);
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    assert_eq!(
        load(&app, "cast:tv", &movie, direct("mp4"), None),
        Err(json!("unreachable"))
    );
    assert!(!receivers.registry().get("cast:tv").unwrap().available);
    wait_until("it's available again", || {
        receivers.registry().get("cast:tv").unwrap().available
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_newer_load_keeps_the_session_an_older_one_opened() {
    let app = TestApp::new();
    let first = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    let second = channel("m-2", "http://192.0.2.1/2.mp4", "movie");
    add_channel(&app, &first);
    add_channel(&app, &second);
    let (addr, mut got) =
        fake_receiver::start_with(vec![fake_receiver::acceptor().0], Duration::from_secs(1)).await;
    add_receiver(&app, "tv", addr);
    let older = load_in_background(&app, &first, direct("mp4"), None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    load(&app, "cast:tv", &second, direct("mp4"), None).unwrap();
    assert_eq!(older.join().unwrap(), Err(json!("superseded")));
    let loaded = next_of(&mut got, "LOAD").await;
    assert_eq!(loaded.body["media"]["contentId"], "http://192.0.2.1/2.mp4");
    // On the one connection the older load opened.
    assert_eq!(loaded.connection, 0);
    control(&app, "cast:tv", json!({ "action": "play" })).unwrap();
}

/// Whether an ffmpeg runs that starts `url` at `seconds`.
fn ffmpeg_starts_at(url: &str, seconds: &str) -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", &format!("ss {seconds} -i {url}")])
        .status()
        .is_ok_and(|s| s.success())
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_plan_only_for_the_same_item_source_and_choices() {
    let app = TestApp::new();
    if !crate::convert::support::support(&app.handle())
        .await
        .convert
    {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let (source, connections) = counting_source(wav16(), Duration::ZERO, false);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    let handle = app.handle();
    let streams = handle.state::<crate::streams::StreamsState>();
    // Two URLs for it, both on the same server.
    let generation = streams.remember(&movie.id, vec![source.clone(), format!("{source}?2")]);
    let cast = |source: usize, video: &str, audio: &str, start: Option<f64>| {
        let route = json!({ "via": "converted", "generation": generation, "source": source,
                            "container": "mkv", "video": video, "audio": audio });
        app.invoke(
            "cast_load",
            json!({ "receiverId": "cast:tv", "channel": movie, "route": route, "startAt": start, "restart": false }),
        )
        .unwrap();
    };
    let opened = |count: usize| assert_eq!(connections.load(Ordering::SeqCst), count);
    cast(0, "copy", "aac", None);
    next_of(&mut got, "LOAD").await;
    // The probe and the converter.
    opened(2);
    // The same again, from 2 s: only the converter, which starts there.
    cast(0, "copy", "aac", Some(2.0));
    next_of(&mut got, "LOAD").await;
    opened(3);
    assert!(ffmpeg_starts_at(&source, "2.000"));
    // Each other choice probes again.
    cast(0, "copy", "copy", None);
    next_of(&mut got, "LOAD").await;
    opened(5);
    cast(0, "none", "copy", None);
    next_of(&mut got, "LOAD").await;
    opened(7);
    cast(1, "none", "copy", None);
    next_of(&mut got, "LOAD").await;
    opened(9);
    // Another item on the same URLs too.
    let other = channel("m-2", &source, "movie");
    add_channel(&app, &other);
    let generation = streams.remember(&other.id, vec![source.clone(), format!("{source}?2")]);
    let route = json!({ "via": "converted", "generation": generation, "source": 1,
                        "container": "mkv", "video": "none", "audio": "copy" });
    app.invoke(
        "cast_load",
        json!({ "receiverId": "cast:tv", "channel": other, "route": route, "startAt": null, "restart": false }),
    )
    .unwrap();
    next_of(&mut got, "LOAD").await;
    opened(11);
    // And the same item in a newer list of its URLs.
    let newer = streams.remember(&movie.id, vec![source.clone(), format!("{source}?3")]);
    let route = json!({ "via": "converted", "generation": newer, "source": 0,
                        "container": "mkv", "video": "none", "audio": "copy" });
    app.invoke(
        "cast_load",
        json!({ "receiverId": "cast:tv", "channel": movie, "route": route, "startAt": null, "restart": false }),
    )
    .unwrap();
    next_of(&mut got, "LOAD").await;
    opened(13);
}

/// Whether a converter can run here, for the tests that need one.
async fn converts(app: &TestApp) -> bool {
    crate::convert::support::support(&app.handle())
        .await
        .convert
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seek_through_the_converter_stops_the_old_media_first() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let (source, _) = counting_source(wav16(), Duration::ZERO, false);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    let events = updates(&app);
    load(&app, "cast:tv", &movie, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    // The receiver says what plays, so there's media to stop.
    loop {
        let event = events
            .recv_timeout(Duration::from_secs(10))
            .expect("the media within 10 s");
        if event["update"]["kind"] == "media" && !event["update"]["media"].is_null() {
            break;
        }
    }
    let old = ffmpeg_pids(&source);
    assert!(!old.is_empty());
    load(&app, "cast:tv", &movie, converted(), Some(2.0)).unwrap();
    // The receiver lets go of the old media before anything else, so it
    // ends as cancelled rather than with an error from a stream that went
    // away.
    let mut next = Vec::new();
    while next.len() < 2 {
        let message = tokio::time::timeout(Duration::from_secs(10), got.recv())
            .await
            .expect("the receiver's messages within 10 s")
            .expect("the receiver's messages");
        if message.namespace == mvp_core::cast::message::NS_MEDIA && message.kind() != "GET_STATUS"
        {
            next.push(message);
        }
    }
    assert_eq!(next[0].kind(), "STOP");
    assert_eq!(next[0].body["mediaSessionId"], 1);
    assert_eq!(next[1].kind(), "LOAD");
    // The old converter is gone, and the new one starts at 2 s.
    assert!(ffmpeg_pids(&source).iter().all(|pid| !old.contains(pid)));
    assert!(ffmpeg_starts_at(&source, "2.000"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_switch_from_a_direct_item_has_no_media_to_stop() {
    let app = TestApp::new();
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let first = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    let second = channel("m-2", "http://192.0.2.1/2.mp4", "movie");
    add_channel(&app, &first);
    add_channel(&app, &second);
    load(&app, "cast:tv", &first, direct("mp4"), None).unwrap();
    next_of(&mut got, "LOAD").await;
    load(&app, "cast:tv", &second, direct("mp4"), None).unwrap();
    // The receiver swaps one for the other itself.
    loop {
        let message = tokio::time::timeout(Duration::from_secs(10), got.recv())
            .await
            .expect("the receiver's messages within 10 s")
            .expect("the receiver's messages");
        assert_ne!(message.kind(), "STOP");
        if message.kind() == "LOAD" {
            assert_eq!(message.body["media"]["contentId"], "http://192.0.2.1/2.mp4");
            break;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_cast_of_the_same_item_probes_it_again() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let (source, connections) = counting_source(wav16(), Duration::ZERO, false);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    load(&app, "cast:tv", &movie, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    // The probe and the converter.
    assert_eq!(connections.load(Ordering::SeqCst), 2);
    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    // The channel's tracks may have changed since, so the next cast looks
    // at them again.
    load(&app, "cast:tv", &movie, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    assert_eq!(connections.load(Ordering::SeqCst), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_converter_that_couldnt_start_probes_again_next_time() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    // The provider turns away the seek's converter, and again when it asks
    // once more.
    let (source, connections) = refusing_source(wav16(), Duration::ZERO, false, vec![2, 3]);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    load(&app, "cast:tv", &movie, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    assert_eq!(
        load(&app, "cast:tv", &movie, converted(), Some(2.0)),
        Err(json!("refused"))
    );
    assert_eq!(connections.load(Ordering::SeqCst), 4);
    // The plan that just failed isn't tried again as it was.
    load(&app, "cast:tv", &movie, converted(), Some(2.0)).unwrap();
    next_of(&mut got, "LOAD").await;
    assert_eq!(connections.load(Ordering::SeqCst), 6);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seek_the_provider_turns_away_once_asks_again() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    // The provider still counts the old connection a moment after it
    // closed, so it turns away the seek's converter once.
    let (source, connections) = refusing_source(wav16(), Duration::ZERO, false, vec![2]);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    load(&app, "cast:tv", &movie, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    load(&app, "cast:tv", &movie, converted(), Some(2.0)).unwrap();
    next_of(&mut got, "LOAD").await;
    assert_eq!(connections.load(Ordering::SeqCst), 4);
    // A first cast closed nothing, so a refusal there is the answer.
    let (refused, connections) = refusing_source(wav16(), Duration::ZERO, false, vec![0]);
    let other = channel("m-2", &refused, "movie");
    add_channel(&app, &other);
    app.invoke("cast_stop", json!({ "receiverId": "cast:tv" }))
        .unwrap();
    assert_eq!(
        load(&app, "cast:tv", &other, converted(), None),
        Err(json!("refused"))
    );
    assert_eq!(connections.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_converter_that_failed_while_it_cast_probes_again_next_time() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let events = updates(&app);
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    let (source, connections) = counting_source(wav16(), Duration::ZERO, false);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    load(&app, "cast:tv", &movie, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    assert_eq!(connections.load(Ordering::SeqCst), 2);
    std::process::Command::new("pkill")
        .args(["-9", "-f", &source])
        .status()
        .unwrap();
    loop {
        let event = events
            .recv_timeout(Duration::from_secs(10))
            .expect("the failure within 10 s");
        if event["update"]["kind"] == "conversionFailed" {
            break;
        }
    }
    load(&app, "cast:tv", &movie, converted(), Some(2.0)).unwrap();
    next_of(&mut got, "LOAD").await;
    assert_eq!(connections.load(Ordering::SeqCst), 4);
}

/// The ids of the ffmpeg processes that read `url`.
fn ffmpeg_pids(url: &str) -> Vec<String> {
    let out = std::process::Command::new("pgrep")
        .args(["-f", url])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_channel_that_dropped_starts_again_without_a_probe() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let events = updates(&app);
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    // A channel whose connection closes after eight seconds of sound.
    let (source, connections) = counting_source(wav16(), Duration::ZERO, false);
    let live = channel("l-1", &source, "live");
    add_channel(&app, &live);
    load(&app, "cast:tv", &live, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    // The probe and the converter.
    assert_eq!(connections.load(Ordering::SeqCst), 2);
    let dropped = next_update(&events, "conversionStopped");
    assert_eq!(dropped["update"]["why"], "dropped");
    // Its tracks are the same as a moment ago, so only the converter asks.
    load(&app, "cast:tv", &live, converted(), None).unwrap();
    next_of(&mut got, "LOAD").await;
    assert_eq!(connections.load(Ordering::SeqCst), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_newer_load_waits_until_the_one_it_overtook_lets_go_of_the_provider() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    // An account that allows one connection, and a source that holds back
    // its sound, so the converter waits on it.
    let (source, connections) = counting_source(wav16(), Duration::from_secs(4), true);
    let movie = channel("m-1", &source, "movie");
    add_channel(&app, &movie);
    let first = load_in_background(&app, &movie, converted(), None);
    // The probe, then the converter, which waits.
    wait_until("the converter's connection", || {
        connections.load(Ordering::SeqCst) >= 2
    })
    .await;
    // A seek, say, meanwhile.
    let second = load_in_background(&app, &movie, converted(), Some(2.0));
    let asked = std::time::Instant::now();
    // The first gives up at once rather than when its source answers.
    assert_eq!(first.join().unwrap(), Err(json!("superseded")));
    assert!(
        asked.elapsed() < Duration::from_millis(2500),
        "{:?}",
        asked.elapsed()
    );
    // The second's connections never overlap the first's, so none is turned
    // away.
    second.join().unwrap().unwrap();
    let loaded = next_of(&mut got, "LOAD").await;
    assert!(loaded.body["media"]["contentId"].is_string());
    assert!(ffmpeg_starts_at(&source, "2.000"));
}

/// Has stopped conversions wait before they kill ffmpeg, until dropped.
struct SlowKill;

impl SlowKill {
    fn new(delay: Duration) -> Self {
        let ms = u64::try_from(delay.as_millis()).unwrap();
        crate::convert::KILL_DELAY_MS.store(ms, Ordering::SeqCst);
        Self
    }
}

impl Drop for SlowKill {
    fn drop(&mut self) {
        crate::convert::KILL_DELAY_MS.store(0, Ordering::SeqCst);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_overtaken_load_lets_go_of_the_provider_before_it_returns() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    // A receiver that takes a second to answer, so the newer load comes
    // while the first connects with its converter running.
    let (addr, mut got, receiver) = fake_receiver::start_controlled(Duration::from_secs(1)).await;
    add_receiver(&app, "tv", addr);
    let (source, connections) = counting_source(wav16_lasting(24), Duration::ZERO, false);
    let film = channel("m-1", &source, "movie");
    let other = channel("m-2", "http://192.0.2.1/2.mp4", "movie");
    add_channel(&app, &film);
    add_channel(&app, &other);
    // A stopped ffmpeg takes a moment to go, so a load that only dropped it
    // would return while it still runs.
    let _slow = SlowKill::new(Duration::from_millis(1500));
    let first = load_in_background(&app, &film, converted(), None);
    // Its converter runs, and it connects to the receiver.
    wait_until("the connection to the receiver", || {
        receiver.accepted() >= 1
    })
    .await;
    assert_eq!(connections.load(Ordering::SeqCst), 2);
    load(&app, "cast:tv", &other, direct("mp4"), None).unwrap();
    assert_eq!(first.join().unwrap(), Err(json!("superseded")));
    // Its ffmpeg exited before it let the newer load go on.
    assert!(!ffmpeg_runs_for(&source));
    let loaded = next_of(&mut got, "LOAD").await;
    assert_eq!(loaded.body["media"]["contentId"], "http://192.0.2.1/2.mp4");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_waits_for_an_overtaken_load_to_let_go_of_the_provider() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let (addr, _got, receiver) = fake_receiver::start_controlled(Duration::from_secs(1)).await;
    add_receiver(&app, "tv", addr);
    let (source, connections) = counting_source(wav16_lasting(24), Duration::ZERO, false);
    let film = channel("m-1", &source, "movie");
    add_channel(&app, &film);
    let _slow = SlowKill::new(Duration::from_millis(1500));
    let first = load_in_background(&app, &film, converted(), None);
    // Its converter runs, and it connects to the receiver.
    wait_until("the connection to the receiver", || {
        receiver.accepted() >= 1
    })
    .await;
    assert_eq!(connections.load(Ordering::SeqCst), 2);
    // The load under way gives up, and lets go of the provider, before the
    // release answers, whether or not it had opened a session to release.
    let _ = app.invoke("cast_release", json!({ "receiverId": "cast:tv" }));
    assert!(!ffmpeg_runs_for(&source));
    assert_eq!(first.join().unwrap(), Err(json!("superseded")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_whose_cast_ended_while_it_started_opens_none() {
    let app = TestApp::new();
    if !converts(&app).await {
        return;
    }
    let (addr, mut got, first) = fake_receiver::start_controlled(Duration::ZERO).await;
    add_receiver(&app, "tv", addr);
    let movie = channel("m-1", "http://192.0.2.1/1.mp4", "movie");
    add_channel(&app, &movie);
    load(&app, "cast:tv", &movie, direct("mp4"), None).unwrap();
    next_of(&mut got, "LOAD").await;
    // A converted restart whose source takes a while to answer.
    let (source, connections) = counting_source(wav16(), Duration::from_secs(2), false);
    let slow = channel("m-2", &source, "movie");
    add_channel(&app, &slow);
    let generation = app
        .handle()
        .state::<crate::streams::StreamsState>()
        .remember(&slow.id, vec![slow.url.clone()]);
    let mut route = converted();
    route["generation"] = json!(generation);
    let handle = app.handle();
    let args = json!({ "receiverId": "cast:tv", "channel": slow, "route": route,
                       "startAt": null, "restart": true });
    let restarting =
        std::thread::spawn(move || crate::test_support::invoke_on(&handle, "cast_load", args));
    wait_until("the probe's connection", || {
        connections.load(Ordering::SeqCst) >= 1
    })
    .await;
    // The receiver ends the cast meanwhile.
    first.hang_up();
    assert_eq!(restarting.join().unwrap(), Err(json!("notConnected")));
    assert!(!ffmpeg_runs_for(&source));
    // It never connected again.
    let opened = tokio::time::timeout(Duration::from_millis(500), async {
        while let Some(message) = got.recv().await {
            if message.connection > 0 {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(!opened);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_newer_load_doesnt_wait_out_a_playlist_that_never_answers() {
    let app = TestApp::new();
    let (addr, _, mut got) = fake_receiver::start().await;
    add_receiver(&app, "tv", addr);
    // A provider that takes the connection and never answers.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let silent = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let held: Vec<_> = listener.incoming().flatten().collect();
        drop(held);
    });
    let stuck = channel("l-1", &format!("http://{silent}/live/1.m3u8"), "live");
    let other = channel("m-2", "http://192.0.2.1/2.mp4", "movie");
    add_channel(&app, &stuck);
    add_channel(&app, &other);
    let first = load_in_background(&app, &stuck, direct("hls-ts"), None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let asked = std::time::Instant::now();
    load(&app, "cast:tv", &other, direct("mp4"), None).unwrap();
    assert!(
        asked.elapsed() < Duration::from_secs(2),
        "{:?}",
        asked.elapsed()
    );
    assert_eq!(first.join().unwrap(), Err(json!("superseded")));
    let loaded = next_of(&mut got, "LOAD").await;
    assert_eq!(loaded.body["media"]["contentId"], "http://192.0.2.1/2.mp4");
}
