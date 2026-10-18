// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Answers a controller's catalog queries from this device's cache, and
//! loads a series' episodes from its provider.
//!
//! Every item goes through [`CatalogItem::from_channel`], which has no field
//! for a URL and drops logos that could point at a provider.

use super::target::CatalogPage;
use mvp_core::cache::store::{CacheError, CacheStore};
use mvp_core::models::channel::Channel;
use mvp_core::remote::catalog::{provider_host, CatalogItem, CatalogQuery, MAX_PAGE};
use mvp_core::remote::message::ErrorCode;
use std::sync::Mutex;

/// Answers `query` from the cache: what this device can play right now.
/// Episodes come from what [`episodes`] loaded, through [`episode_page`];
/// here they're only the ones already cached.
pub fn answer(cache: &CacheStore, query: CatalogQuery) -> CatalogPage {
    match query {
        CatalogQuery::Episodes { series_id } => {
            let episodes = cache.get_series_episodes(&series_id).map_err(failed)?;
            episode_page(cache, &episodes)
        }
        query => {
            let hosts = hosts(cache)?;
            let channels = cache.get_all_channels().map_err(failed)?;
            answer_from(&channels, &hosts, query)
        }
    }
}

/// The page that answers an episodes query with `episodes`.
pub fn episode_page(cache: &CacheStore, episodes: &[Channel]) -> CatalogPage {
    let hosts = hosts(cache)?;
    let page = episodes
        .iter()
        .take(MAX_PAGE)
        .map(|c| CatalogItem::from_channel(c, &hosts))
        .collect();
    Ok((page, None))
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
        (series, cache.get_series_episodes(series_id).map_err(failed)?)
    };
    let from_provider = series.is_some_and(|s| s.url.starts_with("xtream://series/"));
    if !from_provider {
        return Ok(cached);
    }
    match crate::commands::fetch_series_episodes(cache, series_id).await {
        Ok(loaded) if !loaded.is_empty() => Ok(loaded),
        Ok(_) => Ok(cached),
        Err(e) => {
            tracing::warn!("[remote] couldn't load the episodes of {series_id}: {e}");
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

/// The hosts of this device's providers, which no logo may point at.
fn hosts(cache: &CacheStore) -> Result<Vec<String>, ErrorCode> {
    let providers = cache.get_providers().map_err(failed)?;
    Ok(providers
        .iter()
        .flat_map(|p| [Some(p.url.as_str()), p.epg_url.as_deref()])
        .flatten()
        .filter_map(provider_host)
        .collect())
}

/// The answer from a list of channels, in the order the cache gives them.
pub(crate) fn answer_from(
    channels: &[Channel],
    hosts: &[String],
    query: CatalogQuery,
) -> CatalogPage {
    let limit = |limit: u32| (limit as usize).clamp(1, MAX_PAGE);
    match query {
        CatalogQuery::Groups { content_type } => {
            let mut groups: Vec<&str> = channels
                .iter()
                .filter(|c| c.content_type == content_type)
                .map(|c| c.group_title.as_str())
                .collect();
            groups.sort_by_cached_key(|g| (g.to_lowercase(), g.to_string()));
            groups.dedup();
            // A group goes out as an item whose id and name are the group's
            // name, which `items` takes back.
            let page = groups
                .into_iter()
                .take(MAX_PAGE)
                .map(|g| CatalogItem {
                    id: g.to_owned(),
                    name: g.to_owned(),
                    content_type: content_type.clone(),
                    group: g.to_owned(),
                    ..CatalogItem::default()
                })
                .collect();
            Ok((page, None))
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
                .map(|c| CatalogItem::from_channel(c, hosts))
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
                .map(|c| CatalogItem::from_channel(c, hosts))
                .collect();
            Ok((page, None))
        }
        CatalogQuery::Episodes { .. } => Err(ErrorCode::Unsupported),
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
