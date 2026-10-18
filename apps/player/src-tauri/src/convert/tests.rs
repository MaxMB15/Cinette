// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Conversions with the real bundled ffmpeg, from loopback servers, served
//! to a "receiver" on loopback. The copies here need nothing the pinned
//! sidecar lacks.

use super::support::{choose, read_encoders, test_encode_args, Listed};
use super::*;
use crate::downloads::test_support::{missing_url, process_runs, video_url};
use crate::test_support::TestApp;
use mvp_core::convert::{AacEncoder, AudioPlan, Encoders, HardwareEncoder, VideoPlan};

const NO_HARDWARE: Encoders = Encoders {
    video: None,
    aac: AacEncoder::Ffmpeg,
};
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

const SUBTITLES: &[u8] = b"WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n";

async fn start_copy(
    app: &TestApp,
    source: &str,
    receiver: IpAddr,
) -> Result<Conversion, ConvertError> {
    let conversion = start(&app.handle(), source, &copy_audio(), NO_HARDWARE, receiver).await?;
    conversion
        .server
        .files
        .put("subs.vtt", "text/vtt", SUBTITLES.to_vec());
    Ok(conversion)
}

#[tokio::test]
async fn serves_live_matroska_from_this_computers_address() {
    let app = TestApp::new();
    let conversion = start_copy(&app, &live_wav(false), LOOPBACK).await.unwrap();
    let path = conversion.url.strip_prefix("http://127.0.0.1:").unwrap();
    let (_, path) = path.split_once('/').unwrap();
    let token = path
        .strip_prefix("cast/")
        .unwrap()
        .strip_suffix("/stream.mkv")
        .unwrap();
    assert_eq!(token.len(), 64);
    assert!(conversion.url.starts_with(&conversion.server.base));

    let client = test_server::client();
    let mut response = client.get(&conversion.url).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let headers = response.headers();
    assert_eq!(headers["content-type"], "video/x-matroska");
    assert!(headers.get("content-length").is_none());
    assert_eq!(headers["access-control-allow-origin"], "*");
    let pieces = header_and_a_cluster(&mut response).await;
    let Piece::Header(header) = &pieces[0] else {
        panic!("the stream starts with its header");
    };
    assert_eq!(&header[..4], &[0x1A, 0x45, 0xDF, 0xA3]);

    // A second request, as a receiver makes after a first look, gets the
    // header too, then starts at a cluster.
    let mut again = client.get(&conversion.url).send().await.unwrap();
    let pieces = header_and_a_cluster(&mut again).await;
    assert_eq!(pieces[0], Piece::Header(header.clone()));
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
        .get(format!("{}subs.vtt", conversion.server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(subs.headers()["content-type"], "text/vtt");
    assert_eq!(subs.headers()["access-control-allow-origin"], "*");
    assert_eq!(subs.bytes().await.unwrap().as_ref(), SUBTITLES);

    let head = client.head(&conversion.url).send().await.unwrap();
    assert_eq!(head.status(), 200);
    assert_eq!(head.bytes().await.unwrap().len(), 0);
    let head = client
        .head(format!("{}subs.vtt", conversion.server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(
        head.headers()["content-length"],
        SUBTITLES.len().to_string()
    );

    // Another path, a guessed token or another method gets no answer at all.
    let wrong = conversion.url.replace("/cast/", "/cast/0");
    assert!(client.get(&wrong).send().await.is_err());
    assert!(client
        .get(format!("{}other.vtt", conversion.server.base))
        .send()
        .await
        .is_err());
    assert!(client.post(&conversion.url).send().await.is_err());
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
    assert!(tokio::net::TcpStream::connect(&address).await.is_err());
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
    let err = start(&app.handle(), &video_url("x"), &plan, NO_HARDWARE, LOOPBACK)
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
fn reads_the_encoders_ffmpeg_lists() {
    let list = "Encoders:\n V....D = Video\n ------\n A....D aac                  AAC (Advanced Audio Coding)\n A....D aac_at               aac (AudioToolbox)\n V....D h264_videotoolbox    VideoToolbox H.264 Encoder\n S..... webvtt               WebVTT subtitle\n";
    assert_eq!(
        read_encoders(list),
        Listed {
            aac: true,
            aac_at: true,
            videotoolbox: true
        }
    );
    assert_eq!(
        read_encoders(" S..... webvtt  WebVTT\n A....D aac_latm  x\n"),
        Listed::default()
    );
}

#[test]
fn chooses_apples_encoders_on_a_mac_and_ffmpegs_elsewhere() {
    let all = Listed {
        aac: true,
        aac_at: true,
        videotoolbox: true,
    };
    assert_eq!(
        choose(all, true),
        Some(Encoders {
            video: Some(HardwareEncoder::VideoToolbox),
            aac: AacEncoder::AudioToolbox
        })
    );
    assert_eq!(choose(all, false), Some(NO_HARDWARE));
    let no_aac_at = Listed {
        aac_at: false,
        ..all
    };
    assert_eq!(choose(no_aac_at, true).unwrap().aac, AacEncoder::Ffmpeg);
    let only_aac_at = Listed {
        aac: false,
        videotoolbox: false,
        ..all
    };
    assert_eq!(
        choose(only_aac_at, true),
        Some(Encoders {
            video: None,
            aac: AacEncoder::AudioToolbox
        })
    );
    assert_eq!(choose(only_aac_at, false), None);
    assert_eq!(choose(Listed::default(), true), None);
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
        assert!(support.encoders.is_none_or(|e| e.video.is_none()));
    }
    assert_eq!(support.convert, support.encoders.is_some());
    assert!(support.convert || !support.hardware_encoder);
    let json = serde_json::to_value(support).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 2);
    assert_eq!(json["convert"], support.convert);
}

/// A live WAV, like a radio channel: a header with no end, then audio at
/// four times real time for as long as the connection stays open. With
/// `pause`, it sends half a second of audio and then nothing more, so
/// ffmpeg waits with the stream open.
fn live_wav(pause: bool) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let mut wav = b"RIFF\xff\xff\xff\x7fWAVEfmt ".to_vec();
                wav.extend_from_slice(&16u32.to_le_bytes());
                wav.extend_from_slice(&1u16.to_le_bytes());
                wav.extend_from_slice(&1u16.to_le_bytes());
                wav.extend_from_slice(&8000u32.to_le_bytes());
                wav.extend_from_slice(&8000u32.to_le_bytes());
                wav.extend_from_slice(&1u16.to_le_bytes());
                wav.extend_from_slice(&8u16.to_le_bytes());
                wav.extend_from_slice(b"data\xff\xff\xff\x7f");
                let head = "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\n\r\n";
                if stream.write_all(head.as_bytes()).is_err() || stream.write_all(&wav).is_err() {
                    return;
                }
                // Half a second of audio every eighth of a second.
                let chunk = [0x80u8; 4000];
                loop {
                    if stream.write_all(&chunk).is_err() {
                        return;
                    }
                    if pause {
                        // Keep the connection open without a word.
                        std::thread::sleep(Duration::from_secs(120));
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(125));
                }
            });
        }
    });
    format!("http://{address}/live.wav")
}

/// Reads a response until it has given the header and a whole cluster.
async fn header_and_a_cluster(response: &mut reqwest::Response) -> Vec<Piece> {
    let mut splitter = mvp_core::convert::mkv::MkvSplitter::default();
    let mut pieces = Vec::new();
    while !pieces
        .iter()
        .any(|p| matches!(p, Piece::Element { cluster: true, .. }))
    {
        let chunk = tokio::time::timeout(Duration::from_secs(20), response.chunk())
            .await
            .expect("a cluster within 20 s")
            .unwrap()
            .expect("more of the stream");
        pieces.extend(splitter.push(&chunk).unwrap());
    }
    pieces
}

#[tokio::test]
async fn dropping_a_conversion_ends_its_ffmpeg() {
    let app = TestApp::new();
    let conversion = start_copy(&app, &live_wav(true), LOOPBACK).await.unwrap();
    let pid = conversion.pid.unwrap();
    assert!(process_runs(pid));
    assert!(conversion.ended.borrow().is_none());
    drop(conversion);
    // The reader task kills ffmpeg on this runtime, so wait without
    // blocking it.
    for _ in 0..100 {
        if !process_runs(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("ffmpeg still runs after the conversion was dropped");
}
