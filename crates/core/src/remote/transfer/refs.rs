// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The keys that name the same thing on two devices: account tags, titles
//! and the Xtream panel's ids.

use crate::models::playlist::{Provider, ProviderType};
use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};
use std::fmt;

/// How many random bytes a transfer's salt has.
pub const SALT_LEN: usize = 16;
/// How many bytes of the hash make a tag.
const TAG_BYTES: usize = 16;

/// Random bytes the destination picks for each transfer, so tags from one
/// transfer can't be matched with tags from another.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Salt(pub [u8; SALT_LEN]);

impl Salt {
    pub fn generate() -> Self {
        Self(crate::remote::random_bytes())
    }

    pub fn to_hex(self) -> String {
        crate::remote::to_hex(&self.0)
    }

    pub fn from_hex(text: &str) -> Option<Self> {
        crate::remote::from_hex(text).map(Self)
    }
}

impl fmt::Debug for Salt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Salt(..)")
    }
}

/// Stands for a provider's account without saying which: the same server and
/// username give the same tag under the same salt. In lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AccountTag(String);

impl AccountTag {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for AccountTag {
    type Error = &'static str;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        crate::remote::from_hex::<TAG_BYTES>(&text)
            .map(|bytes| Self(crate::remote::to_hex(&bytes)))
            .ok_or("not an account tag")
    }
}

impl From<AccountTag> for String {
    fn from(tag: AccountTag) -> String {
        tag.0
    }
}

/// The tag for a provider's account, or `None` for an M3U file on this
/// device, which no other device can have.
///
/// An Xtream account is its server's scheme, host and port, and the
/// username. The path is left out, since panels answer the same under
/// any. An M3U playlist is its address without the query, and the
/// username in it. Each part ends with a 0 byte, so two can't run into
/// each other. Neither ever leaves the device: only the hash with the salt
/// does. No password field goes into it, but an M3U address that carries
/// the login in its path, such as `http://host/get/USER/PASS/list.m3u`, is
/// hashed with that path. The other device has the salt, so it could test
/// guesses at such a password against the tag.
pub fn account_tag(salt: &Salt, provider: &Provider) -> Option<AccountTag> {
    let (kind, place, username) = match provider.provider_type {
        ProviderType::Xtream => (
            "xtream",
            server_origin(&provider.url)?,
            provider.username.clone().unwrap_or_default(),
        ),
        ProviderType::M3u => {
            let url = provider.url.trim();
            if url.is_empty() || url.starts_with("file:") {
                return None;
            }
            let (place, username) = m3u_account(url)?;
            ("m3u", place, username)
        }
    };
    let mut hash = Blake2s256::new();
    hash.update(salt.0);
    for part in [kind, place.as_str(), username.as_str()] {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    Some(AccountTag(crate::remote::to_hex(
        &hash.finalize()[..TAG_BYTES],
    )))
}

/// An M3U playlist's account: its address without the query, and the
/// username it names, in the query or before the host. A password, token
/// or any other value in the address is left out, so the tag can't be
/// tested against guesses of it.
fn m3u_account(url: &str) -> Option<(String, String)> {
    let parsed = url::Url::parse(url).ok()?;
    let origin = server_origin(url)?;
    let place = format!("{origin}{}", parsed.path());
    let username = parsed
        .query_pairs()
        .find(|(k, _)| k.eq_ignore_ascii_case("username"))
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| parsed.username().to_string());
    Some((place, username))
}

/// The scheme, host and port of a server address, in one form however it
/// was typed: `http://Example.com` and `http://example.com:80/` are the same.
fn server_origin(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    let host = parsed.host_str().filter(|h| !h.is_empty())?;
    let port = parsed
        .port_or_known_default()
        .map_or_else(String::new, |p| p.to_string());
    Some(format!("{}://{host}:{port}", parsed.scheme()))
}

/// A title as both devices compare it: trimmed, lowercased, with each run of
/// spaces made one. The same as `normalize` in the frontend's
/// `lib/playback.ts`, which makes resume keys.
pub fn normalize_title(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The key a movie's or an episode's position is saved under, as
/// `playbackKey` in `lib/playback.ts` makes it.
pub fn movie_key(title: &str) -> String {
    format!("movie:{}", normalize_title(title))
}

/// See [`movie_key`].
pub fn episode_key(series: &str, season: u32, episode: u32) -> String {
    format!("series:{}:s{season}e{episode}", normalize_title(series))
}

/// What a saved position's key names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyRef {
    Movie(String),
    Episode {
        series: String,
        season: u32,
        episode: u32,
    },
}

/// Reads a key made by [`movie_key`] or [`episode_key`]. A show's title can
/// hold a colon, so the season and episode are read from the end.
pub fn parse_key(key: &str) -> Option<KeyRef> {
    if let Some(title) = key.strip_prefix("movie:") {
        return (!title.is_empty()).then(|| KeyRef::Movie(title.to_string()));
    }
    let rest = key.strip_prefix("series:")?;
    let (series, numbers) = rest.rsplit_once(':')?;
    let (season, episode) = numbers.strip_prefix('s')?.split_once('e')?;
    // Digits only: parse alone would take a leading "+", and it refuses "".
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if series.is_empty() || !digits(season) || !digits(episode) {
        return None;
    }
    Some(KeyRef::Episode {
        series: series.to_string(),
        season: season.parse().ok()?,
        episode: episode.parse().ok()?,
    })
}

/// The panel's own id inside an Xtream channel id: `live-123` from
/// `xt-ab12-live-123`. The app gives each channel its provider's id and a
/// dash in front of the id the panel gave it.
pub fn panel_id<'a>(channel_id: &'a str, provider_id: &str) -> Option<&'a str> {
    let id = channel_id.strip_prefix(provider_id)?.strip_prefix('-')?;
    let (kind, rest) = id.split_once('-')?;
    let known =
        matches!(kind, "live" | "movie" | "series") || (kind == "xt" && rest.starts_with("ep-"));
    (known && !rest.is_empty()).then_some(id)
}

/// Reads an Xtream episode's panel id, `xt-ep-<series>-s<season>-<index>`,
/// as the series id, the season and the episode's place in it. Anything
/// else, such as `xt-ep-42-not-an-episode`, reads as nothing.
pub fn parse_episode_id(panel_id: &str) -> Option<(u64, u32, u32)> {
    let mut parts = panel_id.strip_prefix("xt-ep-")?.split('-');
    let (series, season, index) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let season = season.strip_prefix('s')?;
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !(digits(series) && digits(season) && digits(index)) {
        return None;
    }
    Some((
        series.parse().ok()?,
        season.parse().ok()?,
        index.parse().ok()?,
    ))
}

#[cfg(test)]
mod tests;
