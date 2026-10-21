// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::mkv::{MkvError, MkvSplitter, Piece};
use super::serve::{head_end, not_found_head, ok_head, read_request, token, Request, MAX_HEAD};
use super::{
    args, matroska_copies, output_args, pick_audio, unsupported, AacEncoder, AudioPlan,
    Encoders, HardwareEncoder, NoEncoder, Output, Plan, VideoPlan, CAST_AUDIO,
};
use crate::streams::format::Container;
use crate::streams::probe::AudioTrack;

const URL: &str = "http://srv/live/u/p/1.ts";

const LINUX: Encoders = Encoders {
    video: None,
    aac: AacEncoder::Ffmpeg,
};
const MAC: Encoders = Encoders {
    video: Some(HardwareEncoder::VideoToolbox),
    aac: AacEncoder::AudioToolbox,
};

/// What every test's ffmpeg decodes, by the probe's codec names.
const DECODES: &[&str] = &[
    "aac", "aac_latm", "ac3", "dts", "eac3", "mp2", "mp3", "opus", "vorbis",
];

/// The arguments before `-i` for a file from a server: only network
/// protocols, and the file's own pace after a burst.
const FILE_INPUT: &str = "-protocol_whitelist http,https,tcp,tls,crypto -readrate 1 \
                          -readrate_initial_burst 10";

fn plan(video: VideoPlan, audio: AudioPlan) -> Plan {
    Plan {
        video,
        audio,
        live: false,
        start_at: None,
        audio_track: 0,
    }
}

fn joined(args: &[String]) -> String {
    args.join(" ")
}

#[test]
fn a_remux_copies_both_tracks_into_live_matroska() {
    let args = args(URL, &plan(VideoPlan::Copy, AudioPlan::Copy), LINUX).unwrap();
    assert_eq!(
        joined(&args),
        format!(
            "-hide_banner -nostdin -loglevel error -reconnect 1 -reconnect_delay_max 5 \
             -rw_timeout 15000000 {FILE_INPUT} -i http://srv/live/u/p/1.ts -map 0:v:0 \
             -map 0:a:0 -sn -dn -c:v copy -c:a copy -f matroska -live 1 -flush_packets 1 pipe:1"
        )
    );
}

#[test]
fn hls_output_writes_mpeg_ts_with_the_same_input_and_codecs() {
    let p = plan(VideoPlan::Copy, AudioPlan::Aac { downmix: false });
    let ts = joined(&output_args(URL, &p, MAC, Output::MpegTs).unwrap());
    assert_eq!(
        ts,
        format!(
            "-hide_banner -nostdin -loglevel error -reconnect 1 -reconnect_delay_max 5 \
             -rw_timeout 15000000 {FILE_INPUT} -i http://srv/live/u/p/1.ts -map 0:v:0 \
             -map 0:a:0 -sn -dn -c:v copy -c:a aac_at -aac_at_mode cvbr -b:a 256k -ar 48000 -ac 2 \
             -f mpegts -flush_packets 1 pipe:1"
        )
    );
    // Matroska is the same up to its own format.
    let mkv = joined(&output_args(URL, &p, MAC, Output::Matroska).unwrap());
    assert_eq!(mkv, joined(&args(URL, &p, MAC).unwrap()));
    assert_eq!(
        mkv.replace("-f matroska -live 1", "-f mpegts"),
        ts,
        "only the format differs"
    );
    // A transcode without an encoder fails for either.
    let transcode = plan(VideoPlan::Transcode { deinterlace: false }, AudioPlan::Copy);
    assert_eq!(output_args(URL, &transcode, LINUX, Output::MpegTs), Err(NoEncoder));
}

#[test]
fn a_live_channel_comes_at_its_own_pace() {
    let mut live = plan(VideoPlan::Copy, AudioPlan::Copy);
    live.live = true;
    let args = joined(&args(URL, &live, LINUX).unwrap());
    assert!(
        args.contains(
            "-rw_timeout 15000000 -protocol_whitelist http,https,tcp,tls,crypto -i http://srv"
        ),
        "{args}"
    );
    assert!(!args.contains("-readrate"), "{args}");
}

