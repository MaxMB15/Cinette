// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

#[test]
fn names_segments_by_sequence() {
    assert_eq!(segment_name(0), "seg0.ts");
    assert_eq!(segment_name(42), "seg42.ts");
}

/// A window of `segments` segments, with room for any length and size.
fn by_count(segments: usize) -> Window {
    Window {
        segments,
        seconds: f64::INFINITY,
        bytes: usize::MAX,
    }
}

#[test]
fn lists_segments_with_their_lengths() {
    let mut playlist = MediaPlaylist::new(by_count(10), 3);
    assert!(playlist.is_empty());
    assert_eq!(playlist.push(2.002, 100), (0, vec![]));
    assert_eq!(playlist.push(2.5, 100), (1, vec![]));
    assert_eq!(playlist.len(), 2);
    assert!(!playlist.is_empty());
    assert_eq!(
        playlist.text(),
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n\
         #EXTINF:2.002,\nseg0.ts\n#EXTINF:2.500,\nseg1.ts\n"
    );
}

#[test]
fn the_target_never_changes() {
    let mut playlist = MediaPlaylist::new(by_count(4), 10);
    assert!(playlist.text().contains("#EXT-X-TARGETDURATION:10\n"));
    playlist.push(2.0, 1);
    playlist.push(9.6, 1);
    assert!(playlist.text().contains("#EXT-X-TARGETDURATION:10\n"));
    assert!(MediaPlaylist::new(by_count(4), 0)
        .text()
        .contains("#EXT-X-TARGETDURATION:1\n"));
}

#[test]
fn a_movie_starts_at_the_first_segment() {
    let mut playlist = MediaPlaylist::new(by_count(4), 10).from_start();
    playlist.push(2.0, 1);
    assert_eq!(
        playlist.text(),
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n\
         #EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXTINF:2.000,\nseg0.ts\n"
    );
    assert!(!MediaPlaylist::new(by_count(4), 10)
        .text()
        .contains("EXT-X-START"));
}

#[test]
fn slides_the_window_and_says_what_left() {
    let mut playlist = MediaPlaylist::new(by_count(2), 2);
    playlist.push(2.0, 1);
    playlist.push(2.0, 1);
    assert_eq!(playlist.push(2.0, 1), (2, vec![0]));
    assert_eq!(playlist.push(2.0, 1), (3, vec![1]));
    assert_eq!(playlist.len(), 2);
    let text = playlist.text();
    assert!(text.contains("#EXT-X-MEDIA-SEQUENCE:2\n"), "{text}");
    assert!(
        text.contains("seg2.ts\n") && text.contains("seg3.ts\n"),
        "{text}"
    );
    assert!(!text.contains("seg1.ts"), "{text}");
}

#[test]
fn keeps_no_more_seconds_than_the_window_allows() {
    let window = Window {
        segments: 10,
        seconds: 10.0,
        bytes: usize::MAX,
    };
    let mut playlist = MediaPlaylist::new(window, 8);
    for _ in 0..5 {
        playlist.push(2.0, 1);
    }
    // 10 s fits exactly.
    assert_eq!(playlist.len(), 5);
    // Two long segments push three short ones out at once.
    assert_eq!(playlist.push(5.0, 1), (5, vec![0, 1, 2]));
    assert_eq!(playlist.len(), 3);
}

#[test]
fn keeps_no_more_bytes_than_the_window_allows() {
    let window = Window {
        segments: 10,
        seconds: f64::INFINITY,
        bytes: 100,
    };
    let mut playlist = MediaPlaylist::new(window, 8);
    playlist.push(2.0, 50);
    playlist.push(2.0, 50);
    assert_eq!(playlist.len(), 2);
    assert_eq!(playlist.push(2.0, 1), (2, vec![0]));
}

#[test]
fn keeps_the_newest_segment_whatever_its_size() {
    let mut playlist = MediaPlaylist::new(by_count(0), 2);
    playlist.push(2.0, 1);
    assert_eq!(playlist.push(2.0, 1), (1, vec![0]));
    assert_eq!(playlist.len(), 1);
    let window = Window {
        segments: 10,
        seconds: 1.0,
        bytes: 1,
    };
    let mut big = MediaPlaylist::new(window, 8);
    assert_eq!(big.push(5.0, 500), (0, vec![]));
    assert_eq!(big.len(), 1);
}

#[test]
fn a_segment_longer_than_the_target_is_listed_as_the_target() {
    let mut playlist = MediaPlaylist::new(by_count(4), 10);
    playlist.push(12.0, 1);
    playlist.push_after(10.0, 1, true);
    let text = playlist.text();
    assert_eq!(text.matches("#EXTINF:10.000,").count(), 2, "{text}");
}

