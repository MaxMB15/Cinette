// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

const PMT_PID: u16 = 0x1000;
const VIDEO_PID: u16 = 0x100;
const AUDIO_PID: u16 = 0x101;
/// One second in ticks.
const SECOND: i64 = 90_000;

fn header(pid: u16, unit_start: bool, counter: u8, adaptation: bool) -> [u8; PACKET] {
    let mut packet = [0xFFu8; PACKET];
    packet[0] = SYNC;
    packet[1] = (u8::from(unit_start) << 6) | (pid >> 8) as u8;
    packet[2] = pid as u8;
    packet[3] = (if adaptation { 0x30 } else { 0x10 }) | (counter & 0x0F);
    packet
}

/// A PSI packet with `body` as its section after the table id and length.
fn psi(pid: u16, counter: u8, table_id: u8, body: &[u8]) -> [u8; PACKET] {
    let mut packet = header(pid, true, counter, false);
    let length = body.len() + 4;
    let mut data = vec![0, table_id, 0xB0 | (length >> 8) as u8, length as u8];
    data.extend_from_slice(body);
    // A CRC that nothing checks.
    data.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
    packet[4..4 + data.len()].copy_from_slice(&data);
    packet
}

fn pat(counter: u8) -> [u8; PACKET] {
    // Transport stream id, version, section numbers, then program 1.
    let mut body = vec![0, 1, 0xC1, 0, 0];
    body.extend_from_slice(&[0, 1, 0xE0 | (PMT_PID >> 8) as u8, PMT_PID as u8]);
    psi(PAT_PID, counter, 0, &body)
}

fn pmt(counter: u8, streams: &[(u8, u16)]) -> [u8; PACKET] {
    // Program number, version, section numbers, PCR PID, no program info.
    let mut body = vec![
        0,
        1,
        0xC1,
        0,
        0,
        0xE0 | (VIDEO_PID >> 8) as u8,
        VIDEO_PID as u8,
        0xF0,
        0,
    ];
    for &(kind, pid) in streams {
        body.extend_from_slice(&[kind, 0xE0 | (pid >> 8) as u8, pid as u8, 0xF0, 0]);
    }
    psi(PMT_PID, counter, 2, &body)
}

/// A packet that starts a PES packet at `pts`, with `data` after its
/// header, marked a random access point when `key`.
fn pes(pid: u16, pts: i64, key: bool, data: &[u8]) -> [u8; PACKET] {
    let mut packet = header(pid, true, 0, key);
    let mut at = 4;
    if key {
        packet[4] = 1;
        packet[5] = 0x40;
        at = 6;
    }
    let pts = pts & (WRAP - 1);
    let header = [
        0,
        0,
        1,
        0xE0,
        0,
        0,
        0x80,
        0x80,
        5,
        0x21 | ((pts >> 29) as u8 & 0x0E),
        (pts >> 22) as u8,
        0x01 | ((pts >> 14) as u8 & 0xFE),
        (pts >> 7) as u8,
        0x01 | ((pts << 1) as u8 & 0xFE),
    ];
    packet[at..at + header.len()].copy_from_slice(&header);
    at += header.len();
    packet[at..at + data.len()].copy_from_slice(data);
    packet
}

/// A packet that carries on a PES packet.
fn more(pid: u16) -> [u8; PACKET] {
    header(pid, false, 0, false)
}

fn video_stream() -> Vec<[u8; PACKET]> {
    vec![pat(0), pmt(0, &[(H264, VIDEO_PID), (0x0F, AUDIO_PID)])]
}

fn bytes(packets: &[[u8; PACKET]]) -> Vec<u8> {
    packets.concat()
}

fn packets(bytes: &[u8]) -> Vec<[u8; PACKET]> {
    bytes.as_chunks::<PACKET>().0.to_vec()
}

