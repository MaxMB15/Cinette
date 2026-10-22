// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Copying watch history, playback positions, favorites and pinned groups
//! from one device to another (spec 5).
//!
//! Ids only mean something on the device that made them, so the source never
//! sends its own. It sends a reference for each item ([`ItemRef`]): the
//! names, the panel's own id and a tag for the account ([`refs`]). The
//! destination matches each reference against its own catalog
//! ([`matching`]), and writes only what matched, merged with what it has
//! ([`merge`]). Anything else is reported as unmatched and nothing is
//! substituted.
//!
//! A history transfer never carries a URL, server, username, password, logo
//! or channel id.

pub mod chunks;
pub mod flow;
pub mod matching;
pub mod merge;
pub mod refs;

use refs::AccountTag;
use serde::{Deserialize, Serialize};

/// What sort of item a reference is to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Live,
    Movie,
    /// A show, which only a favorite points at.
    Series,
    /// One episode of a show.
    Episode,
}

/// What the source knows about an item, without anything that only means
/// something on the source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub kind: ItemKind,
    /// The name to show, and to match by.
    pub name: String,
    /// The show an episode belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<u32>,
    /// The IMDb id, such as `tt0111161`, when the source looked it up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imdb: Option<String>,
    /// A live channel's `tvg-id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tvg_id: Option<String>,
    /// The account the item came from. See [`refs::account_tag`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountTag>,
    /// The Xtream panel's own id, such as `live-123`, `movie-812`,
    /// `series-42` or `xt-ep-42-s1-3`. Only for an Xtream account, where
    /// the same server and username give the same ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_id: Option<String>,
}

impl ItemRef {
    /// A reference with only a kind and a name.
    pub fn named(kind: ItemKind, name: impl Into<String>) -> Self {
        Self {
            kind,
            name: name.into(),
            series: None,
            season: None,
            episode: None,
            imdb: None,
            tvg_id: None,
            account: None,
            panel_id: None,
        }
    }
}

/// A watch history entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watched {
    /// Unix seconds.
    pub first_watched_at: i64,
    /// Unix seconds.
    pub last_watched_at: i64,
    pub play_count: i64,
    pub watched_seconds: i64,
}

/// A saved place in a movie or episode.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub position: f64,
    pub duration: f64,
    /// Unix seconds.
    pub updated_at: i64,
    /// Watched to the end.
    #[serde(default)]
    pub finished: bool,
}

/// One item and what the source has saved for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    #[serde(rename = "ref")]
    pub reference: ItemRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watched: Option<Watched>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
}

/// A pinned group, in the order it's listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub account: AccountTag,
    /// "live", "movie" or "series".
    pub content_type: String,
    pub group: String,
}

/// Which parts of the history a transfer copies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct What {
    /// Watch history and playback positions, which go together.
    pub history: bool,
    pub favorites: bool,
    pub pins: bool,
}

impl What {
    pub const ALL: What = What {
        history: true,
        favorites: true,
        pins: true,
    };

    /// Asks for nothing at all.
    pub fn is_empty(self) -> bool {
        !(self.history || self.favorites || self.pins)
    }
}

/// How many of each the source has, for the preview and the dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Counts {
    pub history: u32,
    pub positions: u32,
    pub favorites: u32,
    pub pins: u32,
}

/// Everything one transfer carries.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Export {
    pub items: Vec<Item>,
    pub pins: Vec<Pin>,
    /// What the source is playing, or watched last.
    pub current: Option<ItemRef>,
    /// The source's clock when the first chunk was made, in Unix seconds.
    pub sent_at: i64,
    /// The destination's clock when the first chunk arrived. Only the
    /// receiver sets it.
    pub received_at: i64,
    /// Items and pins left out for being over the limits, on either side.
    pub dropped: u32,
}

impl Export {
    pub fn counts(&self) -> Counts {
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        Counts {
            history: count(self.items.iter().filter(|i| i.watched.is_some()).count()),
            positions: count(self.items.iter().filter(|i| i.position.is_some()).count()),
            favorites: count(self.items.iter().filter(|i| i.favorite).count()),
            pins: count(self.pins.len()),
        }
    }

    /// Keeps only the parts `what` asks for, and drops items left with
    /// nothing.
    pub fn only(mut self, what: What) -> Self {
        for item in &mut self.items {
            if !what.history {
                item.watched = None;
                item.position = None;
            }
            if !what.favorites {
                item.favorite = false;
            }
        }
        self.items
            .retain(|i| i.watched.is_some() || i.position.is_some() || i.favorite);
        if !what.pins {
            self.pins.clear();
        }
        if !what.history {
            self.current = None;
        }
        self
    }
}

#[cfg(test)]
mod tests;
