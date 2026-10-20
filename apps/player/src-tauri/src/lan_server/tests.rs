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

/// Waits up to five seconds for `future`. A broken feed fails the test
/// then, instead of leaving it waiting for a piece that never comes.
async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("done within 5 s")
}

/// Reads `response` until it has `n` bytes.
async fn read_bytes(response: &mut reqwest::Response, n: usize) -> Vec<u8> {
    let mut body = Vec::new();
    while body.len() < n {
        let chunk = within(response.chunk())
            .await
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
    within(feed.push(piece(1), false)).await;
    within(feed.push(piece(2), true)).await;
    within(feed.push(piece(3), false)).await;
    let mut response = within(test_server::client().get(&url).send())
        .await
        .unwrap();
    assert_eq!(response.headers()["content-type"], "video/x-matroska");
    assert!(response.headers().get("content-length").is_none());
    within(feed.push(piece(4), true)).await;
    assert_eq!(
        read_bytes(&mut response, 16).await,
        [b"HEAD".to_vec(), piece(2), piece(3), piece(4)].concat()
    );

    // A HEAD request gets the head and no body.
    let head = test_server::client().head(&url).send().await.unwrap();
    assert_eq!(head.status(), 200);
    assert!(head.bytes().await.unwrap().is_empty());

    // The feed ending ends the response once it has everything.
    within(feed.push(piece(4), false)).await;
    feed.end();
    assert_eq!(read_bytes(&mut response, 4).await, piece(4));
    assert!(within(response.chunk()).await.unwrap().is_none());
}

#[tokio::test]
async fn a_request_that_comes_later_starts_at_the_last_start_point_sent() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = feed(1 << 20, true);
    let url = server.set_live("stream.mkv", feed.clone());
    let mut first = within(test_server::client().get(&url).send())
        .await
        .unwrap();
    for (byte, start) in [(1, true), (2, false), (3, true), (4, false)] {
        within(feed.push(piece(byte), start)).await;
    }
    read_bytes(&mut first, 20).await;
    drop(first);
    // It starts from the third piece, the last start point sent.
    let mut again = within(test_server::client().get(&url).send())
        .await
        .unwrap();
    assert_eq!(
        read_bytes(&mut again, 12).await,
        [b"HEAD".to_vec(), piece(3), piece(4)].concat()
    );
    within(feed.push(piece(5), false)).await;
    assert_eq!(read_bytes(&mut again, 4).await, piece(5));
}

#[tokio::test]
async fn a_request_with_no_start_point_kept_waits_for_the_next() {
    let server = LanServer::start(LOOPBACK).await.unwrap();
    let feed = feed(1 << 20, true);
    let url = server.set_live("stream.mkv", feed.clone());
    within(feed.push(piece(1), false)).await;
    let mut response = within(test_server::client().get(&url).send())
        .await
        .unwrap();
    within(feed.push(piece(2), false)).await;
    within(feed.push(piece(3), true)).await;
    within(feed.push(piece(4), false)).await;
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
        within(feed.push(piece(byte), start)).await;
    }
    let mut response = within(test_server::client().get(&url).send())
        .await
        .unwrap();
    assert_eq!(
        read_bytes(&mut response, 12).await,
        [b"HEAD".to_vec(), piece(4), piece(5)].concat()
    );
}

#[tokio::test]
async fn keeps_only_what_a_request_needs_or_starts_from() {
    let feed = feed(1 << 20, true);
    let mut reader = feed.reader();
    for (byte, start) in [(1, true), (2, false), (3, true), (4, false)] {
        within(feed.push(piece(byte), start)).await;
        within(reader.next()).await.unwrap();
    }
    within(feed.push(piece(5), false)).await;
    // The third piece is where a new request starts.
    let state = feed.state();
    assert_eq!((state.first, state.bytes), (2, 12));
}

#[tokio::test]
async fn a_request_that_comes_later_counts_the_last_piece_sent() {
    let feed = feed(1 << 20, true);
    let mut first = feed.reader();
    for (byte, start) in [(1, true), (2, false), (3, true)] {
        within(feed.push(piece(byte), start)).await;
        within(first.next()).await.unwrap();
    }
    let mut later = feed.reader();
    assert_eq!(*within(later.next()).await.unwrap(), piece(3)[..]);
}

