// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What an HLS stream's playlist says: whether its segments are MPEG-TS or
//! fragmented MP4, and whether its server sends CORS headers. A Chromecast
//! only fetches HLS from a server that does.
//!
//! It reads the playlist, the first variant's playlist when the first one
//! lists variants, and two bytes of the first segment. Errors never carry
//! the URL, which has the login in it.

use reqwest::header::{ACCESS_CONTROL_ALLOW_ORIGIN, ORIGIN, RANGE};
use reqwest::{Client, Response, StatusCode};
use url::Url;

use super::format::Container;

/// The origin the check sends. A server that allows any origin, or echoes
/// the one it's sent, would let a receiver's page fetch it too.
const CHECK_ORIGIN: &str = "https://cast.cinette.invalid";
/// A playlist larger than this isn't one.
const MAX_PLAYLIST: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HlsInfo {
    /// [`Container::HlsTs`] or [`Container::HlsFmp4`].
    pub container: Container,
    /// The playlists and the first segment all allow other origins.
    pub cors: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HlsError {
    #[error("the provider refused the stream ({0})")]
    Refused(u16),
    #[error("couldn't reach the stream")]
    Unreachable,
    #[error("the stream isn't an HLS playlist")]
    NotHls,
}

/// Reads the playlist at `url`.
pub async fn inspect(client: &Client, url: &str) -> Result<HlsInfo, HlsError> {
    let (base, text, mut cors) = playlist(client, url).await?;
    let (base, text) = match first_uri_after(&text, "#EXT-X-STREAM-INF") {
        Some(variant) => {
            let variant = base.join(&variant).map_err(|_| HlsError::NotHls)?;
            let (base, text, variant_cors) = playlist(client, variant.as_str()).await?;
            cors &= variant_cors;
            (base, text)
        }
        None => (base, text),
    };
    let container = if text.contains("#EXT-X-MAP") {
        Container::HlsFmp4
    } else {
        Container::HlsTs
    };
    if cors && let Some(segment) = first_uri_after(&text, "#EXTINF") {
        let segment = base.join(&segment).map_err(|_| HlsError::NotHls)?;
        cors = match get(client, segment.as_str(), true).await {
            Ok(response) => allows_other_origins(&response),
            // The playlist was fine, so a segment that fails is a CORS
            // question the check can't answer. Say no.
            Err(_) => false,
        };
    }
    Ok(HlsInfo { container, cors })
}

/// The playlist's final URL after redirects, its text, and its CORS answer.
async fn playlist(client: &Client, url: &str) -> Result<(Url, String, bool), HlsError> {
    let mut response = get(client, url, false).await?;
    let base = response.url().clone();
    let cors = allows_other_origins(&response);
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| HlsError::Unreachable)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_PLAYLIST {
            return Err(HlsError::NotHls);
        }
    }
    let text = String::from_utf8(body).map_err(|_| HlsError::NotHls)?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err(HlsError::NotHls);
    }
    Ok((base, text, cors))
}

async fn get(client: &Client, url: &str, first_bytes: bool) -> Result<Response, HlsError> {
    let mut request = client.get(url).header(ORIGIN, CHECK_ORIGIN);
    if first_bytes {
        request = request.header(RANGE, "bytes=0-1");
    }
    let response = request.send().await.map_err(|_| HlsError::Unreachable)?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            Err(HlsError::Refused(response.status().as_u16()))
        }
        status if status.is_success() => Ok(response),
        _ => Err(HlsError::Unreachable),
    }
}

fn allows_other_origins(response: &Response) -> bool {
    response
        .headers()
        .get(ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim() == "*" || v.trim() == CHECK_ORIGIN)
}

/// The first URI line after a line starting with `tag`.
fn first_uri_after(text: &str, tag: &str) -> Option<String> {
    let mut lines = text.lines().map(str::trim);
    lines.find(|l| l.starts_with(tag))?;
    lines
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
}
