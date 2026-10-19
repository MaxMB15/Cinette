// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Answers a controller's catalog queries from this device's cache, and
//! loads a series' episodes from its provider.
//!
//! Every item goes through [`item`], which has no field for a URL and drops
//! logos that could point at a provider.

use super::logos::on_a_provider_site;
use super::target::CatalogPage;
use mvp_core::cache::store::{CacheError, CacheStore};
use mvp_core::models::channel::Channel;
use mvp_core::remote::catalog::{
    group_page, provider_host, CatalogItem, CatalogQuery, MAX_PAGE,
};
use mvp_core::remote::message::ErrorCode;
use std::sync::Mutex;

/// Answers `query` from the cache: what this device can play right now.
/// Episodes come from what [`episodes`] loaded, through [`episode_page`];
/// here they're only the ones already cached.
pub fn answer(cache: &CacheStore, query: CatalogQuery) -> CatalogPage {
    match query {
        CatalogQuery::Episodes {
            series_id,
            cursor,
            limit,
        } => {
            let episodes = cache.get_series_episodes(&series_id).map_err(failed)?;
            episode_page(cache, &episodes, cursor, limit)
        }
        query => {
            let channels = cache.get_all_channels().map_err(failed)?;
            let hosts = hosts(cache, &channels)?;
            answer_from(&channels, &hosts, query)
        }
    }
}

/// The page of `episodes` from `cursor`, the id of its first episode.
pub fn episode_page(
    cache: &CacheStore,
    episodes: &[Channel],
    cursor: Option<String>,
    limit: u32,
) -> CatalogPage {
    let hosts = hosts(cache, episodes)?;
    let start = match cursor {
        None => 0,
        Some(id) => episodes
            .iter()
            .position(|e| e.id == id)
            .ok_or(ErrorCode::NotFound)?,
    };
    let end = (start + page_size(limit)).min(episodes.len());
    let page = episodes[start..end]
        .iter()
        .map(|c| item(c, &hosts))
        .collect();
    let next = episodes.get(end).map(|e| e.id.clone());
    Ok((page, next))
}

/// The episodes of `series_id`, loaded the way the series list loads them
/// when the series is opened: an Xtream series from its provider, with the
/// cached ones when that fails or finds none, anything else from the cache.
pub async fn episodes(
    cache: &Mutex<CacheStore>,
    series_id: &str,
) -> Result<Vec<Channel>, ErrorCode> {
    let (series, cached) = {
        let cache = cache.lock().map_err(|_| ErrorCode::Failed)?;
        let series = cache.get_channel_by_id(series_id).map_err(failed)?;
        (
            series,
            cache.get_series_episodes(series_id).map_err(failed)?,
        )
    };
    // A downloaded series can keep its episodes after its channel went.
    let Some(series) = series else {
        return if cached.is_empty() {
            Err(ErrorCode::NotFound)
        } else {
            Ok(cached)
        };
    };
    if !series.url.starts_with("xtream://series/") {
        return Ok(cached);
    }
    match crate::commands::fetch_series_episodes(cache, series_id).await {
        Ok(loaded) if !loaded.is_empty() => Ok(loaded),
        Ok(_) => Ok(cached),
        Err(e) => {
            // The id came from the controller, so it's quoted.
            tracing::warn!("[remote] couldn't load the episodes of {series_id:?}: {e}");
            if cached.is_empty() {
                Err(ErrorCode::Failed)
            } else {
                Ok(cached)
            }
        }
    }
}

fn failed(e: CacheError) -> ErrorCode {
    tracing::warn!("[remote] catalog query failed: {e}");
    ErrorCode::Failed
}

/// A limit kept between one and a page.
fn page_size(limit: u32) -> usize {
    (limit as usize).clamp(1, MAX_PAGE)
}

/// The hosts no logo may be on: those of this device's providers, their
/// guides, and every stream in `channels`. A provider often keeps its logos
/// next to its streams, on a host its playlist's address doesn't name.
pub(crate) fn hosts(cache: &CacheStore, channels: &[Channel]) -> Result<Vec<String>, ErrorCode> {
    let providers = cache.get_providers().map_err(failed)?;
    let servers = providers
        .iter()
        .flat_map(|p| [Some(p.url.as_str()), p.epg_url.as_deref()])
        .flatten();
    let streams = channels
        .iter()
        .flat_map(|c| std::iter::once(c.url.as_str()).chain(c.sources.iter().map(String::as_str)));
    let mut hosts: Vec<String> = servers.chain(streams).filter_map(provider_host).collect();
    hosts.sort_unstable();
    hosts.dedup();
    Ok(hosts)
}

/// `channel` as a controller sees it. The core drops a logo on one of
/// `hosts`; this also drops one elsewhere on the same site, such as
/// `logos.panel.example` next to `panel.example`.
pub(crate) fn item(channel: &Channel, hosts: &[String]) -> CatalogItem {
    let mut item = CatalogItem::from_channel(channel, hosts);
    if item
        .logo
        .as_deref()
        .is_some_and(|logo| on_a_provider_site(logo, hosts))
    {
        item.logo = None;
    }
    item
}

/// The answer from a list of channels, in the order the cache gives them.
pub(crate) fn answer_from(
    channels: &[Channel],
    hosts: &[String],
    query: CatalogQuery,
) -> CatalogPage {
    let limit = page_size;
    match query {
        CatalogQuery::Groups {
            content_type,
            cursor,
            limit: wanted,
        } => {
            let names = channels
                .iter()
                .filter(|c| c.content_type == content_type)
                .map(|c| c.group_title.as_str());
            Ok(group_page(
                names,
                &content_type,
                cursor.as_deref(),
                limit(wanted),
            ))
        }
        CatalogQuery::Items {
            content_type,
            group,
            cursor,
            limit: wanted,
        } => {
            let in_group: Vec<&Channel> = channels
                .iter()
                .filter(|c| c.content_type == content_type && c.group_title == group)
                .collect();
            let start = match cursor {
                None => 0,
                Some(id) => in_group
                    .iter()
                    .position(|c| c.id == id)
                    .ok_or(ErrorCode::NotFound)?,
            };
            let end = (start + limit(wanted)).min(in_group.len());
            let page = in_group[start..end]
                .iter()
                .map(|c| item(c, hosts))
                .collect();
            let next = in_group.get(end).map(|c| c.id.clone());
            Ok((page, next))
        }
        CatalogQuery::Search {
            query,
            content_type,
            limit: wanted,
        } => {
            // The same match as the channel list's search box.
            let query = query.to_lowercase();
            let page = channels
                .iter()
                .filter(|c| content_type.as_ref().is_none_or(|t| c.content_type == *t))
                .filter(|c| c.name.to_lowercase().contains(&query))
                .take(limit(wanted))
                .map(|c| item(c, hosts))
                .collect();
            Ok((page, None))
        }
        CatalogQuery::Episodes { .. } => Err(ErrorCode::Unsupported),
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
