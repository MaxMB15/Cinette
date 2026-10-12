// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A client for Xtream Codes panels, which serve live channels, movies and
//! series through `player_api.php`.

use crate::json::number_or_string;
use crate::models::channel::Channel;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::Deserialize;
use std::collections::HashMap;
use thiserror::Error;
use url::form_urlencoded;

/// Errors from talking to an Xtream Codes panel.
#[derive(Debug, Error)]
pub enum XtreamError {
    /// The panel answered but did not accept the login, or the account is not
    /// active.
    #[error("authentication failed")]
    AuthFailed,
    /// The request failed or the reply was not the JSON the panel should send.
    #[error("network error: {0}")]
    Network(#[source] reqwest::Error),
    /// The JSON was valid but not in the expected shape.
    #[error("invalid response: {0}")]
    InvalidResponse(String),
}

// Request URLs can carry API keys and logins, so they are dropped before the
// error can reach a log or the UI.
impl From<reqwest::Error> for XtreamError {
    fn from(e: reqwest::Error) -> Self {
        Self::Network(e.without_url())
    }
}

/// The server address and login for one Xtream provider.
#[derive(Clone)]
pub struct XtreamCredentials {
    pub server: String,
    pub username: String,
    pub password: String,
}

/// What a login can't hold as is in a stream URL's path: what the URL
/// standard escapes in a path, plus `/`, `\` and `%`, which would split the
/// path or start an escape.
const PATH_SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'\\')
    .add(b'`')
    .add(b'{')
    .add(b'}');

/// Leaves the login out, so a `{:?}` in a log line or an error can't print it.
impl std::fmt::Debug for XtreamCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("XtreamCredentials")
            .field("server", &self.server)
            .field("username", &"***")
            .field("password", &"***")
            .finish()
    }
}

impl XtreamCredentials {
    /// Creates credentials. A trailing slash on `server` is dropped so paths
    /// can be added without doubling it.
    pub fn new(server: &str, username: &str, password: &str) -> Self {
        let server = server.trim_end_matches('/').to_string();
        Self {
            server,
            username: username.to_string(),
            password: password.to_string(),
        }
    }

    /// Logins can contain characters such as `&`, `#` or `+` that would
    /// otherwise end the value early or change its meaning, so the whole query
    /// is form encoded.
    fn api_url(&self, action: &str, extra: &[(&str, &str)]) -> String {
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("username", &self.username)
            .append_pair("password", &self.password)
            .append_pair("action", action)
            .extend_pairs(extra)
            .finish();
        format!("{}/player_api.php?{query}", self.server)
    }

    /// A stream's address, with the login in the path. Characters that would
    /// end or split the path, such as `#`, `?` and `/`, are escaped. Ones a
    /// path allows, such as `&` and `+`, are left as they are, so logins that
    /// already worked give the same address.
    fn stream_url(&self, kind: &str, file: &str) -> String {
        let username = utf8_percent_encode(&self.username, PATH_SEGMENT);
        let password = utf8_percent_encode(&self.password, PATH_SEGMENT);
        format!("{}/{kind}/{username}/{password}/{file}", self.server)
    }

    fn live_stream_url(&self, stream_id: u64, extension: &str) -> String {
        self.stream_url("live", &format!("{stream_id}.{extension}"))
    }

    fn vod_stream_url(&self, stream_id: u64, extension: &str) -> String {
        self.stream_url("movie", &format!("{stream_id}.{extension}"))
    }

    fn series_stream_url(&self, episode_id: &str, extension: &str) -> String {
        self.stream_url("series", &format!("{episode_id}.{extension}"))
    }
}

#[derive(Debug, Deserialize)]
struct AuthResponse {
    user_info: Option<UserInfo>,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    auth: Option<u8>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XtreamCategory {
    category_id: String,
    category_name: String,
}

#[derive(Debug, Deserialize)]
struct XtreamStream {
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

/// A client for one Xtream panel's player API.
pub struct XtreamClient {
    credentials: XtreamCredentials,
    client: &'static reqwest::Client,
}

impl XtreamClient {
    /// Creates a client on the shared download client, because a full stream
    /// list can take longer than an API call is allowed. The small calls set
    /// the API limit on each request.
    pub fn new(credentials: XtreamCredentials) -> Self {
        Self {
            credentials,
            client: crate::http::download_client(),
        }
    }