#[test]
fn a_file_on_this_device_may_use_any_protocol() {
    let p = plan(VideoPlan::Copy, AudioPlan::Copy);
    for url in [
        "/Users/me/Movies/film.mkv",
        "file:///tmp/film.mkv",
        "httpx://x",
    ] {
        let args = joined(&args(url, &p, LINUX).unwrap());
        assert!(!args.contains("-protocol_whitelist"), "{args}");
        assert!(
            args.contains("-readrate 1 -readrate_initial_burst 10 -i "),
            "{args}"
        );
    }
    let secure = joined(&args("https://srv/movie/1.mkv", &p, LINUX).unwrap());
    assert!(secure.contains("-protocol_whitelist"), "{secure}");
}

#[test]
fn audio_the_receiver_cant_play_becomes_stereo_aac_at_256k() {
    let mut p = plan(VideoPlan::Copy, AudioPlan::Aac { downmix: false });
    p.audio_track = 2;
    let linux = joined(&args(URL, &p, LINUX).unwrap());
    assert!(
        linux.contains("-map 0:a:2 -sn -dn -c:v copy -c:a aac -b:a 256k -ac 2 -f matroska"),
        "{linux}"
    );
    assert!(!linux.contains("-downmix"), "{linux}");
    // Only Apple's encoder needs the audio at 48 kHz.
    assert!(!linux.contains("-ar "), "{linux}");
    let mac = joined(&args(URL, &p, MAC).unwrap());
    assert!(
        mac.contains(
            "-c:v copy -c:a aac_at -aac_at_mode cvbr -b:a 256k -ar 48000 -ac 2 -f matroska"
        ),
        "{mac}"
    );
}

#[test]
fn dolby_and_dts_mix_down_in_their_decoder() {
    let mut p = plan(VideoPlan::Copy, AudioPlan::Aac { downmix: true });
    p.start_at = Some(30.0);
    let args = joined(&args(URL, &p, LINUX).unwrap());
    assert!(
        args.contains(&format!(
            "-rw_timeout 15000000 -downmix stereo {FILE_INPUT} -ss 30.000 -i "
        )),
        "{args}"
    );
    assert!(args.contains("-c:a aac -b:a 256k -ac 2"), "{args}");
}

#[test]
fn a_stream_without_video_or_audio_maps_only_what_it_has() {
    let radio = joined(
        &args(
            URL,
            &plan(VideoPlan::None, AudioPlan::Aac { downmix: false }),
            LINUX,
        )
        .unwrap(),
    );
    assert!(!radio.contains("0:v"), "{radio}");
    assert!(!radio.contains("-c:v"), "{radio}");
    let silent = joined(&args(URL, &plan(VideoPlan::Copy, AudioPlan::None), LINUX).unwrap());
    assert!(!silent.contains("0:a"), "{silent}");
    assert!(!silent.contains("-c:a"), "{silent}");
}

#[test]
fn starts_a_file_where_asked() {
    let mut p = plan(VideoPlan::Copy, AudioPlan::Copy);
    p.start_at = Some(1312.4);
    let args = joined(&args(URL, &p, LINUX).unwrap());
    assert!(
        args.contains(&format!("{FILE_INPUT} -ss 1312.400 -i ")),
        "{args}"
    );
    p.start_at = Some(0.0);
    assert!(!joined(&super::args(URL, &p, LINUX).unwrap()).contains("-ss"));
}

