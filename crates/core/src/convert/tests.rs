// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::mkv::{MkvError, MkvSplitter, Piece};
use super::serve::{head_end, ok_head, read_request, token, Request, MAX_HEAD};
use super::{args, AudioPlan, HardwareEncoder, NoEncoder, Plan, VideoPlan};

const URL: &str = "http://srv/live/u/p/1.ts";

fn plan(video: VideoPlan, audio: AudioPlan) -> Plan {
    Plan {
        video,
        audio,
        start_at: None,
        audio_track: 0,
    }
}

fn joined(args: &[String]) -> String {
    args.join(" ")
}

#[test]
fn a_remux_copies_both_tracks_into_live_matroska() {
    let args = args(URL, &plan(VideoPlan::Copy, AudioPlan::Copy), None).unwrap();
    assert_eq!(
        joined(&args),
        "-hide_banner -nostdin -loglevel error -reconnect 1 -reconnect_delay_max 5 \
         -rw_timeout 15000000 -i http://srv/live/u/p/1.ts -map 0:v:0 -map 0:a:0? -sn -dn \
         -c:v copy -c:a copy -f matroska -live 1 -flush_packets 1 pipe:1"
    );
}

#[test]
fn audio_the_receiver_cant_play_becomes_stereo_aac() {
    let mut p = plan(VideoPlan::Copy, AudioPlan::Aac);
    p.audio_track = 2;
    let args = joined(&args(URL, &p, None).unwrap());
    assert!(
        args.contains("-map 0:a:2? -sn -dn -c:v copy -c:a aac -b:a 192k -ac 2 -f matroska"),
        "{args}"
    );
}

#[test]
fn a_stream_without_video_or_audio_maps_only_what_it_has() {
    let radio = joined(&args(URL, &plan(VideoPlan::None, AudioPlan::Aac), None).unwrap());
    assert!(!radio.contains("0:v"), "{radio}");
    assert!(!radio.contains("-c:v"), "{radio}");
    let silent = joined(&args(URL, &plan(VideoPlan::Copy, AudioPlan::None), None).unwrap());
    assert!(!silent.contains("0:a"), "{silent}");
    assert!(!silent.contains("-c:a"), "{silent}");
}

#[test]
fn starts_a_file_where_asked() {
    let mut p = plan(VideoPlan::Copy, AudioPlan::Copy);
    p.start_at = Some(1312.4);
    let args = joined(&args(URL, &p, None).unwrap());
    assert!(
        args.contains("-rw_timeout 15000000 -ss 1312.400 -i "),
        "{args}"
    );
    p.start_at = Some(0.0);
    assert!(!joined(&super::args(URL, &p, None).unwrap()).contains("-ss"));
}

#[test]
fn a_transcode_needs_a_hardware_encoder() {
    let transcode = plan(VideoPlan::Transcode { deinterlace: false }, AudioPlan::Copy);
    assert_eq!(args(URL, &transcode, None), Err(NoEncoder));
    let args_vt = joined(&args(URL, &transcode, Some(HardwareEncoder::VideoToolbox)).unwrap());
    assert!(
        args_vt.contains(
            "-vf format=yuv420p -c:v h264_videotoolbox -b:v 6M -maxrate 8M -bufsize 12M -g 50 -c:a copy"
        ),
        "{args_vt}"
    );
    let interlaced = plan(VideoPlan::Transcode { deinterlace: true }, AudioPlan::Aac);
    let args_i = joined(&args(URL, &interlaced, Some(HardwareEncoder::VideoToolbox)).unwrap());
    assert!(
        args_i.contains("-vf yadif=mode=send_frame,format=yuv420p -c:v h264_videotoolbox"),
        "{args_i}"
    );
    assert_eq!(
        NoEncoder.to_string(),
        "this device has no hardware video encoder"
    );
}

