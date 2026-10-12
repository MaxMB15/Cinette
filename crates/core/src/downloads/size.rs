// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The size of a video to download, read from the server's reply to a HEAD
//! request.

use reqwest::header::{HeaderMap, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::StatusCode;

/// Path endings of HLS playlists and DASH manifests. These list a video's
/// parts, so the reply's length is the size of a short text file.
const LIST_EXTENSIONS: [&str; 3] = [".m3u8", ".m3u", ".mpd"];

/// The size of the video at `url` in bytes, from the status and headers of
/// the reply to a HEAD request. `url` is where the request ended up after
/// any redirects.
///
/// None when the reply gives no size, or when the size it gives isn't the
/// video's: an error page, or a playlist or manifest that lists the video's
/// parts.
pub fn media_size(url: &str, status: StatusCode, headers: &HeaderMap) -> Option<i64> {
    if !status.is_success() || is_list_url(url) {
        return None;
    }
    if let Some(content_type) = headers.get(CONTENT_TYPE) {
        if is_text_type(content_type.to_str().unwrap_or_default()) {
            return None;
        }
    }
    let length: i64 = headers
        .get(CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    (length > 0).then_some(length)
}

/// Whether the path of `url` ends like a playlist or manifest. The query
/// doesn't count, so a token after `?` can't hide one.
fn is_list_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let path = parsed.path().to_ascii_lowercase();
    LIST_EXTENSIONS.iter().any(|ext| path.ends_with(ext))
}

/// Whether a Content-Type names text rather than video, such as an HLS
/// playlist, a DASH manifest, or a page or JSON error from the server.
fn is_text_type(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence.starts_with("text/")
        || essence.contains("mpegurl")
        || essence.ends_with("xml")
        || essence.ends_with("json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    const MOVIE: &str = "http://panel.example.test/movie/u/p/42.mp4";

    fn headers(content_type: Option<&'static str>, length: Option<&'static str>) -> HeaderMap {
        let mut map = HeaderMap::new();
        if let Some(t) = content_type {
            map.insert(CONTENT_TYPE, HeaderValue::from_static(t));
        }
        if let Some(l) = length {
            map.insert(CONTENT_LENGTH, HeaderValue::from_static(l));
        }
        map
    }

    fn size(url: &str, content_type: Option<&'static str>, length: &'static str) -> Option<i64> {
        media_size(url, StatusCode::OK, &headers(content_type, Some(length)))
    }

    #[test]
    fn takes_the_length_of_a_video_file() {
        assert_eq!(
            size(MOVIE, Some("video/mp4"), "1500000000"),
            Some(1_500_000_000)
        );
        assert_eq!(size(MOVIE, Some("video/x-matroska"), "42"), Some(42));
        assert_eq!(
            size(MOVIE, Some("application/octet-stream"), "42"),
            Some(42)
        );
    }

    #[test]
    fn takes_the_length_when_the_type_is_missing_or_unreadable() {
        assert_eq!(size(MOVIE, None, "42"), Some(42));
        let mut map = headers(None, Some("42"));
        map.insert(
            CONTENT_TYPE,
            HeaderValue::from_bytes(b"video/\xff").unwrap(),
        );
        assert_eq!(media_size(MOVIE, StatusCode::OK, &map), Some(42));
    }

    #[test]
    fn ignores_an_hls_playlist() {
        for content_type in [
            "application/vnd.apple.mpegurl",
            "application/x-mpegURL",
            "audio/mpegurl",
            "Audio/X-MpegUrl; charset=utf-8",
        ] {
            assert_eq!(
                size(MOVIE, Some(content_type), "460"),
                None,
                "{content_type}"
            );
        }
    }

    #[test]
    fn ignores_a_playlist_or_manifest_by_its_path() {
        for url in [
            "http://127.0.0.1:9999/media/vod.m3u8",
            "http://cdn.example.test/hls/MOVIE.M3U8?token=abc",
            "http://panel.example.test/get/list.m3u",
            "http://cdn.example.test/dash/movie.mpd",
        ] {
            assert_eq!(
                size(url, Some("application/octet-stream"), "460"),
                None,
                "{url}"
            );
        }
    }

    #[test]
    fn looks_only_at_the_end_of_the_path() {
        assert_eq!(
            size(
                "http://cdn.example.test/old.m3u8/movie.mp4?list=a.m3u8",
                None,
                "42"
            ),
            Some(42)
        );
    }

    #[test]
    fn ignores_a_manifest_or_an_error_page_by_its_type() {
        for content_type in [
            "application/dash+xml",
            "application/vnd.ms-sstr+xml",
            "text/html; charset=utf-8",
            "text/plain",
            "application/json",
            "application/problem+json",
        ] {
            assert_eq!(
                size(MOVIE, Some(content_type), "460"),
                None,
                "{content_type}"
            );
        }
    }

    #[test]
    fn ignores_a_reply_that_failed() {
        let map = headers(Some("video/mp4"), Some("42"));
        for status in [
            StatusCode::NOT_FOUND,
            StatusCode::FORBIDDEN,
            StatusCode::BAD_GATEWAY,
        ] {
            assert_eq!(media_size(MOVIE, status, &map), None, "{status}");
        }
    }

    #[test]
    fn has_no_size_without_a_usable_length() {
        assert_eq!(
            media_size(MOVIE, StatusCode::OK, &headers(Some("video/mp4"), None)),
            None
        );
        assert_eq!(size(MOVIE, Some("video/mp4"), "0"), None);
        assert_eq!(size(MOVIE, Some("video/mp4"), "-5"), None);
        assert_eq!(size(MOVIE, Some("video/mp4"), "lots"), None);
    }
}
