// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::downloads::manager::{self, DownloadManager};
use mvp_core::cache::store::{
    CacheStore, GroupHierarchyEntry, PinnedGroup, PlaybackPosition, WatchHistoryEntry,
};
use mvp_core::downloads::model::{DownloadKind, DownloadRecord};
use mvp_core::iptv::m3u::{fetch_and_parse_m3u_with_epg, parse_m3u_file};
use mvp_core::iptv::mdblist::MdbListData;
use mvp_core::iptv::omdb::{fetch_omdb, OmdbData};
use mvp_core::iptv::whatson::WhatsonData;
use mvp_core::iptv::xtream::{fetch_xtream_channels, fetch_xtream_series_episodes, get_xtream_epg_url};
use mvp_core::models::channel::Channel;
use mvp_core::models::playlist::{Provider, ProviderType};
use std::sync::Mutex;
use serde::Serialize;
use tauri::{command, AppHandle, Manager, Runtime, State};
use tauri_plugin_store::StoreExt;

pub struct AppState {
    pub cache: Mutex<CacheStore>,
}

fn prefix_channel_ids(provider_id: &str, channels: &mut [Channel]) {
    for ch in channels.iter_mut() {
        ch.id = format!("{provider_id}-{}", ch.id);
    }
}

#[command]
pub async fn load_m3u_playlist(
    state: State<'_, AppState>,
    name: String,
    url: String,
) -> Result<Vec<Channel>, String> {
    tracing::info!("[IPTV] loading M3U playlist name={:?} url={}", name, url);
    let playlist = fetch_and_parse_m3u_with_epg(&url)
        .await
        .map_err(|e| {
            tracing::error!("[IPTV] M3U fetch/parse failed: {e}");
            format!("Failed to load playlist: {e}")
        })?;
    let mut channels = playlist.channels;
    let epg_url = playlist.epg_url;
    tracing::info!("[IPTV] parsed {} channels from M3U URL", channels.len());

    let provider_id = format!("m3u-{}", uuid_simple());
    prefix_channel_ids(&provider_id, &mut channels);

    let provider = Provider {
        id: provider_id.clone(),
        name,
        provider_type: ProviderType::M3u,
        url,
        username: None,
        password: None,
        last_updated: Some(now_rfc3339()),
        channel_count: channels.len(),
        epg_url,
    };

    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.upsert_provider(&provider).map_err(|e| {
        tracing::error!("[IPTV] failed to save provider: {e}");
        e.to_string()
    })?;
    cache.save_channels(&provider_id, &channels).map_err(|e| {
        tracing::error!("[IPTV] failed to save channels: {e}");
        e.to_string()
    })?;
    tracing::info!("[IPTV] saved provider={} with {} channels", provider_id, channels.len());

    Ok(channels)
}

/// Load an M3U file from a local filesystem path (streaming, low memory).
#[command]
pub async fn load_m3u_file(
    state: State<'_, AppState>,
    name: String,
    path: String,
) -> Result<Vec<Channel>, String> {
    tracing::info!("[IPTV] loading M3U from file path={:?} name={:?}", path, name);

    let file_path = std::path::PathBuf::from(&path);
    let mut channels = tokio::task::spawn_blocking(move || parse_m3u_file(&file_path))
        .await
        .map_err(|e| format!("task error: {e}"))?
        .map_err(|e| {
            tracing::error!("[IPTV] M3U file parse failed: {e}");
            format!("Failed to parse playlist: {e}")
        })?;
    tracing::info!("[IPTV] parsed {} channels from file", channels.len());

    let provider_id = format!("m3u-{}", uuid_simple());
    prefix_channel_ids(&provider_id, &mut channels);

    let provider = Provider {
        id: provider_id.clone(),
        name,
        provider_type: ProviderType::M3u,
        url: format!("file://{path}"),
        username: None,
        password: None,
        last_updated: Some(now_rfc3339()),
        channel_count: channels.len(),
        epg_url: None,
    };

    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.upsert_provider(&provider).map_err(|e| {
        tracing::error!("[IPTV] failed to save provider: {e}");
        e.to_string()
    })?;
    cache.save_channels(&provider_id, &channels).map_err(|e| {
        tracing::error!("[IPTV] failed to save channels: {e}");
        e.to_string()
    })?;
    tracing::info!("[IPTV] saved file provider={} with {} channels", provider_id, channels.len());

    Ok(channels)
}

#[command]
pub async fn load_xtream_provider(
    state: State<'_, AppState>,
    name: String,
    url: String,
    username: String,
    password: String,
) -> Result<Vec<Channel>, String> {
    tracing::info!("[IPTV] loading Xtream provider name={:?} url={}", name, url);
    let mut channels = fetch_xtream_channels(&url, &username, &password)
        .await
        .map_err(|e| {
            tracing::error!("[IPTV] Xtream connect failed: {e}");
            format!("Failed to connect: {e}")
        })?;
    tracing::info!("[IPTV] fetched {} channels from Xtream", channels.len());

    let provider_id = format!("xt-{}", uuid_simple());
    prefix_channel_ids(&provider_id, &mut channels);

    let epg_url = Some(get_xtream_epg_url(&url, &username, &password));
    let provider = Provider {
        id: provider_id.clone(),
        name,
        provider_type: ProviderType::Xtream,
        url,
        username: Some(username),
        password: Some(password),
        last_updated: Some(now_rfc3339()),
        channel_count: channels.len(),
        epg_url,
    };

    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.upsert_provider(&provider).map_err(|e| e.to_string())?;
    cache.save_channels(&provider_id, &channels).map_err(|e| e.to_string())?;
    tracing::info!("[IPTV] saved Xtream provider={} with {} channels", provider_id, channels.len());

    Ok(channels)
}

