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
