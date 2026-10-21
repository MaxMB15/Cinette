// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A fake Cast receiver on loopback for tests: TLS with a self-signed
//! certificate, answering like the Default Media Receiver, and reporting
//! each message it gets.

use std::net::SocketAddr;
use std::sync::Arc;

use mvp_core::cast::frame::{CastMessage, FrameReader, Payload};
use mvp_core::cast::message::{NS_MEDIA, NS_RECEIVER};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;

/// A message the fake got: its namespace and its JSON body, who sent it,
/// and which connection it came on, counting from 0.
#[derive(Debug, Clone)]
pub struct Got {
    pub namespace: String,
    pub body: Value,
    pub source: String,
    pub connection: usize,
}

impl Got {
    pub fn kind(&self) -> &str {
        self.body["type"].as_str().unwrap_or_default()
    }
}

/// A TLS acceptor with a new self-signed certificate, and that certificate.
pub fn acceptor() -> (TlsAcceptor, Vec<u8>) {
    let certified = rcgen::generate_simple_self_signed(vec!["receiver.local".into()]).unwrap();
    let cert: CertificateDer<'static> = certified.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        certified.signing_key.serialize_der(),
    ));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key)
        .unwrap();
    (TlsAcceptor::from(Arc::new(config)), cert.to_vec())
}

/// Starts a fake receiver behind TLS. Returns its address, its certificate
/// and what it gets, from every connection.
pub async fn start() -> (SocketAddr, Vec<u8>, mpsc::UnboundedReceiver<Got>) {
    let (acceptor, cert) = acceptor();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (got, messages) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut connection = 0;
        while let Ok((tcp, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            let got = got.clone();
            tokio::spawn(async move {
                if let Ok(stream) = acceptor.accept(tcp).await {
                    answer(stream, got, connection).await;
                }
            });
            connection += 1;
        }
    });
    (addr, cert, messages)
}

/// Answers `connection` like the Default Media Receiver: nothing running
/// at first, then the app after a launch, then the media after a load.
pub async fn answer<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    got: mpsc::UnboundedSender<Got>,
    connection: usize,
) {
    let mut reader = FrameReader::default();
    let mut buf = [0u8; 4096];
    let mut launched = false;
    loop {
        let n = match stream.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        reader.push(&buf[..n]);
        while let Some(message) = reader.next_message() {
            let Ok(message) = message else {
                return;
            };
            let Payload::Text(text) = &message.payload else {
                continue;
            };
            let body: Value = serde_json::from_str(text).unwrap();
            let _ = got.send(Got {
                namespace: message.namespace.clone(),
                body: body.clone(),
                source: message.source.clone(),
                connection,
            });
            let id = body["requestId"].as_u64().unwrap_or(0);
            let reply = |source: &str, namespace: &str, body: Value| {
                CastMessage::text(source, &message.source, namespace, body.to_string()).encode()
            };
            let receiver_status = |launched: bool| {
                let apps = if launched {
                    json!([{ "appId": "CC1AD845", "sessionId": "s1", "transportId": "web-1" }])
                } else {
                    json!([])
                };
                reply(
                    "receiver-0",
                    NS_RECEIVER,
                    json!({ "type": "RECEIVER_STATUS", "requestId": id,
                            "status": { "applications": apps,
                                        "volume": { "level": 0.5, "muted": false } } }),
                )
            };
            let media = |state: &str| {
                reply(
                    "web-1",
                    NS_MEDIA,
                    json!({ "type": "MEDIA_STATUS", "requestId": id, "status": [{
                        "mediaSessionId": 1, "playerState": state, "currentTime": 42.5,
                        "supportedMediaCommands": 3,
                        "media": { "duration": 600.0, "streamType": "BUFFERED" } }] }),
                )
            };
            let kind = body["type"].as_str().unwrap_or_default();
            let answer = match (message.namespace.as_str(), kind) {
                (NS_RECEIVER, "GET_STATUS") => Some(receiver_status(launched)),
                (NS_RECEIVER, "LAUNCH") => {
                    launched = true;
                    Some(receiver_status(true))
                }
                (NS_RECEIVER, "SET_VOLUME") => Some(receiver_status(launched)),
                (NS_MEDIA, "GET_STATUS") => Some(reply(
                    "web-1",
                    NS_MEDIA,
                    json!({ "type": "MEDIA_STATUS", "requestId": id, "status": [] }),
                )),
                (NS_MEDIA, "LOAD") | (NS_MEDIA, "PLAY") | (NS_MEDIA, "SEEK") => {
                    Some(media("PLAYING"))
                }
                (NS_MEDIA, "PAUSE") => Some(media("PAUSED")),
                (_, "CLOSE") if message.destination == "receiver-0" => return,
                _ => None,
            };
            if let Some(answer) = answer
                && stream.write_all(&answer).await.is_err()
            {
                return;
            }
        }
    }
}

/// Waits for the next message of `kind`, skipping others.
pub async fn next_of(messages: &mut mpsc::UnboundedReceiver<Got>, kind: &str) -> Got {
    let wait = async {
        while let Some(got) = messages.recv().await {
            if got.kind() == kind {
                return got;
            }
        }
        panic!("the receiver closed before a {kind}");
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), wait)
        .await
        .unwrap_or_else(|_| panic!("no {kind} within 10 s"))
}