    /// Checks the login. Panels report a good login either as `auth` 1 or as an
    /// `Active` status, so either one counts.
    pub async fn authenticate(&self) -> Result<(), XtreamError> {
        let url = self.credentials.api_url("", &[]);
        let resp: AuthResponse = self.small_request(&url).send().await?.json().await?;

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

    /// A request for a reply the panel can send at once, such as the login
    /// check or one series. A user waits on these, so a panel that stopped
    /// answering fails within the API limit instead of the download one.
    ///
    /// Category lists stay on the download limit. They load alongside the
    /// stream lists, so a shorter limit wouldn't make a refresh any quicker.
    fn small_request(&self, url: &str) -> reqwest::RequestBuilder {
        self.client.get(url).timeout(crate::http::API_TIMEOUT)
    }

    async fn get_categories(&self, action: &str) -> Result<HashMap<String, String>, XtreamError> {
        let url = self.credentials.api_url(action, &[]);
        let cats: Vec<XtreamCategory> = self.client.get(&url).send().await?.json().await?;
        Ok(cats
            .into_iter()
            .map(|c| (c.category_id, c.category_name))
            .collect())
    }

    async fn fetch_streams_raw(&self, action: &str) -> Result<Vec<XtreamStream>, XtreamError> {
        let url = self.credentials.api_url(action, &[]);
        Ok(self.client.get(&url).send().await?.json().await?)
    }

    async fn fetch_series_raw(&self) -> Result<Vec<XtreamSeries>, XtreamError> {
        let url = self.credentials.api_url("get_series", &[]);
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
        let url = self.credentials.api_url(
            "get_series_info",
            &[("series_id", series_id.to_string().as_str())],
        );
        let resp: XtreamSeriesInfoResponse = self.small_request(&url).send().await?.json().await?;

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
                let ep_id = match ep.id.as_ref().and_then(number_or_string::<u64>) {
                    Some(id) => id,
                    None => continue,
                };
                let ext = ep.container_extension.as_deref().unwrap_or("mkv");
                let ep_num = ep
                    .episode_num
                    .as_ref()
                    .and_then(number_or_string::<u64>)
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
                    content_type: "series".to_string(),
                    series_title: Some(display_name.to_string()),
                    season: Some(season),
                    episode: ep_num,
                    ..Default::default()
                });
            }
        }

        channels.sort_by_key(|ch| (ch.season.unwrap_or(0), ch.episode.unwrap_or(0)));
        Ok(channels)
    }
}

/// Authenticate then fetch all 6 Xtream endpoints simultaneously (3 stream lists + 3 category
/// lists). Each fetch is independent. A failed one is logged and skipped, so a server that
/// supports only some endpoints still returns what it can.
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

    warn_if_failed("get_live_streams", &live_streams_r);
    warn_if_failed("get_live_categories", &live_cats_r);
    warn_if_failed("get_vod_streams", &vod_streams_r);
    warn_if_failed("get_vod_categories", &vod_cats_r);
    warn_if_failed("get_series", &series_r);
    warn_if_failed("get_series_categories", &series_cats_r);

    let live_cats = live_cats_r.unwrap_or_default();
    let vod_cats = vod_cats_r.unwrap_or_default();
    let series_cats = series_cats_r.unwrap_or_default();

    let mut all: Vec<Channel> = Vec::new();
    let creds = &client.credentials;

    if let Ok(streams) = live_streams_r {
        all.extend(
            streams
                .into_iter()
                .enumerate()
                .filter_map(|(i, s)| live_channel(creds, &live_cats, i, s)),
        );
    }

    if let Ok(streams) = vod_streams_r {
        all.extend(
            streams
                .into_iter()
                .enumerate()
                .filter_map(|(i, s)| vod_channel(creds, &vod_cats, i, s)),
        );
    }

    if let Ok(series_list) = series_r {
        all.extend(
            series_list
                .into_iter()
                .enumerate()
                .filter_map(|(i, s)| series_channel(&series_cats, i, s)),
        );
    }

    if all.is_empty() {
        return Err(XtreamError::InvalidResponse(
            "No streams returned from any endpoint".to_string(),
        ));
    }

    Ok(all)
}

/// Logs an endpoint that failed. The errors carry no URL, so the login stays out
/// of the log.
fn warn_if_failed<T>(action: &str, result: &Result<T, XtreamError>) {
    if let Err(e) = result {
        tracing::warn!("[Xtream] {action} failed: {e}");
    }
}

fn live_channel(
    creds: &XtreamCredentials,
    categories: &HashMap<String, String>,
    index: usize,
    stream: XtreamStream,
) -> Option<Channel> {
    let stream_id = stream.stream_id?;
    let ext = stream.container_extension.as_deref().unwrap_or("ts");
    Some(Channel {
        id: format!("xt-{index}"),
        url: creds.live_stream_url(stream_id, ext),
        name: stream.name.unwrap_or_else(|| format!("Stream {stream_id}")),
        logo_url: stream.stream_icon.filter(|u| !u.is_empty()),
        group_title: category_name(categories, stream.category_id.as_deref()),
        tvg_id: stream.epg_channel_id,
        content_type: "live".to_string(),
        ..Default::default()
    })
}