#[command]
pub async fn get_providers(state: State<'_, AppState>) -> Result<Vec<Provider>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    let providers = cache.get_providers().map_err(|e| e.to_string())?;
    tracing::debug!("[IPTV] get_providers -> {} providers", providers.len());
    Ok(providers)
}

#[command]
pub async fn remove_provider(state: State<'_, AppState>, id: String) -> Result<(), String> {
    tracing::info!("[IPTV] removing provider id={}", id);
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.remove_provider(&id).map_err(|e| e.to_string())
}

#[command]
pub async fn get_all_channels(state: State<'_, AppState>) -> Result<Vec<Channel>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    let channels = cache.get_all_channels().map_err(|e| e.to_string())?;
    tracing::debug!("[IPTV] get_all_channels -> {} channels", channels.len());
    Ok(channels)
}

#[command]
pub async fn toggle_favorite(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<bool, String> {
    tracing::info!("[IPTV] toggle_favorite channel_id={}", channel_id);
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .toggle_favorite(&channel_id)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn refresh_provider(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    tracing::info!("[IPTV] refreshing provider id={}", id);

    let provider = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        cache.get_provider(&id).map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Provider not found: {id}"))?
    };

    let (mut channels, refreshed_epg_url) = match provider.provider_type {
        ProviderType::M3u => {
            if provider.url.starts_with("file://") {
                let path = provider.url.trim_start_matches("file://").to_string();
                let pb = std::path::PathBuf::from(path);
                let ch = tokio::task::spawn_blocking(move || parse_m3u_file(&pb))
                    .await
                    .map_err(|e| format!("task error: {e}"))?
                    .map_err(|e| format!("Failed to parse file: {e}"))?;
                (ch, None)
            } else {
                let playlist = fetch_and_parse_m3u_with_epg(&provider.url)
                    .await
                    .map_err(|e| format!("Failed to fetch: {e}"))?;
                (playlist.channels, playlist.epg_url)
            }
        }
        ProviderType::Xtream => {
            let username = provider.username.clone().unwrap_or_default();
            let password = provider.password.clone().unwrap_or_default();
            let ch = fetch_xtream_channels(&provider.url, &username, &password)
                .await
                .map_err(|e| format!("Failed to connect: {e}"))?;
            let epg = Some(get_xtream_epg_url(&provider.url, &username, &password));
            (ch, epg)
        }
    };

    prefix_channel_ids(&id, &mut channels);

    let mut updated = provider;
    updated.last_updated = Some(now_rfc3339());
    updated.channel_count = channels.len();
    if refreshed_epg_url.is_some() {
        updated.epg_url = refreshed_epg_url.clone();
    }

    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.save_channels(&id, &channels).map_err(|e| e.to_string())?;
    cache.upsert_provider(&updated).map_err(|e| e.to_string())?;
    tracing::info!("[IPTV] refreshed provider={} with {} channels", id, channels.len());

    Ok(())
}

#[command]
pub async fn update_provider(
    state: State<'_, AppState>,
    id: String,
    name: String,
    url: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    tracing::info!("[IPTV] updating provider id={} name={:?}", id, name);
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .update_provider_credentials(&id, &name, &url, username.as_deref(), password.as_deref())
        .map_err(|e| e.to_string())
}

/// Lazy-fetch episodes for an Xtream series when the user opens its drawer.
/// The channel URL encodes the series_id as "xtream://series/{series_id}".
#[command]
pub async fn get_xtream_series_episodes(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<Vec<Channel>, String> {
    let (channel, provider) = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        let ch = cache
            .get_channel_by_id(&channel_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Channel not found: {channel_id}"))?;
        let p = cache
            .get_provider_for_channel(&channel_id)
            .map_err(|e| e.to_string())?
            .ok_or("Provider not found for channel")?;
        (ch, p)
    };

    if !matches!(provider.provider_type, ProviderType::Xtream) {
        return Err("Not an Xtream provider".to_string());
    }

    let series_id: u64 = channel
        .url
        .strip_prefix("xtream://series/")
        .ok_or("Invalid Xtream series URL")?
        .parse()
        .map_err(|e| format!("Invalid series ID: {e}"))?;

    let username = provider.username.as_deref().unwrap_or("");
    let password = provider.password.as_deref().unwrap_or("");

    let mut episodes = fetch_xtream_series_episodes(
        &provider.url,
        username,
        password,
        series_id,
        &channel.name,
        channel.logo_url.as_deref(),
        &channel.group_title,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Prefix episode IDs with the provider ID to match the app-wide convention.
    let provider_id = &provider.id;
    for ep in &mut episodes {
        ep.id = format!("{provider_id}-{}", ep.id);
    }

    tracing::info!(
        "[Xtream] fetched {} episodes for series_id={} (channel={})",
        episodes.len(),
        series_id,
        channel_id
    );

    Ok(episodes)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgProgramDto {
    pub channel_id: String,
    pub title: String,
    pub description: Option<String>,
    pub start_time: i64,
    pub end_time: i64,
    pub category: Option<String>,
}

/// Fetch and store EPG programmes for a provider from its configured EPG URL.
#[command]
pub async fn refresh_epg(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), String> {
    use mvp_core::iptv::epg::{fetch_and_parse_epg, epg_data_to_stored};

    let epg_url = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        let providers = cache.get_providers().map_err(|e| e.to_string())?;
        providers
            .into_iter()
            .find(|p| p.id == provider_id)
            .and_then(|p| p.epg_url)
    };

    let Some(url) = epg_url else {
        return Err("No EPG URL configured for this provider".into());
    };

    tracing::info!("[EPG] fetching EPG from {}", url);
    let epg_data = fetch_and_parse_epg(&url)
        .await
        .map_err(|e| format!("Failed to fetch EPG: {e}"))?;

    tracing::info!("[EPG] parsed {} programmes", epg_data.programs.len());
    let stored = epg_data_to_stored(&epg_data, &provider_id);

    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.save_epg_programmes(&provider_id, &stored)
        .map_err(|e| e.to_string())
}

/// Get EPG programmes for a channel within a Unix timestamp time range.
#[command]
pub async fn get_epg_programmes(
    state: State<'_, AppState>,
    channel_id: String,
    range_start: i64,
    range_end: i64,
) -> Result<Vec<EpgProgramDto>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    let progs = cache
        .get_epg_programmes(&channel_id, range_start, range_end)
        .map_err(|e| e.to_string())?;
    Ok(progs
        .into_iter()
        .map(|p| EpgProgramDto {
            channel_id: p.channel_id,
            title: p.title,
            description: p.description,
            start_time: p.start_time,
            end_time: p.end_time,
            category: p.category,
        })
        .collect())
}

/// Detect and return the EPG URL for a provider.
/// For Xtream providers, derives the URL from server/username/password.
/// For M3U/File providers, returns the stored epg_url (detected during load).
#[command]
pub async fn detect_epg_url(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    let provider = cache.get_provider(&id).map_err(|e| e.to_string())?;
    let Some(provider) = provider else { return Ok(None); };

    match provider.provider_type {
        ProviderType::Xtream => {
            let server = provider.url.clone();
            let username = provider.username.unwrap_or_default();
            let password = provider.password.unwrap_or_default();
            Ok(Some(get_xtream_epg_url(&server, &username, &password)))
        }
        ProviderType::M3u => {
            Ok(provider.epg_url)
        }
    }
}

/// Set EPG URL for a provider (manual override). Pass null/None to clear.
#[command]
pub async fn set_epg_url(
    state: State<'_, AppState>,
    provider_id: String,
    epg_url: Option<String>,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .set_provider_epg_url(&provider_id, epg_url.as_deref())
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgSearchResultDto {
    pub channel_id: String,
    pub title: String,
    pub description: Option<String>,
    pub start_time: i64,
    pub end_time: i64,
    pub channel_name: String,
    pub channel_logo_url: Option<String>,
}

/// Fetch all EPG programmes across all channels in a time range.
/// Returns a flat list; the frontend groups by channelId to build per-channel strips.
#[command]
pub async fn get_epg_for_live_channels(
    state: State<'_, AppState>,
    range_start: i64,
    range_end: i64,
) -> Result<Vec<EpgProgramDto>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    let progs = cache
        .get_epg_all_channels(range_start, range_end)
        .map_err(|e| e.to_string())?;
    Ok(progs
        .into_iter()
        .map(|p| EpgProgramDto {
            channel_id: p.channel_id,
            title: p.title,
            description: p.description,
            start_time: p.start_time,
            end_time: p.end_time,
            category: p.category,
        })
        .collect())
}

/// Search EPG programme titles/descriptions, joining channel info for display.
/// Only returns current and future programmes. Limited to 50 results.
#[command]
pub async fn search_epg_programmes(
    state: State<'_, AppState>,
    query: String,
    range_start: i64,
) -> Result<Vec<EpgSearchResultDto>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    let progs = cache
        .search_epg_programmes(&query, range_start)
        .map_err(|e| e.to_string())?;
    Ok(progs
        .into_iter()
        .map(|p| EpgSearchResultDto {
            channel_id: p.channel_id,
            title: p.title,
            description: p.description,
            start_time: p.start_time,
            end_time: p.end_time,
            channel_name: p.channel_name,
            channel_logo_url: p.channel_logo,
        })
        .collect())
}

// --- OMDB Commands ---

const OMDB_STORE_FILE: &str = "settings.json";
const OMDB_API_KEY: &str = "omdb_api_key";
/// 30-day TTL in seconds
const OMDB_CACHE_TTL: i64 = 30 * 24 * 60 * 60;

/// Read the OMDB API key from the persistent Tauri Store.
#[command]
pub async fn get_omdb_api_key<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    let key = store
        .get(OMDB_API_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(key)
}

/// Persist the OMDB API key in the Tauri Store.
#[command]
pub async fn set_omdb_api_key<R: Runtime>(app: AppHandle<R>, key: String) -> Result<(), String> {
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    store.set(OMDB_API_KEY, serde_json::Value::String(key));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Fetch OMDB data for a channel. Checks the DB cache first; fetches from
/// the OMDB API on cache miss or stale entry. Returns `None` if no API key
/// is configured.
#[command]
pub async fn fetch_omdb_data<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    channel_id: String,
    title: String,
    content_type: String,
) -> Result<Option<OmdbData>, String> {
    // 1. Check for a valid cached entry.
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        match cache.get_omdb_cache(&channel_id, OMDB_CACHE_TTL) {
            Ok(Some(data)) => {
                tracing::debug!("[OMDB] cache hit for channel_id={}", channel_id);
                return Ok(Some(data));
            }
            Ok(None) => {} // cache miss or stale — proceed to fetch
            Err(e) => return Err(e.to_string()),
        }
    }

    // 2. Retrieve API key — bail out silently if not set.
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    let api_key = match store.get(OMDB_API_KEY).and_then(|v| v.as_str().map(|s| s.to_string())) {
        Some(k) if !k.is_empty() => k,
        _ => {
            tracing::debug!("[OMDB] no API key configured, skipping fetch");
            return Ok(None);
        }
    };

    // 3. Fetch from OMDB.
    tracing::info!("[OMDB] fetching data for title={:?} type={}", title, content_type);
    let data = fetch_omdb(&title, &content_type, &api_key)
        .await
        .map_err(|e| {
            tracing::warn!("[OMDB] fetch failed for title={:?}: {e}", title);
            e.to_string()
        })?;

    // 4. Store in cache.
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        if let Err(e) = cache.save_omdb_cache(&channel_id, &data) {
            tracing::warn!("[OMDB] failed to save cache for channel_id={}: {e}", channel_id);
        }
    }

    Ok(Some(data))
}

