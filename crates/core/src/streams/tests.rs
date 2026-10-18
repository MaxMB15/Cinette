// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::format::{
    audio_codec, container_from_demuxer, video_codec, AudioCodec, Container, PlayingInfo,
    StreamFormat, VideoCodec,
};
use super::hls::{inspect, HlsError, HlsInfo};
use super::probe::{self, ProbeError, Probed};
use super::{candidates, formats_for, is_hls_url, HlsCheck};
use crate::http::test_server::{self, password, route, serve_once, serve_routes};
use crate::models::playlist::ProviderType;

fn allowed(formats: &[&str]) -> Vec<String> {
    formats.iter().map(|f| f.to_string()).collect()
}

#[test]
fn xtream_live_comes_as_m3u8_first_when_allowed() {
    let pass = password();
    let url = format!("http://srv:8080/live/user/{pass}/123.ts");
    let both = candidates(
        &ProviderType::Xtream,
        "live",
        &url,
        &allowed(&["ts", "m3u8", "rtmp"]),
    );
    assert_eq!(
        both,
        vec![
            format!("http://srv:8080/live/user/{pass}/123.m3u8"),
            format!("http://srv:8080/live/user/{pass}/123.ts"),
        ]
    );
    let ts = candidates(&ProviderType::Xtream, "live", &url, &allowed(&["ts"]));
    assert_eq!(ts, vec![url.clone()]);
    let m3u8 = format!("http://srv:8080/live/user/{pass}/123.m3u8");
    assert_eq!(
        candidates(&ProviderType::Xtream, "live", &m3u8, &allowed(&["ts"])),
        vec![url.clone()]
    );
    // A panel that doesn't say, or allows neither, keeps the channel's own URL.
    assert_eq!(
        candidates(&ProviderType::Xtream, "live", &url, &[]),
        vec![url.clone()]
    );
    assert_eq!(
        candidates(&ProviderType::Xtream, "live", &url, &allowed(&["rtmp"])),
        vec![url.clone()]
    );
}

#[test]
fn everything_else_keeps_its_own_url() {
    let all = allowed(&["m3u8", "ts"]);
    for (provider, content, url) in [
        (ProviderType::M3u, "live", "http://srv/live/u/p/123.ts"),
        (ProviderType::Xtream, "movie", "http://srv/movie/u/p/9.mkv"),
        (ProviderType::Xtream, "live", "http://srv/live/u/p/abc.ts"),
        (ProviderType::Xtream, "live", "http://srv/live/u/p/.ts"),
        (ProviderType::Xtream, "live", "http://srv/other/u/p/1.ts"),
        (
            ProviderType::Xtream,
            "live",
            "http://srv/live/u/p/1.ts?token=x/y",
        ),
        (ProviderType::Xtream, "live", "http://srv/live/u/p/1"),
        (ProviderType::Xtream, "live", "no-slash.ts"),
    ] {
        assert_eq!(
            candidates(&provider, content, url, &all),
            vec![url.to_string()],
            "{url}"
        );
    }
}

#[test]
fn names_containers_and_codecs() {
    for (name, container) in [
        ("hls", Container::HlsTs),
        ("applehttp", Container::HlsTs),
        ("mpegts", Container::Ts),
        ("ts", Container::Ts),
        ("matroska,webm", Container::Mkv),
        ("matroska", Container::Mkv),
        ("mkv", Container::Mkv),
        ("webm", Container::Mkv),
        ("mov,mp4,m4a,3gp,3g2,mj2", Container::Mp4),
        ("MP4", Container::Mp4),
        ("mov", Container::Mp4),
        ("avi", Container::Other),
    ] {
        assert_eq!(container_from_demuxer(name), container, "{name}");
    }
    for (name, codec) in [
        ("h264", VideoCodec::H264),
        ("avc", VideoCodec::H264),
        ("avc1", VideoCodec::H264),
        ("hevc", VideoCodec::Hevc),
        ("h265", VideoCodec::Hevc),
        ("mpeg2video", VideoCodec::Mpeg2),
        ("mpeg2", VideoCodec::Mpeg2),
        ("vp9", VideoCodec::Other),
    ] {
        assert_eq!(video_codec(name), codec, "{name}");
    }
    for (name, codec) in [
        ("aac", AudioCodec::Aac),
        ("aac_latm", AudioCodec::Aac),
        ("mp3", AudioCodec::Mp3),
        ("mp3float", AudioCodec::Mp3),
        ("ac3", AudioCodec::Ac3),
        ("eac3", AudioCodec::Eac3),
        ("mp2", AudioCodec::Mp2),
        ("mp2float", AudioCodec::Mp2),
        ("dts", AudioCodec::Dts),
        ("dca", AudioCodec::Dts),
        ("opus", AudioCodec::Opus),
        ("flac", AudioCodec::Other),
    ] {
        assert_eq!(audio_codec(name), codec, "{name}");
    }
}

