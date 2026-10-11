// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/// Scrub Xtream credentials from any string before it is logged, returned in an
/// error, or emitted in an event. Xtream URLs embed credentials as path
/// segments: `http://host:8080/movie/<user>/<pass>/12345.mkv`. We also redact
/// `username=`/`password=` query parameters used by EPG/auth URLs.
pub fn redact_credentials(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for token in split_keep(input) {
        out.push_str(&redact_token(token));
    }
    out
}

/// Split on whitespace but keep the separators so messages read naturally.
fn split_keep(input: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut last = 0;
    for (i, c) in input.char_indices() {
        if c.is_whitespace() {
            if last < i {
                parts.push(&input[last..i]);
            }
            parts.push(&input[i..i + c.len_utf8()]);
            last = i + c.len_utf8();
        }
    }
    if last < input.len() {
        parts.push(&input[last..]);
    }
    parts
}

fn redact_token(token: &str) -> String {
    // Query-style credentials.
    let mut t = token.to_string();
    for key in ["username", "password"] {
        t = redact_query_param(&t, key);
    }
    // Path-style Xtream credentials: /movie|series|live/<user>/<pass>/<id>
    for kind in ["movie", "series", "live"] {
        if let Some(redacted) = redact_path_creds(&t, kind) {
            t = redacted;
        }
    }
    t
}

fn redact_query_param(token: &str, key: &str) -> String {
    let needle = format!("{key}=");
    if let Some(start) = token.find(&needle) {
        let value_start = start + needle.len();
        let value_end = token[value_start..]
            .find(['&', ' '])
            .map(|i| value_start + i)
            .unwrap_or(token.len());
        let mut s = String::new();
        s.push_str(&token[..value_start]);
        s.push_str("***");
        s.push_str(&token[value_end..]);
        return s;
    }
    token.to_string()
}

fn redact_path_creds(token: &str, kind: &str) -> Option<String> {
    let marker = format!("/{kind}/");
    let idx = token.find(&marker)?;
    let after = idx + marker.len();
    let rest = &token[after..];
    let mut segs = rest.splitn(3, '/');
    let _user = segs.next()?;
    let _pass = segs.next()?;
    let tail = segs.next().unwrap_or("");
    Some(format!("{}{}***/***/{}", &token[..idx], marker, tail))
}

/// Rewrite every URL in free text so the text can go in a log. Logins hide in
/// many places: `user:pass@host`, Xtream paths with or without `/live/`,
/// `username=` and `password=` queries, and `apikey=` or `key=` for OMDb,
/// MDBList and Gemini. Rather than chase each one, this keeps only the scheme,
/// the host and port, and a last path segment that looks like a stream ID or a
/// file name. `http://host:8080/user/pass/123.ts` becomes
/// `http://host:8080/…/123.ts`.
pub fn scrub_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // Everything before `copied` is already in `out`.
    let mut copied = 0;
    let mut search = 0;
    while let Some(found) = text[search..].find("://") {
        let sep = search + found;
        let scheme_start = text[copied..sep]
            .bytes()
            .rposition(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')))
            .map(|i| copied + i + 1)
            .unwrap_or(copied);
        let scheme = &text[scheme_start..sep];
        if !scheme.starts_with(|c: char| c.is_ascii_alphabetic()) {
            search = sep + 3;
            continue;
        }
        let rest_start = sep + 3;
        let end = text[rest_start..]
            .find(|c: char| c.is_whitespace() || "\"'<>)]}`".contains(c))
            .map(|i| rest_start + i)
            .unwrap_or(text.len());
        out.push_str(&text[copied..rest_start]);
        out.push_str(&scrub_after_scheme(&text[rest_start..end]));
        copied = end;
        search = end;
    }
    out.push_str(&text[copied..]);
    out
}

/// `rest` is everything after `scheme://` up to the end of the URL.
fn scrub_after_scheme(rest: &str) -> String {
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let mut out = match authority.rfind('@') {
        Some(at) => format!("***@{}", &authority[at + 1..]),
        None => authority.to_string(),
    };

    let after = &rest[authority_end..];
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    let segments: Vec<&str> = after[..path_end]
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if let Some(last) = segments.last() {
        if is_safe_segment(last) {
            if segments.len() > 1 {
                out.push_str("/…");
            }
            out.push('/');
            out.push_str(last);
        } else {
            out.push_str("/…");
        }
    } else {
        out.push_str(&after[..path_end]);
    }

    match after[path_end..].chars().next() {
        Some('?') => out.push_str("?…"),
        Some('#') => out.push_str("#…"),
        _ => {}
    }
    out
}

