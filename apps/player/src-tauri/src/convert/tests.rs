// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Conversions with the real bundled ffmpeg, from loopback servers, served
//! to a "receiver" on loopback. The copies here need nothing the pinned
//! sidecar lacks.

use super::support::{
    choose, decoded_codecs, encoder_works, read_encoders, read_names, run, run_within,
    test_encode_args, Finished, Listed, Unfinished,
};
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
        live: false,
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
    let conversion = start_copy(&app, &live_wav(End::Never), LOOPBACK)
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
    assert!(conversion.url.starts_with(&conversion.server.base));
    assert_eq!(*conversion.stalls.borrow(), 0);

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
    assert!(matches!(&pieces[1], Piece::Element { start: true, .. }));
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
    let mut conversion = start_copy(&app, &file_source(wav(4)), LOOPBACK)
        .await
        .unwrap();
    // Nobody reads, so ffmpeg runs the whole file into the feed, which
    // holds far more than four seconds.
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
async fn a_track_ffmpeg_cant_convert_is_unsupported() {
    let app = TestApp::new();
    // The sidecar has no decoder for 8-bit PCM.
    let plan = Plan {
        audio: AudioPlan::Aac { downmix: false },
        ..copy_audio()
    };
    let err = start(
        &app.handle(),
        &file_source(wav(4)),
        &plan,
        NO_HARDWARE,
        LOOPBACK,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err, ConvertError::Unsupported);
    assert_eq!(
        err.to_string(),
        "this computer can't convert this stream's format"
    );
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

#[test]
fn reads_the_decoders_ffmpeg_lists_as_codecs() {
    let list = "Decoders:\n V....D = Video\n ------\n A....D dca     DCA (DTS Coherent Acoustics)\n A....D mp3float  MP3\n A....D mp2float  MP2\n A....D ac3_fixed  ATSC A/52A\n A....D truehd  TrueHD\n";
    assert_eq!(
        decoded_codecs(&read_names(list)),
        ["=", "dts", "mp3", "mp2", "ac3", "truehd"]
    );
}

#[tokio::test]
async fn reports_what_this_computers_ffmpeg_can_convert() {
    let app = TestApp::new();
    let support = super::support::support(&app.handle()).await;
    // A build that converts decodes AAC and H.264. The pinned build before
    // build 3 has no AAC encoder, so it converts nothing.
    if support.convert {
        assert!(support.decoders.iter().any(|d| d == "aac"));
        assert!(support.decoders.iter().any(|d| d == "h264"));
    } else {
        assert!(support.decoders.is_empty());
    }
    // Only a Mac has a hardware encoder the app uses.
    if !cfg!(target_os = "macos") {
        assert!(!support.hardware_encoder);
        assert!(support.encoders.is_none_or(|e| e.video.is_none()));
    }
    assert_eq!(support.convert, support.encoders.is_some());
    assert!(support.convert || !support.hardware_encoder);
    let json = serde_json::to_value(&support).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 2);
    assert_eq!(json["convert"], support.convert);
}

#[tokio::test]
async fn runs_the_sidecar_and_keeps_its_output_only_when_it_succeeds() {
    let app = TestApp::new();
    let version = run(&app.handle(), &["-version"], None)
        .await
        .unwrap()
        .unwrap();
    assert!(version.starts_with(b"ffmpeg version "));
    assert!(run(&app.handle(), &["-no-such-option"], Some(b"x"))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_run_that_goes_on_too_long_is_stopped() {
    let app = TestApp::new();
    // A source that answers and then sends nothing.
    let url = live_wav(End::Pause);
    let started = std::time::Instant::now();
    let run = run_within(
        &app.handle(),
        &["-hide_banner", "-i", &url, "-f", "matroska", "pipe:1"],
        None,
        Duration::from_millis(500),
    )
    .await;
    assert!(run.is_err());
    assert!(started.elapsed() < Duration::from_secs(5));
    for _ in 0..50 {
        if !ffmpeg_runs_for(&url) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the check's ffmpeg still runs");
}

/// What a live source does once it has started.
#[derive(Clone, Copy)]
enum End {
    /// It sends for as long as the connection stays open.
    Never,
    /// It sends its first chunk, then keeps the connection open without a
    /// word.
    Pause,
    /// It closes the connection after this many chunks.
    After(usize),
}

/// A live source on loopback that sends `head`, then `chunks` in turn, one
/// every `every`, round and round, until `end`.
fn live_source(head: Vec<u8>, chunks: Vec<Vec<u8>>, every: Duration, end: End) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let (head, chunks) = (head.clone(), chunks.clone());
            std::thread::spawn(move || {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let answer = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n";
                if stream.write_all(answer.as_bytes()).is_err() || stream.write_all(&head).is_err()
                {
                    return;
                }
                for (sent, chunk) in chunks.iter().cycle().enumerate() {
                    if matches!(end, End::After(n) if sent == n) {
                        return;
                    }
                    if stream.write_all(chunk).is_err() {
                        return;
                    }
                    if let End::Pause = end {
                        std::thread::sleep(Duration::from_secs(120));
                        return;
                    }
                    std::thread::sleep(every);
                }
            });
        }
    });
    format!("http://{address}/live")
}

