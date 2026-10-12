// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/// Scrub Xtream credentials from any string before it is logged, returned in an
/// error, or emitted in an event. Xtream URLs embed credentials as path
/// segments: `http://host:8080/movie/<user>/<pass>/12345.mkv`. We also redact
/// the values of `key=value` pairs that carry a login or an API key, such as
/// `username=`, `password=` or `apikey=`, whatever their case.
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
    let mut t = redact_key_values(token);
    // Path-style Xtream credentials: /movie|series|live/<user>/<pass>/<id>
    for kind in ["movie", "series", "live"] {
        if let Some(redacted) = redact_path_creds(&t, kind) {
            t = redacted;
        }
    }
    t
}

/// Keys whose values are logins or API keys. Xtream logins travel as
/// `username` and `password`, OMDb and MDBList take `apikey`, and Gemini takes
/// `key`.
const SECRET_KEYS: [&str; 6] = ["username", "password", "apikey", "api_key", "key", "token"];

/// Replaces the value of every `key=value` pair in `token` whose key is in
/// [`SECRET_KEYS`] with `***`. Keys match in any case but only as a whole
/// word, so `Password=` counts and `monkey=` doesn't. A value runs to the next
/// `&` or the end of the token.
fn redact_key_values(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    // Everything before `copied` is already in `out`.
    let mut copied = 0;
    let mut search = 0;
    while let Some(found) = token[search..].find('=') {
        let eq = search + found;
        let key_start = token[..eq]
            .bytes()
            .rposition(|b| !(b.is_ascii_alphanumeric() || b == b'_'))
            .map_or(0, |i| i + 1);
        let key = &token[key_start..eq];
        let value_start = eq + 1;
        let value_end = token[value_start..]
            .find('&')
            .map_or(token.len(), |i| value_start + i);
        if value_end > value_start && SECRET_KEYS.iter().any(|k| k.eq_ignore_ascii_case(key)) {
            out.push_str(&token[copied..value_start]);
            out.push_str("***");
            copied = value_end;
            search = value_end;
        } else {
            search = value_start;
        }
    }
    out.push_str(&token[copied..]);
    out
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

/// Prepares a line for a log that outlives the session, such as the iOS
/// system log. [`redact_credentials`] goes first because it reads whole words,
/// so it finds a password in a `/live/` path or a `password=` value even when
/// the password holds a character, such as a quote, that ends the address for
/// [`scrub_urls`].
pub fn scrub_log_line(line: &str) -> String {
    scrub_urls(&redact_credentials(line))
}

/// Rewrite every URL in free text so the text can go in a log. Logins hide in
/// many places: `user:pass@host`, Xtream paths with or without `/live/`,
/// `username=` and `password=` queries, and `apikey=` or `key=` for OMDb,
/// MDBList and Gemini. Rather than chase each one, this keeps only the scheme,
/// the host and port, and as much of the last path segment as [`tail`] allows.
/// `http://host:8080/user/pass/123.ts` becomes `http://host:8080/…/123.ts`.
fn scrub_urls(text: &str) -> String {
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
        let end = rest_start + url_len(&text[rest_start..]);
        out.push_str(&text[copied..rest_start]);
        out.push_str(&scrub_after_scheme(&text[rest_start..end]));
        copied = end;
        search = end;
    }
    out.push_str(&text[copied..]);
    out
}

/// The length of the URL at the start of `rest`, which follows `scheme://`.
/// A query or fragment runs to the next whitespace, because a secret in it can
/// hold any other character. Without one, the URL also ends at a character it
/// can't hold unencoded, such as a quote, and gives up the punctuation that
/// closes a sentence or a bracket around it.
fn url_len(rest: &str) -> usize {
    let word = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let unencoded = rest[..word]
        .find(|c: char| "\"<>`{}|\\^".contains(c))
        .unwrap_or(word);
    let url = &rest[..unencoded];
    if url.contains(['?', '#']) {
        return word;
    }
    trim_trailing_punctuation(url).len()
}

/// Drops trailing `.`, `,`, `;`, `:`, `!` and `'`, and a `)` or `]` that has
/// no partner inside the URL, as in `(see http://host/1.ts).`.
fn trim_trailing_punctuation(mut url: &str) -> &str {
    while let Some(last) = url.chars().next_back() {
        let outside = match last {
            ')' => url.matches(')').count() > url.matches('(').count(),
            ']' => url.matches(']').count() > url.matches('[').count(),
            '.' | ',' | ';' | ':' | '!' | '\'' => true,
            _ => false,
        };
        if !outside {
            break;
        }
        url = &url[..url.len() - 1];
    }
    url
}