#[test]
fn a_transcode_needs_a_hardware_encoder() {
    let transcode = plan(VideoPlan::Transcode { deinterlace: false }, AudioPlan::Copy);
    assert_eq!(args(URL, &transcode, LINUX), Err(NoEncoder));
    let progressive = joined(&args(URL, &transcode, MAC).unwrap());
    assert!(
        progressive.contains(
            "-vf scale=-2:'min(ih,1080)',format=yuv420p -c:v h264_videotoolbox -b:v 10M \
             -maxrate 12M -bufsize 20M -force_key_frames expr:gte(t,n_forced*2) -c:a copy"
        ),
        "{progressive}"
    );
    let interlaced = plan(VideoPlan::Transcode { deinterlace: true }, AudioPlan::Copy);
    let interlaced = joined(&args(URL, &interlaced, MAC).unwrap());
    assert!(
        interlaced.contains(
            "-vf bwdif=mode=send_field,scale=-2:'min(ih,1080)',format=yuv420p -c:v h264_videotoolbox"
        ),
        "{interlaced}"
    );
    assert_eq!(
        NoEncoder.to_string(),
        "this device has no hardware video encoder"
    );
}

fn track(codec: &str, language: Option<&str>, default: bool) -> AudioTrack {
    let layout = Some("stereo".to_string());
    AudioTrack {
        codec: codec.into(),
        language: language.map(String::from),
        default,
        layout,
    }
}

/// A track with the channel layout `layout`, as ffmpeg names it.
fn laid_out(codec: &str, layout: Option<&str>) -> AudioTrack {
    let layout = layout.map(String::from);
    AudioTrack {
        layout,
        ..track(codec, None, true)
    }
}

#[test]
fn copies_a_playable_track_in_the_chosen_language() {
    let tracks = [
        track("ac3", Some("eng"), true),
        track("aac", Some("eng"), false),
        track("mp2", Some("deu"), false),
        track("mp3", Some("deu"), false),
    ];
    assert_eq!(
        pick_audio(&tracks, Some("eng"), &CAST_AUDIO, DECODES, true),
        (1, AudioPlan::Copy)
    );
    assert_eq!(
        pick_audio(&tracks, Some("deu"), &CAST_AUDIO, DECODES, true),
        (3, AudioPlan::Copy)
    );
    // No language asked, or none matches: any playable track, the default
    // first.
    assert_eq!(
        pick_audio(&tracks, None, &CAST_AUDIO, DECODES, true),
        (1, AudioPlan::Copy)
    );
    assert_eq!(
        pick_audio(&tracks, Some("fre"), &CAST_AUDIO, DECODES, true),
        (1, AudioPlan::Copy)
    );
    for codec in ["opus", "vorbis"] {
        let tracks = [track("dts", None, true), track(codec, None, false)];
        assert_eq!(
            pick_audio(&tracks, None, &CAST_AUDIO, DECODES, true),
            (1, AudioPlan::Copy),
            "{codec}"
        );
    }
}

#[test]
fn copies_only_what_the_receivers_own_list_plays() {
    // AirPlay plays AAC and MP3 in TS segments, but not Opus or Vorbis.
    let airplay = ["aac", "mp3"];
    let tracks = [
        track("opus", Some("eng"), true),
        track("mp3", Some("eng"), false),
    ];
    assert_eq!(
        pick_audio(&tracks, Some("eng"), &airplay, DECODES, true),
        (1, AudioPlan::Copy)
    );
    assert_eq!(
        pick_audio(&tracks, Some("eng"), &CAST_AUDIO, DECODES, true),
        (0, AudioPlan::Copy)
    );
    let opus = [track("opus", None, false)];
    assert_eq!(
        pick_audio(&opus, None, &airplay, DECODES, true),
        (0, AudioPlan::Aac { downmix: false })
    );
}

