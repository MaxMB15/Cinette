// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Conversions of media made here: WAV audio and Y4M video, from files and
//! from loopback servers. The output is read back through the same API.

use super::*;
use crate::test_media::{ts_bytes, Media};
use mvp_core::http::test_server::{refused_url, serve_once};
use std::io::Write;
use std::path::PathBuf;
use tempfile::TempDir;

const RATE: u32 = 48_000;

/// `seconds` of a 440 Hz tone, 16-bit stereo.
fn wav(seconds: u32) -> Vec<u8> {
    let samples = RATE * seconds;
    let data_len = samples * 4;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..samples {
        let t = i as f64 / f64::from(RATE);
        let v = ((t * 440.0 * std::f64::consts::TAU).sin() * 8000.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// `frames` frames of grey 64x36 video at 25 frames a second.
fn y4m(frames: usize) -> Vec<u8> {
    let mut out = b"YUV4MPEG2 W64 H36 F25:1 Ip A1:1 C420jpeg\n".to_vec();
    for _ in 0..frames {
        out.extend_from_slice(b"FRAME\n");
        out.extend(std::iter::repeat_n(128u8, 64 * 36 * 3 / 2));
    }
    out
}

fn file(dir: &TempDir, name: &str, bytes: &[u8]) -> String {
    let path: PathBuf = dir.path().join(name);
    std::fs::File::create(&path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
    path.to_string_lossy().into_owned()
}

/// What a conversion wrote: the bytes and each segment's length.
#[derive(Default)]
struct Collected {
    bytes: Vec<u8>,
    segments: Vec<(usize, f64)>,
    /// Where each segment started in the source.
    starts: Vec<f64>,
    /// How many cuts to allow before asking it to stop.
    stop_after: Option<usize>,
}

impl Sink for Collected {
    fn write(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    fn cut(&mut self, duration: f64, start: f64) -> bool {
        self.segments.push((self.bytes.len(), duration));
        self.starts.push(start);
        self.stop_after.is_none_or(|n| self.segments.len() < n)
    }
}

fn convert(
    url: &str,
    start: f64,
    audio: Audio,
    segment: f64,
) -> (Result<(), RemuxError>, Collected) {
    let mut source = Source::open(url, start, Some("Cinette/test")).expect("open the source");
    let mut out = Collected::default();
    let result = source.run(audio, segment, &mut out);
    (result, out)
}

fn total(segments: &[(usize, f64)]) -> f64 {
    segments.iter().map(|(_, d)| d).sum()
}

#[test]
fn reads_a_sources_tracks_and_length() {
    let dir = tempfile::tempdir().unwrap();
    let source = Source::open(&file(&dir, "tone.wav", &wav(3)), 0.0, None).unwrap();
    let tracks = source.audio_tracks();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].codec, "pcm_s16le");
    assert_eq!(tracks[0].language, None);
    assert!(tracks[0].decodable);
    assert_eq!(source.video(), (Video::None, Vec::new()));
    let duration = source.duration().unwrap();
    assert!((duration - 3.0).abs() < 0.05, "{duration}");
}

#[test]
fn converts_audio_to_aac_in_segments() {
    let dir = tempfile::tempdir().unwrap();
    let (result, out) = convert(
        &file(&dir, "tone.wav", &wav(6)),
        0.0,
        Audio::Aac {
            track: 0,
            downmix: true,
        },
        2.0,
    );
    result.unwrap();
    // Every MPEG-TS packet is 188 bytes and starts with the sync byte.
    assert!(!out.bytes.is_empty());
    assert_eq!(out.bytes.len() % 188, 0);
    assert!(out.bytes.chunks(188).all(|p| p[0] == 0x47));
    // Each segment ends on a packet boundary, and starts a new one.
    assert!(out.segments.len() >= 3, "{:?}", out.segments);
    for &(end, duration) in &out.segments {
        assert_eq!(end % 188, 0);
        assert!(duration <= 2.2, "{:?}", out.segments);
    }
    assert!(
        (total(&out.segments) - 6.0).abs() < 0.2,
        "{:?}",
        out.segments
    );
    // Read back, it's AAC of the same length.
    let back = Source::open(&file(&dir, "out.ts", &out.bytes), 0.0, None).unwrap();
    let tracks = back.audio_tracks();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].codec, "aac");
}

#[test]
fn every_segment_starts_with_the_tables_a_player_needs() {
    let dir = tempfile::tempdir().unwrap();
    let (result, out) = convert(
        &file(&dir, "tone.wav", &wav(6)),
        0.0,
        Audio::Aac {
            track: 0,
            downmix: false,
        },
        2.0,
    );
    result.unwrap();
    let mut start = 0;
    for &(end, _) in &out.segments {
        if end == start {
            continue;
        }
        // Each segment starts with the tables: the SDT (PID 17) and the PAT
        // (PID 0), so a player can read it without the one before.
        let pids: Vec<u16> = out.bytes[start..end]
            .chunks(188)
            .take(2)
            .map(|p| (u16::from(p[1] & 0x1f) << 8) | u16::from(p[2]))
            .collect();
        assert!(
            pids.contains(&0),
            "segment at {start} starts with PIDs {pids:?}"
        );
        let segment = file(&dir, "segment.ts", &out.bytes[start..end]);
        let alone = Source::open(&segment, 0.0, None).expect("a segment opens on its own");
        assert_eq!(alone.audio_tracks().len(), 1);
        start = end;
    }
}

#[test]
fn copies_audio_a_receiver_plays() {
    let dir = tempfile::tempdir().unwrap();
    let (result, aac) = convert(
        &file(&dir, "tone.wav", &wav(4)),
        0.0,
        Audio::Aac {
            track: 0,
            downmix: false,
        },
        2.0,
    );
    result.unwrap();
    let (result, copied) = convert(&file(&dir, "aac.ts", &aac.bytes), 0.0, Audio::Copy(0), 1.0);
    result.unwrap();
    assert!(copied.segments.len() >= 3, "{:?}", copied.segments);
    let back = Source::open(&file(&dir, "copy.ts", &copied.bytes), 0.0, None).unwrap();
    assert_eq!(back.audio_tracks()[0].codec, "aac");
}

#[test]
fn copies_video_and_cuts_at_keyframes() {
    let dir = tempfile::tempdir().unwrap();
    let source = file(&dir, "grey.y4m", &y4m(100));
    let opened = Source::open(&source, 0.0, None).unwrap();
    assert_eq!(opened.video().0, Video::Other);
    assert!(opened.audio_tracks().is_empty());
    drop(opened);
    let (result, out) = convert(&source, 0.0, Audio::None, 1.0);
    result.unwrap();
    // 4 s of video in segments of at least a second, each frame a keyframe.
    assert!(out.segments.len() >= 3, "{:?}", out.segments);
    for &(_, duration) in &out.segments[..out.segments.len() - 1] {
        assert!((duration - 1.0).abs() < 0.05, "{:?}", out.segments);
    }
    assert!(
        (total(&out.segments) - 3.96).abs() < 0.1,
        "{:?}",
        out.segments
    );
}

#[test]
fn starts_part_way_in() {
    let dir = tempfile::tempdir().unwrap();
    let (result, out) = convert(
        &file(&dir, "tone.wav", &wav(6)),
        4.0,
        Audio::Aac {
            track: 0,
            downmix: false,
        },
        1.0,
    );
    result.unwrap();
    assert!(
        (total(&out.segments) - 2.0).abs() < 0.2,
        "{:?}",
        out.segments
    );
}

#[test]
fn stops_when_the_sink_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = Source::open(&file(&dir, "tone.wav", &wav(6)), 0.0, None).unwrap();
    let mut out = Collected {
        stop_after: Some(1),
        ..Default::default()
    };
    let audio = Audio::Aac {
        track: 0,
        downmix: false,
    };
    assert_eq!(source.run(audio, 1.0, &mut out), Err(RemuxError::Cancelled));
    assert_eq!(out.segments.len(), 1);
}