#[tokio::test]
async fn a_request_that_skips_to_a_start_point_makes_room_for_it() {
    let feed = feed(8, false);
    let mut reader = feed.reader();
    within(feed.push(piece(1), false)).await;
    within(feed.push(piece(2), false)).await;
    // The feed is full, but the request skips what it holds, so it's
    // dropped to make room.
    let pusher = tokio::spawn({
        let feed = feed.clone();
        async move { feed.push(piece(3), true).await }
    });
    tokio::task::yield_now().await;
    let next = within(reader.next()).await.unwrap();
    assert_eq!(*next, piece(3)[..]);
    within(pusher).await.unwrap();
}

/// A waker that notes whether it was woken.
#[derive(Default)]
struct Woken(std::sync::atomic::AtomicBool);

impl std::task::Wake for Woken {
    fn wake(self: Arc<Self>) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[test]
fn a_full_feed_sleeps_until_its_request_moves_on() {
    use std::future::Future;
    let woken = Arc::new(Woken::default());
    let waker = std::task::Waker::from(woken.clone());
    let mut cx = std::task::Context::from_waker(&waker);
    let feed = feed(8, false);
    let mut reader = feed.reader();
    for (byte, start) in [(1, true), (2, false)] {
        let push = std::pin::pin!(feed.push(piece(byte), start));
        assert!(push.poll(&mut cx).is_ready());
    }
    // The request hasn't taken the first piece yet.
    let mut push = std::pin::pin!(feed.push(piece(3), false));
    assert!(push.as_mut().poll(&mut cx).is_pending());
    assert!(!woken.0.load(std::sync::atomic::Ordering::SeqCst));
    let next = std::pin::pin!(reader.next());
    assert!(next.poll(&mut cx).is_ready());
    assert!(woken.0.load(std::sync::atomic::Ordering::SeqCst));
    // It drops the piece taken, then pushes.
    assert!(push.as_mut().poll(&mut cx).is_pending());
    assert!(push.poll(&mut cx).is_ready());
}

#[test]
fn each_request_keeps_its_own_place() {
    let feed = feed(1 << 20, true);
    let first = feed.reader();
    let second = feed.reader();
    assert_ne!(first.id, second.id);
    assert_eq!(feed.state().readers.len(), 2);
    drop(first);
    assert_eq!(feed.state().readers.len(), 1);
    drop(second);
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
    let mut response = within(test_server::client().get(&url).send())
        .await
        .unwrap();
    let mut body = Vec::new();
    within(async {
        while let Some(chunk) = response.chunk().await.unwrap() {
            body.extend_from_slice(&chunk);
            assert!(body.len() <= 4 + 200 * 16, "more than was written");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await;
    within(writer).await.unwrap();
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
        within(feed.push(vec![0; 64 << 10], true)).await;
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
    // A connection that sends nothing gets nothing, and the server closes it
    // once its time to send a request runs out.
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
    let mut response = within(test_server::client().get(&url).send())
        .await
        .unwrap();
    assert_eq!(read_bytes(&mut response, 4).await, b"HEAD");
    let address = address(&server);
    drop(server);
    // The open request ends, though its feed hasn't.
    assert!(within(response.chunk()).await.ok().flatten().is_none());
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

#[test]
fn tells_a_lost_connection_from_a_lost_socket() {
    use std::io::{Error, ErrorKind};
    for kind in [
        ErrorKind::ConnectionAborted,
        ErrorKind::ConnectionReset,
        ErrorKind::Interrupted,
        ErrorKind::WouldBlock,
    ] {
        assert_eq!(
            after_accept(&Error::from(kind)),
            AfterAccept::Retry,
            "{kind:?}"
        );
    }
    for code in [libc::EMFILE, libc::ENFILE, libc::ENOBUFS, libc::ENOMEM] {
        assert_eq!(
            after_accept(&Error::from_raw_os_error(code)),
            AfterAccept::Pause,
            "{code}"
        );
    }
    for code in [libc::EBADF, libc::EINVAL, libc::ENOTSOCK] {
        assert_eq!(
            after_accept(&Error::from_raw_os_error(code)),
            AfterAccept::Rebind,
            "{code}"
        );
    }
}

#[test]
fn takes_the_socket_for_gone_after_losing_too_many_connections_in_a_row() {
    use std::io::{Error, ErrorKind};
    let aborted = || Error::from(ErrorKind::ConnectionAborted);
    let mut failures = AcceptFailures::default();
    for _ in 1..MAX_LOST {
        assert_eq!(failures.after(&aborted()), AfterAccept::Retry);
    }
    // Running out of file descriptors neither counts nor starts again.
    let full = Error::from_raw_os_error(libc::EMFILE);
    assert_eq!(failures.after(&full), AfterAccept::Pause);
    assert_eq!(failures.after(&aborted()), AfterAccept::Rebind);
    // The count starts again after listening again, or an accept.
    for _ in 1..MAX_LOST {
        assert_eq!(failures.after(&aborted()), AfterAccept::Retry);
    }
    failures.accepted();
    for _ in 1..MAX_LOST {
        assert_eq!(failures.after(&aborted()), AfterAccept::Retry);
    }
    let gone = Error::from_raw_os_error(libc::EBADF);
    assert_eq!(failures.after(&gone), AfterAccept::Rebind);
    for _ in 1..MAX_LOST {
        assert_eq!(failures.after(&aborted()), AfterAccept::Retry);
    }
    assert_eq!(failures.after(&aborted()), AfterAccept::Rebind);
}

/// What a request from `source` for `path` gets back.
#[cfg(target_os = "linux")]
async fn get_from(source: IpAddr, server: &LanServer, path: &str) -> std::io::Result<Vec<u8>> {
    let socket = tokio::net::TcpSocket::new_v4()?;
    socket.bind(SocketAddr::new(source, 0))?;
    let mut socket = socket.connect(address(server).parse().unwrap()).await?;
    socket
        .write_all(format!("GET {path} HTTP/1.1\r\n\r\n").as_bytes())
        .await?;
    let mut reply = Vec::new();
    socket.read_to_end(&mut reply).await?;
    Ok(reply)
}

/// Takes the listening socket away as iOS does from a suspended app: every
/// accept fails from then on.
#[cfg(target_os = "linux")]
fn take_socket(fd: std::os::fd::RawFd) {
    // SAFETY: shutdown takes any descriptor and changes no memory.
    assert_eq!(unsafe { libc::shutdown(fd, libc::SHUT_RDWR) }, 0);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn listens_again_where_it_was_after_losing_its_socket() {
    let receiver = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2));
    let server = LanServer::start(receiver).await.unwrap();
    server.files.put("a.vtt", "text/vtt", b"WEBVTT\n".to_vec());
    let path = server
        .url("a.vtt")
        .strip_prefix(&format!("http://{}", address(&server)))
        .unwrap()
        .to_string();
    take_socket(server.fd);
    let reply = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match get_from(receiver, &server, &path).await {
                Ok(reply) if !reply.is_empty() => break reply,
                _ => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    })
    .await
    .expect("the server listens again");
    assert!(reply.ends_with(b"WEBVTT\n"));
    // Still only for the receiver, and only under its token.
    assert!(get_from(LOOPBACK, &server, &path)
        .await
        .unwrap_or_default()
        .is_empty());
    let wrong = path.replace("/cast/", "/cast/0");
    assert!(get_from(receiver, &server, &wrong)
        .await
        .unwrap_or_default()
        .is_empty());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn stopping_ends_a_server_waiting_to_listen_again() {
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let fd = std::os::fd::AsRawFd::as_raw_fd(&listener);
    // Somewhere else holds the address it would listen on again.
    let held = std::net::TcpListener::bind((LOOPBACK, 0)).unwrap();
    let address = held.local_addr().unwrap();
    let task = tokio::spawn(serve(
        listener,
        address,
        Peers::Receiver(LOOPBACK),
        "/cast/token/".to_string(),
        Files::default(),
        Arc::new(RwLock::new(None)),
    ));
    take_socket(fd);
    // Long enough to fail to listen again at least once.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!task.is_finished());
    // What dropping the server does.
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    drop(held);
    tokio::time::sleep(REBIND_PAUSE * 2).await;
    // Nothing went on to take the address once it was free.
    std::net::TcpListener::bind(address).unwrap();
}
