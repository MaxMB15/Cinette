// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The target's channels as a controller sees them: names, groups and ids,
//! but never a stream URL, a provider or a login.

use crate::models::channel::Channel;
use serde::{Deserialize, Serialize};

/// The most items in one catalog page.
pub const MAX_PAGE: usize = 100;
/// The longest search text a target takes, in characters.
pub const MAX_QUERY_CHARS: usize = 200;
/// The longest id or cursor a target takes, in bytes.
pub const MAX_ID_BYTES: usize = 256;

/// One channel, movie, series or episode in the target's catalog.
///
/// There's no field for a URL. The `id` is the target's own channel id,
/// which only means something on the target.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    /// "live", "movie" or "series".
    pub content_type: String,
    pub group: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<u32>,
    /// What's on now, for a live channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now_playing: Option<String>,
}

impl CatalogItem {
    /// The item for one of the target's channels. `provider_hosts` are the
    /// hosts of every provider's server, since a logo there could tell a
    /// controller where the target's subscription is.
    pub fn from_channel(channel: &Channel, provider_hosts: &[String]) -> Self {
        Self {
            id: channel.id.clone(),
            name: channel.name.clone(),
            content_type: channel.content_type.clone(),
            group: channel.group_title.clone(),
            logo: channel
                .logo_url
                .as_deref()
                .filter(|logo| shareable_logo(logo, provider_hosts))
                .map(str::to_owned),
            series_title: channel.series_title.clone(),
            season: channel.season,
            episode: channel.episode,
            now_playing: None,
        }
    }
}

/// Whether a logo URL can go to another device: plain http or https, with no
/// login, no query, no fragment, and not on a provider's server. Anything
/// else could carry a token or point at the subscription.
pub fn shareable_logo(logo: &str, provider_hosts: &[String]) -> bool {
    let Ok(url) = url::Url::parse(logo) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && !provider_hosts
            .iter()
            .any(|provider| provider.eq_ignore_ascii_case(host))
}

/// The host of a provider's server URL, for [`CatalogItem::from_channel`].
pub fn provider_host(server: &str) -> Option<String> {
    url::Url::parse(server)
        .ok()?
        .host_str()
        .map(|host| host.to_ascii_lowercase())
}

/// A catalog request from a controller.
///
/// A paged query sends `cursor` back as the `next` of the page before, or
/// leaves it out for the first page. A page can hold fewer than `limit`
/// items and still have a `next`, since it also has to fit in one frame,
/// so only a missing `next` ends the list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CatalogQuery {
    /// The groups of one content type, a page at a time, in name order
    /// (see [`group_page`]). Each group goes out as an item whose id, name
    /// and group are all the group's name, which `Items` takes back. A
    /// group whose name fails [`group_ok`] is left out, since neither
    /// query could name it.
    Groups {
        content_type: String,
        /// The name of the first group on the page. A group that's gone
        /// since starts the page at the next one in name order.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
        /// The most items on the page. A missing one means [`MAX_PAGE`].
        #[serde(default = "max_page")]
        limit: u32,
    },
    /// The items in one group, a page at a time, in the target's order.
    Items {
        content_type: String,
        group: String,
        /// The id of the first item on the page.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
        /// The most items on the page. A missing one means [`MAX_PAGE`].
        #[serde(default = "max_page")]
        limit: u32,
    },
    /// Items whose name has `query` in it, one page with no `next`.
    Search {
        query: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
        /// The most items on the page. A missing one means [`MAX_PAGE`].
        #[serde(default = "max_page")]
        limit: u32,
    },
    /// The episodes of a series, a page at a time, in the target's order.
    Episodes {
        series_id: String,
        /// The id of the first episode on the page.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
        /// The most items on the page. A missing one means [`MAX_PAGE`].
        #[serde(default = "max_page")]
        limit: u32,
    },
}

const fn max_page() -> u32 {
    MAX_PAGE as u32
}

/// Whether a group can go to a controller: one whose name is longer than
/// [`MAX_ID_BYTES`] couldn't come back as a cursor or an `Items` group.
pub fn group_ok(name: &str) -> bool {
    name.len() <= MAX_ID_BYTES
}

/// The order groups go out in: by name ignoring case, then by name, so
/// names that differ only in case keep one order.
fn group_key(name: &str) -> (String, &str) {
    (name.to_lowercase(), name)
}

/// One page of the groups `names`, for a `Groups` query: the distinct names
/// that pass [`group_ok`], in name order, from the first one at or after
/// `cursor`, with the name after the page as `next`. A cursor naming a
/// group that's gone starts at the one after where it was, so paging goes
/// on without repeating a group.
pub fn group_page<'a>(
    names: impl IntoIterator<Item = &'a str>,
    content_type: &str,
    cursor: Option<&str>,
    limit: usize,
) -> (Vec<CatalogItem>, Option<String>) {
    let mut groups: Vec<&str> = names.into_iter().filter(|g| group_ok(g)).collect();
    groups.sort_by_cached_key(|g| group_key(g));
    groups.dedup();
    let start = cursor.map_or(0, |c| {
        let key = group_key(c);
        groups.partition_point(|g| group_key(g) < key)
    });
    let end = (start + limit).min(groups.len());
    let page = groups[start..end]
        .iter()
        .map(|&g| CatalogItem {
            id: g.to_owned(),
            name: g.to_owned(),
            content_type: content_type.to_owned(),
            group: g.to_owned(),
            ..CatalogItem::default()
        })
        .collect();
    (page, groups.get(end).map(|g| (*g).to_owned()))
}

impl CatalogQuery {
    /// Whether the query is one a target should run. A limit above
    /// [`MAX_PAGE`] is lowered rather than refused.
    pub fn validate(mut self) -> Option<Self> {
        let content_type_ok = |t: &str| matches!(t, "live" | "movie" | "series");
        let id_ok = |s: &str| !s.is_empty() && s.len() <= MAX_ID_BYTES;
        match &mut self {
            CatalogQuery::Groups {
                content_type,
                cursor,
                limit,
            } => {
                *limit = (*limit).clamp(1, MAX_PAGE as u32);
                // A group's name can be empty, so its cursor can be too.
                (content_type_ok(content_type) && cursor.as_deref().is_none_or(group_ok))
                    .then_some(())
            }
            CatalogQuery::Items {
                content_type,
                group,
                cursor,
                limit,
            } => {
                *limit = (*limit).clamp(1, MAX_PAGE as u32);
                (content_type_ok(content_type)
                    && group_ok(group)
                    && cursor.as_deref().is_none_or(id_ok))
                .then_some(())
            }
            CatalogQuery::Search {
                query,
                content_type,
                limit,
            } => {
                *limit = (*limit).clamp(1, MAX_PAGE as u32);
                (!query.trim().is_empty()
                    && query.chars().count() <= MAX_QUERY_CHARS
                    && content_type.as_deref().is_none_or(content_type_ok))
                .then_some(())
            }
            CatalogQuery::Episodes {
                series_id,
                cursor,
                limit,
            } => {
                *limit = (*limit).clamp(1, MAX_PAGE as u32);
                (id_ok(series_id) && cursor.as_deref().is_none_or(id_ok)).then_some(())
            }
        }?;
        Some(self)
    }
}

#[cfg(test)]
mod tests;
