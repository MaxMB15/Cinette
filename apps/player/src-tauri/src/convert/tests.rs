// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Conversions with the real bundled ffmpeg, from loopback servers, served
//! to a "receiver" on loopback. The copies here need nothing the pinned
//! sidecar lacks.

use super::support::{read_encoders, test_encode_args};
use super::*;
use crate::downloads::test_support::{missing_url, video_url};
use crate::test_support::TestApp;
use mvp_core::convert::{AudioPlan, VideoPlan};
use mvp_core::http::test_server::{self, serve_once};

const LOOPBACK: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);

fn copy_audio() -> Plan {
    Plan {
        video: VideoPlan::None,
        audio: AudioPlan::Copy,
        start_at: None,
        audio_track: 0,
    }
}

fn subtitles() -> ServedFile {
    ServedFile {
        name: "subs.vtt".into(),
        content_type: "text/vtt",
        body: Arc::new(b"WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n".to_vec()),
    }
}

async fn start_copy(
    app: &TestApp,
    source: &str,
    receiver: IpAddr,
) -> Result<Conversion, ConvertError> {
    start(
        &app.handle(),
        source,
        &copy_audio(),
        None,
        receiver,
        vec![subtitles()],
    )
    .await
}

#[tokio::test]
async fn serves_live_matroska_from_this_computers_address() {
    let app = TestApp::new();
    let conversion = start_copy(&app, &video_url("convert"), LOOPBACK)
        .await
        .unwrap();
    let path = conversion.url.strip_prefix("http://127.0.0.1:").unwrap();
    let (_, path) = path.split_once('/').unwrap();
    let token = path
        .strip_prefix("cast/")
        .unwrap()
        .strip_suffix("/stream.mkv")
        .unwrap();
    assert_eq!(token.len(), 64);
    assert!(conversion.url.starts_with(&conversion.base));

    let client = test_server::client();
    let mut response = client.get(&conversion.url).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let headers = response.headers();
    assert_eq!(headers["content-type"], "video/x-matroska");
    assert!(headers.get("content-length").is_none());
    assert_eq!(headers["access-control-allow-origin"], "*");
    // The header, then at least one cluster.
    let mut body = Vec::new();
    while body.len() < 64 * 1024 {
        body.extend_from_slice(&response.chunk().await.unwrap().unwrap());
    }
    assert_eq!(&body[..4], &[0x1A, 0x45, 0xDF, 0xA3]);
    assert!(body.windows(4).any(|w| w == [0x1F, 0x43, 0xB6, 0x75]));

    // A second request, as a receiver makes after a first look, gets the
    // header and starts at a cluster.
    let mut again = client.get(&conversion.url).send().await.unwrap();
    let mut body = Vec::new();
    while body.len() < 64 * 1024 {
        body.extend_from_slice(&again.chunk().await.unwrap().unwrap());
    }
    let mut splitter = mvp_core::convert::mkv::MkvSplitter::default();
    let pieces = splitter.push(&body).unwrap();
    assert!(matches!(pieces[0], Piece::Header(_)));
    assert!(matches!(&pieces[1], Piece::Element { cluster: true, .. }));
}

#[tokio::test]
async fn serves_subtitles_and_heads_and_nothing_else() {
    let app = TestApp::new();
    let conversion = start_copy(&app, &video_url("files"), LOOPBACK)
        .await
        .unwrap();
    let client = test_server::client();

    let subs = client
        .get(format!("{}subs.vtt", conversion.base))
        .send()
        .await
        .unwrap();
    assert_eq!(subs.headers()["content-type"], "text/vtt");
    assert_eq!(subs.headers()["access-control-allow-origin"], "*");
    assert_eq!(
        subs.bytes().await.unwrap().as_ref(),
        subtitles().body.as_slice()
    );

    let head = client.head(&conversion.url).send().await.unwrap();
    assert_eq!(head.status(), 200);
    assert_eq!(head.bytes().await.unwrap().len(), 0);
    let head = client
        .head(format!("{}subs.vtt", conversion.base))
        .send()
        .await
        .unwrap();
    assert_eq!(
        head.headers()["content-length"],
        subtitles().body.len().to_string()
    );

    // Another path, a guessed token or another method gets no answer at all.
    let wrong = conversion.url.replace("/cast/", "/cast/0");
    assert!(client.get(&wrong).send().await.is_err());
    assert!(client
        .get(format!("{}other.vtt", conversion.base))
        .send()
        .await
        .is_err());
    assert!(client.post(&conversion.url).send().await.is_err());
}

#[tokio::test]
async fn a_request_that_never_ends_its_head_gets_nothing() {
    let app = TestApp::new();
    let conversion = start_copy(&app, &video_url("slow"), LOOPBACK)
        .await
        .unwrap();
    let address = conversion
        .url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .to_string();
    let mut socket = TcpStream::connect(&address).await.unwrap();
    socket
        .write_all(&vec![b'a'; MAX_HEAD + 1024])
        .await
        .unwrap();
    let mut reply = Vec::new();
    let _ = socket.read_to_end(&mut reply).await;
    assert!(reply.is_empty());
    // A head that ends with nothing in it gets nothing either.
    let mut socket = TcpStream::connect(&address).await.unwrap();
    socket.write_all(b"GET\r\n\r\n").await.unwrap();
    let mut reply = Vec::new();
    let _ = socket.read_to_end(&mut reply).await;
    assert!(reply.is_empty());
}