/// Frames every 0.5 s with a keyframe every `gop` frames, and an audio
/// packet after each.
fn frames(count: i64, gop: i64) -> Vec<[u8; PACKET]> {
    let mut stream = video_stream();
    for n in 0..count {
        stream.push(pes(VIDEO_PID, n * SECOND / 2, n % gop == 0, &[]));
        stream.push(more(VIDEO_PID));
        stream.push(pes(AUDIO_PID, n * SECOND / 2, false, &[]));
    }
    stream
}

fn cut(stream: &[[u8; PACKET]], shortest: f64) -> (Vec<Segment>, Option<Segment>) {
    let mut segmenter = TsSegmenter::new(shortest);
    let segments = segmenter.push(&bytes(stream)).unwrap();
    (segments, segmenter.finish())
}

#[test]
fn cuts_at_keyframes_at_least_the_shortest_length_apart() {
    // A keyframe every 1.5 s: the cuts come at 3 s and 6 s.
    let (segments, last) = cut(&frames(14, 3), 2.0);
    let durations: Vec<f64> = segments.iter().map(|s| s.duration).collect();
    assert_eq!(durations, [3.0, 3.0]);
    // 6 s to 6.5 s, plus one frame.
    assert_eq!(last.unwrap().duration, 1.0);
}

#[test]
fn every_segment_starts_with_the_pat_and_the_pmt_and_then_a_keyframe() {
    let (segments, last) = cut(&frames(14, 3), 2.0);
    let all: Vec<Segment> = segments.into_iter().chain(last).collect();
    assert_eq!(all.len(), 3);
    for segment in &all {
        let packets = packets(&segment.bytes);
        assert_eq!(pid(&packets[0]), PAT_PID);
        assert_eq!(pid(&packets[1]), PMT_PID);
        assert_eq!(pid(&packets[2]), VIDEO_PID);
        assert!(random_access(&packets[2]));
    }
}

#[test]
fn keeps_every_packet_once_besides_the_copies() {
    let stream = frames(14, 3);
    let (segments, last) = cut(&stream, 2.0);
    let all: Vec<u8> = segments
        .iter()
        .chain(last.as_ref())
        .flat_map(|s| s.bytes.clone())
        .collect();
    // Two copies of the PAT and the PMT, for the second and third segments.
    assert_eq!(all.len(), (stream.len() + 4) * PACKET);
    let media: Vec<[u8; PACKET]> = packets(&all)
        .into_iter()
        .filter(|p| pid(p) != PAT_PID && pid(p) != PMT_PID)
        .collect();
    let sent: Vec<[u8; PACKET]> = stream[2..].to_vec();
    assert_eq!(media, sent);
}

#[test]
fn renumbers_the_pat_and_pmt_so_their_counters_run_on() {
    let mut stream = frames(14, 3);
    // ffmpeg's own PAT and PMT, later on, with counters of their own.
    stream.insert(20, pat(9));
    stream.insert(21, pmt(9, &[(H264, VIDEO_PID), (0x0F, AUDIO_PID)]));
    let (segments, last) = cut(&stream, 2.0);
    let all: Vec<u8> = segments
        .iter()
        .chain(last.as_ref())
        .flat_map(|s| s.bytes.clone())
        .collect();
    for wanted in [PAT_PID, PMT_PID] {
        let counters: Vec<u8> = packets(&all)
            .iter()
            .filter(|p| pid(p) == wanted)
            .map(|p| p[3] & 0x0F)
            .collect();
        assert_eq!(counters, [0, 1, 2, 3], "PID {wanted}");
    }
}

#[test]
fn the_counter_wraps_at_sixteen() {
    let mut packet = pat(0);
    assert_eq!(renumber(&mut packet, 15), 0);
    assert_eq!(packet[3] & 0x0F, 15);
    // The adaptation field bits stay as they were.
    assert_eq!(packet[3] >> 4, 0x1);
}

