// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The little HTTP the converter's server speaks: it reads a request's
//! first line and answers with a head. It only ever serves its own few
//! paths to one receiver, so it needs nothing more.

/// The longest a request's head may be before the server drops it.
pub const MAX_HEAD: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub path: String,
    /// `HEAD`, which gets the head without a body.
    pub head_only: bool,
}

/// The end of a request's head in `bytes`, after its blank line.
pub fn head_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
}

/// The method and path of a request's head. Only `GET` and `HEAD` of a
/// plain path count; anything else gets no answer.
pub fn read_request(head: &[u8]) -> Option<Request> {
    let line = head.split(|&b| b == b'\r').next()?;
    let line = std::str::from_utf8(line).ok()?;
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let path = parts.next()?;
    let version = parts.next()?;
    if parts.next().is_some() || !version.starts_with("HTTP/1.") || !path.starts_with('/') {
        return None;
    }
    let head_only = match method {
        "GET" => false,
        "HEAD" => true,
        _ => return None,
    };
    Some(Request {
        path: path.to_string(),
        head_only,
    })
}

/// A `200 OK` head. A live stream has no length. Every answer allows any
/// origin, since the receiver's page fetches subtitles with XHR.
pub fn ok_head(content_type: &str, length: Option<usize>) -> String {
    let length = length.map_or_else(String::new, |n| format!("Content-Length: {n}\r\n"));
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n{length}\
         Accept-Ranges: none\r\nCache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    )
}

/// A `404 Not Found` head, for a name under the token that isn't there,
/// such as a segment the window dropped. A receiver that asks for one
/// after a stall moves on to the next.
pub fn not_found_head() -> &'static str {
    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\
     Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
}

/// A random path segment no one can guess: 32 bytes as hex.
pub fn token() -> String {
    let mut bytes = [0u8; 32];
    // The OS random source only fails on a broken system.
    getrandom::fill(&mut bytes).expect("the operating system's random source failed");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