// --- MDBList Commands ---

const MDBLIST_API_KEY: &str = "mdblist_api_key";
/// 7-day TTL in seconds
const MDBLIST_CACHE_TTL: i64 = 7 * 24 * 60 * 60;

#[command]
pub async fn get_mdblist_api_key<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    let key = store
        .get(MDBLIST_API_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(key)
}

#[command]
pub async fn set_mdblist_api_key<R: Runtime>(app: AppHandle<R>, key: String) -> Result<(), String> {
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    store.set(MDBLIST_API_KEY, serde_json::Value::String(key));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Test an MDBList API key directly (does not use/update cache or stored key).
/// Used by the Settings UI to validate a key before saving.
#[command]
pub async fn test_mdblist_api_key(key: String) -> Result<bool, String> {
    // Use a known IMDB ID (The Dark Knight) to validate the key
    let result = mvp_core::iptv::mdblist::fetch_mdblist("tt0468569", "movie", &key).await;
    match result {
        Ok(_) => Ok(true),
        Err(mvp_core::iptv::mdblist::MdbListError::Api(_)) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Fetch MDBList data for an IMDB ID. Checks cache first; fetches on miss.
/// Returns None if no MDBList API key is configured.
#[command]
pub async fn fetch_mdblist_data<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    imdb_id: String,
    media_type: String,
) -> Result<Option<MdbListData>, String> {
    // 1. Check cache
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        match cache.get_mdblist_cache(&imdb_id, MDBLIST_CACHE_TTL) {
            Ok(Some(data)) => {
                tracing::debug!("[MDBList] cache hit for imdb_id={}", imdb_id);
                return Ok(Some(data));
            }
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
    }

    // 2. Get API key
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    let api_key = match store.get(MDBLIST_API_KEY).and_then(|v| v.as_str().map(|s| s.to_string())) {
        Some(k) if !k.is_empty() => k,
        _ => {
            tracing::debug!("[MDBList] no API key configured, skipping fetch");
            return Ok(None);
        }
    };

    // 3. Fetch
    tracing::info!("[MDBList] fetching data for imdb_id={} type={}", imdb_id, media_type);
    let data = mvp_core::iptv::mdblist::fetch_mdblist(&imdb_id, &media_type, &api_key)
        .await
        .map_err(|e| {
            tracing::warn!("[MDBList] fetch failed for imdb_id={}: {}", imdb_id, e);
            e.to_string()
        })?;

    // 4. Cache
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        if let Err(e) = cache.save_mdblist_cache(&imdb_id, &data) {
            tracing::warn!("[MDBList] failed to save cache for imdb_id={}: {}", imdb_id, e);
        }
    }

    Ok(Some(data))
}

// --- Whatson Commands ---

/// 7-day TTL in seconds
const WHATSON_CACHE_TTL: i64 = 7 * 24 * 60 * 60;

/// Fetch whatson-api enriched ratings for an IMDB ID. Checks cache first; fetches on miss.
/// No API key required.
#[command]
pub async fn fetch_whatson_data(
    state: State<'_, AppState>,
    imdb_id: String,
    media_type: String,
) -> Result<Option<WhatsonData>, String> {
    // 1. Check cache
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        match cache.get_whatson_cache(&imdb_id, WHATSON_CACHE_TTL) {
            Ok(Some(data)) => return Ok(Some(data)),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
    }

    // 2. Fetch from whatson-api
    let item_type = if media_type == "show" || media_type == "series" { "tvshow" } else { "movie" };
    tracing::info!("[Whatson] fetching data for imdb_id={} type={}", imdb_id, item_type);
    let data = match mvp_core::iptv::whatson::fetch_whatson(&imdb_id, item_type).await {
        Ok(data) => data,
        Err(mvp_core::iptv::whatson::WhatsonError::NotFound) => {
            tracing::info!("[Whatson] no data found for imdb_id={}", imdb_id);
            return Ok(None);
        }
        Err(e) => {
            tracing::warn!("[Whatson] fetch failed for imdb_id={}: {}", imdb_id, e);
            return Err(e.to_string());
        }
    };

    // 3. Cache
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        if let Err(e) = cache.save_whatson_cache(&imdb_id, &data) {
            tracing::warn!("[Whatson] failed to save cache for imdb_id={}: {}", imdb_id, e);
        }
    }

    Ok(Some(data))
}