fn vod_channel(
    creds: &XtreamCredentials,
    categories: &HashMap<String, String>,
    index: usize,
    stream: XtreamStream,
) -> Option<Channel> {
    let stream_id = stream.stream_id?;
    let ext = stream.container_extension.as_deref().unwrap_or("mp4");
    Some(Channel {
        id: format!("vod-{index}"),
        url: creds.vod_stream_url(stream_id, ext),
        name: stream.name.unwrap_or_else(|| format!("VOD {stream_id}")),
        logo_url: stream.stream_icon.filter(|u| !u.is_empty()),
        group_title: category_name(categories, stream.category_id.as_deref()),
        content_type: "movie".to_string(),
        ..Default::default()
    })
}

/// Series come without episodes, which are fetched when the user opens one,
/// so the URL only records which series it is.
fn series_channel(
    categories: &HashMap<String, String>,
    index: usize,
    series: XtreamSeries,
) -> Option<Channel> {
    let series_id = series.series_id?;
    Some(Channel {
        id: format!("ser-{index}"),
        name: series.name.unwrap_or_else(|| format!("Series {series_id}")),
        url: format!("xtream://series/{series_id}"),
        logo_url: series.cover.filter(|u| !u.is_empty()),
        group_title: category_name(categories, series.category_id.as_deref()),
        content_type: "series".to_string(),
        ..Default::default()
    })
}

fn category_name(categories: &HashMap<String, String>, category_id: Option<&str>) -> String {
    category_id
        .and_then(|id| categories.get(id))
        .cloned()
        .unwrap_or_else(|| "Uncategorized".to_string())
}

