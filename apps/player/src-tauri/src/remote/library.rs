// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The library calls of `mvp_core::remote::library` on both sides.
//!
//! As a target, [`answer`] runs a controller's call through the same
//! command this device's own screens use, and takes out what may not leave
//! it: stream URLs, logins, provider servers, and logos on a provider's
//! site. As a controller, [`checked`] goes over an answer before the
//! webview sees it, since the other device is trusted with nothing.

use super::catalog::{hosts, read, shareable};
use super::logos::fetchable;
use crate::commands::{self, AppState, EpgSearchResultDto, WatchHistoryEntryDto};
use mvp_core::iptv::omdb::OmdbData;
use mvp_core::iptv::whatson::WhatsonData;
use mvp_core::models::channel::Channel;
use mvp_core::models::playlist::Provider;
use mvp_core::remote::library::LibraryCall;
use mvp_core::remote::message::ErrorCode;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::future::Future;
use tauri::{AppHandle, Manager, Runtime};

/// The start of an Xtream series' URL, which is all of it that goes out.
/// The channel list opens such a series by loading its episodes.
pub const SERIES_URL: &str = "xtream://series/";

/// What a controller puts in place of the URL of something on the other
/// device, followed by its id, so a play can name it.
pub const REMOTE_URL: &str = "cinette-remote:";

/// The JSON answer to `call`, from this device's library. `episodes` loads
/// a series' episodes, the way the catalog does, so they can be played.
/// This blocks, so it runs on a blocking thread.
pub fn answer<R: Runtime>(
    app: &AppHandle<R>,
    call: LibraryCall,
    episodes: impl FnOnce(&str) -> Result<Vec<Channel>, ErrorCode>,
) -> Result<Vec<u8>, ErrorCode> {
    let state = || app.state::<AppState>();
    match call {
        LibraryCall::Channels => {
            let (channels, providers) =
                read(&state().cache, |c| Ok((c.get_all_channels()?, c.get_providers()?)))?;
            let hosts = hosts(&providers, &channels);
            json(&shared_channels(channels, &hosts))
        }
        LibraryCall::Providers => {
            let providers = run(commands::get_providers(state()))?;
            json(&providers.into_iter().map(shared_provider).collect::<Vec<_>>())
        }
        LibraryCall::GroupHierarchy {
            provider_id,
            content_type,
        } => json(&run(commands::get_group_hierarchy(
            state(),
            provider_id,
            content_type,
        ))?),
        LibraryCall::PinnedGroups {
            provider_id,
            content_type,
        } => json(&run(commands::get_pinned_groups(
            state(),
            provider_id,
            content_type,
        ))?),
        LibraryCall::Guide { from, to, ids } => json(&run(commands::get_epg_for_live_channels(
            state(),
            from,
            to,
            ids,
        ))?),
        LibraryCall::Schedule { epg_id, from, to } => {
            json(&run(commands::get_epg_programmes(state(), epg_id, from, to))?)
        }
        LibraryCall::GuideSearch { query, from } => {
            let mut results = run(commands::search_epg_programmes(state(), query, from))?;
            let hosts = all_hosts(app)?;
            for result in &mut results {
                result.channel_logo_url = shared_logo(result.channel_logo_url.take(), &hosts);
            }
            json(&results)
        }
        LibraryCall::History {
            limit,
            content_type,
        } => {
            let mut entries = run(commands::get_watch_history(
                state(),
                i64::from(limit),
                content_type,
            ))?;
            let hosts = all_hosts(app)?;
            for entry in &mut entries {
                entry.channel_logo = shared_logo(entry.channel_logo.take(), &hosts);
            }
            json(&entries)
        }
        LibraryCall::SeriesEpisodes { series_id } => {
            let episodes = episodes(&series_id)?;
            let providers = read(&state().cache, |c| c.get_providers())?;
            let hosts = hosts(&providers, &episodes);
            json(&shared_channels(episodes, &hosts))
        }
        LibraryCall::Omdb { id, title, kind } => json(&run(commands::fetch_omdb_data(
            app.clone(),
            state(),
            id,
            title,
            kind,
        ))?),
        LibraryCall::Whatson { imdb_id, kind } => json(&run(commands::fetch_whatson_data(
            app.clone(),
            state(),
            imdb_id,
            kind,
        ))?),
        LibraryCall::ToggleFavorite { id } => {
            json(&run(commands::toggle_favorite(state(), id))?)
        }
        LibraryCall::PinGroup {
            provider_id,
            content_type,
            group,
            order,
        } => json(&run(commands::pin_group(
            state(),
            provider_id,
            content_type,
            group,
            order,
        ))?),
        LibraryCall::UnpinGroup {
            provider_id,
            content_type,
            group,
        } => json(&run(commands::unpin_group(
            state(),
            provider_id,
            content_type,
            group,
        ))?),
        LibraryCall::DeleteHistory { channel_id } => {
            json(&run(commands::delete_history_entry(state(), channel_id))?)
        }
        LibraryCall::DeleteHistorySeries { series_title } => {
            json(&run(commands::delete_history_series(state(), series_title))?)
        }
        LibraryCall::ClearHistory {
            content_type: Some(content_type),
        } => json(&run(commands::clear_watch_history_of_type(
            state(),
            content_type,
        ))?),
        LibraryCall::ClearHistory { content_type: None } => {
            json(&run(commands::clear_watch_history(state()))?)
        }
    }
}