// --- OpenSubtitles Commands ---

const OPENSUBTITLES_API_KEY: &str = "opensubtitles_api_key";

#[command]
pub async fn get_opensubtitles_api_key<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    let key = store
        .get(OPENSUBTITLES_API_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(key)
}

#[command]
pub async fn set_opensubtitles_api_key<R: Runtime>(app: AppHandle<R>, key: String) -> Result<(), String> {
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    store.set(OPENSUBTITLES_API_KEY, serde_json::Value::String(key));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Test an OpenSubtitles API key directly (does not use/update cache or stored key).
/// Used by the Settings UI to validate a key before saving.
#[command]
pub async fn test_opensubtitles_api_key(key: String) -> Result<bool, String> {
    // Use a known IMDB ID (The Dark Knight) to validate the key
    let result = mvp_core::iptv::opensubtitles::search_subtitles("tt0468569", None, None, &key).await;
    match result {
        Ok(_) => Ok(true),
        Err(mvp_core::iptv::opensubtitles::OpenSubtitlesError::Api(_)) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

const OPENSUBTITLES_SEARCH_CACHE_TTL: i64 = 24 * 60 * 60;

/// Search subtitles for a channel. Resolves IMDB ID from OMDB cache first.
/// Returns None if no OpenSubtitles API key is configured or no OMDB data.
#[command]
pub async fn search_subtitles<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    imdb_id: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Option<mvp_core::iptv::opensubtitles::SubtitleSearchResult>, String> {
    // 1. Check search cache
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        match cache.get_opensubtitles_search_cache(&imdb_id, season, episode, OPENSUBTITLES_SEARCH_CACHE_TTL) {
            Ok(Some(data)) => {
                tracing::debug!("[OpenSubtitles] search cache hit for imdb_id={}", imdb_id);
                return Ok(Some(data));
            }
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
    }

    // 2. Get API key
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    let api_key = match store.get(OPENSUBTITLES_API_KEY).and_then(|v| v.as_str().map(|s| s.to_string())) {
        Some(k) if !k.is_empty() => k,
        _ => {
            tracing::debug!("[OpenSubtitles] no API key configured");
            return Ok(None);
        }
    };

    // 3. Search
    tracing::info!("[OpenSubtitles] searching for imdb_id={} season={:?} episode={:?}", imdb_id, season, episode);
    let result = mvp_core::iptv::opensubtitles::search_subtitles(&imdb_id, season, episode, &api_key)
        .await
        .map_err(|e| {
            tracing::warn!("[OpenSubtitles] search failed: {}", e);
            e.to_string()
        })?;

    // 4. Cache
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        if let Err(e) = cache.save_opensubtitles_search_cache(&imdb_id, season, episode, &result) {
            tracing::warn!("[OpenSubtitles] failed to save search cache: {}", e);
        }
    }

    Ok(Some(result))
}

/// Download a subtitle file by file_id. Returns the local file path.
#[command]
pub async fn download_subtitle<R: Runtime>(
    app: AppHandle<R>,
    file_id: i64,
) -> Result<String, String> {
    // Get API key
    let store = app.store(OMDB_STORE_FILE).map_err(|e| e.to_string())?;
    let api_key = match store.get(OPENSUBTITLES_API_KEY).and_then(|v| v.as_str().map(|s| s.to_string())) {
        Some(k) if !k.is_empty() => k,
        _ => return Err("No OpenSubtitles API key configured".into()),
    };

    // Get subtitle download directory
    let subtitles_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("subtitles");

    tracing::info!("[OpenSubtitles] downloading subtitle file_id={}", file_id);
    let path = mvp_core::iptv::opensubtitles::download_subtitle(file_id, &api_key, &subtitles_dir)
        .await
        .map_err(|e| {
            tracing::warn!("[OpenSubtitles] download failed: {}", e);
            e.to_string()
        })?;

    Ok(path.to_string_lossy().into_owned())
}

// --- Watch History Commands ---

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHistoryEntryDto {
    pub channel_id: String,
    pub channel_name: String,
    pub channel_logo: Option<String>,
    pub content_type: String,
    pub first_watched_at: i64,
    pub last_watched_at: i64,
    pub total_duration_seconds: i64,
    pub play_count: i64,
}

impl From<WatchHistoryEntry> for WatchHistoryEntryDto {
    fn from(e: WatchHistoryEntry) -> Self {
        Self {
            channel_id: e.channel_id,
            channel_name: e.channel_name,
            channel_logo: e.channel_logo,
            content_type: e.content_type,
            first_watched_at: e.first_watched_at,
            last_watched_at: e.last_watched_at,
            total_duration_seconds: e.total_duration_seconds,
            play_count: e.play_count,
        }
    }
}

#[command]
pub async fn record_play_start(
    state: State<'_, AppState>,
    channel_id: String,
    channel_name: String,
    channel_logo: Option<String>,
    content_type: String,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .record_play_start(&channel_id, &channel_name, channel_logo.as_deref(), &content_type)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn record_play_end(
    state: State<'_, AppState>,
    channel_id: String,
    duration_seconds: i64,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .record_play_end(&channel_id, duration_seconds)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn get_watch_history(
    state: State<'_, AppState>,
    limit: i64,
) -> Result<Vec<WatchHistoryEntryDto>, String> {
    let limit = limit.max(0) as usize;
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    let entries = cache.get_watch_history(limit).map_err(|e| e.to_string())?;
    Ok(entries.into_iter().map(WatchHistoryEntryDto::from).collect())
}

#[command]
pub async fn delete_history_entry(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .delete_history_entry(&channel_id)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn clear_watch_history(state: State<'_, AppState>) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.clear_watch_history().map_err(|e| e.to_string())
}

#[command]
pub async fn save_playback_position(
    state: State<'_, AppState>,
    content_key: String,
    position_seconds: f64,
    duration_seconds: f64,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .save_playback_position(&content_key, position_seconds, duration_seconds)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn get_playback_position(
    state: State<'_, AppState>,
    content_key: String,
) -> Result<Option<PlaybackPosition>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .get_playback_position(&content_key)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn delete_playback_position(
    state: State<'_, AppState>,
    content_key: String,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .delete_playback_position(&content_key)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn clear_all_caches(state: State<'_, AppState>) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.clear_all_caches().map_err(|e| e.to_string())
}

#[command]
pub async fn read_subtitle_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:x}")
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// --- Group Hierarchy Commands ---

#[command]
pub async fn get_group_hierarchy(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
) -> Result<Vec<GroupHierarchyEntry>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.get_group_hierarchy(&provider_id, &content_type).map_err(|e| e.to_string())
}

#[command]
pub async fn reorder_group_hierarchy_entry(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
    group_name: String,
    new_sort_order: i64,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.update_group_sort_order(&provider_id, &content_type, &group_name, new_sort_order)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn update_group_hierarchy_entry(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
    group_name: String,
    new_super_category: Option<String>,
    new_sort_order: i64,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.save_group_hierarchy(
        &provider_id, &content_type, &group_name,
        new_super_category.as_deref(), new_sort_order, true,
    ).map_err(|e| e.to_string())
}

#[command]
pub async fn delete_group_hierarchy(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.replace_group_hierarchy(&provider_id, &content_type, &[]).map_err(|e| e.to_string())
}

#[command]
pub async fn pin_group(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
    group_name: String,
    sort_order: i64,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.pin_group(&provider_id, &content_type, &group_name, sort_order).map_err(|e| e.to_string())
}

#[command]
pub async fn unpin_group(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
    group_name: String,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.unpin_group(&provider_id, &content_type, &group_name).map_err(|e| e.to_string())
}

#[command]
pub async fn get_pinned_groups(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
) -> Result<Vec<PinnedGroup>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.get_pinned_groups(&provider_id, &content_type).map_err(|e| e.to_string())
}

// --- Gemini API Commands ---

const GEMINI_STORE_FILE: &str = "gemini.json";
const GEMINI_KEY: &str = "apiKey";

#[command]
pub async fn get_gemini_api_key<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let store = app.store(GEMINI_STORE_FILE).map_err(|e| e.to_string())?;
    Ok(store.get(GEMINI_KEY).and_then(|v| v.as_str().map(|s| s.to_string())))
}

#[command]
pub async fn set_gemini_api_key<R: Runtime>(app: AppHandle<R>, key: String) -> Result<(), String> {
    let store = app.store(GEMINI_STORE_FILE).map_err(|e| e.to_string())?;
    store.set(GEMINI_KEY, serde_json::Value::String(key));
    store.save().map_err(|e| e.to_string())
}

#[command]
pub async fn test_gemini_api_key(key: String) -> Result<bool, String> {
    mvp_core::ai::gemini::test_gemini_key(&key).await.map_err(|e| e.to_string())
}

#[command]
pub async fn categorize_provider(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
    api_key: String,
    groups_with_samples: Vec<(String, Vec<String>)>,
) -> Result<Vec<GroupHierarchyEntry>, String> {
    let groups_ref: Vec<(&str, Vec<&str>)> = groups_with_samples.iter()
        .map(|(g, s)| (g.as_str(), s.iter().map(|x| x.as_str()).collect()))
        .collect();
    let prompt = mvp_core::ai::gemini::build_categorization_prompt(&content_type, &groups_ref);

    let known_groups: Vec<&str> = groups_with_samples.iter().map(|(g, _)| g.as_str()).collect();
    let mut last_err = String::new();
    for _ in 0..2 {
        match mvp_core::ai::gemini::call_gemini(&api_key, &prompt).await {
            Ok(json) => {
                match mvp_core::ai::gemini::parse_categorization_response(&json, &known_groups) {
                    Ok(result) => {
                        let mut entries: Vec<(&str, Option<&str>, i64)> = result.hierarchy.iter()
                            .map(|h| (h.group_name.as_str(), h.super_category.as_deref(), h.sort_order))
                            .collect();
                        let mut ungrouped_order = entries.last().map(|e| e.2 + 100).unwrap_or(0);
                        for name in &result.ungrouped {
                            entries.push((name.as_str(), None, ungrouped_order));
                            ungrouped_order += 100;
                        }

                        let cache = state.cache.lock().map_err(|e| e.to_string())?;
                        cache.replace_group_hierarchy(&provider_id, &content_type, &entries)
                            .map_err(|e| e.to_string())?;

                        return cache.get_group_hierarchy(&provider_id, &content_type)
                            .map_err(|e| e.to_string());
                    }
                    Err(e) => { last_err = e.to_string(); continue; }
                }
            }
            Err(e) => { last_err = e.to_string(); continue; }
        }
    }
    Err(format!("Categorization failed: {}", last_err))
}

#[command]
pub async fn fix_uncategorized_groups(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
    api_key: String,
    uncategorized_groups: Vec<(String, Vec<String>)>,
    existing_categories: Vec<String>,
) -> Result<Vec<GroupHierarchyEntry>, String> {
    let groups_ref: Vec<(&str, Vec<&str>)> = uncategorized_groups.iter()
        .map(|(g, s)| (g.as_str(), s.iter().map(|x| x.as_str()).collect()))
        .collect();
    let cats_ref: Vec<&str> = existing_categories.iter().map(|s| s.as_str()).collect();
    let prompt = mvp_core::ai::gemini::build_fix_uncategorized_prompt(&groups_ref, &cats_ref);

    let known: Vec<&str> = uncategorized_groups.iter().map(|(g, _)| g.as_str()).collect();
    let mut last_err = String::new();
    for _ in 0..2 {
        match mvp_core::ai::gemini::call_gemini(&api_key, &prompt).await {
            Ok(json) => {
                match mvp_core::ai::gemini::parse_assignment_response(&json, &known, &cats_ref) {
                    Ok(assignments) => {
                        let cache = state.cache.lock().map_err(|e| e.to_string())?;
                        for a in &assignments {
                            cache.save_group_hierarchy(
                                &provider_id, &content_type, &a.group_name,
                                Some(&a.category), 0, false,
                            ).map_err(|e| e.to_string())?;
                        }
                        return cache.get_group_hierarchy(&provider_id, &content_type)
                            .map_err(|e| e.to_string());
                    }
                    Err(e) => { last_err = e.to_string(); continue; }
                }
            }
            Err(e) => { last_err = e.to_string(); continue; }
        }
    }
    Err(format!("Fix uncategorized failed: {}", last_err))
}

#[command]
pub async fn rename_super_category(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.rename_super_category(&provider_id, &content_type, &old_name, &new_name)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn delete_super_category(
    state: State<'_, AppState>,
    provider_id: String,
    content_type: String,
    category_name: String,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.delete_super_category(&provider_id, &content_type, &category_name)
        .map_err(|e| e.to_string())
}

/// Returns the installation type so the frontend knows which update path to use.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    /// "appimage" | "deb" | "rpm" | "native"
    pub install_type: String,
    /// The release download URL for manual updates.
    pub release_url: String,
}

#[command]
pub fn get_install_info() -> InstallInfo {
    let install_type = if cfg!(mobile) {
        // The App Store updates the app.
        "store"
    } else if cfg!(target_os = "linux") {
        if std::env::var("APPIMAGE").is_ok() {
            "appimage"
        } else if std::path::Path::new("/usr/bin/dpkg").exists() {
            "deb"
        } else if std::path::Path::new("/usr/bin/rpm").exists() {
            "rpm"
        } else {
            // Unknown layout (e.g. Nix, Arch without dpkg): use Tauri updater path, not deb/rpm package install
            "native"
        }
    } else {
        // macOS and Windows updaters work natively
        "native"
    };
    InstallInfo {
        install_type: install_type.to_string(),
        release_url: "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest".to_string(),
    }
}

/// Fetch latest.json, download the appropriate package, and install it via pkexec.
/// Emits "package-update://progress" events with { percent: u8 } payloads.
#[command]
pub async fn package_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri::Emitter;

    let info = get_install_info();
    let pkg_key = match info.install_type.as_str() {
        "deb" => "linux-deb-x86_64",
        "rpm" => "linux-rpm-x86_64",
        other => return Err(format!("package_update not supported for install type: {other}")),
    };

    // 1. Fetch latest.json to get the package URL
    let latest_url = "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest/download/latest.json";
    let client = reqwest::Client::new();
    let latest: serde_json::Value = client.get(latest_url)
        .send().await.map_err(|e| format!("Failed to fetch latest.json: {e}"))?
        .json().await.map_err(|e| format!("Failed to parse latest.json: {e}"))?;

    let pkg_url = latest.get("packages")
        .and_then(|p| p.get(pkg_key))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("No package URL found for {pkg_key} in latest.json"))?
        .to_string();

    // 2. Download the package to a temp file
    let response = client.get(&pkg_url)
        .send().await.map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let extension = if info.install_type == "rpm" { "rpm" } else { "deb" };
    // keep() disables auto-delete and returns a TempPath (RAII: deletes on drop)
    // plus the raw File handle for writing. TempPath stays alive until end of
    // function, so dpkg/rpm can access the file, and cleanup happens on all paths.
    use tempfile::Builder;
    let temp_file = Builder::new()
        .prefix("maxvideoplayer_update.")
        .suffix(&format!(".{extension}"))
        .tempfile_in(std::env::temp_dir())
        .map_err(|e| format!("Failed to create temp file: {e}"))?;
    let (std_file, tmp_path) = temp_file.into_parts();
    let mut file = tokio::fs::File::from_std(std_file);

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let percent = ((downloaded as f64 / total_size as f64) * 100.0)
                .clamp(0.0, 100.0) as u8;
            if percent != last_percent {
                last_percent = percent;
                let _ = app.emit("package-update://progress", serde_json::json!({ "percent": percent }));
            }
        }
    }
    file.flush().await.map_err(|e| format!("Flush error: {e}"))?;
    drop(file);

    // 3. Install via pkexec (async so we do not block the Tokio worker for the whole GUI prompt)
    // For deb: prefer apt-get install which resolves dependencies automatically,
    // fall back to dpkg -i for systems without apt-get.
    let output = match info.install_type.as_str() {
        "deb" => {
            let apt_result = tokio::process::Command::new("pkexec")
                .arg("apt-get")
                .arg("install")
                .arg("-y")
                .arg("--allow-downgrades")
                .arg(&tmp_path)
                .output()
                .await;
            match apt_result {
                Ok(o) if o.status.success() => o,
                _ => {
                    // Fallback to dpkg -i (no dependency resolution)
                    tokio::process::Command::new("pkexec")
                        .arg("dpkg")
                        .arg("-i")
                        .arg(&tmp_path)
                        .output()
                        .await
                        .map_err(|e| format!("Failed to run installer: {e}"))?
                }
            }
        },
        "rpm" => tokio::process::Command::new("pkexec")
            .arg("rpm")
            .arg("-U")
            .arg(&tmp_path)
            .output()
            .await
            .map_err(|e| format!("Failed to run installer: {e}"))?,
        _ => unreachable!(),
    };

    // tmp_path (TempPath) auto-deletes on drop at end of function.

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Installation failed: {stderr}"));
    }

    Ok(())
}