#[test]
fn keeps_5_1_as_5_1_aac_where_the_receiver_takes_it() {
    for layout in ["5.1(side)", "5.1"] {
        for codec in ["ac3", "eac3", "dts", "mp2"] {
            let tracks = [laid_out(codec, Some(layout))];
            assert_eq!(
                pick_audio(&tracks, None, &CAST_AUDIO, DECODES, true),
                (0, AudioPlan::Surround),
                "{codec} {layout}"
            );
        }
    }
    // The stereo fallback.
    let dolby = [laid_out("ac3", Some("5.1(side)"))];
    assert_eq!(
        pick_audio(&dolby, None, &CAST_AUDIO, DECODES, false),
        (0, AudioPlan::Aac { downmix: true })
    );
    // 5.1 AAC plays as it is.
    let aac = [laid_out("aac", Some("5.1"))];
    assert_eq!(
        pick_audio(&aac, None, &CAST_AUDIO, DECODES, true),
        (0, AudioPlan::Copy)
    );
    // Anything but 5.1 becomes stereo, 5.1 with height channels too.
    for layout in [
        Some("7.1"),
        Some("stereo"),
        Some("6.0"),
        Some("5.1.2"),
        Some("5.1.4"),
        None,
    ] {
        assert_eq!(
            pick_audio(&[laid_out("ac3", layout)], None, &CAST_AUDIO, DECODES, true),
            (0, AudioPlan::Aac { downmix: true }),
            "{layout:?}"
        );
    }
}

#[test]
fn converts_5_1_to_5_1_aac_at_448k() {
    let surround = plan(VideoPlan::Copy, AudioPlan::Surround);
    let linux = joined(&args(URL, &surround, LINUX).unwrap());
    assert!(
        linux
            .contains("-c:v copy -af channelmap=channel_layout=5.1 -c:a aac -b:a 448k -f matroska"),
        "{linux}"
    );
    assert!(!linux.contains("-downmix"), "{linux}");
    assert!(!linux.contains("-ar "), "{linux}");
    let mac = joined(&args(URL, &surround, MAC).unwrap());
    assert!(
        mac.contains("-c:v copy -c:a aac_at -aac_at_mode cvbr -b:a 448k -ar 48000 -f matroska"),
        "{mac}"
    );
}

#[test]
fn converts_the_default_track_when_none_plays() {
    let tracks = [
        track("mp2", Some("deu"), false),
        track("ac3", Some("deu"), true),
        track("aac_latm", Some("eng"), false),
    ];
    assert_eq!(
        pick_audio(&tracks, Some("deu"), &CAST_AUDIO, DECODES, true),
        (1, AudioPlan::Aac { downmix: true })
    );
    // In the chosen language, though it isn't the default.
    assert_eq!(
        pick_audio(&tracks, Some("eng"), &CAST_AUDIO, DECODES, true),
        (2, AudioPlan::Aac { downmix: false })
    );
    let plain = [track("mp2", None, false), track("eac3", None, false)];
    assert_eq!(
        pick_audio(&plain, None, &CAST_AUDIO, DECODES, true),
        (0, AudioPlan::Aac { downmix: false })
    );
    for codec in ["ac3", "eac3", "dts"] {
        assert_eq!(
            pick_audio(
                &[track(codec, None, false)],
                None,
                &CAST_AUDIO,
                DECODES,
                true
            ),
            (0, AudioPlan::Aac { downmix: true }),
            "{codec}"
        );
    }
    assert_eq!(
        pick_audio(&[], Some("eng"), &CAST_AUDIO, DECODES, true),
        (0, AudioPlan::None)
    );
}

#[test]
fn converts_a_track_this_device_decodes_when_it_cant_decode_the_default() {
    let tracks = [
        track("truehd", Some("eng"), true),
        track("ac3", Some("eng"), false),
        track("flac", Some("deu"), false),
    ];
    assert_eq!(
        pick_audio(&tracks, Some("eng"), &CAST_AUDIO, DECODES, true),
        (1, AudioPlan::Aac { downmix: true })
    );
    // Within the chosen language when it can.
    assert_eq!(
        pick_audio(&tracks, Some("deu"), &CAST_AUDIO, DECODES, true),
        (2, AudioPlan::Aac { downmix: false })
    );
    // The default when nothing decodes, so ffmpeg says why it can't.
    assert_eq!(
        pick_audio(&tracks, Some("deu"), &CAST_AUDIO, &[], true),
        (2, AudioPlan::Aac { downmix: false })
    );
    assert_eq!(
        pick_audio(&tracks, None, &CAST_AUDIO, &["flac", "truehd"], true),
        (0, AudioPlan::Aac { downmix: false })
    );
}