#[test]
fn a_cancel_from_another_thread_stops_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = Source::open(&file(&dir, "tone.wav", &wav(6)), 0.0, None).unwrap();
    let canceller = source.canceller();
    std::thread::spawn(move || canceller.cancel())
        .join()
        .unwrap();
    let mut out = Collected::default();
    assert_eq!(
        source.run(Audio::Copy(0), 1.0, &mut out),
        Err(RemuxError::Cancelled)
    );
}

#[test]
fn a_track_that_isnt_there_fails() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = Source::open(&file(&dir, "grey.y4m", &y4m(10)), 0.0, None).unwrap();
    // Neither video nor the audio asked for: nothing to make.
    let mut out = Collected::default();
    let mut audio_only = Source::open(&file(&dir, "tone.wav", &wav(1)), 0.0, None).unwrap();
    assert_eq!(
        audio_only.run(Audio::Copy(3), 1.0, &mut out),
        Err(RemuxError::Failed)
    );
    assert_eq!(source.run(Audio::None, 1.0, &mut out).map(|_| ()), Ok(()));
    assert_eq!(track_index(usize::MAX), Err(RemuxError::Failed));
}

#[test]
fn a_source_that_refuses_the_login_says_so() {
    let url = serve_once("403 Forbidden", "");
    assert_eq!(
        Source::open(&format!("{url}/live/u/p/1.ts"), 0.0, None).err(),
        Some(RemuxError::Refused)
    );
    let url = serve_once("401 Unauthorized", "");
    assert_eq!(
        Source::open(&format!("{url}/live/u/p/1.ts"), 0.0, None).err(),
        Some(RemuxError::Refused)
    );
}

