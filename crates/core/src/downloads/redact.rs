// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/// Scrub Xtream credentials from any string before it is logged, returned in an
/// error, or emitted in an event. Xtream URLs embed credentials as path
/// segments: `http://host:8080/movie/<user>/<pass>/12345.mkv`, or for live
/// channels also `http://host:8080/<user>/<pass>/12345`. We also redact
/// `username=`/`password=` query parameters used by EPG/auth URLs, and a login
/// before the host, as in `http://user:pass@host/`.
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
    // Path-style Xtream credentials: /movie|series|live|timeshift/<user>/<pass>/<id>
    for kind in ["movie", "series", "live", "timeshift"] {
        if let Some(redacted) = redact_path_creds(&t, kind) {
            t = redacted;
        }
    }
    if let Some(redacted) = redact_userinfo(&t) {
        t = redacted;
    }
    if let Some(redacted) = redact_short_stream_path(&t) {
        t = redacted;
    }
    t
}

/// Where the host of a URL in `token` starts and its path begins, or the
/// token's end when it has no path.
fn authority(token: &str) -> Option<(usize, usize)> {
    let start = token.find("://")? + 3;
    let end = token[start..]
        .find(['/', '?', '#'])
        .map_or(token.len(), |i| start + i);
    Some((start, end))
}

/// `scheme://user:pass@host/...` with the login replaced.
fn redact_userinfo(token: &str) -> Option<String> {
    let (start, end) = authority(token)?;
    let at = token[start..end].rfind('@')? + start;
    Some(format!("{}***{}", &token[..start], &token[at..]))
}

/// The short form of an Xtream live URL, `http://host/<user>/<pass>/<id>`,
/// with the login replaced. The last segment has to be a stream number,
/// optionally with an extension, so other three-part paths stay readable.
fn redact_short_stream_path(token: &str) -> Option<String> {
    let (_, path_start) = authority(token)?;
    let path = token[path_start..].strip_prefix('/')?;
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let segs: Vec<&str> = path.split('/').collect();
    let [user, pass, id] = segs.as_slice() else {
        return None;
    };
    let stem = id
        .split('.')
        .next()
        .unwrap_or(id)
        .trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
    if user.is_empty() || pass.is_empty() || stem.is_empty() {
        return None;
    }
    if !stem.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let tail_start = path_start + 1 + user.len() + 1 + pass.len();
    Some(format!(
        "{}/***/***{}",
        &token[..path_start],
        &token[tail_start..]
    ))
}

/// The scheme, host and port of `url`, the part of it that can't hold a
/// login, for a message about it. Used in place of a stream URL whose login
/// may sit anywhere in it.
pub fn url_origin(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => match (parsed.host_str(), parsed.port()) {
            (Some(host), Some(port)) => format!("{}://{host}:{port}", parsed.scheme()),
            (Some(host), None) => format!("{}://{host}", parsed.scheme()),
            (None, _) => "the stream".to_string(),
        },
        Err(_) => "the stream".to_string(),
    }
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
    fn redacts_the_short_live_path() {
        let line = "Error opening input file http://host:8080/john/s3cret/12345.";
        let out = redact_credentials(line);
        assert_eq!(
            out,
            "Error opening input file http://host:8080/***/***/12345."
        );
        let out = redact_credentials("http://host/john/s3cret/7.ts: Server returned 403");
        assert_eq!(out, "http://host/***/***/7.ts: Server returned 403");
    }

    #[test]
    fn redacts_timeshift_credentials() {
        let out = redact_credentials("http://host/timeshift/john/s3cret/60/2026-10-12:20-00/9.ts");
        assert!(!out.contains("john"));
        assert!(!out.contains("s3cret"));
    }

    #[test]
    fn redacts_a_login_before_the_host() {
        let out = redact_credentials("rtmp://john:s3cret@host:1935/live/stream");
        assert_eq!(out, "rtmp://***@host:1935/live/stream");
        let out = redact_credentials("http://john@host/a.m3u8?x=1");
        assert_eq!(out, "http://***@host/a.m3u8?x=1");
    }

    #[test]
    fn leaves_other_three_part_paths_alone() {
        let msg = "see http://host/docs/guide/intro.html";
        assert_eq!(redact_credentials(msg), msg);
        let email = "mail someone@example.com";
        assert_eq!(redact_credentials(email), email);
    }

    #[test]
    fn keeps_only_the_origin_of_a_url() {
        assert_eq!(
            url_origin("http://host:8080/john/s3cret/12345"),
            "http://host:8080"
        );
        assert_eq!(
            url_origin("https://john:s3cret@host/live.m3u8"),
            "https://host"
        );
        assert_eq!(url_origin("rtmp://host/live/u/p/1"), "rtmp://host");
        assert_eq!(url_origin("not a url"), "the stream");
    }

    #[test]
    fn leaves_clean_text_untouched() {
        let msg = "download failed: connection reset";
        assert_eq!(redact_credentials(msg), msg);
    }
}