#[test]
fn marks_a_discontinuity_and_counts_those_that_left() {
    let mut playlist = MediaPlaylist::new(by_count(2), 4);
    playlist.push(2.0, 1);
    assert_eq!(playlist.push_after(2.0, 1, true), (1, vec![]));
    let text = playlist.text();
    assert!(
        text.contains("seg0.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\nseg1.ts\n"),
        "{text}"
    );
    assert!(!text.contains("DISCONTINUITY-SEQUENCE"), "{text}");
    // seg0 leaving takes no discontinuity with it.
    playlist.push(2.0, 1);
    assert!(!playlist.text().contains("DISCONTINUITY-SEQUENCE"));
    // seg1 leaving does.
    playlist.push_after(2.0, 1, true);
    let text = playlist.text();
    assert!(text.contains("#EXT-X-DISCONTINUITY-SEQUENCE:1\n"), "{text}");
    assert_eq!(text.matches("#EXT-X-DISCONTINUITY\n").count(), 1, "{text}");
    playlist.push(2.0, 1);
    playlist.push(2.0, 1);
    let text = playlist.text();
    assert!(text.contains("#EXT-X-DISCONTINUITY-SEQUENCE:2\n"), "{text}");
    assert!(!text.contains("#EXT-X-DISCONTINUITY\n"), "{text}");
    // It comes right after the media sequence.
    assert!(
        text.contains("#EXT-X-MEDIA-SEQUENCE:4\n#EXT-X-DISCONTINUITY-SEQUENCE:2\n#EXTINF"),
        "{text}"
    );
}

#[test]
fn a_broken_duration_counts_as_zero() {
    let mut playlist = MediaPlaylist::new(by_count(4), 1);
    playlist.push(f64::NAN, 1);
    playlist.push(-1.0, 1);
    playlist.push(f64::INFINITY, 1);
    let text = playlist.text();
    assert_eq!(text.matches("#EXTINF:0.000,").count(), 3, "{text}");
}

#[test]
fn is_ready_with_three_segments_or_six_seconds_or_at_the_end() {
    let mut playlist = MediaPlaylist::new(by_count(10), 8);
    assert!(!playlist.ready());
    playlist.push(2.0, 1);
    playlist.push(2.0, 1);
    assert!(!playlist.ready());
    playlist.push(2.0, 1);
    assert!(playlist.ready());

    // Keyframes far apart: one long segment is enough.
    let mut long = MediaPlaylist::new(by_count(10), 8);
    long.push(READY_SECONDS - 0.01, 1);
    assert!(!long.ready());
    long.push(0.01, 1);
    assert!(long.ready());

    let mut short = MediaPlaylist::new(by_count(10), 8);
    short.finish();
    assert!(!short.ready(), "an empty stream has nothing to play");
    short.push(1.0, 1);
    assert!(short.ready());
}

#[test]
fn ends_the_playlist_when_the_stream_ends() {
    let mut playlist = MediaPlaylist::new(by_count(10), 2);
    playlist.push(2.0, 1);
    assert!(!playlist.text().contains("ENDLIST"));
    playlist.finish();
    assert!(playlist.text().ends_with("seg0.ts\n#EXT-X-ENDLIST\n"));
}

#[test]
fn the_master_names_the_media_playlist_and_its_codecs() {
    let codecs = vec!["avc1.64001f".to_string(), "mp4a.40.2".to_string()];
    assert_eq!(
        master(6_000_000, &codecs),
        "#EXTM3U\n#EXT-X-VERSION:3\n\
         #EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS=\"avc1.64001f,mp4a.40.2\"\nmedia.m3u8\n"
    );
    assert_eq!(
        master(1, &[]),
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n"
    );
}

#[test]
fn reads_the_h264_profile_from_avcc() {
    // version 1, High profile (100), compatibility 0, level 3.1 (31).
    let avcc = [1, 100, 0, 31, 0xff, 0xe1, 0, 0];
    assert_eq!(avc_codec(&avcc).as_deref(), Some("avc1.64001f"));
    assert_eq!(avc_codec(&[1, 100, 0]), None);
}

#[test]
fn reads_the_h264_profile_from_an_annex_b_sps() {
    // A PPS-like NAL first, then the SPS (type 7) with Main profile, level 4.
    let annex_b = [0, 0, 0, 1, 0x68, 0xce, 0, 0, 1, 0x67, 77, 0x40, 40, 0xaa];
    assert_eq!(avc_codec(&annex_b).as_deref(), Some("avc1.4d4028"));
    // An SPS cut short has no profile to read.
    assert_eq!(avc_codec(&[0, 0, 1, 0x67, 77]), None);
    // Without an SPS there's nothing.
    assert_eq!(avc_codec(&[0, 0, 1, 0x68, 1, 2, 3]), None);
    assert_eq!(avc_codec(&[]), None);
    // A start code right at the end.
    assert_eq!(avc_codec(&[9, 0, 0, 1]), None);
}