#[test]
fn serializes_as_the_frontend_names_them() {
    let format = StreamFormat {
        container: Container::HlsFmp4,
        video: Some(VideoCodec::Mpeg2),
        interlaced: true,
        audio: Some(AudioCodec::Eac3),
        cors: false,
    };
    assert_eq!(
        serde_json::to_value(format).unwrap(),
        serde_json::json!({ "container": "hls-fmp4", "video": "mpeg2", "interlaced": true, "audio": "eac3", "cors": false })
    );
    let audio_only = StreamFormat {
        container: Container::HlsTs,
        video: None,
        audio: None,
        ..format
    };
    let json = serde_json::to_value(audio_only).unwrap();
    assert_eq!(json["container"], "hls-ts");
    assert!(json["video"].is_null());
}

#[test]
fn reads_what_mpv_is_playing() {
    let info: PlayingInfo = serde_json::from_str(
        r#"{ "fileFormat": "mpegts", "videoCodec": "mpeg2video", "audioCodec": "mp2", "interlaced": true }"#,
    )
    .unwrap();
    assert_eq!(
        info.format(),
        StreamFormat {
            container: Container::Ts,
            video: Some(VideoCodec::Mpeg2),
            interlaced: true,
            audio: Some(AudioCodec::Mp2),
            cors: false,
        }
    );
    let radio: PlayingInfo = serde_json::from_str(r#"{ "audioCodec": "aac" }"#).unwrap();
    let format = radio.format();
    assert_eq!(format.container, Container::Other);
    assert_eq!(format.video, None);
    assert!(!format.interlaced);
}

#[test]
fn probe_arguments_limit_the_wait_and_end_with_the_input() {
    let args = probe::args("http://srv/1.ts");
    assert_eq!(
        args,
        [
            "-hide_banner",
            "-nostdin",
            "-rw_timeout",
            "10000000",
            "-probesize",
            "5000000",
            "-analyzeduration",
            "5000000",
            "-i",
            "http://srv/1.ts",
        ]
    );
}

const LIVE_TS: &str = "Input #0, mpegts, from 'http://srv/live/user/SECRET/1.ts':
  Duration: N/A, start: 1234.5, bitrate: N/A
  Program 1
    Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709, top first), 1920x1080 [SAR 1:1 DAR 16:9], 25 fps, 50 tbr, 90k tbn
    Stream #0:1[0x101](deu): Audio: mp2 ([3][0][0][0] / 0x0003), 48000 Hz, stereo, fltp, 192 kb/s
    Stream #0:2[0x102](eng): Audio: ac3 ([129][0][0][0] / 0x0081), 48000 Hz, 5.1(side), fltp, 384 kb/s
At least one output file must be specified
";

#[test]
fn parses_a_live_ts_probe() {
    assert_eq!(
        probe::parse(LIVE_TS).unwrap(),
        Probed {
            container: Container::Ts,
            video: Some(VideoCodec::H264),
            interlaced: true,
            audio: Some(AudioCodec::Mp2),
            duration: None,
        }
    );
}

#[test]
fn parses_a_film_with_cover_art_and_a_default_track() {
    let text = "Input #0, matroska,webm, from 'http://srv/movie/u/p/9.mkv':
  Metadata:
    title           : A Film
  Duration: 01:42:10.50, start: 0.000000, bitrate: 4000 kb/s
  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x900, 90k tbr (attached pic)
  Stream #0:1: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084, progressive), 3840x2160, 23.98 fps
  Stream #0:2(eng): Audio: dts (DTS-HD MA), 48000 Hz, 5.1(side), s32p (24 bit)
  Stream #0:3(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s (default)
  Stream #0:4(eng): Subtitle: subrip
At least one output file must be specified
";
    let probed = probe::parse(text).unwrap();
    assert_eq!(probed.container, Container::Mkv);
    assert_eq!(probed.video, Some(VideoCodec::Hevc));
    assert!(!probed.interlaced);
    assert_eq!(probed.audio, Some(AudioCodec::Eac3));
    assert_eq!(probed.duration, Some(6130.5));
}

