// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Conversions of WAV, Y4M and H.264 files made here, served on loopback
//! and fetched the way a receiver would.

use super::*;
use hls_remux::test_media::{ts_bytes, Media};
use mvp_core::http::test_server::{self, serve_once};
use std::io::{Read, Write};
use std::net::Ipv4Addr;
use tempfile::TempDir;

const LOOPBACK: Peers = Peers::Subnet {
    local: Ipv4Addr::LOCALHOST,
    prefix: 16,
};
const AIRPLAY: &[&str] = &["aac", "mp3"];
const LEAD_SECONDS: f64 = mvp_core::convert::hls::LEAD;

/// `seconds` of a quiet 440 Hz tone, 8 kHz mono. A tone, not noise, which
/// AAC takes far longer to encode.
fn wav(seconds: u32) -> Vec<u8> {
    let samples = 8000 * seconds;
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(36 + samples).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&8000u32.to_le_bytes());
    out.extend_from_slice(&8000u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&8u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&samples.to_le_bytes());
    out.extend((0..samples).map(|i| {
        let t = f64::from(i) / 8000.0;
        (128.0 + (t * 440.0 * std::f64::consts::TAU).sin() * 20.0) as u8
    }));
    out
}

fn y4m(frames: usize) -> Vec<u8> {
    let mut out = b"YUV4MPEG2 W32 H32 F25:1 Ip A1:1 C420jpeg\n".to_vec();
    for _ in 0..frames {
        out.extend_from_slice(b"FRAME\n");
        out.extend(std::iter::repeat_n(128u8, 32 * 32 * 3 / 2));
    }
    out
}

fn file(dir: &TempDir, name: &str, bytes: &[u8]) -> String {
    let path = dir.path().join(name);
    std::fs::File::create(&path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
    path.to_string_lossy().into_owned()
}

fn request(url: &str) -> HlsRequest<'_> {
    HlsRequest {
        url,
        start_at: 0.0,
        user_agent: Some("Cinette/test"),
        language: None,
        playable: AIRPLAY,
        peers: LOOPBACK,
        live: false,
    }
}

async fn get(url: &str) -> (u16, String, Vec<u8>) {
    let response = test_server::client().get(url).send().await.unwrap();
    let status = response.status().as_u16();
    let kind = response
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    (status, kind, response.bytes().await.unwrap().to_vec())
}

async fn text(url: &str) -> String {
    String::from_utf8(get(url).await.2).unwrap()
}

/// Waits for the converter to stop. The limit only catches a converter
/// that never stops: a busy machine running every test at once can take a
/// while.
async fn ended(conversion: &mut HlsConversion) -> Ended {
    let ended = tokio::time::timeout(
        Duration::from_secs(60),
        conversion.ended.wait_for(Option::is_some),
    )
    .await
    .expect("the converter ends")
    .expect("the converter reports");
    (*ended).unwrap()
}

#[tokio::test]
async fn serves_a_converted_stream_as_hls() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(8));
    let mut conversion = start(request(&source)).await.unwrap();
    assert!(conversion.url.starts_with("http://127.0.0.1:"));
    assert!(conversion.url.ends_with("/index.m3u8"));
    assert!((conversion.duration.unwrap() - 8.0).abs() < 0.1);

    let (status, kind, master) = get(&conversion.url).await;
    assert_eq!(status, 200);
    assert_eq!(kind, "application/vnd.apple.mpegurl");
    let master = String::from_utf8(master).unwrap();
    assert!(master.contains("CODECS=\"mp4a.40.2\""), "{master}");
    assert!(master.ends_with("\nmedia.m3u8\n"), "{master}");

    assert_eq!(ended(&mut conversion).await, Ok(()));
    let base = conversion.url.trim_end_matches("index.m3u8").to_string();
    let media = text(&format!("{base}media.m3u8")).await;
    assert!(media.ends_with("#EXT-X-ENDLIST\n"), "{media}");
    assert!(media.contains("seg0.ts"), "{media}");
    let (status, kind, segment) = get(&format!("{base}seg0.ts")).await;
    assert_eq!(status, 200);
    assert_eq!(kind, "video/mp2t");
    assert_eq!(segment[0], 0x47);
    assert_eq!(segment.len() % 188, 0);
}