/// `rest` is everything after `scheme://` up to the end of the URL.
fn scrub_after_scheme(rest: &str) -> String {
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let mut out = String::new();
    let host = match authority.rfind('@') {
        Some(at) => {
            out.push_str("***@");
            &authority[at + 1..]
        }
        None => authority,
    };
    // A password with a `/`, `?` or `#` in it ends the authority early and
    // leaves something like `user:pa` behind, which isn't a host.
    out.push_str(if is_host_and_port(host) { host } else { "***" });

    let after = &rest[authority_end..];
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    let path = &after[..path_end];
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match segments.split_last() {
        None => out.push_str(path),
        Some((last, before)) => match tail(last) {
            Tail::Whole => {
                if !before.is_empty() {
                    out.push_str("/…");
                }
                out.push('/');
                out.push_str(last);
            }
            Tail::Extension(ext) => {
                out.push_str("/….");
                out.push_str(ext);
            }
            Tail::Hidden => out.push_str("/…"),
        },
    }

    match after[path_end..].chars().next() {
        Some('?') => out.push_str("?…"),
        Some('#') => out.push_str("#…"),
        _ => {}
    }
    out
}

/// `host`, `host:port`, `[v6]` or `[v6]:port`.
fn is_host_and_port(authority: &str) -> bool {
    let after_host = match authority.strip_prefix('[') {
        Some(v6) => match v6.find(']') {
            Some(close) => &v6[close + 1..],
            None => return false,
        },
        None => authority.find(':').map_or("", |colon| &authority[colon..]),
    };
    match after_host.strip_prefix(':') {
        Some(port) => port.bytes().all(|b| b.is_ascii_digit()),
        None => after_host.is_empty(),
    }
}

/// How much of a URL's last path segment a log keeps. Any name other than an
/// ID or a well-known one could be a token, such as the session ID some
/// servers put in an HLS playlist's name.
enum Tail<'a> {
    /// A stream ID such as `12345` or `12345.ts`, or a name in [`WELL_KNOWN`].
    Whole,
    /// Another name with an extension in [`EXTENSIONS`] keeps only that, so
    /// `a1b2c3d4e5.m3u8` comes out as `….m3u8`.
    Extension(&'a str),
    Hidden,
}

const EXTENSIONS: [&str; 15] = [
    "ts", "m3u8", "m3u", "mp4", "mkv", "avi", "mov", "webm", "flv", "mpd", "php", "xml", "gz",
    "json", "m4s",
];

/// File names that Xtream servers and HLS streams use for everyone.
const WELL_KNOWN: [&str; 6] = [
    "get.php",
    "player_api.php",
    "xmltv.php",
    "index.m3u8",
    "playlist.m3u8",
    "master.m3u8",
];

/// Xtream stream IDs are well under ten digits. A longer number may not be an
/// ID at all.
const MAX_ID_DIGITS: usize = 10;

