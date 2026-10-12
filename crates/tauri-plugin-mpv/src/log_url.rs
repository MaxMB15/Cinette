// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Stream URLs cut down to what a log line may show.

use tauri::Url;

/// The scheme, host and port of a stream URL, for log lines.
///
/// IPTV panels put the login in the path, the query or before the host,
/// depending on the panel, so logs get only the part that can't hold one.
/// Local paths are left out the same way, since they name the user's
/// folders.
pub(crate) fn origin_for_log(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        return "<not a URL>".to_string();
    };
    let scheme = parsed.scheme();
    match (
        parsed.host_str().filter(|host| !host.is_empty()),
        parsed.port(),
    ) {
        (Some(host), Some(port)) => format!("{scheme}://{host}:{port}"),
        (Some(host), None) => format!("{scheme}://{host}"),
        (None, _) => format!("{scheme}:"),
    }
}

#[cfg(test)]
mod tests {
    use super::origin_for_log;

    #[test]
    fn keeps_only_the_scheme_host_and_port() {
        for url in [
            "http://host.test:8080/live/USER/SECRET/1.ts",
            "http://host.test:8080/get.php?username=USER&password=SECRET",
            "http://USER:SECRET@host.test:8080/stream.m3u8",
            "http://host.test:8080/stream.m3u8#SECRET",
        ] {
            assert_eq!(origin_for_log(url), "http://host.test:8080", "{url}");
        }
    }

    #[test]
    fn works_for_other_streaming_schemes() {
        assert_eq!(
            origin_for_log("rtmp://USER:SECRET@host.test:1935/live/SECRET"),
            "rtmp://host.test:1935"
        );
        assert_eq!(
            origin_for_log("rtsp://host.test/stream?token=SECRET"),
            "rtsp://host.test"
        );
        assert_eq!(
            origin_for_log("udp://@239.0.0.1:1234"),
            "udp://239.0.0.1:1234"
        );
    }

    #[test]
    fn leaves_out_a_default_port() {
        assert_eq!(
            origin_for_log("https://host.test:443/SECRET.m3u8"),
            "https://host.test"
        );
    }

    #[test]
    fn keeps_the_brackets_around_an_ipv6_host() {
        assert_eq!(
            origin_for_log("http://[2001:db8::1]:8080/live/USER/SECRET/1.ts"),
            "http://[2001:db8::1]:8080"
        );
    }

    #[test]
    fn hides_local_files_and_unreadable_input() {
        assert_eq!(
            origin_for_log("file:///Users/USER/Movies/SECRET.mkv"),
            "file:"
        );
        assert_eq!(
            origin_for_log("/Users/USER/Movies/SECRET.mkv"),
            "<not a URL>"
        );
        assert_eq!(origin_for_log("not a url SECRET"), "<not a URL>");
        assert_eq!(origin_for_log(""), "<not a URL>");
    }
}