#[test]
fn a_source_it_cant_reach_or_read_is_unreachable() {
    assert_eq!(
        Source::open(&format!("{}/x.ts", refused_url()), 0.0, None).err(),
        Some(RemuxError::Unreachable)
    );
    let url = serve_once("404 Not Found", "");
    assert_eq!(
        Source::open(&format!("{url}/x.ts"), 0.0, None).err(),
        Some(RemuxError::Unreachable)
    );
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        Source::open(&file(&dir, "junk.ts", b"not media at all"), 0.0, None).err(),
        Some(RemuxError::Unreachable)
    );
    assert_eq!(
        Source::open("nul\0inside", 0.0, None).err(),
        Some(RemuxError::Unreachable)
    );
}

#[test]
fn errors_read_plainly_and_never_carry_the_url() {
    for (error, text) in [
        (RemuxError::Unreachable, "couldn't reach the stream"),
        (RemuxError::Refused, "the provider refused the stream"),
        (RemuxError::Failed, "the converter failed"),
        (RemuxError::Cancelled, "the conversion was stopped"),
    ] {
        assert_eq!(error.to_string(), text);
    }
    assert_eq!(check(0), Ok(()));
    assert_eq!(check(-1), Err(RemuxError::Unreachable));
    assert_eq!(check(-2), Err(RemuxError::Refused));
    assert_eq!(check(-3), Err(RemuxError::Failed));
    assert_eq!(check(-4), Err(RemuxError::Cancelled));
    assert_eq!(check(-99), Err(RemuxError::Failed));
}

#[test]
fn reads_the_c_answers() {
    let codec = CString::new("ac3").unwrap();
    let language = CString::new("eng").unwrap();
    let raw = ffi::CinetteAudioTrack {
        codec: codec.as_ptr(),
        language: language.as_ptr(),
        is_default: 1,
        decodable: 1,
    };
    assert_eq!(
        audio_track(&raw),
        AudioTrack {
            codec: "ac3".into(),
            language: Some("eng".into()),
            default: true,
            decodable: true,
        }
    );
    let bare = ffi::CinetteAudioTrack {
        codec: std::ptr::null(),
        language: std::ptr::null(),
        is_default: 0,
        decodable: 0,
    };
    assert_eq!(
        audio_track(&bare),
        AudioTrack {
            codec: String::new(),
            language: None,
            default: false,
            decodable: false,
        }
    );

    assert_eq!(video_kind(-1), Video::None);
    assert_eq!(video_kind(0), Video::Other);
    assert_eq!(video_kind(1), Video::H264);
    assert_eq!(video_kind(2), Video::Hevc);
    assert_eq!(video_kind(7), Video::Other);

    let data = [1u8, 100, 0, 31];
    assert_eq!(copy_bytes(data.as_ptr(), 4), data.to_vec());
    assert_eq!(copy_bytes(data.as_ptr(), 2), vec![1, 100]);
    assert_eq!(copy_bytes(data.as_ptr(), 0), Vec::<u8>::new());
    assert_eq!(copy_bytes(data.as_ptr(), -1), Vec::<u8>::new());
    assert_eq!(copy_bytes(std::ptr::null(), 4), Vec::<u8>::new());

    assert_eq!(length(5.5), Some(5.5));
    assert_eq!(length(0.0), None);
    assert_eq!(length(-1.0), None);
    assert_eq!(NO_TRACK, -1);
}

