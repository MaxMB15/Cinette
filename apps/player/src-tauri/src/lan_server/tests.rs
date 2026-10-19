// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The server on loopback, with a live pipe fed by hand.

use super::*;
use mvp_core::http::test_server;

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// A feed of at most `cap` bytes, with the header `HEAD`.
fn feed(cap: usize, live: bool) -> LiveFeed {
    LiveFeed::new("video/x-matroska", b"HEAD".to_vec(), cap, live)
}

/// Four bytes of `byte`.
fn piece(byte: u8) -> Vec<u8> {
    vec![byte; 4]
}

/// Reads `response` until it has `n` bytes.
async fn read_bytes(response: &mut reqwest::Response, n: usize) -> Vec<u8> {
    let mut body = Vec::new();
    while body.len() < n {
        let chunk = tokio::time::timeout(Duration::from_secs(10), response.chunk())
            .await
            .expect("more of the stream within 10 s")
            .unwrap()
            .expect("the stream goes on");
        body.extend_from_slice(&chunk);
    }
    body
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
async fn the_first_request_gets_the_stream_from_its_first_piece() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = feed(1 << 20, false);
    let url = server.set_live("stream.mkv", feed.clone());
    assert_eq!(url, format!("{}stream.mkv", server.base));
    assert!(server.base.starts_with("http://127.0.0.1:"));
    let token = server
        .base
        .split("/cast/")
        .nth(1)
        .unwrap()
        .trim_end_matches('/');
    assert_eq!(token.len(), 64);

    // Pieces written before anyone asks are kept for the first request,
    // from the first start point.
    feed.push(piece(1), false).await;
    feed.push(piece(2), true).await;
    feed.push(piece(3), false).await;
    let mut response = test_server::client().get(&url).send().await.unwrap();
    assert_eq!(response.headers()["content-type"], "video/x-matroska");
    assert!(response.headers().get("content-length").is_none());
    feed.push(piece(4), true).await;
    assert_eq!(
        read_bytes(&mut response, 16).await,
        [b"HEAD".to_vec(), piece(2), piece(3), piece(4)].concat()
    );

    // A HEAD request gets the head and no body.
    let head = test_server::client().head(&url).send().await.unwrap();
    assert_eq!(head.status(), 200);
    assert!(head.bytes().await.unwrap().is_empty());

    // The feed ending ends the response once it has everything.
    feed.push(piece(4), false).await;
    feed.end();
    assert_eq!(read_bytes(&mut response, 4).await, piece(4));
    assert!(response.chunk().await.unwrap().is_none());
}

#[tokio::test]
async fn a_request_that_comes_later_starts_at_the_last_start_point_sent() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = feed(1 << 20, true);
    let url = server.set_live("stream.mkv", feed.clone());
    let mut first = test_server::client().get(&url).send().await.unwrap();
    for (byte, start) in [(1, true), (2, false), (3, true), (4, false)] {
        feed.push(piece(byte), start).await;
    }
    read_bytes(&mut first, 20).await;
    drop(first);
    // It starts from the third piece, the last start point sent.
    let mut again = test_server::client().get(&url).send().await.unwrap();
    assert_eq!(
        read_bytes(&mut again, 12).await,
        [b"HEAD".to_vec(), piece(3), piece(4)].concat()
    );
    feed.push(piece(5), false).await;
    assert_eq!(read_bytes(&mut again, 4).await, piece(5));
}

#[tokio::test]
async fn a_request_with_no_start_point_kept_waits_for_the_next() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = feed(1 << 20, true);
    let url = server.set_live("stream.mkv", feed.clone());
    feed.push(piece(1), false).await;
    let mut response = test_server::client().get(&url).send().await.unwrap();
    feed.push(piece(2), false).await;
    feed.push(piece(3), true).await;
    feed.push(piece(4), false).await;
    assert_eq!(
        read_bytes(&mut response, 12).await,
        [b"HEAD".to_vec(), piece(3), piece(4)].concat()
    );
}

#[tokio::test]
async fn a_live_feed_no_one_reads_drops_its_oldest_pieces_to_a_start_point() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = feed(12, true);
    let url = server.set_live("stream.mkv", feed.clone());
    for (byte, start) in [(1, true), (2, false), (3, false), (4, true), (5, false)] {
        // Never waits, though the feed holds only three.
        tokio::time::timeout(Duration::from_secs(5), feed.push(piece(byte), start))
            .await
            .unwrap();
    }
    let mut response = test_server::client().get(&url).send().await.unwrap();
    assert_eq!(
        read_bytes(&mut response, 12).await,
        [b"HEAD".to_vec(), piece(4), piece(5)].concat()
    );
}