#[test]
fn tells_a_missing_decoder_or_encoder_from_a_stream_it_couldnt_read() {
    for text in [
        "[aist#0:0/pcm_u8 @ 0x1] Decoding requested, but no decoder found for: pcm_u8",
        "Decoder (codec truehd) not found for input stream #0:1",
        "[aost#0:0 @ 0x1] Unknown encoder 'aac'\nError opening output files: Encoder not found",
        "Error while opening encoder - maybe incorrect parameters",
        "[vost#0:0] Could not open encoder before EOF",
    ] {
        assert!(unsupported(text), "{text}");
    }
    for text in [
        "Server returned 404 Not Found",
        "Connection refused",
        "Invalid data found when processing input",
        "",
    ] {
        assert!(!unsupported(text), "{text}");
    }
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
                start: true
            },
            Piece::Element {
                bytes: tags,
                start: false
            },
            Piece::Element {
                bytes: second,
                start: true
            },
        ]
    );
}

/// A stream whose Tracks has audio as track 2 and video as track 3, with a
/// Void after it.
fn header_with_video() -> Vec<u8> {
    let audio = [element(&[0xD7], &[2]), element(&[0x83], &[2])].concat();
    let video = [element(&[0x83], &[1]), element(&[0xD7], &[3])].concat();
    let tracks = [element(&[0xAE], &audio), element(&[0xAE], &video)].concat();
    let mut out = element(EBML, &[0x42, 0x86, 0x81, 0x01]);
    out.extend_from_slice(SEGMENT);
    out.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    out.extend(element(INFO, b"info"));
    out.extend(element(TRACKS, &tracks));
    out.extend(element(&[0xEC], &[0]));
    out
}

/// A SimpleBlock of `track`, a keyframe when `key`.
fn simple_block(track: u8, key: bool) -> Vec<u8> {
    element(
        &[0xA3],
        &[0x80 | track, 0, 0, if key { 0x80 } else { 0 }, 9, 9],
    )
}

/// A BlockGroup of `track`, with a ReferenceBlock when it isn't a keyframe.
fn block_group(track: u8, key: bool) -> Vec<u8> {
    let mut group = element(&[0xA1], &[0x80 | track, 0, 0, 0, 9, 9]);
    if !key {
        group.extend(element(&[0xFB], &[0xFF]));
    }
    element(&[0xA0], &group)
}

