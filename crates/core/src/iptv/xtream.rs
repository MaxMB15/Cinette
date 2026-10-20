// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A client for Xtream Codes panels, which serve live channels, movies and
//! series through `player_api.php`.

use crate::json::number_or_string;
use crate::models::channel::Channel;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use url::form_urlencoded;

/// Errors from talking to an Xtream Codes panel.
#[derive(Debug, Error)]
pub enum XtreamError {
    /// The panel answered but did not accept the login, or the account is not
    /// active.
    #[error("authentication failed")]
    AuthFailed,
    /// The request failed, a list came back with an error status, or the
    /// reply was not the JSON the panel should send.
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
/// path or start an escape. `&` and `+` are escaped too, because Xtream
/// servers commonly rewrite the path into a query string, where a raw `&`
/// would end the login and PHP would decode a raw `+` as a space.
const PATH_SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'+')
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

    /// A stream's address, with the login in the path, escaped as
    /// `PATH_SEGMENT` says.
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
    /// Such as `["m3u8", "ts", "rtmp"]`. Read loosely, since panels differ.
    #[serde(default)]
    allowed_output_formats: Option<serde_json::Value>,
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
        self.user_info().await.map(|_| ())
    }

    /// The stream formats the panel lets this login fetch, such as `m3u8`
    /// and `ts`, in lowercase. Empty when the panel doesn't say.
    pub async fn output_formats(&self) -> Result<Vec<String>, XtreamError> {
        let info = self.user_info().await?;
        let formats = match info.allowed_output_formats {
            Some(serde_json::Value::Array(items)) => items
                .iter()
                .filter_map(|v| v.as_str())
                .map(|f| f.trim().to_ascii_lowercase())
                .filter(|f| !f.is_empty())
                .collect(),
            _ => Vec::new(),
        };
        Ok(formats)
    }

    /// The login's details, once the panel accepted it.
    async fn user_info(&self) -> Result<UserInfo, XtreamError> {
        let url = self.credentials.api_url("", &[]);
        let resp: AuthResponse = self.small_request(&url).send().await?.json().await?;

        match resp.user_info {
            Some(info) if info.auth == Some(1) || info.status.as_deref() == Some("Active") => {
                Ok(info)
            }
            _ => Err(XtreamError::AuthFailed),
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

    /// Fetches one of the panel's lists. A reply with an error status fails
    /// even when its body parses, since a panel can send an empty list with
    /// an error, and the refresh would then drop every saved channel of that
    /// list.
    async fn get_list<T: DeserializeOwned>(&self, action: &str) -> Result<Vec<T>, XtreamError> {
        let url = self.credentials.api_url(action, &[]);
        Ok(self
            .client
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    async fn get_categories(&self, action: &str) -> Result<HashMap<String, String>, XtreamError> {
        let cats: Vec<XtreamCategory> = self.get_list(action).await?;
        Ok(cats
            .into_iter()
            .map(|c| (c.category_id, c.category_name))
            .collect())
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
                    id: episode_id(series_id, season, i),
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

/// The channels an Xtream panel lists, and the lists that didn't load.
#[derive(Debug, Default, PartialEq)]
pub struct XtreamChannels {
    pub channels: Vec<Channel>,
    /// Content types whose list failed to load, such as `movie` when the
    /// panel didn't answer for its movies. The panel may still have them, so
    /// a refresh keeps the ones saved before.
    pub failed_content_types: Vec<&'static str>,
}

impl XtreamChannels {
    /// Adds the channels of one of the panel's lists, or notes its content
    /// type as failed when the list didn't load.
    fn add_list<T: Listing>(
        &mut self,
        content_type: &'static str,
        list: Result<Vec<T>, XtreamError>,
        to_channel: impl Fn(T) -> Option<Channel>,
    ) {
        match list {
            Ok(listings) => self.channels.extend(channels_from(listings, to_channel)),
            Err(_) => self.failed_content_types.push(content_type),
        }
    }
}

/// Authenticate then fetch all 6 Xtream endpoints simultaneously (3 stream lists + 3 category
/// lists). Each fetch is independent. A failed one is logged and skipped, so a server that
/// supports only some endpoints still returns what it can, and a failed stream list is named
/// in `failed_content_types`.
///
/// Channel ids come from the panel's own stream and series ids, so favorites,
/// history and downloads stay with the same channel when the panel reorders
/// its lists.
pub async fn fetch_xtream_channels(
    server: &str,
    username: &str,
    password: &str,
) -> Result<XtreamChannels, XtreamError> {
    let creds = XtreamCredentials::new(server, username, password);
    fetch_all_channels(&XtreamClient::new(creds)).await
}

/// The work of [`fetch_xtream_channels`], taking the client so tests can point
/// it at a local server.
async fn fetch_all_channels(client: &XtreamClient) -> Result<XtreamChannels, XtreamError> {
    client.authenticate().await?;

    let (live_streams_r, live_cats_r, vod_streams_r, vod_cats_r, series_r, series_cats_r) = tokio::join!(
        client.get_list::<XtreamStream>("get_live_streams"),
        client.get_categories("get_live_categories"),
        client.get_list::<XtreamStream>("get_vod_streams"),
        client.get_categories("get_vod_categories"),
        client.get_list::<XtreamSeries>("get_series"),
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

    let creds = &client.credentials;
    let mut fetched = XtreamChannels::default();
    fetched.add_list("live", live_streams_r, |s| {
        live_channel(creds, &live_cats, s)
    });
    fetched.add_list("movie", vod_streams_r, |s| vod_channel(creds, &vod_cats, s));
    fetched.add_list("series", series_r, |s| series_channel(&series_cats, s));

    if fetched.channels.is_empty() {
        return Err(XtreamError::InvalidResponse(
            "No streams returned from any endpoint".to_string(),
        ));
    }

    Ok(fetched)
}

/// An entry in one of the panel's lists.
trait Listing {
    /// The category the entry is listed in.
    fn category_id(&self) -> Option<&str>;
}

impl Listing for XtreamStream {
    fn category_id(&self) -> Option<&str> {
        self.category_id.as_deref()
    }
}

impl Listing for XtreamSeries {
    fn category_id(&self) -> Option<&str> {
        self.category_id.as_deref()
    }
}

/// Turns one of the panel's lists into channels with unique ids. A panel can
/// list a stream in more than one category. Its first listing gets the plain
/// id and later ones add their category id, as in `live-7-c12`, so a listing
/// keeps its id when the panel adds or moves other channels.
fn channels_from<T: Listing>(
    listings: Vec<T>,
    to_channel: impl Fn(T) -> Option<Channel>,
) -> Vec<Channel> {
    let mut taken = HashSet::new();
    listings
        .into_iter()
        .filter_map(|listing| {
            let category_id = listing.category_id().map(str::to_string);
            let mut channel = to_channel(listing)?;
            channel.id = unique_id(&mut taken, channel.id, category_id.as_deref());
            Some(channel)
        })
        .collect()
}

/// `id` when no channel has it yet, else `id` with the category id added,
/// else `id` with the first free number from 2 added. The id it returns is
/// added to `taken`.
fn unique_id(taken: &mut HashSet<String>, id: String, category_id: Option<&str>) -> String {
    let unique = if !taken.contains(&id) {
        id
    } else if let Some(with_category) = category_id
        .filter(|category| !category.is_empty())
        .map(|category| format!("{id}-c{category}"))
        .filter(|candidate| !taken.contains(candidate))
    {
        with_category
    } else {
        let mut n = 2;
        loop {
            let candidate = format!("{id}-{n}");
            if !taken.contains(&candidate) {
                break candidate;
            }
            n += 1;
        }
    };
    taken.insert(unique.clone());
    unique
}

/// A channel's id from its content type and the panel's id for it, such as
/// `live-7`.
fn channel_id(content_type: &str, panel_id: impl std::fmt::Display) -> String {
    format!("{content_type}-{panel_id}")
}

/// The id a channel saved under one of the old list position ids, such as
/// `vod-3`, has now. Older versions named Xtream channels by their place in
/// the panel's lists, so an id passed to another channel whenever the panel
/// added or reordered one. The panel's id is read back from the saved URL.
/// Returns None for any other id, or for a URL this module didn't build.
pub(crate) fn id_for_position_id(position_id: &str, url: &str) -> Option<String> {
    let (old_prefix, position) = position_id.split_once('-')?;
    if !is_number(position) {
        return None;
    }
    let (content_type, panel_id) = match old_prefix {
        "xt" => ("live", stream_id_in_url(url)?),
        "vod" => ("movie", stream_id_in_url(url)?),
        "ser" => ("series", url.strip_prefix("xtream://series/")?),
        _ => return None,
    };
    is_number(panel_id).then(|| channel_id(content_type, panel_id))
}

/// An episode's id, such as `xt-ep-42-s1-0`, from the panel's id for its
/// series, the season and the episode's place in that season.
fn episode_id(series_id: u64, season: u32, index: usize) -> String {
    format!("xt-ep-{series_id}-s{season}-{index}")
}

/// The id of the series an episode id such as `xt-ep-42-s1-0` belongs to,
/// such as `series-42`. Returns None for any other id.
pub(crate) fn series_id_for_episode_id(episode_id: &str) -> Option<String> {
    let (series_id, _) = episode_id.strip_prefix("xt-ep-")?.split_once('-')?;
    is_number(series_id).then(|| channel_id("series", series_id))
}

/// The stream id in a live or movie URL, which ends in `/{id}.{extension}`.
fn stream_id_in_url(url: &str) -> Option<&str> {
    let file = url.rsplit('/').next()?;
    file.split_once('.').map(|(stream_id, _)| stream_id)
}

fn is_number(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
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
    stream: XtreamStream,
) -> Option<Channel> {
    let stream_id = stream.stream_id?;
    let ext = stream.container_extension.as_deref().unwrap_or("ts");
    Some(Channel {
        id: channel_id("live", stream_id),
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
    stream: XtreamStream,
) -> Option<Channel> {
    let stream_id = stream.stream_id?;
    let ext = stream.container_extension.as_deref().unwrap_or("mp4");
    Some(Channel {
        id: channel_id("movie", stream_id),
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
fn series_channel(categories: &HashMap<String, String>, series: XtreamSeries) -> Option<Channel> {
    let series_id = series.series_id?;
    Some(Channel {
        id: channel_id("series", series_id),
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
    use crate::http::test_server::{
        self, assert_hides, route, serve_in_order, serve_once, serve_once_recording, serve_routes,
        Route,
    };
    use crate::test_log::Logged;
    use serde_json::json;
    use std::sync::OnceLock;

    // ── EPG URL ───────────────────────────────────────────────────────

    #[test]
    fn test_get_xtream_epg_url() {
        let password = test_server::password();
        for server in ["http://example.com:8080", "http://example.com:8080/"] {
            assert_eq!(
                get_xtream_epg_url(server, "user", &password),
                format!("http://example.com:8080/xmltv.php?username=user&password={password}"),
                "{server}"
            );
        }
    }

    // ── Credentials & URL building ────────────────────────────────────

    #[test]
    fn test_credentials_strip_trailing_slash() {
        let creds = login("http://srv.example.com:8080/");
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
        let password = test_server::password();
        let creds = XtreamCredentials::new("http://srv:8080", "user1", &password);
        let start = format!("http://srv:8080/player_api.php?username=user1&password={password}");
        assert_eq!(
            creds.api_url("get_live_streams", &[]),
            format!("{start}&action=get_live_streams")
        );
        // Logging in sends an empty action.
        assert_eq!(creds.api_url("", &[]), format!("{start}&action="));
    }

    const AWKWARD_USER: &str = "me&you #1";

    /// A password with characters that would end a query value early or break
    /// a path, ahead of the test password.
    fn awkward_password() -> String {
        format!("a+b/c d&action=x#{}", test_server::password())
    }

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
        let password = awkward_password();
        let creds = XtreamCredentials::new("http://srv:8080", AWKWARD_USER, &password);
        let url = creds.api_url("get_series_info", &[("series_id", "42")]);
        assert_eq!(
            url,
            format!(
                "http://srv:8080/player_api.php?username=me%26you+%231\
                 &password=a%2Bb%2Fc+d%26action%3Dx%23{}&action=get_series_info&series_id=42",
                test_server::password()
            )
        );
        assert_eq!(
            query_pairs(&url),
            pairs(&[
                ("username", AWKWARD_USER),
                ("password", password.as_str()),
                ("action", "get_series_info"),
                ("series_id", "42"),
            ])
        );
    }

    #[test]
    fn test_get_xtream_epg_url_encodes_awkward_credentials() {
        let password = awkward_password();
        let url = get_xtream_epg_url("http://srv:8080/", AWKWARD_USER, &password);
        assert!(url.starts_with("http://srv:8080/xmltv.php?"), "{url}");
        assert_eq!(
            query_pairs(&url),
            pairs(&[("username", AWKWARD_USER), ("password", password.as_str())])
        );
    }

    #[test]
    fn test_stream_urls() {
        let password = test_server::password();
        let creds = XtreamCredentials::new("http://srv:8080", "u", &password);
        let start = "http://srv:8080";
        assert_eq!(
            creds.live_stream_url(12345, "ts"),
            format!("{start}/live/u/{password}/12345.ts")
        );
        assert_eq!(
            creds.vod_stream_url(99, "mp4"),
            format!("{start}/movie/u/{password}/99.mp4")
        );
        assert_eq!(
            creds.series_stream_url("555", "mkv"),
            format!("{start}/series/u/{password}/555.mkv")
        );
    }

    #[test]
    fn stream_urls_escape_what_would_break_the_path() {
        let password = awkward_password();
        let creds = XtreamCredentials::new("http://srv:8080", AWKWARD_USER, &password);
        let url = creds.live_stream_url(7, "ts");
        assert_eq!(
            url,
            format!(
                "http://srv:8080/live/me%26you%20%231/a%2Bb%2Fc%20d%26action=x%23{}/7.ts",
                test_server::password()
            )
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
        assert_eq!(segments, ["live", AWKWARD_USER, password.as_str(), "7.ts"]);
    }

    #[test]
    fn stream_urls_escape_question_marks_and_percent_signs() {
        let password = format!("50%off-{}", test_server::password());
        let creds = XtreamCredentials::new("http://srv:8080", "u?1", &password);
        assert_eq!(
            creds.vod_stream_url(9, "mp4"),
            format!(
                "http://srv:8080/movie/u%3F1/50%25off-{}/9.mp4",
                test_server::password()
            )
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

    fn categories() -> HashMap<String, String> {
        HashMap::from([("3".to_string(), "News".to_string())])
    }

    /// Credentials for `server` with the user `u` and the test password.
    fn login(server: &str) -> XtreamCredentials {
        XtreamCredentials::new(server, "u", &test_server::password())
    }

    #[test]
    fn test_live_channel() {
        let creds = login("http://srv");
        let stream: XtreamStream = serde_json::from_value(json!({
            "stream_id": 7,
            "name": "CNN",
            "stream_icon": "http://img/cnn.png",
            "epg_channel_id": "cnn.us",
            "category_id": "3"
        }))
        .unwrap();
        assert_eq!(
            live_channel(&creds, &categories(), stream),
            Some(Channel {
                id: "live-7".into(),
                name: "CNN".into(),
                url: format!("http://srv/live/u/{}/7.ts", test_server::password()),
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
        let creds = login("http://srv");
        let stream: XtreamStream = serde_json::from_value(json!({
            "stream_id": 9,
            "stream_icon": "",
            "epg_channel_id": "ignored",
            "category_id": "99"
        }))
        .unwrap();
        assert_eq!(
            vod_channel(&creds, &categories(), stream),
            Some(Channel {
                id: "movie-9".into(),
                name: "VOD 9".into(),
                url: format!("http://srv/movie/u/{}/9.mp4", test_server::password()),
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
            series_channel(&categories(), series),
            Some(Channel {
                id: "series-5".into(),
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
        let creds = login("http://srv");
        let stream = || serde_json::from_value::<XtreamStream>(json!({ "name": "x" })).unwrap();
        assert_eq!(live_channel(&creds, &categories(), stream()), None);
        assert_eq!(vod_channel(&creds, &categories(), stream()), None);
        let series: XtreamSeries = serde_json::from_value(json!({ "name": "x" })).unwrap();
        assert_eq!(series_channel(&categories(), series), None);
    }

    fn stream(stream_id: u64, category_id: &str) -> XtreamStream {
        serde_json::from_value(json!({ "stream_id": stream_id, "category_id": category_id }))
            .unwrap()
    }

    fn ids(channels: &[Channel]) -> Vec<&str> {
        channels.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn a_stream_listed_twice_adds_the_category_to_its_second_id() {
        let creds = login("http://srv");
        let streams = vec![
            stream(7, "3"),
            stream(8, "3"),
            stream(7, "12"),
            stream(7, "12"),
            stream(7, ""),
        ];
        let channels = channels_from(streams, |s| live_channel(&creds, &categories(), s));
        assert_eq!(
            ids(&channels),
            ["live-7", "live-8", "live-7-c12", "live-7-2", "live-7-3"]
        );
    }

    #[test]
    fn a_series_listed_twice_adds_the_category_to_its_second_id() {
        let series = |category_id: &str| -> XtreamSeries {
            serde_json::from_value(json!({ "series_id": 5, "category_id": category_id })).unwrap()
        };
        let channels = channels_from(vec![series("3"), series("12")], |s| {
            series_channel(&categories(), s)
        });
        assert_eq!(ids(&channels), ["series-5", "series-5-c12"]);
    }

    #[test]
    fn a_movie_keeps_its_poster() {
        let creds = login("http://srv");
        let stream: XtreamStream = serde_json::from_value(json!({
            "stream_id": 9,
            "stream_icon": "http://example.com/poster.jpg"
        }))
        .unwrap();
        let channel = vod_channel(&creds, &categories(), stream).unwrap();
        assert_eq!(
            channel.logo_url.as_deref(),
            Some("http://example.com/poster.jpg")
        );
    }

    #[test]
    fn a_listing_keeps_its_id_when_other_channels_move() {
        let creds = login("http://srv");
        let to_channel = |s: XtreamStream| live_channel(&creds, &categories(), s);
        let before = channels_from(vec![stream(7, "3"), stream(7, "12")], to_channel);
        let after = channels_from(
            vec![
                stream(9, "3"),
                stream(7, "3"),
                stream(8, "5"),
                stream(7, "12"),
            ],
            to_channel,
        );
        assert_eq!(ids(&before), ["live-7", "live-7-c12"]);
        assert_eq!(ids(&after), ["live-9", "live-7", "live-8", "live-7-c12"]);
    }

    #[test]
    fn a_list_that_fails_is_noted_and_the_others_are_kept() {
        let creds = login("http://srv");
        let failed = || Err(XtreamError::InvalidResponse("no answer".into()));
        let series: XtreamSeries = serde_json::from_value(json!({ "series_id": 5 })).unwrap();

        let mut fetched = XtreamChannels::default();
        fetched.add_list("live", Ok(vec![stream(7, "3")]), |s| {
            live_channel(&creds, &categories(), s)
        });
        fetched.add_list("movie", failed(), |s| vod_channel(&creds, &categories(), s));
        fetched.add_list("series", Ok(vec![series]), |s| {
            series_channel(&categories(), s)
        });

        assert_eq!(ids(&fetched.channels), ["live-7", "series-5"]);
        assert_eq!(fetched.failed_content_types, ["movie"]);
    }

    #[test]
    fn an_empty_list_is_not_a_failed_one() {
        let creds = login("http://srv");
        let mut fetched = XtreamChannels::default();
        fetched.add_list("movie", Ok(Vec::new()), |s| {
            vod_channel(&creds, &categories(), s)
        });
        assert_eq!(fetched, XtreamChannels::default());
    }

    #[test]
    fn position_ids_map_to_the_panels_ids_in_the_saved_url() {
        // A dot or slash in the password must not change where the id is read.
        let password = format!("pa.ss/word-{}", test_server::password());
        let creds = XtreamCredentials::new("http://srv:8080/", "user", &password);
        let cases = [
            ("xt-0", creds.live_stream_url(7, "ts"), "live-7"),
            ("xt-12", creds.live_stream_url(7, "m3u8"), "live-7"),
            ("vod-3", creds.vod_stream_url(812, "mkv"), "movie-812"),
            ("ser-41", "xtream://series/5".to_string(), "series-5"),
        ];
        for (position_id, url, expected) in cases {
            assert_eq!(
                id_for_position_id(position_id, &url).as_deref(),
                Some(expected),
                "{position_id}"
            );
        }
    }

    #[test]
    fn other_ids_and_urls_have_no_new_id() {
        let creds = login("http://srv");
        let live = creds.live_stream_url(7, "ts");
        for (id, url) in [
            ("live-7", live.as_str()),
            ("ch-3", live.as_str()),
            ("xt-ep-5-s1-0", "http://srv/series/u/p/100.mkv"),
            ("xt-", live.as_str()),
            ("xt-1a", live.as_str()),
            ("xt-0", "http://srv/live/u/p/stream"),
            ("xt-0", "http://srv/live/u/p/abc.ts"),
            ("vod-0", "http://srv/movie/u/p/.mp4"),
            ("ser-0", "http://srv/series/5"),
            ("ser-0", "xtream://series/"),
        ] {
            assert_eq!(id_for_position_id(id, url), None, "{id} {url}");
        }
    }

    #[test]
    fn an_episode_id_names_its_series() {
        assert_eq!(
            series_id_for_episode_id(&episode_id(42, 1, 0)).as_deref(),
            Some("series-42")
        );
        for id in [
            "xt-ep-",
            "xt-ep-42",
            "xt-ep--s1-0",
            "xt-ep-x-s1-0",
            "ser-42",
            "series-42",
        ] {
            assert_eq!(series_id_for_episode_id(id), None, "{id}");
        }
    }

    // ── Talking to a panel ─────────────────────────────────────────────

    const AUTH_OK: &str = r#"{"user_info":{"auth":1,"status":"Active"}}"#;

    /// A client for a local test server, shared across tests like the real one.
    fn panel(server: &str) -> XtreamClient {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        XtreamClient {
            credentials: login(server),
            client: CLIENT.get_or_init(test_server::client),
        }
    }

    /// A panel that accepts the login and lists one live channel, one movie
    /// and one series. Routes in `overrides` win over these. The trailing
    /// space ends the action, so `get_series` doesn't match the other series
    /// actions.
    fn serve_panel(overrides: Vec<Route>) -> String {
        let defaults = vec![
            route("action= ", "200 OK", AUTH_OK),
            route(
                "action=get_live_streams ",
                "200 OK",
                r#"[{"stream_id":7,"name":"CNN","category_id":"3"},{"name":"no id"}]"#,
            ),
            route(
                "action=get_live_categories ",
                "200 OK",
                r#"[{"category_id":"3","category_name":"News"}]"#,
            ),
            route(
                "action=get_vod_streams ",
                "200 OK",
                r#"[{"stream_id":9,"name":"Heat","category_id":"5","container_extension":"mkv"}]"#,
            ),
            route(
                "action=get_vod_categories ",
                "200 OK",
                r#"[{"category_id":"5","category_name":"Movies"}]"#,
            ),
            route(
                "action=get_series ",
                "200 OK",
                r#"[{"series_id":4,"name":"The Wire","category_id":"8"}]"#,
            ),
            route(
                "action=get_series_categories ",
                "200 OK",
                r#"[{"category_id":"8","category_name":"Drama"}]"#,
            ),
        ];
        serve_routes(overrides.into_iter().chain(defaults).collect()).0
    }

    fn id_group_url(channels: &[Channel]) -> Vec<(&str, &str, &str)> {
        channels
            .iter()
            .map(|c| (c.id.as_str(), c.group_title.as_str(), c.url.as_str()))
            .collect()
    }

    #[tokio::test]
    async fn either_auth_1_or_an_active_status_counts_as_logged_in() {
        for (body, accepted) in [
            (r#"{"user_info":{"auth":1,"status":"Expired"}}"#, true),
            (r#"{"user_info":{"auth":0,"status":"Active"}}"#, true),
            (r#"{"user_info":{"auth":0,"status":"Banned"}}"#, false),
            (r#"{"user_info":{}}"#, false),
            ("{}", false),
        ] {
            let result = panel(&serve_once("200 OK", body)).authenticate().await;
            if accepted {
                assert!(result.is_ok(), "{body}: {result:?}");
            } else {
                assert!(matches!(result, Err(XtreamError::AuthFailed)), "{body}");
            }
        }
    }

    #[tokio::test]
    async fn reads_the_output_formats_the_login_allows() {
        for (body, expected) in [
            (
                r#"{"user_info":{"auth":1,"allowed_output_formats":["m3u8"," TS ",""]}}"#,
                vec!["m3u8", "ts"],
            ),
            (r#"{"user_info":{"auth":1,"allowed_output_formats":["ts",3]}}"#, vec!["ts"]),
            (r#"{"user_info":{"auth":1,"allowed_output_formats":"ts"}}"#, vec![]),
            (r#"{"user_info":{"auth":1}}"#, vec![]),
        ] {
            let formats = panel(&serve_once("200 OK", body)).output_formats().await.unwrap();
            assert_eq!(formats, expected, "{body}");
        }
        let refused = r#"{"user_info":{"auth":0,"allowed_output_formats":["ts"]}}"#;
        let result = panel(&serve_once("200 OK", refused)).output_formats().await;
        assert!(matches!(result, Err(XtreamError::AuthFailed)));
    }

    #[tokio::test]
    async fn replies_that_are_not_json_are_network_errors() {
        let (server, _) = serve_in_order(&[
            ("503 Service Unavailable", "<html>Maintenance</html>"),
            ("200 OK", "<html>Maintenance</html>"),
        ]);
        let client = panel(&server);
        let login = client.authenticate().await.unwrap_err();
        let episodes = client
            .fetch_series_episodes(1, "Show", None, "Drama")
            .await
            .unwrap_err();
        for err in [login, episodes] {
            assert!(matches!(err, XtreamError::Network(_)), "{err:?}");
        }
    }

    #[tokio::test]
    async fn a_refresh_lists_live_channels_then_movies_then_series() {
        let server = serve_panel(vec![]);
        let password = test_server::password();
        let fetched = fetch_all_channels(&panel(&server)).await.unwrap();
        assert_eq!(
            id_group_url(&fetched.channels),
            [
                (
                    "live-7",
                    "News",
                    format!("{server}/live/u/{password}/7.ts").as_str()
                ),
                (
                    "movie-9",
                    "Movies",
                    format!("{server}/movie/u/{password}/9.mkv").as_str()
                ),
                ("series-4", "Drama", "xtream://series/4"),
            ]
        );
        assert!(fetched.failed_content_types.is_empty());
    }

    #[tokio::test]
    async fn a_failed_endpoint_leaves_out_only_what_it_would_have_listed() {
        let server = serve_panel(vec![
            route(
                "action=get_vod_streams ",
                "500 Internal Server Error",
                "<html>oops</html>",
            ),
            route("action=get_series_categories ", "200 OK", "not json"),
        ]);
        let live = format!("{server}/live/u/{}/7.ts", test_server::password());
        let logged = Logged::default();
        let fetched = {
            let _guard = logged.start();
            fetch_all_channels(&panel(&server)).await.unwrap()
        };
        assert_eq!(
            id_group_url(&fetched.channels),
            [
                ("live-7", "News", live.as_str()),
                ("series-4", "Uncategorized", "xtream://series/4"),
            ]
        );
        // A failed category list only loses the group names.
        assert_eq!(fetched.failed_content_types, ["movie"]);
        // Both failures are logged, without the login.
        let log = logged.text();
        assert!(log.contains("[Xtream] get_vod_streams failed: "), "{log}");
        assert!(
            log.contains("[Xtream] get_series_categories failed: "),
            "{log}"
        );
        assert!(!log.contains(&test_server::password()), "{log}");
    }

    #[tokio::test]
    async fn a_failed_live_list_still_lists_movies_and_series() {
        let server = serve_panel(vec![route(
            "action=get_live_streams ",
            "503 Service Unavailable",
            "",
        )]);
        let fetched = fetch_all_channels(&panel(&server)).await.unwrap();
        assert_eq!(ids(&fetched.channels), ["movie-9", "series-4"]);
        assert_eq!(fetched.failed_content_types, ["live"]);
    }

    #[tokio::test]
    async fn a_list_sent_with_an_error_status_counts_as_failed() {
        // Both bodies parse as empty lists, which would read as lists the
        // panel emptied.
        let server = serve_panel(vec![
            route("action=get_vod_streams ", "500 Internal Server Error", "[]"),
            route("action=get_series ", "404 Not Found", "[]"),
        ]);
        let fetched = fetch_all_channels(&panel(&server)).await.unwrap();
        assert_eq!(ids(&fetched.channels), ["live-7"]);
        assert_eq!(fetched.failed_content_types, ["movie", "series"]);
    }

    #[tokio::test]
    async fn a_category_list_sent_with_an_error_status_is_not_used() {
        let server = serve_panel(vec![route(
            "action=get_live_categories ",
            "500 Internal Server Error",
            r#"[{"category_id":"3","category_name":"Stale"}]"#,
        )]);
        let fetched = fetch_all_channels(&panel(&server)).await.unwrap();
        let groups: Vec<(&str, &str)> = fetched
            .channels
            .iter()
            .map(|c| (c.id.as_str(), c.group_title.as_str()))
            .collect();
        assert_eq!(
            groups,
            [
                ("live-7", "Uncategorized"),
                ("movie-9", "Movies"),
                ("series-4", "Drama"),
            ]
        );
        assert!(fetched.failed_content_types.is_empty());
    }

    #[tokio::test]
    async fn an_error_status_does_not_show_the_login() {
        let server = serve_once("500 Internal Server Error", "[]");
        let err = panel(&server)
            .get_list::<XtreamStream>("get_vod_streams")
            .await
            .unwrap_err();
        assert!(matches!(err, XtreamError::Network(_)), "{err:?}");
        assert_hides(&err, &test_server::password());
    }

    #[tokio::test]
    async fn a_panel_with_nothing_to_list_is_an_invalid_response() {
        let server = serve_panel(vec![
            route("action=get_live_streams ", "200 OK", "[]"),
            route("action=get_vod_streams ", "200 OK", "[]"),
            route("action=get_series ", "404 Not Found", ""),
        ]);
        let err = fetch_all_channels(&panel(&server)).await.unwrap_err();
        assert!(
            matches!(&err, XtreamError::InvalidResponse(m) if m == "No streams returned from any endpoint"),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn a_rejected_login_stops_before_any_list_is_fetched() {
        let (server, requests) = serve_routes(vec![route(
            "action= ",
            "200 OK",
            r#"{"user_info":{"auth":0,"status":"Expired"}}"#,
        )]);
        let err = fetch_all_channels(&panel(&server)).await.unwrap_err();
        assert!(matches!(err, XtreamError::AuthFailed), "{err:?}");
        assert_eq!(requests.try_iter().count(), 1);
    }

    #[tokio::test]
    async fn series_episodes_are_named_and_sorted_by_season_and_episode() {
        let body = json!({
            "info": { "name": "The Wire", "cover": "http://img.example.test/wire.jpg" },
            "episodes": {
                "2": [
                    { "id": "201", "episode_num": 1, "title": "Ebb Tide", "container_extension": "mp4" }
                ],
                "1": [
                    { "id": 102, "episode_num": "2", "title": "" },
                    { "id": "101", "episode_num": 1, "title": "The Target" },
                    { "episode_num": 3, "title": "No id" }
                ],
                "specials": [
                    { "id": 900, "title": "Making Of" },
                    { "id": 901 }
                ]
            }
        });
        let (server, requests) = serve_once_recording("200 OK", body.to_string());
        let password = test_server::password();
        let episodes = panel(&server)
            .fetch_series_episodes(42, "Wire", Some("http://img.example.test/old.jpg"), "Drama")
            .await
            .unwrap();
        let names: Vec<(&str, &str)> = episodes
            .iter()
            .map(|e| (e.id.as_str(), e.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("xt-ep-42-s0-0", "The Wire S00 Making Of"),
                ("xt-ep-42-s0-1", "The Wire S00 Ep1"),
                ("xt-ep-42-s1-1", "The Wire S01E01 The Target"),
                ("xt-ep-42-s1-0", "The Wire S01E02"),
                ("xt-ep-42-s2-0", "The Wire S02E01 Ebb Tide"),
            ]
        );
        assert_eq!(
            episodes[4],
            Channel {
                id: "xt-ep-42-s2-0".into(),
                name: "The Wire S02E01 Ebb Tide".into(),
                url: format!("{server}/series/u/{password}/201.mp4"),
                logo_url: Some("http://img.example.test/wire.jpg".into()),
                group_title: "Drama".into(),
                content_type: "series".into(),
                series_title: Some("The Wire".into()),
                season: Some(2),
                episode: Some(1),
                ..Default::default()
            }
        );
        assert_eq!(
            episodes[1].url,
            format!("{server}/series/u/{password}/901.mkv")
        );
        let request = requests.try_recv().unwrap();
        assert!(
            request.starts_with(&format!(
                "GET /player_api.php?username=u&password={password}\
                 &action=get_series_info&series_id=42 "
            )),
            "{request}"
        );
    }

    #[tokio::test]
    async fn series_info_without_a_name_or_cover_keeps_the_list_entry() {
        let (server, _) = serve_in_order(&[
            (
                "200 OK",
                &json!({
                    "info": { "name": "", "cover": "" },
                    "episodes": { "1": [{ "id": 5, "episode_num": 1 }] }
                })
                .to_string(),
            ),
            ("200 OK", &json!({ "info": null }).to_string()),
        ]);
        let client = panel(&server);
        let logo = Some("http://img.example.test/wire.jpg");
        let episodes = client
            .fetch_series_episodes(42, "Wire", logo, "Drama")
            .await
            .unwrap();
        assert_eq!(episodes.len(), 1);
        assert_eq!(episodes[0].name, "Wire S01E01");
        assert_eq!(episodes[0].series_title.as_deref(), Some("Wire"));
        assert_eq!(episodes[0].logo_url.as_deref(), logo);
        let none = client
            .fetch_series_episodes(42, "Wire", logo, "Drama")
            .await
            .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn clients_use_the_shared_download_client() {
        let client = XtreamClient::new(login("http://srv"));
        assert!(std::ptr::eq(client.client, crate::http::download_client()));
    }

    #[tokio::test]
    async fn the_public_fetches_fail_without_showing_the_login() {
        // A URL without a host fails before anything is sent, with the request
        // URL and so the login in its error.
        let password = test_server::password();
        let channels = fetch_xtream_channels("unix:/panel", "u", &password)
            .await
            .unwrap_err();
        let episodes =
            fetch_xtream_series_episodes("unix:/panel", "u", &password, 1, "Show", None, "Drama")
                .await
                .unwrap_err();
        for err in [channels, episodes] {
            assert!(matches!(err, XtreamError::Network(_)), "{err:?}");
            assert_hides(&err, &password);
        }
    }
}