/// Returns the XMLTV EPG URL for an Xtream provider, with the login form
/// encoded the same way as the API calls.
pub fn get_xtream_epg_url(server: &str, username: &str, password: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("username", username)
        .append_pair("password", password)
        .finish();
    format!("{}/xmltv.php?{query}", server.trim_end_matches('/'))
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
    fn test_debug_hides_the_login() {
        // Built field by field because CodeQL reads a literal passed to a
        // parameter named `password` as a hard-coded credential.
        let creds = XtreamCredentials {
            server: "http://srv:8080".into(),
            username: "user1".into(),
            password: "s3cret".into(),
        };
        let printed = format!("{creds:?}");
        assert!(printed.contains("http://srv:8080"));
        assert!(!printed.contains("user1"));
        assert!(!printed.contains("s3cret"));
    }

    #[test]
    fn test_api_url() {
        let creds = XtreamCredentials::new("http://srv:8080", "user1", "pass1");
        assert_eq!(
            creds.api_url("get_live_streams", &[]),
            "http://srv:8080/player_api.php?username=user1&password=pass1&action=get_live_streams"
        );
    }

    #[test]
    fn test_api_url_for_authentication_keeps_an_empty_action() {
        let creds = XtreamCredentials::new("http://srv:8080", "user1", "pass1");
        assert_eq!(
            creds.api_url("", &[]),
            "http://srv:8080/player_api.php?username=user1&password=pass1&action="
        );
    }

    const AWKWARD_USER: &str = "me&you #1";
    const AWKWARD_PASS: &str = "a+b/c d&action=x#e";

    fn query_pairs(url: &str) -> Vec<(String, String)> {
        url::Url::parse(url)
            .unwrap()
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
        expected
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn test_api_url_encodes_awkward_credentials() {
        let creds = XtreamCredentials::new("http://srv:8080", AWKWARD_USER, AWKWARD_PASS);
        let url = creds.api_url("get_series_info", &[("series_id", "42")]);
        assert_eq!(
            url,
            "http://srv:8080/player_api.php?username=me%26you+%231\
             &password=a%2Bb%2Fc+d%26action%3Dx%23e&action=get_series_info&series_id=42"
        );
        assert_eq!(
            query_pairs(&url),
            pairs(&[
                ("username", AWKWARD_USER),
                ("password", AWKWARD_PASS),
                ("action", "get_series_info"),
                ("series_id", "42"),
            ])
        );
    }

    #[test]
    fn test_get_xtream_epg_url_encodes_awkward_credentials() {
        let url = get_xtream_epg_url("http://srv:8080/", AWKWARD_USER, AWKWARD_PASS);
        assert!(url.starts_with("http://srv:8080/xmltv.php?"), "{url}");
        assert_eq!(
            query_pairs(&url),
            pairs(&[("username", AWKWARD_USER), ("password", AWKWARD_PASS)])
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

    #[test]
    fn stream_urls_escape_what_would_break_the_path() {
        let creds = XtreamCredentials::new("http://srv:8080", AWKWARD_USER, AWKWARD_PASS);
        let url = creds.live_stream_url(7, "ts");
        assert_eq!(
            url,
            "http://srv:8080/live/me&you%20%231/a+b%2Fc%20d&action=x%23e/7.ts"
        );
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert_eq!(parsed.fragment(), None);
        assert_eq!(parsed.query(), None);
        let segments: Vec<String> = parsed
            .path_segments()
            .unwrap()
            .map(|s| {
                percent_encoding::percent_decode_str(s)
                    .decode_utf8()
                    .unwrap()
                    .into_owned()
            })
            .collect();
        assert_eq!(segments, ["live", AWKWARD_USER, AWKWARD_PASS, "7.ts"]);
    }

    #[test]
    fn stream_urls_escape_question_marks_and_percent_signs() {
        let creds = XtreamCredentials::new("http://srv:8080", "u?1", "50%off");
        assert_eq!(
            creds.vod_stream_url(9, "mp4"),
            "http://srv:8080/movie/u%3F1/50%25off/9.mp4"
        );
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
        assert_eq!(
            number_or_string::<u64>(s1[0].id.as_ref().unwrap()),
            Some(1001)
        );
        assert_eq!(
            number_or_string::<u64>(s1[0].episode_num.as_ref().unwrap()),
            Some(1)
        );

        // Second episode: id as number, episode_num as string
        assert_eq!(
            number_or_string::<u64>(s1[1].id.as_ref().unwrap()),
            Some(1002)
        );
        assert_eq!(
            number_or_string::<u64>(s1[1].episode_num.as_ref().unwrap()),
            Some(2)
        );
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

    #[test]
    fn http_errors_leave_out_the_request_url() {
        let err = XtreamError::from(crate::http::error_with_url(
            "unix:/player_api.php?username=u&password=SECRET",
        ));
        assert!(!err.to_string().contains("SECRET"), "{err}");
        assert!(!format!("{err:?}").contains("SECRET"), "{err:?}");
    }

    fn categories() -> HashMap<String, String> {
        HashMap::from([("3".to_string(), "News".to_string())])
    }

    #[test]
    fn test_live_channel() {
        let creds = XtreamCredentials::new("http://srv", "u", "p");
        let stream: XtreamStream = serde_json::from_value(json!({
            "stream_id": 7,
            "name": "CNN",
            "stream_icon": "http://img/cnn.png",
            "epg_channel_id": "cnn.us",
            "category_id": "3"
        }))
        .unwrap();
        assert_eq!(
            live_channel(&creds, &categories(), 2, stream),
            Some(Channel {
                id: "xt-2".into(),
                name: "CNN".into(),
                url: "http://srv/live/u/p/7.ts".into(),
                logo_url: Some("http://img/cnn.png".into()),
                group_title: "News".into(),
                tvg_id: Some("cnn.us".into()),
                content_type: "live".into(),
                ..Default::default()
            })
        );
    }

    #[test]
    fn test_vod_channel_fills_gaps() {
        let creds = XtreamCredentials::new("http://srv", "u", "p");
        let stream: XtreamStream = serde_json::from_value(json!({
            "stream_id": 9,
            "stream_icon": "",
            "epg_channel_id": "ignored",
            "category_id": "99"
        }))
        .unwrap();
        assert_eq!(
            vod_channel(&creds, &categories(), 0, stream),
            Some(Channel {
                id: "vod-0".into(),
                name: "VOD 9".into(),
                url: "http://srv/movie/u/p/9.mp4".into(),
                group_title: "Uncategorized".into(),
                content_type: "movie".into(),
                ..Default::default()
            })
        );
    }

    #[test]
    fn test_series_channel() {
        let series: XtreamSeries = serde_json::from_value(json!({
            "series_id": 5,
            "cover": "http://img/wire.jpg",
            "category_id": "3"
        }))
        .unwrap();
        assert_eq!(
            series_channel(&categories(), 1, series),
            Some(Channel {
                id: "ser-1".into(),
                name: "Series 5".into(),
                url: "xtream://series/5".into(),
                logo_url: Some("http://img/wire.jpg".into()),
                group_title: "News".into(),
                content_type: "series".into(),
                ..Default::default()
            })
        );
    }

    #[test]
    fn test_entries_without_an_id_are_skipped() {
        let creds = XtreamCredentials::new("http://srv", "u", "p");
        let stream = || serde_json::from_value::<XtreamStream>(json!({ "name": "x" })).unwrap();
        assert_eq!(live_channel(&creds, &categories(), 0, stream()), None);
        assert_eq!(vod_channel(&creds, &categories(), 0, stream()), None);
        let series: XtreamSeries = serde_json::from_value(json!({ "name": "x" })).unwrap();
        assert_eq!(series_channel(&categories(), 0, series), None);
    }
}