/// Downloads run the bundled ffmpeg, which only ships with the desktop app.
fn ensure_downloads_supported() -> Result<(), String> {
    if cfg!(mobile) {
        return Err("Downloads aren't available on this device".to_string());
    }
    Ok(())
}

/// Enqueue a single movie download.
#[command]
pub async fn enqueue_movie_download(
    app: AppHandle,
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<String, String> {
    ensure_downloads_supported()?;
    let (title, url) = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        let ch = cache
            .get_channel_by_id(&channel_id)
            .map_err(|e| e.to_string())?
            .ok_or("channel not found")?;
        (ch.name, ch.url)
    };
    let id = manager::enqueue_record(
        &app, &channel_id, &title, &url, DownloadKind::Movie, None, None,
    )?;
    manager::pump(&app)?;
    Ok(id)
}

/// Enqueue a single already-resolved episode (the frontend passes the episode
/// Channel from get_xtream_series_episodes, plus the parent series channel id).
#[command]
pub async fn enqueue_episode_download(
    app: AppHandle,
    state: State<'_, AppState>,
    episode: Channel,
    series_channel_id: String,
    series_title: String,
) -> Result<String, String> {
    ensure_downloads_supported()?;
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        cache.upsert_channel("__downloads__", &episode).map_err(|e| e.to_string())?;
    }
    let id = manager::enqueue_record(
        &app,
        &episode.id,
        &episode.name,
        &episode.url,
        DownloadKind::Episode,
        Some(series_channel_id),
        Some(&series_title),
    )?;
    manager::pump(&app)?;
    Ok(id)
}