#[tokio::test]
async fn returns_once_three_segments_are_up() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(60));
    let conversion = start(request(&source)).await.unwrap();
    let base = conversion.url.trim_end_matches("index.m3u8").to_string();
    let media = text(&format!("{base}media.m3u8")).await;
    assert!(media.matches("#EXTINF").count() >= 3, "{media}");
    assert!(!media.contains("ENDLIST"), "{media}");
}

/// Seconds of media the media playlist has listed so far, counting from the
/// sequence number, which keeps counting as the window slides.
async fn listed(base: &str) -> (f64, String) {
    let media = text(&format!("{base}media.m3u8")).await;
    let made = media
        .lines()
        .filter_map(|l| l.strip_prefix("#EXTINF:"))
        .map(|l| l.trim_end_matches(',').parse::<f64>().unwrap())
        .sum();
    (made, media)
}

/// Waits until the pacer holds the converter for a resume.
async fn held(conversion: &HlsConversion) {
    let deadline = Instant::now() + Duration::from_secs(90);
    let control = conversion.control.clone();
    while control.pacer().wait(control.now()).is_some() {
        assert!(
            Instant::now() < deadline,
            "the pacer never held the converter"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_movie_waits_for_the_receiver_to_play() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(120));
    let conversion = start(request(&source)).await.unwrap();
    let base = conversion.url.trim_end_matches("index.m3u8").to_string();
    // Not told anything, it makes the lead and holds there.
    held(&conversion).await;
    let (before, _) = listed(&base).await;
    assert!(before >= LEAD_SECONDS, "{before}");
    conversion.set_playing(true);
    let deadline = Instant::now() + Duration::from_secs(30);
    while listed(&base).await.0 <= before {
        assert!(Instant::now() < deadline, "it never went on");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn a_live_channel_never_pauses() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(60));
    let mut live = request(&source);
    live.live = true;
    let conversion = start(live).await.unwrap();
    conversion.set_playing(false);
    // The clock runs on: an hour from now, the converter is behind.
    let control = conversion.control.clone();
    assert_eq!(control.pacer().wait(control.now() + 3600.0), Some(0.0));
    let base = conversion.url.trim_end_matches("index.m3u8").to_string();
    let media = text(&format!("{base}media.m3u8")).await;
    assert!(!media.contains("EXT-X-START"), "{media}");
}

#[tokio::test]
async fn stays_a_little_ahead_of_playback() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(120));
    let conversion = start(request(&source)).await.unwrap();
    conversion.set_playing(true);
    conversion.set_playing(false);
    let base = conversion.url.trim_end_matches("index.m3u8").to_string();
    // It runs until it's 20 s ahead of the time playback had before the
    // pause. Then the pacer holds it, however busy the machine is.
    let deadline = Instant::now() + Duration::from_secs(90);
    let control = conversion.control.clone();
    while control.pacer().wait(control.now()).is_some() {
        assert!(
            Instant::now() < deadline,
            "the pacer never held the converter"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (held, media) = listed(&base).await;
    assert!(!media.contains("ENDLIST"), "{media}");
    assert!(held >= LEAD_SECONDS, "{held}: {media}");
    // Held, it makes nothing more.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(listed(&base).await.0, held);
    conversion.set_playing(true);
}

#[tokio::test]
async fn drops_old_segments_from_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(40));
    let mut conversion = start(request(&source)).await.unwrap();
    let base = conversion.url.trim_end_matches("index.m3u8").to_string();
    // Pretend playback ran far ahead, so the pacer lets it finish.
    *conversion.control.pacer() = Pacer::new(-1000.0);
    conversion.control.wake.notify_all();
    assert_eq!(ended(&mut conversion).await, Ok(()));
    let media = text(&format!("{base}media.m3u8")).await;
    assert_eq!(media.matches("#EXTINF").count(), WINDOW.segments, "{media}");
    assert!(!media.contains("seg0.ts"), "{media}");
    // Gone from the server, which closes the connection with no answer.
    let gone = test_server::client()
        .get(format!("{base}seg0.ts"))
        .send()
        .await;
    assert!(gone.is_err());
}

