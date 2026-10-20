// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! HLS from the real bundled ffmpeg, from H.264 and MP2 in MPEG-TS made
//! here, served on loopback and fetched the way a receiver would.

use super::desktop::{start, start_within, FfmpegHls, Pace, Publisher, MAX_SEGMENT_BYTES};
use super::*;
use crate::downloads::test_support::{missing_url, process_runs};
use crate::lan_server::Peers;
use crate::test_support::TestApp;
use hls_remux::test_media::{ts_bytes, Media};
use mvp_core::convert::hls::{self, MediaPlaylist, LEAD, TARGET, WINDOW};
use mvp_core::convert::ts::Segment;
use mvp_core::convert::{AacEncoder, AudioPlan, Encoders, Plan, VideoPlan};
use mvp_core::http::test_server::{self, serve_once};
use std::net::Ipv4Addr;
use std::time::Duration;
use tokio::sync::oneshot;

const LOOPBACK: Peers = Peers::Subnet {
    local: Ipv4Addr::LOCALHOST,
    prefix: 16,
};
const NO_HARDWARE: Encoders = Encoders {
    video: None,
    aac: AacEncoder::Ffmpeg,
};
const LIMIT: Duration = Duration::from_secs(60);

fn remux(live: bool) -> Plan {
    Plan {
        video: VideoPlan::Copy,
        audio: AudioPlan::Aac { downmix: false },
        live,
        start_at: None,
        audio_track: 0,
    }
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
                    "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            });
        }
    });
    format!("http://{address}/movie.ts")
}

fn movie(seconds: f64) -> String {
    let dir = tempfile::tempdir().unwrap();
    let media = Media {
        seconds,
        ..Media::default()
    };
    file_source(ts_bytes(dir.path(), &media))
}

async fn fetch(url: &str) -> (u16, Vec<u8>) {
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        test_server::client().get(url).send(),
    )
    .await
    .expect("an answer within 10 s")
    .unwrap();
    let status = response.status().as_u16();
    (status, response.bytes().await.unwrap().to_vec())
}

async fn text(url: &str) -> String {
    let (status, body) = fetch(url).await;
    assert_eq!(status, 200, "{url}");
    String::from_utf8(body).unwrap()
}

/// The URL of `name` beside the master playlist.
fn beside(master: &str, name: &str) -> String {
    format!("{}{name}", master.strip_suffix(hls::MASTER).unwrap())
}

/// Waits for the conversion to end, and says how.
async fn ended(conversion: &mut FfmpegHls) -> Ended {
    tokio::time::timeout(LIMIT, conversion.ended.wait_for(Option::is_some))
        .await
        .expect("an end within a minute")
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn serves_a_movie_as_hls_from_the_start() {
    let app = TestApp::new();
    let source = movie(8.0);
    let mut conversion = start(
        &app.handle(),
        &source,
        &remux(false),
        NO_HARDWARE,
        LOOPBACK,
        Some("mp4a.40.2"),
    )
    .await
    .unwrap();
    assert!(conversion.url.starts_with("http://127.0.0.1:"));
    assert!(conversion.url.ends_with("/index.m3u8"));
    assert!(process_runs(conversion.pid.unwrap()));

    let master = text(&conversion.url).await;
    // The test video's profile from its SPS, Constrained Baseline at level
    // 1.0, then the AAC.
    assert!(
        master.contains("CODECS=\"avc1.42c00a,mp4a.40.2\""),
        "{master}"
    );
    assert!(master.contains("\nmedia.m3u8\n"), "{master}");

    // The movie plays, so ffmpeg goes on to its end.
    conversion.set_playing(true);
    assert_eq!(ended(&mut conversion).await, Ok(()));
    let media = text(&beside(&conversion.url, hls::MEDIA)).await;
    assert!(
        media.contains(&format!("#EXT-X-TARGETDURATION:{TARGET}\n")),
        "{media}"
    );
    assert!(media.contains("#EXT-X-MEDIA-SEQUENCE:0\n"), "{media}");
    assert!(media.ends_with("#EXT-X-ENDLIST\n"), "{media}");
    // A keyframe a second, so 2 s segments, from 8 s of video.
    let durations: Vec<f64> = media
        .lines()
        .filter_map(|l| l.strip_prefix("#EXTINF:"))
        .map(|d| d.trim_end_matches(',').parse().unwrap())
        .collect();
    assert_eq!(durations.len(), 4, "{media}");
    let total: f64 = durations.iter().sum();
    assert!((7.5..=8.5).contains(&total), "{media}");

    for (n, _) in durations.iter().enumerate() {
        let (status, segment) = fetch(&beside(&conversion.url, &hls::segment_name(n as u64))).await;
        assert_eq!(status, 200);
        assert_eq!(segment.len() % 188, 0);
        // Each has the PAT before any media. ffmpeg's own stream starts
        // with its SDT, and later segments with the PAT.
        let pids: Vec<u16> = segment
            .chunks(188)
            .map(|p| (u16::from(p[1] & 0x1F) << 8) | u16::from(p[2]))
            .collect();
        let pat = pids.iter().position(|&pid| pid == 0).unwrap();
        assert!(pat <= usize::from(n == 0), "segment {n}: {:?}", &pids[..4]);
    }
    // ffmpeg plays it back as HLS from start to end, with no error, as a
    // receiver would.
    let played = crate::convert::support::run_within(
        &app.handle(),
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-xerror",
            "-i",
            &conversion.url,
            // Copied, since the pinned sidecar has no encoder for `null`.
            "-c",
            "copy",
            "-f",
            "null",
            "-",
        ],
        None,
        LIMIT,
    )
    .await;
    assert!(
        matches!(played, Ok(Some(_))),
        "ffmpeg couldn't read the HLS back"
    );

    // A name that was never made gets no answer at all.
    let missing = test_server::client()
        .get(beside(&conversion.url, "seg9.ts"))
        .send()
        .await;
    assert!(missing.is_err(), "{missing:?}");
}