#[test]
fn a_frame_that_isnt_a_keyframe_never_starts_a_segment_until_its_overdue() {
    // One keyframe at the start, then none: the cut comes at 4 × 2 s.
    let (segments, last) = cut(&frames(20, 1000), 2.0);
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].duration, 8.0);
    let packets = packets(&segments[0].bytes);
    assert_eq!(pid(&packets[2]), VIDEO_PID);
    assert_eq!(last.unwrap().duration, 2.0);
}

#[test]
fn a_segment_shorter_than_the_shortest_waits_for_the_next_keyframe() {
    // A keyframe every 0.5 s: segments still run 2 s.
    let (segments, _) = cut(&frames(9, 1), 2.0);
    let durations: Vec<f64> = segments.iter().map(|s| s.duration).collect();
    assert_eq!(durations, [2.0, 2.0]);
}

#[test]
fn a_stream_without_video_is_cut_by_its_audio() {
    let mut stream = vec![pat(0), pmt(0, &[(0x0F, AUDIO_PID)])];
    for n in 0..10 {
        // Audio packets aren't marked, and every one can start a segment.
        stream.push(pes(AUDIO_PID, n * SECOND / 2, false, &[]));
    }
    let mut segmenter = TsSegmenter::new(2.0);
    let segments = segmenter.push(&bytes(&stream)).unwrap();
    assert!(!segmenter.has_video());
    let durations: Vec<f64> = segments.iter().map(|s| s.duration).collect();
    assert_eq!(durations, [2.0, 2.0]);
    assert_eq!(segmenter.finish().unwrap().duration, 1.0);
}

#[test]
fn reads_the_video_stream_types_it_cuts_by() {
    for kind in VIDEO_TYPES {
        let mut segmenter = TsSegmenter::new(2.0);
        segmenter
            .push(&bytes(&[
                pat(0),
                pmt(0, &[(0x0F, AUDIO_PID), (kind, VIDEO_PID)]),
            ]))
            .unwrap();
        assert!(segmenter.has_video(), "type {kind:#x}");
        assert_eq!(segmenter.cut_pid, Some(VIDEO_PID));
    }
    for kind in AUDIO_TYPES {
        let mut segmenter = TsSegmenter::new(2.0);
        segmenter
            .push(&bytes(&[
                pat(0),
                pmt(0, &[(0x06, 0x102), (kind, AUDIO_PID)]),
            ]))
            .unwrap();
        assert!(!segmenter.has_video(), "type {kind:#x}");
        assert_eq!(segmenter.cut_pid, Some(AUDIO_PID));
    }
}

#[test]
fn cuts_the_same_however_the_bytes_arrive() {
    let stream = bytes(&frames(14, 3));
    let (whole, whole_last) = cut(&frames(14, 3), 2.0);
    for size in [1, 100, 187, 188, 189, 1000] {
        let mut segmenter = TsSegmenter::new(2.0);
        let mut segments = Vec::new();
        for chunk in stream.chunks(size) {
            segments.extend(segmenter.push(chunk).unwrap());
        }
        assert_eq!(segments, whole, "chunks of {size}");
        assert_eq!(segmenter.finish(), whole_last, "chunks of {size}");
    }
}

#[test]
fn bytes_that_arent_mpeg_ts_fail() {
    let mut segmenter = TsSegmenter::new(2.0);
    assert_eq!(segmenter.push(&[0u8; PACKET]), Err(TsError::NotTs));
    // A packet that loses its sync partway fails too.
    let mut segmenter = TsSegmenter::new(2.0);
    let mut stream = bytes(&video_stream());
    stream.extend_from_slice(&[0x00; PACKET]);
    assert_eq!(segmenter.push(&stream), Err(TsError::NotTs));
}

#[test]
fn nothing_but_the_tables_makes_no_segment() {
    assert_eq!(cut(&video_stream(), 2.0), (Vec::new(), None));
    let mut segmenter = TsSegmenter::new(2.0);
    segmenter.push(&[]).unwrap();
    assert_eq!(segmenter.finish(), None);
}