/// Enqueue every episode in `episodes`. Used for whole-season, whole-series,
/// and "download all missing". The frontend resolves/filters the list.
#[command]
pub async fn enqueue_episodes_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    episodes: Vec<Channel>,
    series_channel_id: String,
    series_title: String,
) -> Result<Vec<String>, String> {
    ensure_downloads_supported()?;
    let mut ids = Vec::new();
    for ep in episodes {
        {
            let cache = state.cache.lock().map_err(|e| e.to_string())?;
            cache.upsert_channel("__downloads__", &ep).map_err(|e| e.to_string())?;
        }
        let id = manager::enqueue_record(
            &app,
            &ep.id,
            &ep.name,
            &ep.url,
            DownloadKind::Episode,
            Some(series_channel_id.clone()),
            Some(&series_title),
        )?;
        ids.push(id);
    }
    manager::pump(&app)?;
    Ok(ids)
}

#[command]
pub async fn list_downloads(state: State<'_, AppState>) -> Result<Vec<DownloadRecord>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.list_downloads().map_err(|e| e.to_string())
}

/// Persist a series' full episode list so the season/episode selector works
/// offline. Called when the user downloads any episode of the series.
#[command]
pub async fn cache_series_episodes(
    state: State<'_, AppState>,
    series_channel_id: String,
    episodes: Vec<Channel>,
) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .save_series_episodes(&series_channel_id, &episodes)
        .map_err(|e| e.to_string())
}

