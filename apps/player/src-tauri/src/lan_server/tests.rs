// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The server on loopback, with a live pipe fed by hand.

use super::*;
use mvp_core::http::test_server;

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

fn element(cluster: bool, byte: u8) -> Arc<Piece> {
    Arc::new(Piece::Element {
        bytes: vec![byte; 4],
        cluster,
    })
}

/// The server's `host:port`.
fn address(server: &LanServer) -> String {
    server
        .base
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .to_string()
}

/// What a raw request gets back before the server closes the connection.
async fn raw(server: &LanServer, request: &[u8]) -> Vec<u8> {
    let mut socket = TcpStream::connect(address(server)).await.unwrap();
    socket.write_all(request).await.unwrap();
    let mut reply = Vec::new();
    let _ = socket.read_to_end(&mut reply).await;
    reply
}

#[tokio::test]
async fn serves_a_live_pipe_from_the_next_start_point() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let (pieces, _) = broadcast::channel(16);
    let url = server.set_live(
        "stream.mkv",
        LivePipe {
            content_type: "video/x-matroska",
            header: b"HEAD".to_vec(),
            pieces: pieces.subscribe(),
        },
    );
    assert_eq!(url, format!("{}stream.mkv", server.base));
    assert!(server.base.starts_with("http://127.0.0.1:"));
    let token = server
        .base
        .split("/cast/")
        .nth(1)
        .unwrap()
        .trim_end_matches('/');
    assert_eq!(token.len(), 64);

    let mut response = test_server::client().get(&url).send().await.unwrap();
    assert_eq!(response.headers()["content-type"], "video/x-matroska");
    assert!(response.headers().get("content-length").is_none());
    // The request is in once the head is back. A piece that isn't a start
    // point is skipped, and everything from the next one on comes through.
    pieces.send(element(false, 1)).unwrap();
    pieces.send(Arc::new(Piece::Header(b"x".to_vec()))).unwrap();
    pieces.send(element(true, 2)).unwrap();
    pieces.send(element(false, 3)).unwrap();
    let mut body = Vec::new();
    while body.len() < 12 {
        body.extend_from_slice(&response.chunk().await.unwrap().unwrap());
    }
    assert_eq!(body, b"HEAD\x02\x02\x02\x02\x03\x03\x03\x03");

    // A HEAD request gets the head and no body.
    let head = test_server::client().head(&url).send().await.unwrap();
    assert_eq!(head.status(), 200);
    assert!(head.bytes().await.unwrap().is_empty());

    // The pipe ending ends the response.
    drop(pieces);
    assert!(response.chunk().await.unwrap().is_none());
}

#[tokio::test]
async fn a_receiver_that_falls_behind_is_dropped() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let (pieces, _) = broadcast::channel(1);
    let url = server.set_live(
        "stream.mkv",
        LivePipe {
            content_type: "video/x-matroska",
            header: vec![],
            pieces: pieces.subscribe(),
        },
    );
    let mut response = test_server::client().get(&url).send().await.unwrap();
    for byte in 0..8 {
        pieces.send(element(true, byte)).unwrap();
    }
    // It may get a piece or two before the lag shows, then the end.
    let mut ended = false;
    for _ in 0..8 {
        if response.chunk().await.ok().flatten().is_none() {
            ended = true;
            break;
        }
    }
    assert!(ended);
}

#[tokio::test]
async fn serves_named_files_that_change_while_it_runs() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let client = test_server::client();
    server.files.put(
        "index.m3u8",
        "application/vnd.apple.mpegurl",
        b"#EXTM3U\n".to_vec(),
    );
    let playlist = client.get(server.url("index.m3u8")).send().await.unwrap();
    assert_eq!(
        playlist.headers()["content-type"],
        "application/vnd.apple.mpegurl"
    );
    assert_eq!(playlist.headers()["content-length"], "8");
    assert_eq!(playlist.headers()["access-control-allow-origin"], "*");
    assert_eq!(playlist.bytes().await.unwrap().as_ref(), b"#EXTM3U\n");

    server.files.put(
        "index.m3u8",
        "application/vnd.apple.mpegurl",
        b"#EXTM3U\n#2\n".to_vec(),
    );
    let playlist = client.get(server.url("index.m3u8")).send().await.unwrap();
    assert_eq!(playlist.bytes().await.unwrap().as_ref(), b"#EXTM3U\n#2\n");
    let head = client.head(server.url("index.m3u8")).send().await.unwrap();
    assert_eq!(head.headers()["content-length"], "11");
    assert!(head.bytes().await.unwrap().is_empty());

    server.files.remove("index.m3u8");
    assert!(client.get(server.url("index.m3u8")).send().await.is_err());
}