#[test]
fn reads_each_field_order_and_audio_only_streams() {
    for (order, interlaced) in [
        ("top first", true),
        ("bottom first", true),
        ("top coded first (swapped)", true),
        ("bottom coded first (swapped)", true),
        ("progressive", false),
    ] {
        let text = format!(
            "Input #0, mpegts, from 'x':\n  Stream #0:0: Video: mpeg2video (Main), yuv420p(tv, {order}), 720x576\n"
        );
        let probed = probe::parse(&text).unwrap();
        assert_eq!(probed.interlaced, interlaced, "{order}");
        assert_eq!(probed.video, Some(VideoCodec::Mpeg2));
        assert_eq!(probed.audio, None);
    }
    // Only the first video stream counts.
    let two = "Input #0, mpegts, from 'x':
  Stream #0:0: Video: h264, yuv420p(progressive)
  Stream #0:1: Video: mpeg2video, yuv420p(top first)
";
    let probed = probe::parse(two).unwrap();
    assert_eq!(
        (probed.video, probed.interlaced),
        (Some(VideoCodec::H264), false)
    );
    let radio = "Input #0, hls, from 'x':\n  Duration: N/A\n    Stream #0:0: Audio: aac (LC), 44100 Hz, stereo\n";
    let probed = probe::parse(radio).unwrap();
    assert_eq!(probed.container, Container::HlsTs);
    assert_eq!((probed.video, probed.audio), (None, Some(AudioCodec::Aac)));
    let mp4 = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x':\n  Duration: 00:00:10.00, start\n  Stream #0:0[0x1](und): Video: h264 (avc1 / 0x31637661), yuv420p\n";
    let probed = probe::parse(mp4).unwrap();
    assert_eq!(probed.container, Container::Mp4);
    assert_eq!(probed.duration, Some(10.0));
}

#[test]
fn reads_odd_durations() {
    for (duration, expected) in [
        ("00:00:00.00", None),
        ("1:02", None),
        ("1:02:03:04", None),
        ("aa:00:01", None),
        ("00:aa:01", None),
        ("00:00:aa", None),
        ("02:00:00.25", Some(7200.25)),
        ("00:03:00", Some(180.0)),
    ] {
        let text = format!("Input #0, mpegts, from 'x':\n  Duration: {duration}, start: 0\n  Stream #0:0: Audio: aac\n");
        assert_eq!(
            probe::parse(&text).unwrap().duration,
            expected,
            "{duration}"
        );
    }
}

#[test]
fn reads_why_a_probe_failed() {
    let refused = "[http @ 0x6000] HTTP error 403 Forbidden\nhttp://srv/live/u/SECRET/1.ts: Server returned 403 Forbidden (access denied)\n";
    assert_eq!(probe::parse(refused), Err(ProbeError::Refused(403)));
    let expired = "http://srv/x: Server returned 401 Unauthorized (authorization failed)\n";
    assert_eq!(probe::parse(expired), Err(ProbeError::Refused(401)));
    let only_http_error = "[http @ 0x1] HTTP error 401 Unauthorized\n";
    assert_eq!(probe::parse(only_http_error), Err(ProbeError::Refused(401)));
    let missing = "http://srv/x: Server returned 404 Not Found\n";
    assert_eq!(probe::parse(missing), Err(ProbeError::Unreachable));
    let short = "Server returned 40";
    assert_eq!(probe::parse(short), Err(ProbeError::Unreachable));
    let down = "http://srv/x: Connection refused\n";
    assert_eq!(probe::parse(down), Err(ProbeError::Unreachable));
    let empty = "Input #0, mpegts, from 'x':\n  Duration: N/A\n  Stream #0:0: Data: bin_data\n";
    assert_eq!(probe::parse(empty), Err(ProbeError::NoStreams));
    // The error says nothing about the URL.
    test_server::assert_hides(&probe::parse(refused).unwrap_err(), "SECRET");
}

/// A status line followed by extra header lines, since the test server
/// writes the status as given, then its own headers.
fn with_cors(status: &str) -> String {
    format!("{status}\r\nAccess-Control-Allow-Origin: *")
}