fn tail(segment: &str) -> Tail<'_> {
    if WELL_KNOWN
        .iter()
        .any(|name| name.eq_ignore_ascii_case(segment))
    {
        return Tail::Whole;
    }
    let (stem, ext) = match segment.rsplit_once('.') {
        Some((stem, ext)) if EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext)) => {
            (stem, Some(ext))
        }
        _ => (segment, None),
    };
    let is_id =
        !stem.is_empty() && stem.len() <= MAX_ID_DIGITS && stem.bytes().all(|b| b.is_ascii_digit());
    match (is_id, ext) {
        (true, _) => Tail::Whole,
        (false, Some(ext)) => Tail::Extension(ext),
        (false, None) => Tail::Hidden,
    }
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
    fn redacts_secret_keys_in_any_case() {
        assert_eq!(
            redact_credentials(
                "?Username=john&PASSWORD=s3cret&apiKey=abc&API_KEY=def&key=ghi&Token=jkl&t=Up"
            ),
            "?Username=***&PASSWORD=***&apiKey=***&API_KEY=***&key=***&Token=***&t=Up"
        );
        assert_eq!(
            redact_credentials("retrying with key=AIzaSECRET in 5s"),
            "retrying with key=*** in 5s"
        );
    }

    #[test]
    fn redacts_only_whole_secret_keys() {
        for msg in ["monkey=banana&keyboard=qwerty", "tokens=3 passwords=2"] {
            assert_eq!(redact_credentials(msg), msg);
        }
    }

    #[test]
    fn redacts_every_secret_value() {
        assert_eq!(
            redact_credentials("password=a&x=1&password=b"),
            "password=***&x=1&password=***"
        );
        // An `=` inside a value doesn't start a new pair.
        assert_eq!(redact_credentials("token=YWJj==&x=1"), "token=***&x=1");
        // An empty value has nothing to hide.
        assert_eq!(redact_credentials("password=&x=1"), "password=&x=1");
    }

    #[test]
    fn redacts_path_credentials_with_punctuation() {
        assert_eq!(
            redact_credentials("http://host/live/john/pa)s's]w/1.ts"),
            "http://host/live/***/***/1.ts"
        );
    }

    #[test]
    fn scrub_log_line_hides_passwords_that_look_like_url_ends() {
        // A quote, `)`, `'` or `]` in a password used to end the address early
        // and leave the rest of the password in the line.
        assert_eq!(
            scrub_log_line("load url=http://host/live/john/pa)s\"s/12345.ts done"),
            "load url=http://host/…/12345.ts done"
        );
        assert_eq!(
            scrub_log_line("epg http://host/xmltv.php?username=john&password=pa)s'w]rd now"),
            "epg http://host/xmltv.php?… now"
        );
        assert_eq!(
            scrub_log_line("(http://host/get.php?username=john&password=a\"b): timed out"),
            "(http://host/get.php?… timed out"
        );
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
        // A `)` in a short-form password doesn't end the address either.
        assert_eq!(
            scrub_urls("http://host:80/john/s3)cret/12345 failed"),
            "http://host:80/…/12345 failed"
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
    fn scrub_runs_queries_and_fragments_to_whitespace() {
        assert_eq!(
            scrub_urls(
                "error sending request for url (https://www.omdbapi.com/?apikey=ab)c&t=Up): timed out"
            ),
            "error sending request for url (https://www.omdbapi.com/?… timed out"
        );
        assert_eq!(
            scrub_urls("http://host/x#token=a\"b'c]d next"),
            "http://host/…#… next"
        );
    }

    #[test]
    fn scrub_hides_userinfo() {
        assert_eq!(
            scrub_urls("rtmp://john:s3cret@host:1935/app/stream"),
            "rtmp://***@host:1935/…"
        );
        // A `/` or `#` in the password ends the authority early.
        assert_eq!(
            scrub_urls("http://john:pa/ss@host/12345.ts"),
            "http://***/…/12345.ts"
        );
        assert_eq!(scrub_urls("http://john:pa#ss@host/"), "http://***#…");
    }

    #[test]
    fn scrub_keeps_ipv6_hosts() {
        assert_eq!(
            scrub_urls("http://[2001:db8::1]:8080/john/s3cret/12345.ts"),
            "http://[2001:db8::1]:8080/…/12345.ts"
        );
        assert_eq!(
            scrub_urls("rtsp://john:s3cret@[::1]/cam"),
            "rtsp://***@[::1]/…"
        );
        assert_eq!(scrub_urls("see http://[::1]."), "see http://[::1].");
    }

    #[test]
    fn scrub_keeps_only_ids_well_known_names_and_extensions() {
        assert_eq!(
            scrub_urls("https://cdn.example.com/hls/0123456789abcdef0123456789abcdef.m3u8"),
            "https://cdn.example.com/….m3u8"
        );
        assert_eq!(
            scrub_urls("https://cdn.example.com/hls/a1b2c3/index.m3u8"),
            "https://cdn.example.com/…/index.m3u8"
        );
        assert_eq!(
            scrub_urls("http://host/player_api.php"),
            "http://host/player_api.php"
        );
        // Too long for a stream ID.
        assert_eq!(scrub_urls("http://host/u/12345678901"), "http://host/…");
        assert_eq!(
            scrub_urls("http://host/u/12345678901.ts"),
            "http://host/….ts"
        );
        // Not a media or playlist extension.
        assert_eq!(scrub_urls("http://host/u/12345.secret"), "http://host/…");
    }

    #[test]
    fn scrub_stops_at_delimiters() {
        assert_eq!(
            scrub_urls(r#"{"path":"http://host/john/s3cret/1.ts","id":1}"#),
            r#"{"path":"http://host/…/1.ts","id":1}"#
        );
        assert_eq!(
            scrub_urls("(see http://host/live/john/s3cret/1.ts)."),
            "(see http://host/…/1.ts)."
        );
        // A bracket the URL opened stays with it.
        assert_eq!(
            scrub_urls("(http://host/wiki/Foo_(bar))"),
            "(http://host/…)"
        );
        assert_eq!(
            scrub_urls("at http://host:8080, then"),
            "at http://host:8080, then"
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