#[test]
fn a_sink_gets_every_byte_but_none_from_nowhere() {
    let mut out = Collected::default();
    let mut sink: &mut dyn Sink = &mut out;
    let ctx = (&mut sink as *mut &mut dyn Sink).cast::<c_void>();
    let bytes = [0x47u8, 1, 2];
    on_write(ctx, bytes.as_ptr(), 3);
    on_write(ctx, bytes.as_ptr(), 0);
    on_write(ctx, std::ptr::null(), 3);
    on_write(ctx, bytes.as_ptr(), -1);
    assert_eq!(on_cut(ctx, 2.0, 6.0), 0);
    assert_eq!(out.bytes, vec![0x47, 1, 2]);
    assert_eq!(out.segments, vec![(3, 2.0)]);
    assert_eq!(out.starts, vec![6.0]);
}

/// `parts` written one after the other into one file, as a stream whose
/// timestamps jump or whose audio changes between them would arrive.
fn joined(dir: &TempDir, parts: &[Media]) -> String {
    let mut bytes = Vec::new();
    for part in parts {
        bytes.extend(ts_bytes(dir.path(), part));
    }
    file(dir, "joined.ts", &bytes)
}

fn longest(segments: &[(usize, f64)]) -> f64 {
    segments.iter().map(|(_, d)| *d).fold(0.0, f64::max)
}

const STEREO_AAC: Audio = Audio::Aac {
    track: 0,
    downmix: false,
};

#[test]
fn copies_h264_and_says_where_each_segment_starts() {
    let dir = tempfile::tempdir().unwrap();
    let url = file(&dir, "h264.ts", &ts_bytes(dir.path(), &Media::default()));
    let opened = Source::open(&url, 0.0, None).unwrap();
    let (video, extradata) = opened.video();
    assert_eq!(video, Video::H264);
    assert!(!extradata.is_empty());
    assert_eq!(opened.audio_tracks()[0].codec, "mp2");
    drop(opened);
    let (result, out) = convert(&url, 0.0, STEREO_AAC, 1.0);
    result.unwrap();
    // A keyframe a second, so a segment a second, counted from the source's
    // first timestamp, which MPEG-TS puts past 0.
    assert_eq!(out.segments.len(), 4, "{:?}", out.segments);
    for (i, start) in out.starts.iter().enumerate() {
        assert!((start - i as f64).abs() < 0.05, "{:?}", out.starts);
    }
    assert!((total(&out.segments) - 3.96).abs() < 0.1, "{:?}", out.segments);
}

#[test]
fn starts_from_the_sources_first_timestamp() {
    let dir = tempfile::tempdir().unwrap();
    let media = Media {
        ts_offset: 50.0,
        ..Media::default()
    };
    let url = file(&dir, "late.ts", &ts_bytes(dir.path(), &media));
    let (result, out) = convert(&url, 2.0, STEREO_AAC, 1.0);
    result.unwrap();
    // 2 s in is the keyframe at 2 s, not the file's start.
    assert!((out.starts[0] - 2.0).abs() < 0.05, "{:?}", out.starts);
    assert!((total(&out.segments) - 1.96).abs() < 0.1, "{:?}", out.segments);
}

