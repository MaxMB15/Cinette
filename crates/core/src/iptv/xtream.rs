// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::models::channel::Channel;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum XtreamError {
    #[error("authentication failed")]
    AuthFailed,
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("invalid response: {0}")]
    InvalidResponse(String),
}

#[derive(Debug, Clone)]
pub struct XtreamCredentials {
    pub server: String,
    pub username: String,
    pub password: String,
}

impl XtreamCredentials {
    pub fn new(server: &str, username: &str, password: &str) -> Self {
        let server = server.trim_end_matches('/').to_string();
        Self {
            server,
            username: username.to_string(),
            password: password.to_string(),
        }
    }

    fn api_url(&self, action: &str) -> String {
        format!(
            "{}/player_api.php?username={}&password={}&action={action}",
            self.server, self.username, self.password
        )
    }

    fn live_stream_url(&self, stream_id: u64, extension: &str) -> String {
        format!(
            "{}/live/{}/{}/{stream_id}.{extension}",
            self.server, self.username, self.password
        )
    }

    fn vod_stream_url(&self, stream_id: u64, extension: &str) -> String {
        format!(
            "{}/movie/{}/{}/{stream_id}.{extension}",
            self.server, self.username, self.password
        )
    }

    fn series_stream_url(&self, episode_id: &str, extension: &str) -> String {
        format!(
            "{}/series/{}/{}/{episode_id}.{extension}",
            self.server, self.username, self.password
        )
    }
}