#[tokio::test]
async fn stops_when_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(120));
    let conversion = start(request(&source)).await.unwrap();
    let mut ended_rx = conversion.ended.clone();
    let url = conversion.url.clone();
    drop(conversion);
    let end = tokio::time::timeout(Duration::from_secs(10), ended_rx.wait_for(Option::is_some))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(end, Err(HlsError::Failed));
    // The server went with it.
    assert!(test_server::client().get(&url).send().await.is_err());
}

#[tokio::test]
async fn a_refused_login_fails_before_anything_is_served() {
    let url = serve_once("403 Forbidden", "");
    assert_eq!(
        start(request(&format!("{url}/live/u/p/1.ts"))).await.err(),
        Some(HlsError::Refused)
    );
}

#[tokio::test]
async fn a_source_that_isnt_media_is_unreachable() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "junk.ts", b"not media");
    assert_eq!(
        start(request(&source)).await.err(),
        Some(HlsError::Unreachable)
    );
}

#[tokio::test]
async fn video_it_cant_copy_fails() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "grey.y4m", &y4m(50));
    assert_eq!(
        start(request(&source)).await.err(),
        Some(HlsError::VideoCodec)
    );
}

#[tokio::test]
async fn needs_a_network_the_receiver_can_reach() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(1));
    let mut wide = request(&source);
    wide.peers = Peers::Subnet {
        local: Ipv4Addr::LOCALHOST,
        prefix: 8,
    };
    assert_eq!(start(wide).await.err(), Some(HlsError::NoNetwork));
}

#[tokio::test]
async fn a_source_too_short_to_cut_still_plays() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "tone.wav", &wav(1));
    let mut conversion = start(request(&source)).await.unwrap();
    assert_eq!(ended(&mut conversion).await, Ok(()));
    let base = conversion.url.trim_end_matches("index.m3u8").to_string();
    let media = text(&format!("{base}media.m3u8")).await;
    assert_eq!(media.matches("#EXTINF").count(), 1, "{media}");
}

fn track(codec: &str, language: Option<&str>, default: bool) -> hls_remux::AudioTrack {
    hls_remux::AudioTrack {
        codec: codec.into(),
        language: language.map(str::to_string),
        default,
        decodable: true,
    }
}

#[test]
fn converts_a_track_it_can_decode_when_the_default_is_one_it_cant() {
    let tracks = [
        hls_remux::AudioTrack {
            decodable: false,
            ..track("truehd", None, true)
        },
        track("ac3", None, false),
    ];
    assert_eq!(
        plan(Video::None, &[], &tracks, None, &playable())
            .unwrap()
            .audio,
        Audio::Aac {
            track: 1,
            downmix: true
        }
    );
}

fn playable() -> Vec<String> {
    AIRPLAY.iter().map(|c| c.to_string()).collect()
}

#[test]
fn copies_h264_and_a_playable_track() {
    let avcc = [1, 100, 0, 31];
    let tracks = [
        track("ac3", Some("eng"), true),
        track("aac", Some("eng"), false),
    ];
    assert_eq!(
        plan(Video::H264, &avcc, &tracks, Some("eng"), &playable()),
        Ok(OutputPlan {
            audio: Audio::Copy(1),
            codecs: vec!["avc1.64001f".into(), "mp4a.40.2".into()],
        })
    );
}

#[test]
fn converts_audio_the_receiver_cant_play() {
    let tracks = [track("ac3", None, true), track("mp2", None, false)];
    assert_eq!(
        plan(Video::None, &[], &tracks, None, &playable()),
        Ok(OutputPlan {
            audio: Audio::Aac {
                track: 0,
                downmix: true
            },
            codecs: vec!["mp4a.40.2".into()],
        })
    );
    let mp2 = [track("mp2", None, true)];
    assert_eq!(
        plan(Video::None, &[], &mp2, None, &playable())
            .unwrap()
            .audio,
        Audio::Aac {
            track: 0,
            downmix: false
        }
    );
}