/// A file on loopback, sent whole with its length.
fn file_source(body: Vec<u8>) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let body = body.clone();
            std::thread::spawn(move || {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            });
        }
    });
    format!("http://{address}/file.wav")
}

/// The start of a WAV of 8-bit mono at 8 kHz with `samples` samples, or no
/// end at all.
fn wav_head(samples: Option<u32>) -> Vec<u8> {
    let data = samples.unwrap_or(0x7fff_ffff);
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&(data.saturating_add(36)).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&8000u32.to_le_bytes());
    wav.extend_from_slice(&8000u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&8u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data.to_le_bytes());
    wav
}

/// A WAV of `seconds` of silence.
fn wav(seconds: u32) -> Vec<u8> {
    let mut wav = wav_head(Some(seconds * 8000));
    wav.resize(wav.len() + seconds as usize * 8000, 0x80);
    wav
}

/// A live WAV, like a radio channel: a header with no end, then half a
/// second of audio every eighth of a second, until `end`.
fn live_wav(end: End) -> String {
    live_source(
        wav_head(None),
        vec![vec![0x80u8; 4000]],
        Duration::from_millis(125),
        end,
    )
}

/// Reads a response until it has given the header and a whole cluster.
async fn header_and_a_cluster(response: &mut reqwest::Response) -> Vec<Piece> {
    let mut splitter = mvp_core::convert::mkv::MkvSplitter::default();
    let mut pieces = Vec::new();
    while !pieces
        .iter()
        .any(|p| matches!(p, Piece::Element { start: true, .. }))
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
    let conversion = start_copy(&app, &live_wav(End::Pause), LOOPBACK)
        .await
        .unwrap();
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

/// Whether an ffmpeg with `url` among its arguments runs.
fn ffmpeg_runs_for(url: &str) -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", url])
        .status()
        .is_ok_and(|s| s.success())
}

/// Reads a response to its end, or until `limit` bytes.
async fn read_to_end(response: &mut reqwest::Response, limit: usize) -> Vec<u8> {
    let mut body = Vec::new();
    while body.len() < limit {
        let chunk = tokio::time::timeout(Duration::from_secs(30), response.chunk())
            .await
            .expect("more of the stream within 30 s")
            .unwrap();
        let Some(chunk) = chunk else { break };
        body.extend_from_slice(&chunk);
    }
    body
}

/// Waits up to a minute for the conversion to end, and says how.
async fn ended(conversion: &mut Conversion) -> Ended {
    tokio::time::timeout(
        Duration::from_secs(60),
        conversion.ended.wait_for(Option::is_some),
    )
    .await
    .expect("the conversion ends within a minute")
    .unwrap()
    .clone()
    .unwrap()
}