#[test]
fn only_a_cluster_whose_first_video_frame_is_a_keyframe_is_a_start() {
    let timestamp = element(&[0xE7], &[0x10]);
    let crc = element(&[0xBF], &[0, 0, 0, 0]);
    let void = element(&[0xEC], &[0]);
    let clusters: Vec<(Vec<u8>, bool)> = vec![
        ([timestamp.clone(), simple_block(3, true)].concat(), true),
        (
            [
                crc.clone(),
                void,
                timestamp.clone(),
                simple_block(2, true),
                simple_block(3, false),
                simple_block(3, true),
            ]
            .concat(),
            false,
        ),
        (
            [crc, timestamp.clone(), block_group(3, true)].concat(),
            true,
        ),
        ([timestamp.clone(), block_group(3, false)].concat(), false),
        ([block_group(2, true), simple_block(3, true)].concat(), true),
        // No video at all, or a block cut short.
        ([timestamp.clone(), simple_block(2, true)].concat(), false),
        ([timestamp, element(&[0xA3], &[0x81, 0])].concat(), false),
        // The track number at its longest, and one too long.
        (
            element(&[0xA3], &[0x01, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0x80]),
            true,
        ),
        (
            element(&[0xA3], &[0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0x80]),
            false,
        ),
        (vec![], false),
    ];
    let mut stream = header_with_video();
    for (data, _) in &clusters {
        stream.extend(element(CLUSTER, data));
    }
    let pieces = MkvSplitter::default().push(&stream).unwrap();
    let starts: Vec<bool> = pieces[1..]
        .iter()
        .map(|p| matches!(p, Piece::Element { start: true, .. }))
        .collect();
    let expected: Vec<bool> = clusters.iter().map(|(_, start)| *start).collect();
    assert_eq!(starts, expected);
    // A video track with a two-byte number.
    let video = [element(&[0x83], &[1]), element(&[0xD7], &[0x01, 0x02])].concat();
    let mut stream = element(EBML, &[]);
    stream.extend_from_slice(SEGMENT);
    stream.push(0xFF);
    stream.extend(element(TRACKS, &element(&[0xAE], &video)));
    let block = element(&[0xA3], &[0x41, 0x02, 0, 0, 0x80]);
    stream.extend(element(CLUSTER, &block));
    let pieces = MkvSplitter::default().push(&stream).unwrap();
    assert!(matches!(pieces[1], Piece::Element { start: true, .. }));
    // Something other than a cluster is never a start.
    let mut stream = header_with_video();
    stream.extend(element(CLUSTER, &simple_block(3, true)));
    stream.extend(element(TAGS, &simple_block(3, true)));
    let pieces = MkvSplitter::default().push(&stream).unwrap();
    assert!(matches!(pieces[2], Piece::Element { start: false, .. }));
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
    // Nor one whose unknown size takes two bytes.
    let mut stream = header();
    stream.extend_from_slice(CLUSTER);
    stream.extend_from_slice(&[0x7F, 0xFF]);
    assert_eq!(MkvSplitter::default().push(&stream), Err(MkvError::Size));
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
fn answers_a_missing_name_with_an_empty_404() {
    assert_eq!(
        not_found_head(),
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
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
    // the arguments a conversion uses, from a server, as the app's are.
    let script = include_str!("../../../../scripts/test-ffmpeg-sidecar.py");
    let aac = plan(VideoPlan::Copy, AudioPlan::Aac { downmix: false });
    let live = Plan { live: true, ..aac };
    let seek = Plan {
        start_at: Some(2.0),
        ..plan(VideoPlan::Copy, AudioPlan::Copy)
    };
    let transcode = Plan {
        video: VideoPlan::Transcode { deinterlace: true },
        ..aac
    };
    let missing = [
        ("CONVERT_ARGS", aac, LINUX),
        (
            "CONVERT_DOWNMIX_ARGS",
            plan(VideoPlan::Copy, AudioPlan::Aac { downmix: true }),
            LINUX,
        ),
        (
            "CONVERT_SURROUND_ARGS",
            plan(VideoPlan::Copy, AudioPlan::Surround),
            LINUX,
        ),
        ("CONVERT_LIVE_ARGS", live, LINUX),
        ("CONVERT_SEEK_ARGS", seek, LINUX),
        ("CONVERT_MAC_ARGS", aac, MAC),
        (
            "CONVERT_MAC_SURROUND_ARGS",
            plan(VideoPlan::Copy, AudioPlan::Surround),
            MAC,
        ),
        ("CONVERT_MAC_TRANSCODE_ARGS", transcode, MAC),
    ]
    .map(|(name, plan, encoders)| {
        let convert = args("http://URL", &plan, encoders).unwrap().join(" ");
        format!("{name} = \"{convert}\"")
    })
    .into_iter()
    .filter(|line| !script.lines().any(|l| l == line))
    .collect::<Vec<_>>();
    assert!(
        missing.is_empty(),
        "scripts/test-ffmpeg-sidecar.py should have these lines:\n{}",
        missing.join("\n")
    );
}

#[test]
fn copies_aac_into_matroska_only_from_mp4_and_matroska() {
    for container in [Container::Mp4, Container::Mkv, Container::HlsFmp4] {
        assert_eq!(
            matroska_copies(container, &CAST_AUDIO),
            CAST_AUDIO,
            "{container:?}"
        );
    }
    for container in [Container::Ts, Container::HlsTs, Container::Other] {
        assert_eq!(
            matroska_copies(container, &CAST_AUDIO),
            ["mp3", "opus", "vorbis"],
            "{container:?}"
        );
    }
}