#[tokio::test]
async fn a_movie_that_isnt_played_holds_ffmpeg_back() {
    let app = TestApp::new();
    // Far longer than the lead.
    let source = movie(60.0);
    let conversion = start_within(
        &app.handle(),
        &source,
        &remux(false),
        NO_HARDWARE,
        LOOPBACK,
        Some("mp4a.40.2"),
        LIMIT,
    )
    .await
    .unwrap();
    // Plenty of time to remux all 60 s if nothing held ffmpeg back.
    tokio::time::sleep(Duration::from_secs(4)).await;
    let media = text(&beside(&conversion.url, hls::MEDIA)).await;
    let made: f64 = media
        .lines()
        .filter_map(|l| l.strip_prefix("#EXTINF:"))
        .map(|d| d.trim_end_matches(',').parse::<f64>().unwrap())
        .sum();
    assert!(made <= LEAD + 4.0, "{media}");
    assert!(!media.contains("#EXT-X-ENDLIST"), "{media}");
    assert!(conversion.ended.borrow().is_none());
    let pid = conversion.pid.unwrap();
    conversion.stop().await;
    assert!(!process_runs(pid));
}

#[tokio::test]
async fn a_refused_or_missing_source_fails_before_anything_is_served() {
    let app = TestApp::new();
    let refused = format!(
        "{}/movie/u/{}/1.ts",
        serve_once("401 Unauthorized", ""),
        test_server::password()
    );
    let start = |source: String| {
        let handle = app.handle();
        async move {
            start_within(
                &handle,
                &source,
                &remux(false),
                NO_HARDWARE,
                LOOPBACK,
                None,
                LIMIT,
            )
            .await
            .err()
            .unwrap()
        }
    };
    assert_eq!(start(refused).await, HlsError::Refused);
    assert_eq!(start(missing_url("gone")).await, HlsError::Unreachable);
}

#[tokio::test]
async fn a_short_movie_starts_once_its_all_there() {
    let app = TestApp::new();
    // One segment, short of the three or 6 s a receiver starts with, but
    // nothing more comes.
    let mut conversion = start_within(
        &app.handle(),
        &movie(1.0),
        &remux(false),
        NO_HARDWARE,
        LOOPBACK,
        None,
        LIMIT,
    )
    .await
    .unwrap();
    assert_eq!(ended(&mut conversion).await, Ok(()));
    let media = text(&beside(&conversion.url, hls::MEDIA)).await;
    assert_eq!(media.matches("#EXTINF").count(), 1, "{media}");
    assert!(media.ends_with("#EXT-X-ENDLIST\n"), "{media}");
}