#[tokio::test]
async fn a_file_waits_for_its_reader_who_gets_every_byte_in_order() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = feed(64, false);
    let url = server.set_live("stream.mkv", feed.clone());
    let written = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let writer = {
        let (feed, written) = (feed.clone(), written.clone());
        tokio::spawn(async move {
            for i in 0..200u8 {
                feed.push(vec![i; 16], i % 10 == 0).await;
                written.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            feed.end();
        })
    };
    // With no one reading, the writer stops once the feed is full.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(written.load(std::sync::atomic::Ordering::SeqCst), 4);
    let mut response = test_server::client().get(&url).send().await.unwrap();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.unwrap() {
        body.extend_from_slice(&chunk);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    writer.await.unwrap();
    let expected: Vec<u8> = (0..200u8).flat_map(|i| [i; 16]).collect();
    assert_eq!(&body[..4], b"HEAD");
    assert!(body[4..] == expected[..], "every piece, in order");
}

#[tokio::test]
async fn a_receiver_that_stops_reading_is_dropped_and_counted() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = LiveFeed::with_write_limit(
        "video/x-matroska",
        vec![],
        64 << 20,
        false,
        Duration::from_millis(200),
    );
    let mut stalls = feed.stalls();
    let url = server.set_live("stream.mkv", feed.clone());
    let path = url
        .strip_prefix(&format!("http://{}", address(&server)))
        .unwrap();
    // A request that never reads its answer.
    let mut socket = TcpStream::connect(address(&server)).await.unwrap();
    socket
        .write_all(format!("GET {path} HTTP/1.1\r\n\r\n").as_bytes())
        .await
        .unwrap();
    for _ in 0..256 {
        feed.push(vec![0; 64 << 10], true).await;
    }
    tokio::time::timeout(Duration::from_secs(10), stalls.changed())
        .await
        .expect("the stall is counted")
        .unwrap();
    assert_eq!(*stalls.borrow(), 1);
    drop(socket);
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

/// What a request sent in two parts gets back, with a pause between them.
async fn in_two_parts(server: &LanServer, first: &[u8], rest: &[u8]) -> Vec<u8> {
    let mut socket = TcpStream::connect(address(server)).await.unwrap();
    socket.write_all(first).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    // The server may have closed the connection already.
    let _ = socket.write_all(rest).await;
    let mut reply = Vec::new();
    let _ = socket.read_to_end(&mut reply).await;
    reply
}

#[tokio::test]
async fn answers_a_head_that_arrives_in_parts_up_to_its_limit() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    server.files.put("a.vtt", "text/vtt", b"WEBVTT\n".to_vec());
    let host = format!("http://{}", address(&server));
    let line = format!(
        "GET {} HTTP/1.1\r\n",
        server.url("a.vtt").replacen(&host, "", 1)
    );
    let reply = in_two_parts(&server, line.as_bytes(), b"\r\n").await;
    assert!(reply.ends_with(b"WEBVTT\n"));
    // The limit is how much may arrive before the head ends.
    let mut full = format!("{line}X-Pad: ").into_bytes();
    full.resize(MAX_HEAD, b'a');
    let reply = in_two_parts(&server, &full, b"\r\n\r\n").await;
    assert!(reply.ends_with(b"WEBVTT\n"));
    full.push(b'a');
    assert!(in_two_parts(&server, &full, b"\r\n\r\n").await.is_empty());
}

#[tokio::test]
async fn stops_when_dropped_and_ends_its_requests() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = feed(1 << 20, true);
    let url = server.set_live("stream.mkv", feed.clone());
    let mut response = test_server::client().get(&url).send().await.unwrap();
    assert_eq!(read_bytes(&mut response, 4).await, b"HEAD");
    let address = address(&server);
    drop(server);
    // The open request ends, though its feed hasn't.
    assert!(response.chunk().await.ok().flatten().is_none());
    drop(feed);
    assert!(TcpStream::connect(&address).await.is_err());
}

#[tokio::test]
async fn answers_at_most_16_requests_at_once() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    server.files.put("a.vtt", "text/vtt", b"WEBVTT\n".to_vec());
    let mut idle = Vec::new();
    for _ in 0..MAX_REQUESTS {
        idle.push(TcpStream::connect(address(&server)).await.unwrap());
    }
    // Let the server take them all.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let client = test_server::client();
    assert!(client.get(server.url("a.vtt")).send().await.is_err());
    drop(idle);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let body = client.get(server.url("a.vtt")).send().await.unwrap();
    assert_eq!(body.bytes().await.unwrap().as_ref(), b"WEBVTT\n");
    assert_eq!(MAX_REQUESTS, 16);
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