/// Read the cached episode list for a series (empty if nothing cached).
#[command]
pub async fn get_cached_series_episodes(
    state: State<'_, AppState>,
    series_channel_id: String,
) -> Result<Vec<Channel>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache
        .get_series_episodes(&series_channel_id)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn stop_download(app: AppHandle, id: String) -> Result<(), String> {
    manager::stop_one(&app, &id)
}

/// Stop a set of active (queued + downloading) items (series or season scope).
#[command]
pub async fn stop_downloads(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    for id in ids {
        manager::stop_one(&app, &id)?;
    }
    manager::pump(&app)?;
    Ok(())
}

/// Remove a completed download: delete the file and the DB row.
#[command]
pub async fn remove_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        cache.get_download(&id).map_err(|e| e.to_string())?.map(|r| r.dest_path)
    };
    if let Some(p) = path {
        let _ = std::fs::remove_file(&p);
    }
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    cache.delete_download(&id).map_err(|e| e.to_string())
}

#[command]
pub async fn remove_downloads(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    for id in ids {
        if let Ok(Some(rec)) = cache.get_download(&id) {
            let _ = std::fs::remove_file(&rec.dest_path);
        }
        cache.delete_download(&id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn set_download_concurrency(
    manager: State<'_, DownloadManager>,
    app: AppHandle,
    n: usize,
) -> Result<(), String> {
    // Save first, so a failed write leaves the running limit unchanged.
    let n = n.max(1);
    manager::save_concurrency(&app, n)?;
    manager.set_concurrency(n);
    manager::pump(&app)?;
    Ok(())
}

#[command]
pub async fn get_download_concurrency(manager: State<'_, DownloadManager>) -> Result<usize, String> {
    Ok(manager.concurrency())
}

#[command]
pub async fn set_download_folder(
    manager: State<'_, DownloadManager>,
    app: AppHandle,
    path: String,
) -> Result<(), String> {
    // Save first, so a failed write doesn't switch the folder for this session only.
    manager::save_folder(&app, &path)?;
    manager.set_root(std::path::PathBuf::from(&path));
    Ok(())
}

#[command]
pub async fn get_download_folder(manager: State<'_, DownloadManager>) -> Result<String, String> {
    Ok(manager.root().to_string_lossy().to_string())
}

/// Given a channel id, return the local file path if a completed download
/// exists (and the file is present on disk), else None. The frontend calls this
/// before playback and passes the local path to mpvLoad when present.
#[command]
pub async fn resolve_local_download(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<Option<String>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    let rec = cache
        .completed_download_for_channel(&channel_id)
        .map_err(|e| e.to_string())?;
    Ok(rec.and_then(|r| {
        if std::path::Path::new(&r.dest_path).exists() {
            Some(r.dest_path)
        } else {
            None
        }
    }))
}