#[test]
fn names_mp3_when_it_copies_it() {
    let tracks = [track("mp3", None, true)];
    assert_eq!(
        plan(Video::None, &[], &tracks, None, &playable())
            .unwrap()
            .codecs,
        vec!["mp4a.40.34".to_string()]
    );
}

#[test]
fn video_without_audio_is_fine_and_an_unknown_profile_gets_a_safe_name() {
    // Without the profile, the master must still say there's video.
    assert_eq!(
        plan(Video::H264, &[], &[], None, &playable()),
        Ok(OutputPlan {
            audio: Audio::None,
            codecs: vec![AVC_FALLBACK.to_string()],
        })
    );
    assert_eq!(AVC_FALLBACK, "avc1.640028");
}

#[test]
fn refuses_what_it_cant_copy_or_has_nothing() {
    for video in [Video::Hevc, Video::Other] {
        assert_eq!(
            plan(video, &[], &[track("aac", None, true)], None, &playable()),
            Err(HlsError::VideoCodec)
        );
    }
    assert_eq!(
        plan(Video::None, &[], &[], None, &playable()),
        Err(HlsError::Unreachable)
    );
}

#[test]
fn reads_converter_errors() {
    assert_eq!(HlsError::from(RemuxError::Refused), HlsError::Refused);
    assert_eq!(
        HlsError::from(RemuxError::Unreachable),
        HlsError::Unreachable
    );
    assert_eq!(HlsError::from(RemuxError::Failed), HlsError::Failed);
    assert_eq!(HlsError::from(RemuxError::Cancelled), HlsError::Failed);
}

#[test]
fn says_why_for_the_player() {
    assert_eq!(HlsError::Refused.for_player(), "refused");
    assert_eq!(
        HlsError::Unreachable.for_player(),
        "Couldn't reach the stream to convert it."
    );
    assert_eq!(
        HlsError::VideoCodec.for_player(),
        "The TV can't play this video, and this device can't convert it."
    );
    assert_eq!(
        HlsError::NoNetwork.for_player(),
        "Connect to Wi-Fi to send this to the TV."
    );
    assert_eq!(
        HlsError::Failed.for_player(),
        "Couldn't convert the stream on this device."
    );
}

fn control(started: Duration) -> Control {
    Control {
        pacer: Mutex::new(Pacer::new(0.0)),
        wake: Condvar::new(),
        stopped: AtomicBool::new(false),
        clock: Instant::now() - started,
        live: false,
    }
}

#[test]
fn the_clock_counts_from_the_start() {
    let c = control(Duration::from_secs(5));
    let now = c.now();
    assert!((5.0..6.0).contains(&now), "{now}");
}

#[test]
fn paces_by_the_playback_clock_while_playing() {
    // Playing since the clock started, a second ago: 1 s played. Making
    // LEAD + 1.5 s puts it half a second past the lead, so it waits.
    let c = Arc::new(control(Duration::from_secs(1)));
    let started = Instant::now();
    assert!(c.pace(LEAD_SECONDS + 1.5));
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(400), "{waited:?}");
    assert!(waited < Duration::from_secs(3), "{waited:?}");
    // Behind, it goes straight on.
    let behind = control(Duration::from_secs(30));
    let started = Instant::now();
    assert!(behind.pace(2.0));
    assert!(started.elapsed() < Duration::from_millis(200));
}

#[test]
fn a_stop_ends_the_wait() {
    let c = Arc::new(control(Duration::ZERO));
    c.pacer().pause(0.0);
    let waiting = {
        let c = c.clone();
        std::thread::spawn(move || c.pace(LEAD_SECONDS + 5.0))
    };
    std::thread::sleep(Duration::from_millis(100));
    c.stopped.store(true, Ordering::Release);
    c.wake.notify_all();
    assert!(!waiting.join().unwrap());
    // Stopped already, it doesn't wait at all.
    assert!(!c.pace(1.0));
}