/// A stream ID such as `12345`, or a short file name with a known media or
/// page extension such as `12345.ts`, `index.m3u8` or `xmltv.php`.
fn is_safe_segment(segment: &str) -> bool {
    const EXTENSIONS: [&str; 15] = [
        "ts", "m3u8", "m3u", "mp4", "mkv", "avi", "mov", "webm", "flv", "mpd", "php", "xml", "gz",
        "json", "m4s",
    ];
    if segment.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    let Some((stem, ext)) = segment.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= 32
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        && EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_path_credentials() {
        let url = "http://host:8080/movie/john/s3cret/12345.mkv";
        let out = redact_credentials(url);
        assert!(!out.contains("john"));
        assert!(!out.contains("s3cret"));
        assert!(out.contains("12345.mkv"));
        assert!(out.contains("/movie/***/***/"));
    }

    #[test]
    fn redacts_query_credentials() {
        let url = "http://host/xmltv.php?username=john&password=s3cret";
        let out = redact_credentials(url);
        assert!(out.contains("username=***"));
        assert!(out.contains("password=***"));
        assert!(!out.contains("john"));
        assert!(!out.contains("s3cret"));
    }

    #[test]
    fn leaves_clean_text_untouched() {
        let msg = "download failed: connection reset";
        assert_eq!(redact_credentials(msg), msg);
    }

    #[test]
    fn scrub_hides_xtream_paths() {
        assert_eq!(
            scrub_urls("[MPV cmd] load url=http://host:8080/live/john/s3cret/12345.ts"),
            "[MPV cmd] load url=http://host:8080/…/12345.ts"
        );
        assert_eq!(
            scrub_urls("http://host/movie/john/s3cret/777.mkv"),
            "http://host/…/777.mkv"
        );
        assert_eq!(
            scrub_urls("http://host/series/john/s3cret/4242.mp4"),
            "http://host/…/4242.mp4"
        );
        // The short form has no `/live/`, which `redact_credentials` misses.
        assert_eq!(
            scrub_urls("http://host:80/john/s3cret/12345"),
            "http://host:80/…/12345"
        );
    }

    #[test]
    fn scrub_hides_queries() {
        assert_eq!(
            scrub_urls("loading http://host/get.php?username=john&password=s3cret&type=m3u_plus"),
            "loading http://host/get.php?…"
        );
        assert_eq!(
            scrub_urls("epg http://host:8080/xmltv.php?username=john&password=s3cret"),
            "epg http://host:8080/xmltv.php?…"
        );
        assert_eq!(
            scrub_urls("https://www.omdbapi.com/?apikey=abc123&t=Sintel"),
            "https://www.omdbapi.com/?…"
        );
        assert_eq!(
            scrub_urls(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSECRET"
            ),
            "https://generativelanguage.googleapis.com/…?…"
        );
    }

    #[test]
    fn scrub_hides_userinfo() {
        assert_eq!(
            scrub_urls("rtmp://john:s3cret@host:1935/app/stream"),
            "rtmp://***@host:1935/…"
        );
    }

    #[test]
    fn scrub_stops_at_delimiters() {
        assert_eq!(
            scrub_urls(
                "error sending request for url (https://www.omdbapi.com/?apikey=abc123&t=Up): timed out"
            ),
            "error sending request for url (https://www.omdbapi.com/?…): timed out"
        );
        assert_eq!(
            scrub_urls(r#"{"path":"http://host/john/s3cret/1.ts","id":1}"#),
            r#"{"path":"http://host/…/1.ts","id":1}"#
        );
    }

    #[test]
    fn scrub_handles_several_urls_and_unicode() {
        assert_eq!(
            scrub_urls("Ré-essai http://a/u/p/1.ts → https://b/x?token=t 完了"),
            "Ré-essai http://a/…/1.ts → https://b/…?… 完了"
        );
    }

    #[test]
    fn scrub_leaves_other_text_alone() {
        for msg in [
            "download failed: connection reset",
            "ratio 3:// not a url",
            "",
            "http://",
            "see https://example.com",
            "https://example.com/",
        ] {
            assert_eq!(scrub_urls(msg), msg);
        }
    }
}