#[derive(Debug, Deserialize)]
struct AuthResponse {
    user_info: Option<UserInfo>,
    #[allow(dead_code)]
    server_info: Option<ServerInfo>,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    auth: Option<u8>,
    status: Option<String>,
    #[allow(dead_code)]
    username: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ServerInfo {
    #[allow(dead_code)]
    url: Option<String>,
    #[allow(dead_code)]
    port: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XtreamCategory {
    category_id: String,
    category_name: String,
}

#[derive(Debug, Deserialize)]
struct XtreamStream {
    #[allow(dead_code)]
    num: Option<u64>,
    name: Option<String>,
    stream_id: Option<u64>,
    stream_icon: Option<String>,
    epg_channel_id: Option<String>,
    category_id: Option<String>,
    #[serde(default)]
    container_extension: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XtreamSeries {
    series_id: Option<u64>,
    name: Option<String>,
    cover: Option<String>,
    category_id: Option<String>,
}

// --- Series info (get_series_info endpoint) ---

#[derive(Debug, Deserialize)]
struct XtreamSeriesInfoResponse {
    info: Option<XtreamSeriesInfoMeta>,
    episodes: Option<HashMap<String, Vec<XtreamEpisode>>>,
}

#[derive(Debug, Deserialize)]
struct XtreamSeriesInfoMeta {
    name: Option<String>,
    cover: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XtreamEpisode {
    id: Option<serde_json::Value>,
    episode_num: Option<serde_json::Value>,
    title: Option<String>,
    container_extension: Option<String>,
}

/// Coerce a JSON value that could be a string or number into u64.
fn coerce_u64(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

pub struct XtreamClient {
    credentials: XtreamCredentials,
    client: &'static reqwest::Client,
}

impl XtreamClient {
    pub fn new(credentials: XtreamCredentials) -> Self {
        Self {
            credentials,
            client: crate::http::download_client(),
        }
    }

    pub async fn authenticate(&self) -> Result<(), XtreamError> {
        let url = self.credentials.api_url("");
        let resp: AuthResponse = self.client.get(&url).send().await?.json().await?;

        match resp.user_info {
            Some(info) => {
                let authed = info.auth == Some(1) || info.status.as_deref() == Some("Active");
                if authed {
                    Ok(())
                } else {
                    Err(XtreamError::AuthFailed)
                }
            }
            None => Err(XtreamError::AuthFailed),
        }
    }

    async fn get_categories(&self, action: &str) -> Result<HashMap<String, String>, XtreamError> {
        let url = self.credentials.api_url(action);
        let cats: Vec<XtreamCategory> = self.client.get(&url).send().await?.json().await?;
        Ok(cats
            .into_iter()
            .map(|c| (c.category_id, c.category_name))
            .collect())
    }

    async fn fetch_streams_raw(&self, action: &str) -> Result<Vec<XtreamStream>, XtreamError> {
        let url = self.credentials.api_url(action);
        Ok(self.client.get(&url).send().await?.json().await?)
    }

    async fn fetch_series_raw(&self) -> Result<Vec<XtreamSeries>, XtreamError> {
        let url = self.credentials.api_url("get_series");
        Ok(self.client.get(&url).send().await?.json().await?)
    }

    /// Fetch all episodes for a specific series from the Xtream `get_series_info` endpoint.
    pub async fn fetch_series_episodes(
        &self,
        series_id: u64,
        show_name: &str,
        show_logo: Option<&str>,
        group: &str,
    ) -> Result<Vec<Channel>, XtreamError> {
        let url = format!(
            "{}/player_api.php?username={}&password={}&action=get_series_info&series_id={series_id}",
            self.credentials.server, self.credentials.username, self.credentials.password
        );
        let resp: XtreamSeriesInfoResponse = self.client.get(&url).send().await?.json().await?;

        let display_name = resp
            .info
            .as_ref()
            .and_then(|i| i.name.as_deref())
            .filter(|n| !n.is_empty())
            .unwrap_or(show_name);
        let logo = resp
            .info
            .as_ref()
            .and_then(|i| i.cover.as_deref())
            .filter(|u| !u.is_empty())
            .or(show_logo);
        let episodes_map = resp.episodes.unwrap_or_default();

        let mut channels: Vec<Channel> = Vec::new();
        for (season_str, episodes) in &episodes_map {
            let season: u32 = season_str.parse().unwrap_or(0);
            for (i, ep) in episodes.iter().enumerate() {
                let ep_id = match ep.id.as_ref().and_then(|v| coerce_u64(v)) {
                    Some(id) => id,
                    None => continue,
                };
                let ext = ep.container_extension.as_deref().unwrap_or("mkv");
                let ep_num = ep
                    .episode_num
                    .as_ref()
                    .and_then(|v| coerce_u64(v))
                    .map(|n| n as u32);
                let ep_title = ep.title.as_deref().filter(|t| !t.is_empty());

                let name = match (ep_num, ep_title) {
                    (Some(n), Some(t)) => format!("{display_name} S{season:02}E{n:02} {t}"),
                    (Some(n), None) => format!("{display_name} S{season:02}E{n:02}"),
                    (None, Some(t)) => format!("{display_name} S{season:02} {t}"),
                    (None, None) => format!("{display_name} S{season:02} Ep{i}"),
                };

                channels.push(Channel {
                    id: format!("xt-ep-{series_id}-s{season}-{i}"),
                    name,
                    url: self.credentials.series_stream_url(&ep_id.to_string(), ext),
                    logo_url: logo.map(|s| s.to_string()),
                    group_title: group.to_string(),
                    tvg_id: None,
                    tvg_name: None,
                    is_favorite: false,
                    content_type: "series".to_string(),
                    sources: Vec::new(),
                    series_title: Some(display_name.to_string()),
                    season: Some(season),
                    episode: ep_num,
                });
            }
        }

        channels.sort_by_key(|ch| (ch.season.unwrap_or(0), ch.episode.unwrap_or(0)));
        Ok(channels)
    }
}

/// Authenticate then fetch all 6 Xtream endpoints simultaneously (3 stream lists + 3 category
/// lists). Each fetch is independent; partial failures are tolerated so a server that supports
/// only some endpoints still returns what it can.
pub async fn fetch_xtream_channels(
    server: &str,
    username: &str,
    password: &str,
) -> Result<Vec<Channel>, XtreamError> {
    let creds = XtreamCredentials::new(server, username, password);
    let client = XtreamClient::new(creds);
    client.authenticate().await?;

    let (live_streams_r, live_cats_r, vod_streams_r, vod_cats_r, series_r, series_cats_r) = tokio::join!(
        client.fetch_streams_raw("get_live_streams"),
        client.get_categories("get_live_categories"),
        client.fetch_streams_raw("get_vod_streams"),
        client.get_categories("get_vod_categories"),
        client.fetch_series_raw(),
        client.get_categories("get_series_categories"),
    );

    let live_cats = live_cats_r.unwrap_or_default();
    let vod_cats = vod_cats_r.unwrap_or_default();
    let series_cats = series_cats_r.unwrap_or_default();

    let mut all: Vec<Channel> = Vec::new();

    if let Ok(streams) = live_streams_r {
        let channels: Vec<Channel> = streams
            .into_iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let stream_id = s.stream_id?;
                let name = s.name.unwrap_or_else(|| format!("Stream {stream_id}"));
                let ext = s.container_extension.as_deref().unwrap_or("ts");
                let group = s
                    .category_id
                    .as_ref()
                    .and_then(|cid| live_cats.get(cid))
                    .cloned()
                    .unwrap_or_else(|| "Uncategorized".to_string());
                Some(Channel {
                    id: format!("xt-{i}"),
                    name,
                    url: client.credentials.live_stream_url(stream_id, ext),
                    logo_url: s.stream_icon.filter(|u| !u.is_empty()),
                    group_title: group,
                    tvg_id: s.epg_channel_id,
                    tvg_name: None,
                    is_favorite: false,
                    content_type: "live".to_string(),
                    sources: Vec::new(),
                    series_title: None,
                    season: None,
                    episode: None,
                })
            })
            .collect();
        all.extend(channels);
    }

    if let Ok(streams) = vod_streams_r {
        let channels: Vec<Channel> = streams
            .into_iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let stream_id = s.stream_id?;
                let name = s.name.unwrap_or_else(|| format!("VOD {stream_id}"));
                let ext = s.container_extension.as_deref().unwrap_or("mp4");
                let group = s
                    .category_id
                    .as_ref()
                    .and_then(|cid| vod_cats.get(cid))
                    .cloned()
                    .unwrap_or_else(|| "Uncategorized".to_string());
                Some(Channel {
                    id: format!("vod-{i}"),
                    name,
                    url: client.credentials.vod_stream_url(stream_id, ext),
                    logo_url: s.stream_icon.filter(|u| !u.is_empty()),
                    group_title: group,
                    tvg_id: None,
                    tvg_name: None,
                    is_favorite: false,
                    content_type: "movie".to_string(),
                    sources: Vec::new(),
                    series_title: None,
                    season: None,
                    episode: None,
                })
            })
            .collect();
        all.extend(channels);
    }

    if let Ok(series_list) = series_r {
        let channels: Vec<Channel> = series_list
            .into_iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let series_id = s.series_id?;
                let name = s.name.unwrap_or_else(|| format!("Series {series_id}"));
                let group = s
                    .category_id
                    .as_ref()
                    .and_then(|cid| series_cats.get(cid))
                    .cloned()
                    .unwrap_or_else(|| "Uncategorized".to_string());
                Some(Channel {
                    id: format!("ser-{i}"),
                    name,
                    url: format!("xtream://series/{series_id}"),
                    logo_url: s.cover.filter(|u| !u.is_empty()),
                    group_title: group,
                    tvg_id: None,
                    tvg_name: None,
                    is_favorite: false,
                    content_type: "series".to_string(),
                    sources: Vec::new(),
                    series_title: None,
                    season: None,
                    episode: None,
                })
            })
            .collect();
        all.extend(channels);
    }

    if all.is_empty() {
        return Err(XtreamError::InvalidResponse(
            "No streams returned from any endpoint".to_string(),
        ));
    }

    Ok(all)
}

