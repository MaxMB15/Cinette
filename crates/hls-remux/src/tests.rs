// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Conversions of media made here: WAV audio and Y4M video, from files and
//! from loopback servers. The output is read back through the same API.

use super::*;
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
    /// How many cuts to allow before asking it to stop.
    stop_after: Option<usize>,
}

impl Sink for Collected {
    fn write(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    fn cut(&mut self, duration: f64) -> bool {
        self.segments.push((self.bytes.len(), duration));
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
