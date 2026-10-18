// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The ways of fetching an item and what each one holds, for deciding
//! whether a Cast or AirPlay receiver can play it, and how. Nothing here is
//! specific to one kind of receiver.

pub mod format;
pub mod hls;
pub mod probe;

#[cfg(test)]
mod tests;

use crate::models::playlist::ProviderType;
use format::{Container, StreamFormat};
use hls::HlsInfo;

/// The URLs an item can be fetched from, best first.
///
/// An Xtream live channel comes as `.m3u8` first when the login allows it,
/// then as `.ts`, since receivers play HLS but not raw MPEG-TS. `allowed` is
/// the login's `allowed_output_formats`. When it's empty, the panel didn't
/// say, so only the channel's own URL is tried. Anything else has just its
/// own URL.
pub fn candidates(
    provider: &ProviderType,
    content_type: &str,
    url: &str,
    allowed: &[String],
) -> Vec<String> {
    let xtream_live = matches!(provider, ProviderType::Xtream) && content_type == "live";
    let Some(stem) = xtream_live.then(|| xtream_live_stem(url)).flatten() else {
        return vec![url.to_string()];
    };
    let mut urls: Vec<String> = ["m3u8", "ts"]
        .into_iter()
        .filter(|ext| allowed.iter().any(|a| a == ext))
        .map(|ext| format!("{stem}.{ext}"))
        .collect();
    if urls.is_empty() {
        urls.push(url.to_string());
    }
    urls
}

/// An Xtream live URL without its extension:
/// `<server>/live/<user>/<pass>/<id>` from `<…>/<id>.ts`. `None` for any
/// other URL.
fn xtream_live_stem(url: &str) -> Option<&str> {
    let (stem, ext) = url.rsplit_once('.')?;
    let (_, id) = stem.rsplit_once('/')?;
    let plain = !ext.contains(['/', '?', '#']) && !id.is_empty();
    (plain && id.bytes().all(|b| b.is_ascii_digit()) && stem.contains("/live/")).then_some(stem)
}

/// Whether `url` names an HLS playlist, going by its path.
pub fn is_hls_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.to_ascii_lowercase().ends_with(".m3u8")
}

/// The container a URL's extension names, if it names one.
fn container_from_extension(url: &str) -> Option<Container> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let (_, ext) = path.rsplit_once('.')?;
    match ext.to_ascii_lowercase().as_str() {
        "ts" => Some(Container::Ts),
        "mkv" => Some(Container::Mkv),
        "mp4" | "m4v" | "mov" => Some(Container::Mp4),
        _ => None,
    }
}

/// What the HLS check said about one URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HlsCheck {
    /// Not an HLS URL, so there was nothing to check.
    NotHls,
    Checked(HlsInfo),
    /// The check failed, so the URL isn't offered.
    Failed,
}

/// One format for each URL that can be offered, with its index in `urls`.
///
/// `codecs` is what mpv or the probe found, about `urls[source]`. The URLs
/// all carry the same source, so they share its codecs. Each one's container
/// comes from its HLS check, then from the probe for the URL it was about,
/// then from its extension.
pub fn formats_for(
    urls: &[String],
    codecs: StreamFormat,
    source: usize,
    hls: &[HlsCheck],
) -> Vec<(usize, StreamFormat)> {
    urls.iter()
        .zip(hls)
        .enumerate()
        .filter_map(|(i, (url, check))| {
            let (container, cors) = match check {
                HlsCheck::Failed => return None,
                HlsCheck::Checked(info) => (info.container, info.cors),
                HlsCheck::NotHls if i == source => (codecs.container, false),
                HlsCheck::NotHls => (
                    container_from_extension(url).unwrap_or(codecs.container),
                    false,
                ),
            };
            Some((
                i,
                StreamFormat {
                    container,
                    cors,
                    ..codecs
                },
            ))
        })
        .collect()
}
