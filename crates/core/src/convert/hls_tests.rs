// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

#[test]
fn names_segments_by_sequence() {
    assert_eq!(segment_name(0), "seg0.ts");
    assert_eq!(segment_name(42), "seg42.ts");
}

#[test]
fn lists_segments_with_their_lengths() {
    let mut playlist = MediaPlaylist::new(10);
    assert!(playlist.is_empty());
    assert_eq!(playlist.push(2.002), (0, None));
    assert_eq!(playlist.push(2.5), (1, None));
    assert_eq!(playlist.len(), 2);
    assert!(!playlist.is_empty());
    assert_eq!(
        playlist.text(),
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n\
         #EXTINF:2.002,\nseg0.ts\n#EXTINF:2.500,\nseg1.ts\n"
    );
}

#[test]
fn an_empty_playlist_has_a_target_of_one() {
    assert_eq!(
        MediaPlaylist::new(3).text(),
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n"
    );
}

#[test]
fn slides_the_window_and_says_what_left() {
    let mut playlist = MediaPlaylist::new(2);
    playlist.push(2.0);
    playlist.push(2.0);
    assert_eq!(playlist.push(2.0), (2, Some(0)));
    assert_eq!(playlist.push(2.0), (3, Some(1)));
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
fn keeps_at_least_one_segment() {
    let mut playlist = MediaPlaylist::new(0);
    playlist.push(2.0);
    assert_eq!(playlist.push(2.0), (1, Some(0)));
    assert_eq!(playlist.len(), 1);
}

#[test]
fn the_target_only_grows() {
    let mut playlist = MediaPlaylist::new(2);
    playlist.push(6.2);
    playlist.push(2.0);
    playlist.push(2.0);
    assert!(playlist.text().contains("#EXT-X-TARGETDURATION:7\n"));
    // A whole number stays as it is.
    let mut whole = MediaPlaylist::new(2);
    whole.push(4.0);
    assert!(whole.text().contains("#EXT-X-TARGETDURATION:4\n"));
}

#[test]
fn a_broken_duration_counts_as_zero() {
    let mut playlist = MediaPlaylist::new(4);
    playlist.push(f64::NAN);
    playlist.push(-1.0);
    playlist.push(f64::INFINITY);
    let text = playlist.text();
    assert_eq!(text.matches("#EXTINF:0.000,").count(), 3, "{text}");
    assert!(text.contains("#EXT-X-TARGETDURATION:1\n"), "{text}");
}

#[test]
fn is_ready_with_three_segments_or_at_the_end() {
    let mut playlist = MediaPlaylist::new(10);
    assert!(!playlist.ready());
    playlist.push(2.0);
    playlist.push(2.0);
    assert!(!playlist.ready());
    playlist.push(2.0);
    assert!(playlist.ready());

    let mut short = MediaPlaylist::new(10);
    short.finish();
    assert!(!short.ready(), "an empty stream has nothing to play");
    short.push(1.0);
    assert!(short.ready());
}

#[test]
fn ends_the_playlist_when_the_stream_ends() {
    let mut playlist = MediaPlaylist::new(10);
    playlist.push(2.0);
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
fn the_pacer_waits_for_a_resume_at_exactly_the_lead() {
    let mut pacer = Pacer::new(0.0);
    pacer.made(LEAD);
    pacer.pause(0.0);
    assert_eq!(pacer.wait(0.0), None);
    pacer.resume(0.0);
    assert_eq!(pacer.wait(0.0), Some(0.0));
}