/// An element with a one-byte size.
fn element(id: &[u8], data: &[u8]) -> Vec<u8> {
    assert!(data.len() < 127);
    let mut out = id.to_vec();
    out.push(0x80 | data.len() as u8);
    out.extend_from_slice(data);
    out
}

const EBML: &[u8] = &[0x1A, 0x45, 0xDF, 0xA3];
const SEGMENT: &[u8] = &[0x18, 0x53, 0x80, 0x67];
const INFO: &[u8] = &[0x15, 0x49, 0xA9, 0x66];
const TRACKS: &[u8] = &[0x16, 0x54, 0xAE, 0x6B];
const CLUSTER: &[u8] = &[0x1F, 0x43, 0xB6, 0x75];
const TAGS: &[u8] = &[0x12, 0x54, 0xC3, 0x67];

/// The start of a live stream: the EBML header, a Segment of unknown size,
/// Info and Tracks.
fn header() -> Vec<u8> {
    let mut out = element(EBML, &[0x42, 0x86, 0x81, 0x01]);
    out.extend_from_slice(SEGMENT);
    out.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    out.extend(element(INFO, b"info"));
    out.extend(element(TRACKS, b"tracks"));
    out
}

#[test]
fn splits_the_header_from_each_cluster() {
    let first = element(CLUSTER, b"one");
    // A cluster with a two-byte size.
    let mut second = CLUSTER.to_vec();
    second.extend_from_slice(&[0x40, 0x03]);
    second.extend_from_slice(b"two");
    let tags = element(TAGS, b"t");
    let mut stream = header();
    stream.extend(&first);
    stream.extend(&tags);
    stream.extend(&second);

    let mut splitter = MkvSplitter::default();
    let pieces = splitter.push(&stream).unwrap();
    assert_eq!(
        pieces,
        vec![
            Piece::Header(header()),
            Piece::Element {
                bytes: first,
                cluster: true
            },
            Piece::Element {
                bytes: tags,
                cluster: false
            },
            Piece::Element {
                bytes: second,
                cluster: true
            },
        ]
    );
}

#[test]
fn waits_for_whole_elements_however_the_bytes_arrive() {
    let mut stream = header();
    stream.extend(element(CLUSTER, b"one"));
    stream.extend(element(CLUSTER, b"two"));
    let mut whole = MkvSplitter::default();
    let expected = whole.push(&stream).unwrap();

    let mut splitter = MkvSplitter::default();
    let mut pieces = Vec::new();
    for byte in &stream {
        pieces.extend(splitter.push(std::slice::from_ref(byte)).unwrap());
    }
    assert_eq!(pieces, expected);
    assert_eq!(pieces.len(), 3);
}

#[test]
fn turns_down_what_isnt_live_matroska() {
    let mut splitter = MkvSplitter::default();
    assert_eq!(splitter.push(b"#EXTM3U\n"), Err(MkvError::NotMatroska));
    // An ID longer than four bytes.
    assert_eq!(
        MkvSplitter::default().push(&[0x00, 0x81]),
        Err(MkvError::NotMatroska)
    );
    // A size longer than eight bytes.
    assert_eq!(
        MkvSplitter::default().push(&[0x1A, 0x45, 0xDF, 0xA3, 0x00]),
        Err(MkvError::NotMatroska)
    );
    // A cluster of unknown size can't be cut out.
    let mut stream = header();
    stream.extend_from_slice(CLUSTER);
    stream.push(0xFF);
    let mut splitter = MkvSplitter::default();
    assert_eq!(splitter.push(&stream), Err(MkvError::Size));
    // Nor can a header element of unknown size.
    let mut stream = element(EBML, &[]);
    stream.extend_from_slice(SEGMENT);
    stream.push(0xFF);
    stream.extend_from_slice(INFO);
    stream.push(0xFF);
    assert_eq!(MkvSplitter::default().push(&stream), Err(MkvError::Size));
    // An element far bigger than any ffmpeg writes.
    let mut stream = header();
    stream.extend_from_slice(CLUSTER);
    stream.extend_from_slice(&[0x08, 0x10, 0, 0, 0]);
    assert_eq!(MkvSplitter::default().push(&stream), Err(MkvError::Size));
    let mut stream = element(EBML, &[]);
    stream.extend_from_slice(SEGMENT);
    stream.push(0xFF);
    stream.extend_from_slice(INFO);
    stream.extend_from_slice(&[0x08, 0x10, 0, 0, 0]);
    assert_eq!(MkvSplitter::default().push(&stream), Err(MkvError::Size));
}