/// Runs a command to its end on this blocking thread.
fn run<T>(command: impl Future<Output = Result<T, String>>) -> Result<T, ErrorCode> {
    tokio::runtime::Handle::current()
        .block_on(command)
        .map_err(|e| {
            tracing::warn!("[remote] a library call failed: {e}");
            ErrorCode::Failed
        })
}

fn json(value: &impl Serialize) -> Result<Vec<u8>, ErrorCode> {
    serde_json::to_vec(value).map_err(|_| ErrorCode::Failed)
}

/// The hosts no logo may be on, from every provider and channel.
fn all_hosts<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, ErrorCode> {
    let (channels, providers) = read(&app.state::<AppState>().cache, |c| {
        Ok((c.get_all_channels()?, c.get_providers()?))
    })?;
    Ok(hosts(&providers, &channels))
}

fn shared_logo(logo: Option<String>, hosts: &[String]) -> Option<String> {
    logo.filter(|logo| shareable(logo, hosts))
}

/// Channels as a controller gets them: no stream URL but the start of an
/// Xtream series', no other sources, and a logo only if it's
/// [`shareable`].
fn shared_channels(channels: Vec<Channel>, hosts: &[String]) -> Vec<Channel> {
    channels
        .into_iter()
        .map(|channel| Channel {
            url: if channel.url.starts_with(SERIES_URL) {
                SERIES_URL.to_owned()
            } else {
                String::new()
            },
            sources: Vec::new(),
            logo_url: shared_logo(channel.logo_url, hosts),
            ..channel
        })
        .collect()
}

/// A provider as a controller gets it: its name and counts, with no server,
/// login or guide address.
fn shared_provider(provider: Provider) -> Provider {
    Provider {
        url: String::new(),
        username: None,
        password: None,
        epg_url: None,
        ..provider
    }
}

/// The answer to `call`, which the other device sent, made safe for this
/// device's webview. Every channel gets a URL that names it on that device
/// and no other sources, and an image is kept only if [`fetchable`].
pub fn checked(call: &LibraryCall, json: Vec<u8>) -> Result<Vec<u8>, ErrorCode> {
    match call {
        LibraryCall::Channels | LibraryCall::SeriesEpisodes { .. } => {
            recheck::<Vec<Channel>, _>(&json, |channel| {
                channel.url = if channel.url == SERIES_URL {
                    SERIES_URL.to_owned()
                } else {
                    format!("{REMOTE_URL}{}", channel.id)
                };
                channel.sources.clear();
                keep_fetchable(&mut channel.logo_url);
            })
        }
        LibraryCall::History { .. } => {
            recheck::<Vec<WatchHistoryEntryDto>, _>(&json, |e| keep_fetchable(&mut e.channel_logo))
        }
        LibraryCall::GuideSearch { .. } => recheck::<Vec<EpgSearchResultDto>, _>(&json, |r| {
            keep_fetchable(&mut r.channel_logo_url)
        }),
        LibraryCall::Omdb { .. } => {
            recheck::<Option<OmdbData>, _>(&json, |d| keep_fetchable(&mut d.poster_url))
        }
        LibraryCall::Whatson { .. } => {
            recheck::<Option<WhatsonData>, _>(&json, |d| keep_fetchable(&mut d.image))
        }
        // Nothing else holds anything the webview would load.
        _ => Ok(json),
    }
}

/// `json` read as a `C`, with `check` run on each of its items.
fn recheck<C, T>(json: &[u8], check: impl FnMut(&mut T)) -> Result<Vec<u8>, ErrorCode>
where
    C: DeserializeOwned + Serialize,
    for<'a> &'a mut C: IntoIterator<Item = &'a mut T>,
{
    let mut answer: C = serde_json::from_slice(json).map_err(|_| ErrorCode::Invalid)?;
    (&mut answer).into_iter().for_each(check);
    serde_json::to_vec(&answer).map_err(|_| ErrorCode::Failed)
}

fn keep_fetchable(image: &mut Option<String>) {
    image.take_if(|image| !fetchable(image));
}

#[cfg(test)]
#[path = "library_tests.rs"]
mod tests;