#[tokio::test]
async fn a_transcode_without_an_encoder_never_starts() {
    let app = TestApp::new();
    let plan = Plan {
        video: VideoPlan::Transcode { deinterlace: false },
        ..remux(false)
    };
    let err = start_within(
        &app.handle(),
        "http://unused",
        &plan,
        NO_HARDWARE,
        LOOPBACK,
        None,
        LIMIT,
    )
    .await
    .err();
    assert_eq!(err, Some(HlsError::VideoCodec));
}

#[tokio::test]
async fn a_start_that_takes_too_long_gives_up() {
    let app = TestApp::new();
    let source = movie(8.0);
    let err = start_within(
        &app.handle(),
        &source,
        &remux(false),
        NO_HARDWARE,
        LOOPBACK,
        None,
        Duration::ZERO,
    )
    .await
    .err();
    assert_eq!(err, Some(HlsError::Unreachable));
}

#[tokio::test]
async fn dropping_a_conversion_ends_its_ffmpeg() {
    let app = TestApp::new();
    let conversion = start_within(
        &app.handle(),
        &movie(60.0),
        &remux(false),
        NO_HARDWARE,
        LOOPBACK,
        None,
        LIMIT,
    )
    .await
    .unwrap();
    let pid = conversion.pid.unwrap();
    drop(conversion);
    for _ in 0..100 {
        if !process_runs(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("ffmpeg still runs after the conversion was dropped");
}

#[test]
fn turns_the_converters_errors_into_the_players() {
    use crate::convert::ConvertError;
    let cases = [
        (ConvertError::Refused(403), HlsError::Refused),
        (ConvertError::Unreachable, HlsError::Unreachable),
        (ConvertError::NoEncoder, HlsError::VideoCodec),
        (ConvertError::Unsupported, HlsError::VideoCodec),
        (ConvertError::Failed("x".into()), HlsError::Failed),
        (ConvertError::NoRoute, HlsError::NoNetwork),
    ];
    for (from, to) in cases {
        assert_eq!(HlsError::from(from.clone()), to, "{from:?}");
    }
    assert_eq!(HlsError::Refused.for_player(), crate::streams::REFUSED);
    assert_eq!(
        HlsError::VideoCodec.for_player(),
        "The TV can't play this video, and this device can't convert it."
    );
    assert_eq!(
        HlsError::Unreachable.for_player(),
        "Couldn't reach the stream to convert it."
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

fn publisher() -> (Publisher, oneshot::Receiver<Result<(), HlsError>>) {
    let (tx, rx) = oneshot::channel();
    let publisher = Publisher {
        files: crate::lan_server::Files::default(),
        playlist: MediaPlaylist::new(WINDOW, TARGET).from_start(),
        audio: Some("mp4a.40.2"),
        master: false,
        started: Some(tx),
    };
    (publisher, rx)
}

fn segment(bytes: usize, duration: f64) -> Segment {
    Segment {
        bytes: vec![0x47; bytes],
        duration,
    }
}

fn file(publisher: &Publisher, name: &str) -> Option<String> {
    publisher
        .files
        .get(name)
        .map(|f| String::from_utf8_lossy(&f.body).into_owned())
}

#[test]
fn the_master_is_written_once_with_the_codecs_of_the_first_segment() {
    let (mut out, _) = publisher();
    assert!(out.publish(segment(250_000, 2.0), Some("avc1.64001f".into())));
    let master = file(&out, hls::MASTER).unwrap();
    assert!(
        master.contains("BANDWIDTH=1200000,CODECS=\"avc1.64001f,mp4a.40.2\""),
        "{master}"
    );
    assert!(out.publish(segment(10, 2.0), None));
    assert_eq!(file(&out, hls::MASTER).unwrap(), master);
    assert!(file(&out, "seg0.ts").is_some());
    assert!(file(&out, "seg1.ts").is_some());
    let media = file(&out, hls::MEDIA).unwrap();
    assert_eq!(media.matches("#EXTINF").count(), 2, "{media}");
}

#[test]
fn audio_only_names_only_its_audio() {
    let (mut out, _) = publisher();
    out.audio = None;
    assert!(out.publish(segment(10, 2.0), None));
    let master = file(&out, hls::MASTER).unwrap();
    assert!(!master.contains("CODECS"), "{master}");
}

#[test]
fn a_segment_too_big_to_keep_is_turned_down() {
    let (mut out, _) = publisher();
    assert!(!out.publish(segment(MAX_SEGMENT_BYTES + 1, 2.0), None));
    assert!(file(&out, hls::MASTER).is_none());
    assert!(out.publish(segment(MAX_SEGMENT_BYTES, 2.0), None));
    assert_eq!(MAX_SEGMENT_BYTES, 50_331_648);
}

#[test]
fn old_segments_leave_the_server_with_the_window() {
    let (mut out, _) = publisher();
    for _ in 0..WINDOW.segments + 2 {
        assert!(out.publish(segment(10, 2.0), None));
    }
    assert!(file(&out, "seg0.ts").is_none());
    assert!(file(&out, "seg1.ts").is_none());
    assert!(file(&out, "seg2.ts").is_some());
}

#[test]
fn the_start_is_told_once_three_segments_are_up() {
    let (mut out, mut started) = publisher();
    out.publish(segment(10, 1.0), None);
    out.publish(segment(10, 1.0), None);
    assert!(started.try_recv().is_err());
    out.publish(segment(10, 1.0), None);
    assert_eq!(started.try_recv(), Ok(Ok(())));
}

#[test]
fn a_source_that_ends_early_still_starts_or_says_why() {
    // Enough to start with: the end lists it as it is.
    let (mut out, mut started) = publisher();
    out.publish(segment(10, 7.0), None);
    out.finish(Ok(()));
    assert_eq!(started.try_recv(), Ok(Ok(())));
    assert!(file(&out, hls::MEDIA)
        .unwrap()
        .ends_with("#EXT-X-ENDLIST\n"));

    // Short, but all there.
    let (mut out, mut started) = publisher();
    out.publish(segment(10, 1.0), None);
    out.finish(Ok(()));
    assert_eq!(started.try_recv(), Ok(Ok(())));

    // Nothing at all.
    let (mut out, mut started) = publisher();
    out.finish(Ok(()));
    assert_eq!(started.try_recv(), Ok(Err(HlsError::Unreachable)));

    // An error, which the start hears as it is.
    let (mut out, mut started) = publisher();
    out.finish(Err(HlsError::Refused));
    assert_eq!(started.try_recv(), Ok(Err(HlsError::Refused)));
    assert!(file(&out, hls::MEDIA).is_none());
}

#[tokio::test]
async fn a_paused_movie_waits_until_it_plays() {
    let pace = Pace::new(false);
    // Short of the lead, a paused movie doesn't wait.
    tokio::time::timeout(Duration::from_secs(1), pace.after(LEAD - 1.0))
        .await
        .expect("no wait within the lead");
    let waiting = pace.after(2.0);
    tokio::pin!(waiting);
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut waiting)
            .await
            .is_err(),
        "a paused movie past its lead waits"
    );
    pace.set_playing(true);
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .expect("playing lets it go on");
}

#[tokio::test]
async fn a_live_channel_never_pauses() {
    let pace = Pace::new(true);
    pace.set_playing(false);
    tokio::time::timeout(Duration::from_secs(1), pace.after(LEAD - 1.0))
        .await
        .expect("no wait within the lead");
    // Past the lead, it waits for the clock, not for a play.
    let waiting = pace.after(2.0);
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .expect("the clock runs");
}

mod planning {
    use super::super::plan as plan_for;
    use super::*;
    use crate::convert::support::Support;
    use mvp_core::convert::HardwareEncoder;
    use mvp_core::streams::format::{Container, VideoCodec};
    use mvp_core::streams::probe::{AudioTrack, Probed};

    const AIRPLAY: &[&str] = &["aac", "mp3"];

    fn support(hardware: bool) -> Support {
        Support {
            convert: true,
            encoders: Some(Encoders {
                video: hardware.then_some(HardwareEncoder::VideoToolbox),
                aac: AacEncoder::AudioToolbox,
            }),
            hardware_encoder: hardware,
            decoders: ["aac", "ac3", "mp2", "mp3"].map(String::from).to_vec(),
        }
    }

    fn track(codec: &str, default: bool) -> AudioTrack {
        AudioTrack {
            codec: codec.into(),
            language: None,
            default,
            layout: None,
        }
    }

    fn probed(video: Option<VideoCodec>, tracks: Vec<AudioTrack>) -> Probed {
        Probed {
            container: Container::Ts,
            video,
            interlaced: false,
            hdr: false,
            audio: None,
            audio_tracks: tracks,
            duration: Some(600.0),
        }
    }

    #[test]
    fn copies_h264_and_converts_audio_the_receiver_cant_play() {
        let source = probed(Some(VideoCodec::H264), vec![track("mp2", true)]);
        let (plan, encoders, audio) =
            plan_for(&source, 42.0, false, AIRPLAY, &support(false)).unwrap();
        assert_eq!(plan.video, VideoPlan::Copy);
        assert_eq!(plan.audio, AudioPlan::Aac { downmix: false });
        assert_eq!(plan.audio_track, 0);
        assert_eq!(plan.start_at, Some(42.0));
        assert!(!plan.live);
        assert_eq!(encoders.aac, AacEncoder::AudioToolbox);
        assert_eq!(audio, Some("mp4a.40.2"));
    }

    #[test]
    fn copies_a_track_the_receiver_plays_even_when_its_not_the_default() {
        let source = probed(
            Some(VideoCodec::H264),
            vec![track("ac3", true), track("mp3", false)],
        );
        let (plan, _, audio) = plan_for(&source, 0.0, false, AIRPLAY, &support(false)).unwrap();
        assert_eq!(plan.audio, AudioPlan::Copy);
        assert_eq!(plan.audio_track, 1);
        assert_eq!(audio, Some("mp4a.40.34"));
        // No start for a movie started at its beginning.
        assert_eq!(plan.start_at, None);
    }

    #[test]
    fn a_live_channel_starts_at_its_edge() {
        let source = probed(Some(VideoCodec::H264), vec![track("aac", true)]);
        let (plan, _, _) = plan_for(&source, 42.0, true, AIRPLAY, &support(false)).unwrap();
        assert!(plan.live);
        assert_eq!(plan.start_at, None);
    }

    #[test]
    fn other_video_and_interlaced_h264_need_the_hardware_encoder() {
        for video in [VideoCodec::Hevc, VideoCodec::Mpeg2, VideoCodec::Other] {
            let source = probed(Some(video), vec![track("aac", true)]);
            assert_eq!(
                plan_for(&source, 0.0, false, AIRPLAY, &support(false)).err(),
                Some(HlsError::VideoCodec),
                "{video:?}"
            );
            let (plan, encoders, _) =
                plan_for(&source, 0.0, false, AIRPLAY, &support(true)).unwrap();
            assert_eq!(plan.video, VideoPlan::Transcode { deinterlace: false });
            assert_eq!(encoders.video, Some(HardwareEncoder::VideoToolbox));
        }
        let mut interlaced = probed(Some(VideoCodec::H264), vec![track("aac", true)]);
        interlaced.interlaced = true;
        assert_eq!(
            plan_for(&interlaced, 0.0, false, AIRPLAY, &support(false)).err(),
            Some(HlsError::VideoCodec)
        );
        let (plan, _, _) = plan_for(&interlaced, 0.0, false, AIRPLAY, &support(true)).unwrap();
        assert_eq!(plan.video, VideoPlan::Transcode { deinterlace: true });
    }

    #[test]
    fn hdr_is_refused_even_with_an_encoder() {
        let mut source = probed(Some(VideoCodec::Hevc), vec![track("aac", true)]);
        source.hdr = true;
        assert_eq!(
            plan_for(&source, 0.0, false, AIRPLAY, &support(true)).err(),
            Some(HlsError::VideoCodec)
        );
    }

    #[test]
    fn audio_only_and_video_only_convert_what_there_is() {
        let radio = probed(None, vec![track("mp2", true)]);
        let (plan, _, audio) = plan_for(&radio, 0.0, true, AIRPLAY, &support(false)).unwrap();
        assert_eq!(plan.video, VideoPlan::None);
        assert_eq!(audio, Some("mp4a.40.2"));
        let silent = probed(Some(VideoCodec::H264), Vec::new());
        let (plan, _, audio) = plan_for(&silent, 0.0, false, AIRPLAY, &support(false)).unwrap();
        assert_eq!(plan.audio, AudioPlan::None);
        assert_eq!(audio, None);
        assert_eq!(
            plan_for(
                &probed(None, Vec::new()),
                0.0,
                false,
                AIRPLAY,
                &support(false)
            )
            .err(),
            Some(HlsError::Unreachable)
        );
    }

    #[test]
    fn a_computer_without_an_aac_encoder_cant_convert() {
        let source = probed(Some(VideoCodec::H264), vec![track("aac", true)]);
        let none = Support {
            encoders: None,
            ..support(false)
        };
        assert_eq!(
            plan_for(&source, 0.0, false, AIRPLAY, &none).err(),
            Some(HlsError::Failed)
        );
    }
}