#[test]
fn cuts_a_segment_whose_keyframes_are_too_far_apart() {
    let dir = tempfile::tempdir().unwrap();
    let media = Media {
        seconds: 10.0,
        gop: 250,
        ..Media::default()
    };
    let url = file(&dir, "long-gop.ts", &ts_bytes(dir.path(), &media));
    let (result, out) = convert(&url, 0.0, Audio::Copy(0), 1.0);
    result.unwrap();
    // One keyframe in 10 s: cut at four times the segment length anyway.
    assert!(out.segments.len() >= 3, "{:?}", out.segments);
    assert!(longest(&out.segments) <= 4.1, "{:?}", out.segments);
}

#[test]
fn carries_on_across_a_jump_forward() {
    let dir = tempfile::tempdir().unwrap();
    let url = joined(
        &dir,
        &[
            Media::default(),
            Media {
                ts_offset: 1000.0,
                ..Media::default()
            },
        ],
    );
    let (result, out) = convert(&url, 0.0, STEREO_AAC, 1.0);
    result.unwrap();
    assert!(longest(&out.segments) <= 1.1, "{:?}", out.segments);
    assert!((total(&out.segments) - 8.0).abs() < 0.2, "{:?}", out.segments);
}

#[test]
fn carries_on_across_a_jump_back() {
    let dir = tempfile::tempdir().unwrap();
    let url = joined(
        &dir,
        &[
            Media {
                ts_offset: 90_000.0,
                ..Media::default()
            },
            Media::default(),
        ],
    );
    // Without the rebase, the muxer refuses the first packet after the jump.
    let (result, out) = convert(&url, 0.0, Audio::Copy(0), 1.0);
    result.unwrap();
    assert!(longest(&out.segments) <= 1.1, "{:?}", out.segments);
    assert!((total(&out.segments) - 8.0).abs() < 0.2, "{:?}", out.segments);
    let back = Source::open(&file(&dir, "out.ts", &out.bytes), 0.0, None).unwrap();
    let length = back.duration().unwrap();
    assert!((length - 8.0).abs() < 0.3, "{length}");
}

#[test]
fn converts_audio_that_changes_from_stereo_to_mono() {
    let dir = tempfile::tempdir().unwrap();
    let url = joined(
        &dir,
        &[
            Media {
                channels: 2,
                ..Media::default()
            },
            Media {
                channels: 1,
                ts_offset: 4.0,
                ..Media::default()
            },
        ],
    );
    let (result, out) = convert(&url, 0.0, STEREO_AAC, 1.0);
    result.unwrap();
    let back = Source::open(&file(&dir, "out.ts", &out.bytes), 0.0, None).unwrap();
    assert_eq!(back.audio_tracks()[0].codec, "aac");
    let length = back.duration().unwrap();
    assert!((length - 8.0).abs() < 0.3, "{length}");
}

#[test]
fn a_cancel_stops_an_open_that_hangs() {
    // A server that takes the connection and never answers.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/live/1.ts", listener.local_addr().unwrap());
    let held = std::thread::spawn(move || listener.accept().map(|(socket, _)| socket));
    let mut source = Source::new().unwrap();
    let canceller = source.canceller();
    let cancel = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        canceller.cancel();
    });
    let started = std::time::Instant::now();
    assert_eq!(source.connect(&url, 0.0, None), Err(RemuxError::Cancelled));
    // Long before the 15 s read timeout.
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    cancel.join().unwrap();
    drop(held);
}

#[test]
fn a_source_cancelled_first_never_opens() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = Source::new().unwrap();
    source.canceller().cancel();
    assert_eq!(
        source.connect(&file(&dir, "tone.wav", &wav(1)), 0.0, None),
        Err(RemuxError::Cancelled)
    );
}

#[test]
fn a_source_opens_once() {
    let dir = tempfile::tempdir().unwrap();
    let url = file(&dir, "tone.wav", &wav(1));
    let mut source = Source::open(&url, 0.0, None).unwrap();
    assert_eq!(source.connect(&url, 0.0, None), Err(RemuxError::Failed));
}