#[test]
fn the_last_segment_holds_the_tables_and_the_frame_that_cut() {
    let mut stream = frames(4, 1);
    // A keyframe at 2 s cuts, and nothing follows it.
    stream.push(pes(VIDEO_PID, 2 * SECOND, true, &[]));
    let mut segmenter = TsSegmenter::new(2.0);
    let segments = segmenter.push(&bytes(&stream)).unwrap();
    assert_eq!(segments.len(), 1);
    let last = segmenter.finish().unwrap();
    assert_eq!(packets(&last.bytes).len(), 3);
}

#[test]
fn reads_the_h264_profile_from_the_first_keyframe_with_an_sps() {
    // An access unit delimiter, then an SPS for High profile at level 3.1.
    let sps = [
        0, 0, 0, 1, 0x09, 0xF0, 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1F, 0xAC,
    ];
    let mut stream = video_stream();
    stream.push(pes(VIDEO_PID, 0, true, &[0, 0, 0, 1, 0x09, 0xF0]));
    stream.push(pes(VIDEO_PID, SECOND, false, &sps));
    let mut segmenter = TsSegmenter::new(2.0);
    segmenter.push(&bytes(&stream)).unwrap();
    // Only a keyframe is read.
    assert_eq!(segmenter.video_codec(), None);
    segmenter
        .push(&bytes(&[pes(VIDEO_PID, 2 * SECOND, true, &sps)]))
        .unwrap();
    assert_eq!(segmenter.video_codec(), Some("avc1.64001f"));
    // Later keyframes don't change it.
    let other = [0, 0, 1, 0x67, 0x42, 0x00, 0x1E];
    segmenter
        .push(&bytes(&[pes(VIDEO_PID, 3 * SECOND, true, &other)]))
        .unwrap();
    assert_eq!(segmenter.video_codec(), Some("avc1.64001f"));
}

#[test]
fn gives_up_on_the_profile_after_a_few_keyframes() {
    let sps = [0, 0, 1, 0x67, 0x64, 0x00, 0x1F];
    let mut stream = video_stream();
    for n in 0..i64::from(SPS_SEARCHES) {
        stream.push(pes(VIDEO_PID, n * SECOND, true, &[]));
    }
    stream.push(pes(VIDEO_PID, 20 * SECOND, true, &sps));
    let mut segmenter = TsSegmenter::new(2.0);
    segmenter.push(&bytes(&stream)).unwrap();
    assert_eq!(segmenter.video_codec(), None);

    // One fewer, and the SPS is found.
    let mut stream = video_stream();
    for n in 0..i64::from(SPS_SEARCHES) - 1 {
        stream.push(pes(VIDEO_PID, n * SECOND, true, &[]));
    }
    stream.push(pes(VIDEO_PID, 20 * SECOND, true, &sps));
    let mut segmenter = TsSegmenter::new(2.0);
    segmenter.push(&bytes(&stream)).unwrap();
    assert_eq!(segmenter.video_codec(), Some("avc1.64001f"));
}

#[test]
fn hevc_has_no_avc_profile() {
    let sps = [0, 0, 1, 0x67, 0x64, 0x00, 0x1F];
    let mut stream = vec![pat(0), pmt(0, &[(0x24, VIDEO_PID)])];
    stream.push(pes(VIDEO_PID, 0, true, &sps));
    let mut segmenter = TsSegmenter::new(2.0);
    segmenter.push(&bytes(&stream)).unwrap();
    assert!(segmenter.has_video());
    assert_eq!(segmenter.video_codec(), None);
}

#[test]
fn a_clock_that_wraps_keeps_counting_up() {
    let mut stream = video_stream();
    let start = WRAP - SECOND;
    for n in 0..9 {
        stream.push(pes(VIDEO_PID, start + n * SECOND / 2, n % 2 == 0, &[]));
    }
    let (segments, last) = cut(&stream, 2.0);
    let durations: Vec<f64> = segments.iter().map(|s| s.duration).collect();
    assert_eq!(durations, [2.0, 2.0]);
    assert_eq!(last.unwrap().duration, 0.5);
}