#[tokio::test]
async fn answers_nothing_outside_its_token() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    server.files.put("a.vtt", "text/vtt", b"WEBVTT\n".to_vec());
    let client = test_server::client();
    let wrong = server.url("a.vtt").replace("/cast/", "/cast/0");
    assert!(client.get(&wrong).send().await.is_err());
    let root = format!("http://{}/a.vtt", address(&server));
    assert!(client.get(&root).send().await.is_err());
    assert!(client.post(server.url("a.vtt")).send().await.is_err());
    // No pipe was set, so its name is just a missing file.
    assert!(client.get(server.url("stream.mkv")).send().await.is_err());
    // A head that never ends, or one with nothing in it, gets nothing.
    assert!(raw(&server, &vec![b'a'; MAX_HEAD + 1024]).await.is_empty());
    assert!(raw(&server, b"GET\r\n\r\n").await.is_empty());
    // A connection that closes at once gets nothing either.
    assert!(raw(&server, b"").await.is_empty());
}

#[tokio::test]
async fn stops_when_dropped_and_ends_its_requests() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let (pieces, _) = broadcast::channel(4);
    let url = server.set_live(
        "stream.mkv",
        LivePipe {
            content_type: "video/x-matroska",
            header: b"HEAD".to_vec(),
            pieces: pieces.subscribe(),
        },
    );
    let mut response = test_server::client().get(&url).send().await.unwrap();
    assert_eq!(response.chunk().await.unwrap().unwrap().as_ref(), b"HEAD");
    let address = address(&server);
    drop(server);
    // The open request ends, though its pipe hasn't.
    assert!(response.chunk().await.ok().flatten().is_none());
    drop(pieces);
    assert!(TcpStream::connect(&address).await.is_err());
}

/// Every loopback address reaches this computer on Linux, so 127.0.0.2 can
/// stand in for a receiver that isn't the client.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn answers_only_the_receiver() {
    let server = LanServer::start(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)))
        .await
        .unwrap();
    server.files.put("a.vtt", "text/vtt", b"WEBVTT\n".to_vec());
    // This client connects from 127.0.0.1.
    assert!(test_server::client()
        .get(server.url("a.vtt"))
        .send()
        .await
        .is_err());
}

#[tokio::test]
async fn a_subnet_server_listens_where_it_was_told_and_answers_the_subnet() {
    let server = LanServer::start_for(Peers::Subnet {
        local: Ipv4Addr::LOCALHOST,
        prefix: 8,
    })
    .await;
    assert_eq!(server.err(), Some(NoRoute));
    let server = LanServer::start_for(Peers::Subnet {
        local: Ipv4Addr::LOCALHOST,
        prefix: 16,
    })
    .await
    .unwrap();
    assert!(server.base.starts_with("http://127.0.0.1:"));
    server.files.put("a.vtt", "text/vtt", b"WEBVTT\n".to_vec());
    let body = test_server::client()
        .get(server.url("a.vtt"))
        .send()
        .await
        .unwrap();
    assert_eq!(body.bytes().await.unwrap().as_ref(), b"WEBVTT\n");
    assert_eq!(
        LanServer::start_for(Peers::Subnet {
            local: Ipv4Addr::LOCALHOST,
            prefix: 33
        })
        .await
        .err(),
        Some(NoRoute)
    );
}

#[test]
fn a_subnet_allows_its_own_addresses_only() {
    let home = Peers::Subnet {
        local: Ipv4Addr::new(192, 168, 1, 20),
        prefix: 24,
    };
    for (peer, allowed) in [
        ("192.168.1.20", true),
        ("192.168.1.1", true),
        ("192.168.1.255", true),
        ("192.168.2.20", false),
        ("10.0.0.1", false),
        ("::1", false),
    ] {
        assert_eq!(home.allows(peer.parse().unwrap()), allowed, "{peer}");
    }
    let single = Peers::Subnet {
        local: Ipv4Addr::new(192, 168, 1, 20),
        prefix: 32,
    };
    assert!(single.allows("192.168.1.20".parse().unwrap()));
    assert!(!single.allows("192.168.1.21".parse().unwrap()));
    let wide = Peers::Subnet {
        local: Ipv4Addr::new(172, 16, 5, 1),
        prefix: 16,
    };
    assert!(wide.allows("172.16.200.9".parse().unwrap()));
    assert!(!wide.allows("172.17.0.1".parse().unwrap()));
    let receiver = Peers::Receiver("192.168.1.30".parse().unwrap());
    assert!(receiver.allows("192.168.1.30".parse().unwrap()));
    assert!(!receiver.allows("192.168.1.31".parse().unwrap()));
    assert_eq!(MIN_PREFIX, 16);
}

#[test]
fn finds_the_route_to_a_receiver() {
    assert_eq!(route_to(LOOPBACK), Ok(LOOPBACK));
    let v6 = IpAddr::V6(std::net::Ipv6Addr::LOCALHOST);
    assert_eq!(route_to(v6), Ok(v6));
    assert_eq!(
        NoRoute.to_string(),
        "this device has no network address the receiver can reach"
    );
}