#[tokio::test]
async fn reads_a_media_playlist_with_ts_segments_and_cors() {
    // A blank line between a tag and its URI is allowed.
    let playlist =
        "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n\nseg-1.ts\n#EXTINF:4.0,\nseg-2.ts\n";
    let (base, requests) = serve_routes(vec![
        route("/live/u/p/1.m3u8", &with_cors("200 OK"), playlist),
        route(
            "/live/u/p/seg-1.ts",
            &with_cors("206 Partial Content"),
            "ab",
        ),
    ]);
    let info = inspect(&test_server::client(), &format!("{base}/live/u/p/1.m3u8"))
        .await
        .unwrap();
    assert_eq!(
        info,
        HlsInfo {
            container: Container::HlsTs,
            cors: true
        }
    );
    let first = requests.recv().unwrap().to_ascii_lowercase();
    assert!(
        first.contains("origin: https://cast.cinette.invalid"),
        "{first}"
    );
    let segment = requests.recv().unwrap().to_ascii_lowercase();
    assert!(segment.starts_with("get /live/u/p/seg-1.ts"), "{segment}");
    assert!(segment.contains("range: bytes=0-1"), "{segment}");
}

#[tokio::test]
async fn follows_a_master_playlist_to_its_first_variant() {
    let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nhigh/index.m3u8\n";
    let media = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.0,\nseg.m4s\n";
    let (base, _) = serve_routes(vec![
        route("/master.m3u8", &with_cors("200 OK"), master),
        route("/low/index.m3u8", &with_cors("200 OK"), media),
        route("/low/seg.m4s", "200 OK", "ab"),
    ]);
    let info = inspect(&test_server::client(), &format!("{base}/master.m3u8"))
        .await
        .unwrap();
    // The segment doesn't send the header.
    assert_eq!(
        info,
        HlsInfo {
            container: Container::HlsFmp4,
            cors: false
        }
    );
}

#[tokio::test]
async fn cors_needs_every_part() {
    let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n";
    let media = "#EXTM3U\n#EXTINF:6.0,\ns.ts\n";
    // The variant doesn't allow it.
    let (base, _) = serve_routes(vec![
        route("/m.m3u8", &with_cors("200 OK"), master),
        route("/v.m3u8", "200 OK", media),
        route("/s.ts", &with_cors("200 OK"), "ab"),
    ]);
    let info = inspect(&test_server::client(), &format!("{base}/m.m3u8"))
        .await
        .unwrap();
    assert!(!info.cors);
    // The first playlist doesn't, so the segment isn't even fetched.
    let (base, requests) = serve_routes(vec![route("/v.m3u8", "200 OK", media)]);
    let info = inspect(&test_server::client(), &format!("{base}/v.m3u8"))
        .await
        .unwrap();
    assert!(!info.cors);
    requests.recv().unwrap();
    assert!(requests
        .recv_timeout(std::time::Duration::from_millis(200))
        .is_err());
    // A segment that fails counts as no.
    let (base, _) = serve_routes(vec![
        route("/v.m3u8", &with_cors("200 OK"), media),
        route("/s.ts", "500 Internal Server Error", ""),
    ]);
    let info = inspect(&test_server::client(), &format!("{base}/v.m3u8"))
        .await
        .unwrap();
    assert!(!info.cors);
    // An origin echoed back counts, any other doesn't.
    let echo = "200 OK\r\nAccess-Control-Allow-Origin: https://cast.cinette.invalid";
    let other = "200 OK\r\nAccess-Control-Allow-Origin: https://example.com";
    for (status, expected) in [(echo, true), (other, false)] {
        let (base, _) = serve_routes(vec![
            route("/v.m3u8", status, media),
            route("/s.ts", status, "ab"),
        ]);
        let info = inspect(&test_server::client(), &format!("{base}/v.m3u8"))
            .await
            .unwrap();
        assert_eq!(info.cors, expected, "{status}");
    }
    // A playlist with no segments yet has nothing more to check.
    let (base, _) = serve_routes(vec![route("/v.m3u8", &with_cors("200 OK"), "#EXTM3U\n")]);
    let info = inspect(&test_server::client(), &format!("{base}/v.m3u8"))
        .await
        .unwrap();
    assert!(info.cors);
}