#[test]
fn a_clock_that_wraps_twice_keeps_counting_up() {
    // Each jump forward is less than half the clock, so each counts as later.
    let jump = 3_000_000_000;
    let mut stream = video_stream();
    for pts in [WRAP - 2 * SECOND, 0, jump, 2 * jump, 0] {
        stream.push(pes(VIDEO_PID, pts, true, &[]));
    }
    let (segments, _) = cut(&stream, 2.0);
    let durations: Vec<f64> = segments.iter().map(|s| s.duration).collect();
    let seconds = |ticks: i64| ticks as f64 / CLOCK;
    assert_eq!(
        durations,
        [2.0, seconds(jump), seconds(jump), seconds(WRAP - 2 * jump)]
    );
}

#[test]
fn a_clock_half_its_range_back_is_earlier_not_wrapped() {
    let mut stream = video_stream();
    stream.push(pes(VIDEO_PID, WRAP / 2, true, &[]));
    stream.push(pes(VIDEO_PID, 0, true, &[]));
    let (segments, _) = cut(&stream, 2.0);
    assert!(segments.is_empty());
}

#[test]
fn the_last_segment_ends_one_frame_after_its_last_timestamp() {
    // The last two frames share a timestamp, so the frame length is the
    // one before them.
    let mut stream = video_stream();
    for pts in [0, SECOND / 2, SECOND, SECOND] {
        stream.push(pes(VIDEO_PID, pts, pts == 0, &[]));
    }
    let (segments, last) = cut(&stream, 2.0);
    assert!(segments.is_empty());
    assert_eq!(last.unwrap().duration, 1.5);
}

#[test]
fn a_pat_that_carries_on_into_a_second_packet_is_copied_whole() {
    let mut stream = frames(8, 1);
    stream.insert(1, header(PAT_PID, false, 1, false));
    let (segments, last) = cut(&stream, 2.0);
    assert!(!segments.is_empty());
    let pids: Vec<u16> = packets(&last.unwrap().bytes)
        .iter()
        .take(3)
        .map(pid)
        .collect();
    assert_eq!(pids, [PAT_PID, PAT_PID, PMT_PID]);
}

#[test]
fn a_packet_with_only_an_adaptation_field_has_no_payload() {
    let mut packet = header(VIDEO_PID, true, 0, true);
    packet[3] = 0x20;
    assert_eq!(payload(&packet), None);
}

#[test]
fn an_adaptation_field_without_the_flag_isnt_a_random_access_point() {
    let mut packet = pes(VIDEO_PID, 0, true, &[]);
    assert!(random_access(&packet));
    packet[5] = 0x00;
    assert!(!random_access(&packet));
    packet[4] = 0;
    packet[5] = 0x40;
    assert!(!random_access(&packet));
}

#[test]
fn reads_the_data_after_the_pes_header() {
    let packet = pes(VIDEO_PID, 0, false, &[1, 2, 3]);
    let data = payload(&packet).and_then(pes_data).unwrap();
    assert_eq!(&data[..3], [1, 2, 3]);
}

#[test]
fn a_frame_shown_before_the_keyframe_doesnt_cut() {
    // B-frames come after their keyframe with earlier timestamps.
    let mut stream = video_stream();
    stream.push(pes(VIDEO_PID, SECOND, true, &[]));
    stream.push(pes(VIDEO_PID, SECOND / 2, false, &[]));
    stream.push(pes(VIDEO_PID, 3 * SECOND, true, &[]));
    let (segments, _) = cut(&stream, 2.0);
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].duration, 2.0);
}