/// Returns the XMLTV EPG URL for an Xtream provider.
pub fn get_xtream_epg_url(server: &str, username: &str, password: &str) -> String {
    format!(
        "{}/xmltv.php?username={}&password={}",
        server.trim_end_matches('/'),
        username,
        password
    )
}

/// Fetch all episodes for a specific Xtream series by its series_id.
/// Called on demand when the user opens a series from the UI.
pub async fn fetch_xtream_series_episodes(
    server: &str,
    username: &str,
    password: &str,
    series_id: u64,
    show_name: &str,
    show_logo: Option<&str>,
    group: &str,
) -> Result<Vec<Channel>, XtreamError> {
    let creds = XtreamCredentials::new(server, username, password);
    let client = XtreamClient::new(creds);
    client
        .fetch_series_episodes(series_id, show_name, show_logo, group)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── EPG URL ───────────────────────────────────────────────────────

    #[test]
    fn test_get_xtream_epg_url() {
        let url = get_xtream_epg_url("http://example.com:8080", "user", "pass");
        assert_eq!(
            url,
            "http://example.com:8080/xmltv.php?username=user&password=pass"
        );
    }

    #[test]
    fn test_get_xtream_epg_url_trailing_slash() {
        let url = get_xtream_epg_url("http://example.com:8080/", "user", "pass");
        assert_eq!(
            url,
            "http://example.com:8080/xmltv.php?username=user&password=pass"
        );
    }

    // ── Credentials & URL building ────────────────────────────────────

    #[test]
    fn test_credentials_strip_trailing_slash() {
        let creds = XtreamCredentials::new("http://srv.example.com:8080/", "u", "p");
        assert_eq!(creds.server, "http://srv.example.com:8080");
    }

    #[test]
    fn test_api_url() {
        let creds = XtreamCredentials::new("http://srv:8080", "user1", "pass1");
        assert_eq!(
            creds.api_url("get_live_streams"),
            "http://srv:8080/player_api.php?username=user1&password=pass1&action=get_live_streams"
        );
    }

    #[test]
    fn test_live_stream_url() {
        let creds = XtreamCredentials::new("http://srv:8080", "u", "p");
        assert_eq!(
            creds.live_stream_url(12345, "ts"),
            "http://srv:8080/live/u/p/12345.ts"
        );
    }

    #[test]
    fn test_vod_stream_url() {
        let creds = XtreamCredentials::new("http://srv:8080", "u", "p");
        assert_eq!(
            creds.vod_stream_url(99, "mp4"),
            "http://srv:8080/movie/u/p/99.mp4"
        );
    }

    #[test]
    fn test_series_stream_url() {
        let creds = XtreamCredentials::new("http://srv:8080", "u", "p");
        assert_eq!(
            creds.series_stream_url("555", "mkv"),
            "http://srv:8080/series/u/p/555.mkv"
        );
    }

    // ── coerce_u64 ────────────────────────────────────────────────────

    #[test]
    fn test_coerce_u64_from_number() {
        assert_eq!(coerce_u64(&json!(42)), Some(42));
    }

    #[test]
    fn test_coerce_u64_from_string() {
        assert_eq!(coerce_u64(&json!("123")), Some(123));
    }

    #[test]
    fn test_coerce_u64_from_invalid_string() {
        assert_eq!(coerce_u64(&json!("abc")), None);
    }

    #[test]
    fn test_coerce_u64_from_null() {
        assert_eq!(coerce_u64(&json!(null)), None);
    }

    #[test]
    fn test_coerce_u64_from_float_string() {
        assert_eq!(coerce_u64(&json!("3.14")), None);
    }

    #[test]
    fn test_coerce_u64_from_negative_number() {
        // serde_json stores -1 as i64, as_u64() returns None
        assert_eq!(coerce_u64(&json!(-1)), None);
    }

    // ── Deserialization: XtreamStream ──────────────────────────────────

    #[test]
    fn test_deserialize_xtream_stream_full() {
        let data = json!({
            "num": 1,
            "name": "CNN HD",
            "stream_id": 5001,
            "stream_icon": "http://img.example.com/cnn.png",
            "epg_channel_id": "CNN.us",
            "category_id": "3",
            "container_extension": "m3u8"
        });
        let stream: XtreamStream = serde_json::from_value(data).unwrap();
        assert_eq!(stream.name.as_deref(), Some("CNN HD"));
        assert_eq!(stream.stream_id, Some(5001));
        assert_eq!(stream.epg_channel_id.as_deref(), Some("CNN.us"));
        assert_eq!(stream.container_extension.as_deref(), Some("m3u8"));
    }

    #[test]
    fn test_deserialize_xtream_stream_missing_optional_fields() {
        let data = json!({
            "stream_id": 100
        });
        let stream: XtreamStream = serde_json::from_value(data).unwrap();
        assert_eq!(stream.stream_id, Some(100));
        assert!(stream.name.is_none());
        assert!(stream.stream_icon.is_none());
        assert!(stream.epg_channel_id.is_none());
        assert!(stream.category_id.is_none());
        assert!(stream.container_extension.is_none());
    }

    #[test]
    fn test_deserialize_xtream_stream_null_stream_id() {
        let data = json!({
            "name": "Test",
            "stream_id": null
        });
        let stream: XtreamStream = serde_json::from_value(data).unwrap();
        assert!(stream.stream_id.is_none());
    }

    // ── Deserialization: XtreamCategory ────────────────────────────────

    #[test]
    fn test_deserialize_xtream_category() {
        let data = json!({
            "category_id": "5",
            "category_name": "Sports"
        });
        let cat: XtreamCategory = serde_json::from_value(data).unwrap();
        assert_eq!(cat.category_id, "5");
        assert_eq!(cat.category_name, "Sports");
    }

    // ── Deserialization: AuthResponse ──────────────────────────────────

    #[test]
    fn test_deserialize_auth_response_active() {
        let data = json!({
            "user_info": {
                "auth": 1,
                "status": "Active",
                "username": "testuser"
            },
            "server_info": {
                "url": "srv.example.com",
                "port": "8080"
            }
        });
        let resp: AuthResponse = serde_json::from_value(data).unwrap();
        let info = resp.user_info.unwrap();
        assert_eq!(info.auth, Some(1));
        assert_eq!(info.status.as_deref(), Some("Active"));
    }

    #[test]
    fn test_deserialize_auth_response_no_user_info() {
        let data = json!({});
        let resp: AuthResponse = serde_json::from_value(data).unwrap();
        assert!(resp.user_info.is_none());
    }

    #[test]
    fn test_deserialize_auth_response_banned() {
        let data = json!({
            "user_info": {
                "auth": 0,
                "status": "Banned"
            }
        });
        let resp: AuthResponse = serde_json::from_value(data).unwrap();
        let info = resp.user_info.unwrap();
        assert_eq!(info.auth, Some(0));
        assert_eq!(info.status.as_deref(), Some("Banned"));
    }

    // ── Deserialization: XtreamSeriesInfoResponse ──────────────────────

    #[test]
    fn test_deserialize_series_info_response() {
        let data = json!({
            "info": {
                "name": "Breaking Bad",
                "cover": "http://img.example.com/bb.jpg"
            },
            "episodes": {
                "1": [
                    {
                        "id": "1001",
                        "episode_num": 1,
                        "title": "Pilot",
                        "container_extension": "mkv"
                    },
                    {
                        "id": 1002,
                        "episode_num": "2",
                        "title": "Cat's in the Bag...",
                        "container_extension": "mkv"
                    }
                ]
            }
        });
        let resp: XtreamSeriesInfoResponse = serde_json::from_value(data).unwrap();
        let info = resp.info.unwrap();
        assert_eq!(info.name.as_deref(), Some("Breaking Bad"));

        let episodes = resp.episodes.unwrap();
        let s1 = episodes.get("1").unwrap();
        assert_eq!(s1.len(), 2);

        // First episode: id as string, episode_num as number
        assert_eq!(coerce_u64(s1[0].id.as_ref().unwrap()), Some(1001));
        assert_eq!(coerce_u64(s1[0].episode_num.as_ref().unwrap()), Some(1));

        // Second episode: id as number, episode_num as string
        assert_eq!(coerce_u64(s1[1].id.as_ref().unwrap()), Some(1002));
        assert_eq!(coerce_u64(s1[1].episode_num.as_ref().unwrap()), Some(2));
    }

    #[test]
    fn test_deserialize_series_info_empty_episodes() {
        let data = json!({
            "info": { "name": "Test Show" },
            "episodes": {}
        });
        let resp: XtreamSeriesInfoResponse = serde_json::from_value(data).unwrap();
        assert!(resp.episodes.unwrap().is_empty());
    }

    #[test]
    fn test_deserialize_series_info_missing_episodes() {
        let data = json!({
            "info": { "name": "Test Show" }
        });
        let resp: XtreamSeriesInfoResponse = serde_json::from_value(data).unwrap();
        assert!(resp.episodes.is_none());
    }

    // ── Deserialization: XtreamSeries ──────────────────────────────────

    #[test]
    fn test_deserialize_xtream_series() {
        let data = json!({
            "series_id": 42,
            "name": "The Wire",
            "cover": "http://img.example.com/wire.jpg",
            "category_id": "10"
        });
        let series: XtreamSeries = serde_json::from_value(data).unwrap();
        assert_eq!(series.series_id, Some(42));
        assert_eq!(series.name.as_deref(), Some("The Wire"));
        assert_eq!(
            series.cover.as_deref(),
            Some("http://img.example.com/wire.jpg")
        );
    }

    #[test]
    fn test_deserialize_xtream_series_missing_fields() {
        let data = json!({});
        let series: XtreamSeries = serde_json::from_value(data).unwrap();
        assert!(series.series_id.is_none());
        assert!(series.name.is_none());
        assert!(series.cover.is_none());
        assert!(series.category_id.is_none());
    }
}