#[test]
fn names_the_audio_codecs_hls_carries() {
    assert_eq!(audio_codec("aac"), Some("mp4a.40.2"));
    assert_eq!(audio_codec("mp3"), Some("mp4a.40.34"));
    assert_eq!(audio_codec("ac3"), Some("ac-3"));
    assert_eq!(audio_codec("eac3"), Some("ec-3"));
    assert_eq!(audio_codec("dts"), None);
}

#[test]
fn the_pacer_lets_the_converter_run_until_it_is_ahead() {
    let mut pacer = Pacer::new(100.0);
    assert_eq!(pacer.wait(100.0), Some(0.0));
    pacer.made(19.0);
    assert_eq!(pacer.wait(100.0), Some(0.0));
    pacer.made(2.0);
    // 21 s made, none played: 1 s past the lead.
    assert_eq!(pacer.wait(100.0), Some(1.0));
    // Playback catches up.
    assert_eq!(pacer.wait(101.0), Some(0.0));
    assert_eq!(pacer.wait(110.0), Some(0.0));
}

#[test]
fn the_pacer_stops_the_clock_while_paused() {
    let mut pacer = Pacer::new(0.0);
    pacer.made(30.0);
    pacer.pause(5.0);
    // 30 made, 5 played: ahead by 25, and paused, so it waits for a resume.
    assert_eq!(pacer.wait(50.0), None);
    pacer.pause(60.0);
    assert_eq!(pacer.wait(60.0), None);
    pacer.resume(100.0);
    assert_eq!(pacer.wait(100.0), Some(5.0));
    // A second resume doesn't move the clock.
    pacer.resume(103.0);
    assert_eq!(pacer.wait(103.0), Some(2.0));
    assert_eq!(pacer.wait(105.0), Some(0.0));
}

#[test]
fn the_pacer_goes_on_while_paused_and_behind() {
    let mut pacer = Pacer::new(0.0);
    pacer.made(5.0);
    pacer.pause(1.0);
    assert_eq!(pacer.wait(500.0), Some(0.0));
}

#[test]
fn the_pacer_ignores_a_clock_going_backwards_and_negative_segments() {
    let mut pacer = Pacer::new(10.0);
    pacer.made(-5.0);
    pacer.made(25.0);
    assert_eq!(pacer.wait(5.0), Some(5.0));
    pacer.pause(5.0);
    pacer.resume(5.0);
    assert_eq!(pacer.wait(5.0), Some(5.0));
}

#[test]
fn a_paused_pacer_runs_to_the_lead_then_waits_for_playback() {
    let mut pacer = Pacer::paused();
    assert_eq!(pacer.wait(0.0), Some(0.0));
    pacer.made(LEAD);
    // The receiver hasn't started, however long it takes.
    assert_eq!(pacer.wait(500.0), None);
    pacer.resume(500.0);
    assert_eq!(pacer.wait(500.0), Some(0.0));
    pacer.made(1.0);
    assert_eq!(pacer.wait(500.5), Some(0.5));
}

#[test]
fn the_pacer_waits_for_a_resume_at_exactly_the_lead() {
    let mut pacer = Pacer::new(0.0);
    pacer.made(LEAD);
    pacer.pause(0.0);
    assert_eq!(pacer.wait(0.0), None);
    pacer.resume(0.0);
    assert_eq!(pacer.wait(0.0), Some(0.0));
}

#[test]
fn the_master_declares_a_fifth_more_than_the_first_segment_took() {
    // 1 MB in 2 s is 4 Mb/s, so 4.8 Mb/s.
    assert_eq!(bandwidth(1_000_000, 2.0), 4_800_000);
    assert_eq!(bandwidth(1_000_000, 4.0), 2_400_000);
    // A tiny segment still declares the minimum.
    assert_eq!(bandwidth(1000, 2.0), MIN_BANDWIDTH);
    assert_eq!(MIN_BANDWIDTH, 500_000);
    // A segment with no length counts as a tenth of a second.
    assert_eq!(bandwidth(100_000, 0.0), 9_600_000);
}

#[test]
fn keeps_the_output_settings_it_says() {
    // 200 MB in the window.
    assert_eq!(WINDOW.bytes, 209_715_200);
    assert_eq!(WINDOW.segments, 15);
    assert_eq!(WINDOW.seconds, 50.0);
    assert_eq!(SEGMENT, 2.0);
    assert_eq!(TARGET, 10);
    assert_eq!(AVC_FALLBACK, "avc1.640028");
}