#[test]
fn a_segment_past_the_byte_cap_is_cut_at_the_next_frame() {
    let mut stream = video_stream();
    stream.push(pes(VIDEO_PID, 0, true, &[]));
    let fill = CUT_BYTES / PACKET + 1;
    stream.extend(std::iter::repeat_n(more(VIDEO_PID), fill));
    stream.push(pes(VIDEO_PID, SECOND / 2, false, &[]));
    let (segments, _) = cut(&stream, 2.0);
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].duration, 0.5);
    assert!(segments[0].bytes.len() >= CUT_BYTES);
}

#[test]
fn a_packet_without_a_timestamp_never_cuts() {
    let mut stream = video_stream();
    stream.push(pes(VIDEO_PID, 0, true, &[]));
    let mut no_pts = pes(VIDEO_PID, 3 * SECOND, true, &[]);
    // The PES header's flags say there's no PTS.
    no_pts[6 + 7] = 0;
    stream.push(no_pts);
    let (segments, last) = cut(&stream, 2.0);
    assert!(segments.is_empty());
    assert_eq!(last.unwrap().duration, 0.0);
}

#[test]
fn reads_a_pat_and_pmt_with_a_pointer_field() {
    let mut packet = header(PAT_PID, true, 0, false);
    let section = &pat(0)[5..];
    packet[4] = 2;
    packet[5..7].copy_from_slice(&[0xFF, 0xFF]);
    packet[7..].copy_from_slice(&section[..PACKET - 7]);
    assert_eq!(payload(&packet).and_then(read_pat), Some(PMT_PID));
    // A program 0 entry names the network PID, not a PMT.
    let body = [0, 1, 0xC1, 0, 0, 0, 0, 0xE0, 0x10, 0, 1, 0xF0, 0x00];
    assert_eq!(
        payload(&psi(PAT_PID, 0, 0, &body)).and_then(read_pat),
        Some(0x1000)
    );
}

#[test]
fn skips_the_descriptors_in_a_pmt() {
    // Program info of 3 bytes, then a stream with 2 bytes of descriptors.
    let body = [
        0, 1, 0xC1, 0, 0, 0xE1, 0x00, 0xF0, 3, 9, 9, 9, H264, 0xE1, 0x00, 0xF0, 2, 7, 7, 0x0F,
        0xE1, 0x01, 0xF0, 0,
    ];
    let streams = payload(&psi(PMT_PID, 0, 2, &body)).and_then(read_pmt);
    assert_eq!(streams, Some(vec![(H264, VIDEO_PID), (0x0F, AUDIO_PID)]));
}

#[test]
fn reads_the_payload_after_the_adaptation_field() {
    let mut packet = header(VIDEO_PID, true, 0, true);
    packet[4] = 7;
    assert_eq!(payload(&packet).map(<[u8]>::len), Some(PACKET - 12));
    assert_eq!(
        payload(&header(VIDEO_PID, true, 0, false)).map(<[u8]>::len),
        Some(PACKET - 4)
    );
    // Adaptation only, with no payload.
    let mut only = header(VIDEO_PID, true, 0, true);
    only[3] = 0x20;
    assert_eq!(payload(&only), None);
    // An empty adaptation field has no flags.
    packet[4] = 0;
    packet[5] = 0x40;
    assert!(!random_access(&packet));
    // Without an adaptation field, the byte that would hold the flags is
    // payload.
    let mut plain = header(VIDEO_PID, true, 0, false);
    plain[4] = 1;
    plain[5] = 0x40;
    assert!(!random_access(&plain));
}

#[test]
fn reads_a_full_33_bit_timestamp() {
    let pts = WRAP - 1;
    let packet = pes(VIDEO_PID, pts, false, &[]);
    assert_eq!(payload(&packet).and_then(pes_pts), Some(pts));
    let packet = pes(VIDEO_PID, 0x1_2345_6789, false, &[]);
    assert_eq!(payload(&packet).and_then(pes_pts), Some(0x1_2345_6789));
    // Not a PES start code.
    assert_eq!(
        pes_pts(&[0, 0, 2, 0xE0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1]),
        None
    );
}