#[test]
fn takes_elements_up_to_64_mib() {
    let mut stream = header();
    stream.extend_from_slice(CLUSTER);
    // A size of exactly 64 MiB, in four bytes.
    stream.extend_from_slice(&[0x14, 0x00, 0x00, 0x00]);
    let mut splitter = MkvSplitter::default();
    assert_eq!(splitter.push(&stream).unwrap().len(), 1);
    // The cluster's data hasn't come yet, so nothing more is out.
    assert!(splitter.push(&[0; 1000]).unwrap().is_empty());
}

#[test]
fn a_header_without_its_segment_children_waits() {
    let mut stream = header();
    let cut = stream.len() - 3;
    stream.truncate(cut);
    let mut splitter = MkvSplitter::default();
    assert!(splitter.push(&stream).unwrap().is_empty());
    assert!(splitter.push(&[]).unwrap().is_empty());
}

#[test]
fn reads_get_and_head_of_a_plain_path() {
    let get = read_request(b"GET /cast/abc/stream.mkv HTTP/1.1\r\nHost: x\r\n\r\n");
    assert_eq!(
        get,
        Some(Request {
            path: "/cast/abc/stream.mkv".into(),
            head_only: false
        })
    );
    let head = read_request(b"HEAD /cast/abc/subs.vtt HTTP/1.0\r\n\r\n");
    assert_eq!(
        head,
        Some(Request {
            path: "/cast/abc/subs.vtt".into(),
            head_only: true
        })
    );
    for bad in [
        &b"POST /x HTTP/1.1\r\n\r\n"[..],
        b"GET x HTTP/1.1\r\n\r\n",
        b"GET /x HTTP/2\r\n\r\n",
        b"GET /x HTTP/1.1 extra\r\n\r\n",
        b"GET /x\r\n\r\n",
        b"GET\r\n\r\n",
        b"\r\n",
        b"",
        b"GET /\xff HTTP/1.1\r\n\r\n",
    ] {
        assert_eq!(read_request(bad), None, "{}", String::from_utf8_lossy(bad));
    }
}

#[test]
fn finds_the_end_of_a_head() {
    assert_eq!(head_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(18));
    assert_eq!(head_end(b"GET / HTTP/1.1\r\n"), None);
    assert_eq!(MAX_HEAD, 8192);
}

#[test]
fn answers_with_no_length_for_a_live_stream() {
    assert_eq!(
        ok_head("video/x-matroska", None),
        "HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nAccept-Ranges: none\r\n\
         Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    assert!(
        ok_head("text/vtt", Some(12)).contains("Content-Type: text/vtt\r\nContent-Length: 12\r\n")
    );
}

#[test]
fn tokens_are_long_and_new_each_time() {
    let (a, b) = (token(), token());
    assert_eq!(a.len(), 64);
    assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
}

#[test]
fn the_sidecar_test_runs_the_converters_arguments() {
    // scripts/test-ffmpeg-sidecar.py tests each ffmpeg build with a copy of
    // the arguments a conversion uses.
    let script = include_str!("../../../../scripts/test-ffmpeg-sidecar.py");
    let convert = args("URL", &plan(VideoPlan::Copy, AudioPlan::Aac), None)
        .unwrap()
        .join(" ");
    let line = format!("CONVERT_ARGS = \"{convert}\"");
    assert!(
        script.lines().any(|l| l == line),
        "scripts/test-ffmpeg-sidecar.py should have the line {line}"
    );
}