/// Every loopback address reaches this computer on Linux, so 127.0.0.2 can
/// stand in for a receiver that isn't the client.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn answers_only_the_receiver() {
    let app = TestApp::new();
    let receiver = IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 2));
    let conversion = start_copy(&app, &video_url("peer"), receiver)
        .await
        .unwrap();
    // This client connects from 127.0.0.1.
    assert!(test_server::client()
        .get(&conversion.url)
        .send()
        .await
        .is_err());
}

#[tokio::test]
async fn says_when_the_source_ends_and_stops_when_dropped() {
    let app = TestApp::new();
    let mut conversion = start_copy(&app, &video_url("ends"), LOOPBACK)
        .await
        .unwrap();
    // Nobody reads, so ffmpeg runs the whole file into the pipe's reader.
    let ended = tokio::time::timeout(
        Duration::from_secs(60),
        conversion.ended.wait_for(Option::is_some),
    )
    .await
    .unwrap()
    .unwrap()
    .clone();
    assert_eq!(ended, Some(Ended::Finished));
    let address = conversion
        .url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .to_string();
    drop(conversion);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(TcpStream::connect(&address).await.is_err());
}

#[tokio::test]
async fn a_refused_or_missing_source_fails_before_anything_is_served() {
    let app = TestApp::new();
    let refused = format!(
        "{}/movie/u/{}/1.mkv",
        serve_once("403 Forbidden", ""),
        test_server::password()
    );
    let err = start_copy(&app, &refused, LOOPBACK).await.err().unwrap();
    assert_eq!(err, ConvertError::Refused(403));
    test_server::assert_hides(&err, &test_server::password());

    let err = start_copy(&app, &missing_url("gone"), LOOPBACK)
        .await
        .err()
        .unwrap();
    assert_eq!(err, ConvertError::Unreachable);
    let err = start_copy(
        &app,
        &format!("{}/x.ts", test_server::refused_url()),
        LOOPBACK,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err, ConvertError::Unreachable);
}

#[tokio::test]
async fn a_source_that_isnt_media_fails() {
    let app = TestApp::new();
    let text = serve_once("200 OK", "not a video at all");
    let err = start_copy(&app, &format!("{text}/x.ts"), LOOPBACK)
        .await
        .err()
        .unwrap();
    assert_eq!(err, ConvertError::Unreachable);
}

#[tokio::test]
async fn a_transcode_without_an_encoder_never_starts() {
    let app = TestApp::new();
    let plan = Plan {
        video: VideoPlan::Transcode { deinterlace: true },
        ..copy_audio()
    };
    let err = start(
        &app.handle(),
        &video_url("x"),
        &plan,
        None,
        LOOPBACK,
        vec![],
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err, ConvertError::NoEncoder);
    assert_eq!(
        err.to_string(),
        "this computer has no hardware video encoder"
    );
}

#[test]
fn finds_the_route_to_a_receiver() {
    assert_eq!(route_to(LOOPBACK), Ok(LOOPBACK));
    assert_eq!(
        route_to(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)),
        Ok(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST))
    );
}

#[test]
fn reads_the_encoders_ffmpeg_lists() {
    let list = "Encoders:\n V....D = Video\n ------\n A....D aac                  AAC (Advanced Audio Coding)\n V....D h264_videotoolbox    VideoToolbox H.264 Encoder\n S..... webvtt               WebVTT subtitle\n";
    let (aac, encoder) = read_encoders(list);
    assert!(aac);
    assert_eq!(encoder.is_some(), cfg!(target_os = "macos"));
    let (aac, encoder) = read_encoders(" S..... webvtt  WebVTT\n A....D aac_at  AudioToolbox\n");
    assert!(!aac);
    assert_eq!(encoder, None);
}

#[test]
fn the_encoder_check_encodes_one_frame_from_standard_input() {
    assert_eq!(
        test_encode_args(HardwareEncoder::VideoToolbox).join(" "),
        "-hide_banner -nostdin -loglevel error -f rawvideo -pix_fmt yuv420p -s 64x64 -i pipe:0 \
         -frames:v 1 -c:v h264_videotoolbox -f null -"
    );
}

#[tokio::test]
async fn reports_what_this_computers_ffmpeg_can_convert() {
    let app = TestApp::new();
    let support = super::support::support(&app.handle()).await;
    // Only a Mac has a hardware encoder the app uses.
    if !cfg!(target_os = "macos") {
        assert!(!support.hardware_encoder);
        assert_eq!(support.encoder, None);
    }
    assert!(support.convert || !support.hardware_encoder);
    let json = serde_json::to_value(support).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 2);
    assert_eq!(json["convert"], support.convert);
}
