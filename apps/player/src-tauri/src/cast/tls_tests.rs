// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! TLS to fake receivers on loopback, each with its own self-signed
//! certificate.

use std::net::{IpAddr, Ipv4Addr};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::fake_receiver::acceptor;
use super::tls::{connect, TlsError};

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// A TLS server that echoes what it reads. Returns its port and certificate.
async fn echo_server() -> (u16, Vec<u8>) {
    let (acceptor, cert) = acceptor();
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut stream) = acceptor.accept(tcp).await else {
                    return;
                };
                let mut buf = [0u8; 64];
                while let Ok(n) = stream.read(&mut buf).await {
                    if n == 0 || stream.write_all(&buf[..n]).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (port, cert)
}

#[tokio::test]
async fn accepts_a_self_signed_receiver_and_pins_its_certificate() {
    let (port, cert) = echo_server().await;
    let (mut stream, presented) = connect(LOOPBACK, port, None).await.unwrap();
    assert_eq!(presented, cert);
    stream.write_all(b"hello").await.unwrap();
    let mut reply = [0u8; 5];
    stream.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"hello");

    // The same certificate again is fine.
    let (_, again) = connect(LOOPBACK, port, Some(&cert)).await.unwrap();
    assert_eq!(again, cert);
}

#[tokio::test]
async fn refuses_another_certificate_than_the_pinned_one() {
    let (port, _) = echo_server().await;
    let (other, _) = echo_server().await;
    let (_, other_cert) = connect(LOOPBACK, other, None).await.unwrap();
    assert_eq!(
        connect(LOOPBACK, port, Some(&other_cert)).await.err(),
        Some(TlsError::NotPinned)
    );
}

#[tokio::test]
async fn says_whether_nothing_answered_or_the_handshake_failed() {
    // A port nothing listens on.
    let closed = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    assert_eq!(
        connect(LOOPBACK, port, None).await.err(),
        Some(TlsError::Unreachable)
    );

    // Something that isn't TLS.
    let plain = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let port = plain.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = plain.accept().await {
            let _ = tcp.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        }
    });
    assert_eq!(
        connect(LOOPBACK, port, None).await.err(),
        Some(TlsError::Handshake)
    );
}

/// This waits out the 5 s limit.
#[tokio::test]
async fn gives_up_on_a_receiver_that_never_answers_the_handshake() {
    // It takes the connection and says nothing.
    let silent = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let port = silent.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut open = Vec::new();
        while let Ok((tcp, _)) = silent.accept().await {
            open.push(tcp);
        }
    });
    assert_eq!(
        connect(LOOPBACK, port, None).await.err(),
        Some(TlsError::Unreachable)
    );
}