#[tokio::test]
async fn serves_h264_with_its_codecs_from_the_start() {
    let dir = tempfile::tempdir().unwrap();
    let media = Media {
        seconds: 8.0,
        ..Media::default()
    };
    let source = file(&dir, "h264.ts", &ts_bytes(dir.path(), &media));
    let mut conversion = start(request(&source)).await.unwrap();
    assert!(conversion.start.abs() < 0.05, "{}", conversion.start);
    let master = text(&conversion.url).await;
    assert!(
        master.contains("CODECS=\"avc1.") && master.contains(",mp4a.40.2\""),
        "{master}"
    );
    assert_eq!(ended(&mut conversion).await, Ok(()));
    let base = conversion.url.trim_end_matches("index.m3u8").to_string();
    let playlist = text(&format!("{base}media.m3u8")).await;
    assert!(playlist.contains("#EXT-X-TARGETDURATION:10\n"), "{playlist}");
    assert!(
        playlist.contains("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n"),
        "{playlist}"
    );
    // A keyframe a second, so segments of 2 s.
    assert!(playlist.matches("#EXTINF:2.000,").count() >= 3, "{playlist}");
    let (_, _, segment) = get(&format!("{base}seg0.ts")).await;
    let back = file(&dir, "seg0.ts", &segment);
    let opened = Source::open(&back, 0.0, None).unwrap();
    assert_eq!(opened.video().0, Video::H264);
    assert_eq!(opened.audio_tracks()[0].codec, "aac");
}

#[tokio::test]
async fn a_resumed_movie_starts_at_the_keyframe_before() {
    let dir = tempfile::tempdir().unwrap();
    let media = Media {
        seconds: 12.0,
        gop: 100,
        ..Media::default()
    };
    let source = file(&dir, "h264.ts", &ts_bytes(dir.path(), &media));
    let mut resume = request(&source);
    resume.start_at = 5.5;
    let conversion = start(resume).await.unwrap();
    // Keyframes every 4 s: 5.5 s in starts at 4 s.
    assert!((conversion.start - 4.0).abs() < 0.05, "{}", conversion.start);
}

#[tokio::test]
async fn a_start_that_runs_out_of_time_hangs_up_on_the_source() {
    // A server that takes the connection and never answers.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/movie/1.ts", listener.local_addr().unwrap());
    let (closed_tx, closed) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 1024];
        // Reads the request, then waits for the converter to hang up.
        while socket.read(&mut buffer).is_ok_and(|n| n > 0) {}
        let _ = closed_tx.send(());
    });
    assert_eq!(
        start_within(request(&url), Duration::from_millis(300))
            .await
            .err(),
        Some(HlsError::Unreachable)
    );
    // Hung up long before the 15 s read timeout.
    closed
        .recv_timeout(Duration::from_secs(5))
        .expect("the converter hung up");
}

fn sink() -> HlsSink {
    HlsSink {
        files: Files::default(),
        playlist: MediaPlaylist::new(WINDOW, TARGET),
        buffer: Vec::new(),
        overflowed: false,
        first_start: None,
        codecs: Vec::new(),
        master: false,
        control: Arc::new(control(Duration::from_secs(1000))),
        started: None,
        duration: None,
    }
}

#[test]
fn a_segment_too_big_to_keep_stops_the_conversion() {
    let mut sink = sink();
    sink.write(&vec![0x47; MAX_SEGMENT_BYTES]);
    assert!(!sink.overflowed);
    sink.write(&[0x47]);
    assert!(sink.overflowed);
    assert_eq!(sink.buffer.len(), MAX_SEGMENT_BYTES);
    assert!(!sink.cut(2.0, 0.0));
}

#[test]
fn remembers_where_the_first_segment_started() {
    let mut sink = sink();
    sink.write(&[0x47; 188]);
    assert!(sink.cut(2.0, 61.5));
    sink.write(&[0x47; 188]);
    assert!(sink.cut(2.0, 63.5));
    assert_eq!(sink.first_start, Some(61.5));
}

#[test]
fn keeps_the_memory_limits_it_says() {
    // 48 MB in one segment. The window's are mvp-core's.
    assert_eq!(MAX_SEGMENT_BYTES, 50_331_648);
}