#[tokio::test]
async fn reads_why_the_check_failed() {
    let client = test_server::client();
    for (status, expected) in [
        ("401 Unauthorized", HlsError::Refused(401)),
        ("403 Forbidden", HlsError::Refused(403)),
        ("404 Not Found", HlsError::Unreachable),
    ] {
        let url = format!("{}/live/u/{}/1.m3u8", serve_once(status, ""), password());
        let err = inspect(&client, &url).await.unwrap_err();
        assert_eq!(err, expected, "{status}");
        test_server::assert_hides(&err, &password());
    }
    let url = format!("{}/x.m3u8", test_server::refused_url());
    assert_eq!(inspect(&client, &url).await, Err(HlsError::Unreachable));
    for body in ["<html>", "\u{feff}#EXTM3"] {
        let url = format!("{}/x.m3u8", serve_once("200 OK", body));
        assert_eq!(
            inspect(&client, &url).await,
            Err(HlsError::NotHls),
            "{body}"
        );
    }
    let url = format!("{}/x.m3u8", serve_once("200 OK", "\u{feff}#EXTM3U\n"));
    assert!(inspect(&client, &url).await.is_ok());
    let huge = format!("#EXTM3U\n{}", "#".repeat(1024 * 1024));
    let url = format!("{}/x.m3u8", serve_once("200 OK", huge));
    assert_eq!(inspect(&client, &url).await, Err(HlsError::NotHls));
    // A variant that fails fails the check.
    let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n";
    let (base, _) = serve_routes(vec![
        route("/m.m3u8", "200 OK", master),
        route("/v.m3u8", "403 Forbidden", ""),
    ]);
    assert_eq!(
        inspect(&client, &format!("{base}/m.m3u8")).await,
        Err(HlsError::Refused(403))
    );
}

#[tokio::test]
async fn takes_playlists_up_to_1_mib() {
    let client = test_server::client();
    for size in [4096, 1024 * 1024] {
        let body = format!("#EXTM3U\n{}", "#".repeat(size - 8));
        assert_eq!(body.len(), size);
        let url = format!("{}/x.m3u8", serve_once("200 OK", body));
        assert!(inspect(&client, &url).await.is_ok(), "{size}");
    }
}

#[test]
fn tells_hls_urls_by_their_path() {
    for (url, hls) in [
        ("http://srv/live/u/p/1.m3u8", true),
        ("http://srv/x.M3U8?token=a.ts", true),
        ("http://srv/x.m3u8#t", true),
        ("http://srv/x.ts?list=.m3u8", false),
        ("http://srv/x.m3u", false),
        ("http://srv/x", false),
    ] {
        assert_eq!(is_hls_url(url), hls, "{url}");
    }
}

fn codecs(container: Container) -> StreamFormat {
    StreamFormat {
        container,
        video: Some(VideoCodec::H264),
        interlaced: true,
        audio: Some(AudioCodec::Mp2),
        cors: true,
    }
}

#[test]
fn each_url_shares_the_codecs_with_its_own_container() {
    let urls = allowed(&["http://s/live/u/p/1.m3u8", "http://s/live/u/p/1.ts"]);
    let hls = HlsInfo {
        container: Container::HlsFmp4,
        cors: true,
    };
    let formats = formats_for(
        &urls,
        codecs(Container::Ts),
        1,
        &[HlsCheck::Checked(hls), HlsCheck::NotHls],
    );
    assert_eq!(
        formats,
        vec![
            (
                0,
                StreamFormat {
                    container: Container::HlsFmp4,
                    ..codecs(Container::Ts)
                }
            ),
            (
                1,
                StreamFormat {
                    container: Container::Ts,
                    cors: false,
                    ..codecs(Container::Ts)
                }
            ),
        ]
    );
    // A failed check drops that URL and keeps the others' indices.
    let formats = formats_for(
        &urls,
        codecs(Container::Ts),
        1,
        &[HlsCheck::Failed, HlsCheck::NotHls],
    );
    assert_eq!(formats.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![1]);
}

#[test]
fn the_probe_names_its_own_urls_container_and_extensions_name_the_rest() {
    let urls = allowed(&[
        "http://s/a.php?id=1",
        "http://s/b.mkv?x=1",
        "http://s/c.MP4",
        "http://s/d.m4v",
        "http://s/e.mov",
        "http://s/f.ts",
        "http://s/g.avi",
        "http://s/no-extension",
    ]);
    let checks = vec![HlsCheck::NotHls; urls.len()];
    let containers: Vec<Container> = formats_for(&urls, codecs(Container::Other), 0, &checks)
        .into_iter()
        .map(|(_, f)| f.container)
        .collect();
    assert_eq!(
        containers,
        vec![
            Container::Other,
            Container::Mkv,
            Container::Mp4,
            Container::Mp4,
            Container::Mp4,
            Container::Ts,
            Container::Other,
            Container::Other,
        ]
    );
    // The probe's container wins over its URL's extension.
    let urls = allowed(&["http://s/really-hls.ts"]);
    let formats = formats_for(&urls, codecs(Container::Mkv), 0, &[HlsCheck::NotHls]);
    assert_eq!(formats[0].1.container, Container::Mkv);
    assert!(!formats[0].1.cors);
}