#[tokio::test]
async fn a_file_is_read_at_its_own_pace_after_a_burst() {
    let app = TestApp::new();
    // Fourteen seconds: ten come at once, and four at their own pace.
    let source = file_source(wav(14));
    let started = std::time::Instant::now();
    let mut conversion = start_copy(&app, &source, LOOPBACK).await.unwrap();
    let mut response = test_server::client()
        .get(&conversion.url)
        .send()
        .await
        .unwrap();
    let body = read_to_end(&mut response, usize::MAX).await;
    assert_eq!(ended(&mut conversion).await, Ended::Finished);
    assert!(
        started.elapsed() >= Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert!(body.len() > 14 * 8000, "all of it came: {}", body.len());

    // A live channel isn't held back, and its end is a drop.
    let plan = Plan {
        live: true,
        ..copy_audio()
    };
    let started = std::time::Instant::now();
    let mut live = start(&app.handle(), &source, &plan, NO_HARDWARE, LOOPBACK)
        .await
        .unwrap();
    assert_eq!(ended(&mut live).await, Ended::Dropped);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_live_channel_whose_connection_closes_has_dropped() {
    let app = TestApp::new();
    let plan = Plan {
        live: true,
        ..copy_audio()
    };
    let mut conversion = start(
        &app.handle(),
        &live_wav(End::After(8)),
        &plan,
        NO_HARDWARE,
        LOOPBACK,
    )
    .await
    .unwrap();
    assert_eq!(ended(&mut conversion).await, Ended::Dropped);
}

/// The cluster's Timestamp and whether its first block is a keyframe, from
/// a whole Cluster element.
fn cluster_start(cluster: &[u8]) -> (Option<u64>, Option<bool>) {
    fn vint(bytes: &[u8], marker: bool) -> (usize, u64) {
        let len = bytes[0].leading_zeros() as usize + 1;
        let first = if marker {
            u64::from(bytes[0])
        } else {
            u64::from(bytes[0]) & (0xFF >> len)
        };
        let value = bytes[1..len]
            .iter()
            .fold(first, |acc, &b| acc << 8 | u64::from(b));
        (len, value)
    }
    let (id_len, _) = vint(cluster, true);
    let (size_len, _) = vint(&cluster[id_len..], false);
    let mut rest = &cluster[id_len + size_len..];
    let (mut timestamp, mut key) = (None, None);
    while !rest.is_empty() {
        let (id_len, id) = vint(rest, true);
        let (size_len, size) = vint(&rest[id_len..], false);
        let data = &rest[id_len + size_len..id_len + size_len + size as usize];
        match id {
            0xE7 => timestamp = Some(data.iter().fold(0, |acc, &b| acc << 8 | u64::from(b))),
            0xA3 if key.is_none() => {
                let (track_len, _) = vint(data, false);
                key = Some(data[track_len + 2] & 0x80 != 0);
            }
            _ => {}
        }
        rest = &rest[id_len + size_len + size as usize..];
    }
    (timestamp, key)
}

#[tokio::test]
async fn the_first_request_starts_at_the_start() {
    let app = TestApp::new();
    let conversion = start_copy(&app, &file_source(wav(8)), LOOPBACK)
        .await
        .unwrap();
    // ffmpeg bursts through the file before the receiver asks.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut response = test_server::client()
        .get(&conversion.url)
        .send()
        .await
        .unwrap();
    let pieces = header_and_a_cluster(&mut response).await;
    let Piece::Element { bytes, .. } = &pieces[1] else {
        panic!("a cluster follows the header");
    };
    assert_eq!(cluster_start(bytes).0, Some(0));
}

#[tokio::test]
async fn starts_a_file_partway_through() {
    let app = TestApp::new();
    let source = file_source(wav(8));
    let whole = start_copy(&app, &source, LOOPBACK).await.unwrap();
    let mut response = test_server::client().get(&whole.url).send().await.unwrap();
    let whole = read_to_end(&mut response, usize::MAX).await;
    let plan = Plan {
        start_at: Some(6.0),
        ..copy_audio()
    };
    let mut later = start(&app.handle(), &source, &plan, NO_HARDWARE, LOOPBACK)
        .await
        .unwrap();
    let mut response = test_server::client().get(&later.url).send().await.unwrap();
    let rest = read_to_end(&mut response, usize::MAX).await;
    assert_eq!(ended(&mut later).await, Ended::Finished);
    // Two seconds of the eight.
    assert!(
        rest.len() < whole.len() / 2 && rest.len() > 2 * 8000,
        "{} of {}",
        rest.len(),
        whole.len()
    );
}

#[tokio::test]
async fn stopping_waits_until_ffmpeg_has_exited() {
    let app = TestApp::new();
    let conversion = start_copy(&app, &live_wav(End::Never), LOOPBACK)
        .await
        .unwrap();
    let pid = conversion.pid.unwrap();
    assert!(process_runs(pid));
    conversion.stop().await;
    assert!(!process_runs(pid));
}

/// Bits for an H.264 stream.
#[derive(Default)]
struct Bits(Vec<bool>);

impl Bits {
    fn u(&mut self, n: u32, v: u32) {
        for i in (0..n).rev() {
            self.0.push(v >> i & 1 == 1);
        }
    }
    fn ue(&mut self, v: u32) {
        let v = v + 1;
        let n = 32 - v.leading_zeros();
        self.u(n - 1, 0);
        self.u(n, v);
    }
    fn align(&mut self) {
        while !self.0.len().is_multiple_of(8) {
            self.0.push(false);
        }
    }
    /// The RBSP with its stop bit, as a NAL unit of `kind` with `reference`.
    fn nal(mut self, reference: u8, kind: u8) -> Vec<u8> {
        self.0.push(true);
        self.align();
        let mut out = vec![0, 0, 0, 1, reference << 5 | kind];
        let mut zeros = 0;
        for byte in self.0.chunks(8) {
            let byte = byte.iter().fold(0u8, |acc, &b| acc << 1 | u8::from(b));
            if zeros >= 2 && byte <= 3 {
                out.push(3);
                zeros = 0;
            }
            out.push(byte);
            zeros = if byte == 0 { zeros + 1 } else { 0 };
        }
        out
    }
}

/// `frames` frames of 16x16 H.264 at 25 frames a second, a keyframe every
/// `gop`: each keyframe is one uncompressed macroblock, and every other
/// frame repeats the one before it.
fn h264(frames: u32, gop: u32) -> Vec<Vec<u8>> {
    let sps = {
        let mut b = Bits::default();
        // Baseline, level 1, POC type 2, one reference frame, one macroblock.
        b.u(8, 66);
        b.u(8, 0);
        b.u(8, 10);
        for v in [0, 0, 2, 1] {
            b.ue(v);
        }
        b.u(1, 0);
        b.ue(0);
        b.ue(0);
        for v in [1, 1, 0, 0] {
            b.u(1, v);
        }
        b.nal(3, 7)
    };
    let pps = {
        let mut b = Bits::default();
        b.ue(0);
        b.ue(0);
        b.u(2, 0);
        b.ue(0);
        b.ue(0);
        b.ue(0);
        b.u(1, 0);
        b.u(2, 0);
        // Three signed zeros, each one bit.
        b.u(3, 0b111);
        b.u(3, 0);
        b.nal(3, 8)
    };
    (0..frames)
        .map(|f| {
            let mut b = Bits::default();
            if f.is_multiple_of(gop) {
                // An IDR slice of one I_PCM macroblock.
                b.ue(0);
                b.ue(7);
                b.ue(0);
                b.u(4, 0);
                b.ue(f / gop);
                b.u(2, 0);
                b.ue(0);
                b.ue(25);
                b.align();
                for _ in 0..384 {
                    b.u(8, 0x80);
                }
                [sps.clone(), pps.clone(), b.nal(3, 5)].concat()
            } else {
                // A P slice that skips its macroblock.
                b.ue(0);
                b.ue(5);
                b.ue(0);
                b.u(4, f % gop % 16);
                b.u(3, 0);
                b.ue(0);
                b.ue(1);
                b.nal(2, 1)
            }
        })
        .collect()
}

#[tokio::test]
async fn a_late_request_with_video_starts_at_a_keyframe() {
    let app = TestApp::new();
    // A keyframe every 2.4 s, sent at four times its speed. ffmpeg starts a
    // cluster every second, so most start between keyframes.
    let source = live_source(vec![], h264(600, 60), Duration::from_millis(10), End::Never);
    let plan = Plan {
        video: VideoPlan::Copy,
        audio: AudioPlan::None,
        live: true,
        ..copy_audio()
    };
    let conversion = start(&app.handle(), &source, &plan, NO_HARDWARE, LOOPBACK)
        .await
        .unwrap();
    let client = test_server::client();
    // Read until a cluster that starts between keyframes has gone by.
    let mut first = client.get(&conversion.url).send().await.unwrap();
    let mut splitter = mvp_core::convert::mkv::MkvSplitter::default();
    let mut between = false;
    while !between {
        let chunk = tokio::time::timeout(Duration::from_secs(20), first.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        for piece in splitter.push(&chunk).unwrap() {
            if let Piece::Element { bytes, start } = piece {
                let key = cluster_start(&bytes).1;
                assert_eq!(start, key == Some(true));
                between |= key == Some(false);
            }
        }
    }
    drop(first);
    let mut again = client.get(&conversion.url).send().await.unwrap();
    let pieces = header_and_a_cluster(&mut again).await;
    let Piece::Element { bytes, .. } = &pieces[1] else {
        panic!("a cluster follows the header");
    };
    assert_eq!(cluster_start(bytes).1, Some(true));
}

#[test]
fn a_hung_encoder_test_counts_as_no_encoder_this_time() {
    assert_eq!(encoder_works(Ok(Some(vec![]))), (true, Finished(true)));
    assert_eq!(encoder_works(Ok(None)), (false, Finished(true)));
    assert_eq!(encoder_works(Err(Unfinished)), (false, Finished(false)));
}
