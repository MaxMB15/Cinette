// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Channels and the playlist groups they belong to.

use serde::{Deserialize, Serialize};

/// A playable entry from a playlist, which may be a live channel, a movie or a
/// series episode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub url: String,
    pub logo_url: Option<String>,
    pub group_title: String,
    pub tvg_id: Option<String>,
    pub tvg_name: Option<String>,
    pub is_favorite: bool,
    /// Classified content type: "live", "movie", or "series"
    pub content_type: String,
    /// Alternative stream URLs for the same content (different servers/quality).
    /// Empty for channels that are unique. Used for movie/series deduplication.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Parsed show title for series content (e.g. "Breaking Bad" from "Breaking Bad S01E03").
    #[serde(default)]
    pub series_title: Option<String>,
    /// Season number parsed from the episode name (e.g. 1 from S01E03).
    #[serde(default)]
    pub season: Option<u32>,
    /// Episode number parsed from the episode name (e.g. 3 from S01E03).
    #[serde(default)]
    pub episode: Option<u32>,
}

/// A playlist group and how many channels it holds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub channel_count: usize,
}

impl Category {
    /// Counts the channels in each group, sorted by name. The ids follow hash
    /// order, so they are only unique within one call and must not be stored.
    pub fn from_channels(channels: &[Channel]) -> Vec<Category> {
        let mut map = std::collections::HashMap::<String, usize>::new();
        for ch in channels {
            *map.entry(ch.group_title.clone()).or_default() += 1;
        }
        let mut cats: Vec<Category> = map
            .into_iter()
            .enumerate()
            .map(|(i, (name, count))| Category {
                id: format!("cat-{i}"),
                name,
                channel_count: count,
            })
            .collect();
        cats.sort_by(|a, b| a.name.cmp(&b.name));
        cats
    }
}
