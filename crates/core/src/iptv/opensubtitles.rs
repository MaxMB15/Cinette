// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Subtitle search and download through the OpenSubtitles API.

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

const OPENSUBTITLES_URL: &str = "https://api.opensubtitles.com/api/v1";

/// How long a cached search stays fresh. New subtitles for a title turn up
/// rarely, so a day saves requests without hiding much.
pub const SEARCH_CACHE_TTL_SECS: i64 = 24 * 60 * 60;

/// One subtitle file the user can pick. `file_id` is what a download asks for.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleEntry {
    pub file_id: i64,
    pub language_code: String,
    pub format: String,
    pub release_name: Option<String>,
    pub download_count: Option<i64>,
}

/// The subtitles found for a title, with the languages among them so the
/// picker can group entries by language.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSearchResult {
    pub entries: Vec<SubtitleEntry>,
    pub languages: Vec<String>,
}

/// Errors from searching for or downloading subtitles.
#[derive(Debug, Error)]
pub enum OpenSubtitlesError {
    /// The request failed or the server answered with an error status.
    #[error("HTTP request failed: {0}")]
    Http(#[source] reqwest::Error),
    /// OpenSubtitles rejected the API key. Kept apart from `Http` so a key test
    /// can report a wrong key rather than a failed request.
    #[error("OpenSubtitles API error: {0}")]
    Api(String),
    /// The response was not in the expected shape.
    #[error("Parse error: {0}")]
    Parse(String),
    /// The subtitle file could not be saved.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

// Request URLs can carry API keys and logins, so they are dropped before the
// error can reach a log or the UI.
impl From<reqwest::Error> for OpenSubtitlesError {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e.without_url())
    }
}

// --- Raw API response shapes ---

#[derive(Debug, Deserialize)]
struct SearchResponse {
    data: Vec<SubtitleItem>,
}

#[derive(Debug, Deserialize)]
struct SubtitleItem {
    attributes: SubtitleAttributes,
}

#[derive(Debug, Deserialize)]
struct SubtitleAttributes {
    language: Option<String>,
    release: Option<String>,
    download_count: Option<i64>,
    files: Option<Vec<SubtitleFile>>,
}

#[derive(Debug, Deserialize)]
struct SubtitleFile {
    file_id: Option<i64>,
    file_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DownloadResponse {
    link: String,
    file_name: String,
}

// --- Helpers ---

/// Strip the "tt" prefix from an IMDB ID, returning the numeric portion.
/// If the ID does not start with "tt", it is returned as-is.
fn strip_tt_prefix(imdb_id: &str) -> &str {
    imdb_id.strip_prefix("tt").unwrap_or(imdb_id)
}

/// Extract a file extension from a filename (e.g. "movie.srt" → "srt").
/// Returns an empty string if no extension is found.
fn extract_extension(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// Parse a raw search API JSON value into a `SubtitleSearchResult`.
/// Separated from the HTTP call for unit testing.
pub fn parse_search_response(
    json: serde_json::Value,
) -> Result<SubtitleSearchResult, OpenSubtitlesError> {
    let resp: SearchResponse =
        serde_json::from_value(json).map_err(|e| OpenSubtitlesError::Parse(e.to_string()))?;

    let mut entries: Vec<SubtitleEntry> = Vec::new();

    for item in resp.data {
        let attrs = item.attributes;
        let language_code = attrs.language.unwrap_or_default();
        let release_name = attrs.release;
        let download_count = attrs.download_count;

        // Take the first file in the files array.
        let file = match attrs.files.and_then(|f| f.into_iter().next()) {
            Some(f) => f,
            None => continue,
        };

        let file_id = match file.file_id {
            Some(id) => id,
            None => continue,
        };

        let format = file
            .file_name
            .as_deref()
            .map(extract_extension)
            .unwrap_or_default();

        entries.push(SubtitleEntry {
            file_id,
            language_code,
            format,
            release_name,
            download_count,
        });
    }

    // Build sorted unique languages list.
    let mut languages: Vec<String> = entries
        .iter()
        .map(|e| e.language_code.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    languages.sort();

    Ok(SubtitleSearchResult { entries, languages })
}

// --- Public API ---

/// Search for subtitles for a movie or episode.
/// `imdb_id` is the full IMDB ID (e.g. "tt0468569").
/// `season` and `episode` are Some for TV episodes, None for movies.
pub async fn search_subtitles(
    imdb_id: &str,
    season: Option<u32>,
    episode: Option<u32>,
    api_key: &str,
) -> Result<SubtitleSearchResult, OpenSubtitlesError> {
    search_from(
        crate::http::client(),
        OPENSUBTITLES_URL,
        imdb_id,
        season,
        episode,
        api_key,
    )
    .await
}

/// The work of [`search_subtitles`], taking the client and address so tests
/// can point it at a local server.
async fn search_from(
    client: &reqwest::Client,
    api_url: &str,
    imdb_id: &str,
    season: Option<u32>,
    episode: Option<u32>,
    api_key: &str,
) -> Result<SubtitleSearchResult, OpenSubtitlesError> {
    let response = search_request(client, api_url, imdb_id, season, episode, api_key)
        .send()
        .await?;
    let json = check_status(response)?.json::<serde_json::Value>().await?;

    parse_search_response(json)
}

fn search_request(
    client: &reqwest::Client,
    api_url: &str,
    imdb_id: &str,
    season: Option<u32>,
    episode: Option<u32>,
    api_key: &str,
) -> reqwest::RequestBuilder {
    let mut query: Vec<(&str, String)> = vec![("imdb_id", strip_tt_prefix(imdb_id).to_string())];

    match (season, episode) {
        (Some(s), Some(e)) => {
            query.push(("type", "episode".to_string()));
            query.push(("season_number", s.to_string()));
            query.push(("episode_number", e.to_string()));
        }
        _ => {
            query.push(("type", "movie".to_string()));
        }
    }

    with_api_key(
        client.get(format!("{api_url}/subtitles")).query(&query),
        api_key,
    )
}

fn download_link_request(
    client: &reqwest::Client,
    api_url: &str,
    file_id: i64,
    api_key: &str,
) -> reqwest::RequestBuilder {
    with_api_key(
        client
            .post(format!("{api_url}/download"))
            .json(&serde_json::json!({ "file_id": file_id })),
        api_key,
    )
}

// Keys are pasted in, often with a trailing newline, and a header can't carry one.
fn with_api_key(request: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    request
        .header("Api-Key", api_key.trim())
        .header("Accept", "application/json")
}

/// Download a subtitle file by file_id to the given directory.
/// Returns the path to the downloaded file.
/// If the file already exists in dest_dir, returns the existing path without downloading.
pub async fn download_subtitle(
    file_id: i64,
    api_key: &str,
    dest_dir: &Path,
) -> Result<PathBuf, OpenSubtitlesError> {
    download_from(
        crate::http::client(),
        OPENSUBTITLES_URL,
        file_id,
        api_key,
        dest_dir,
    )
    .await
}

/// The work of [`download_subtitle`], taking the client and address so tests
/// can point it at a local server.
async fn download_from(
    client: &reqwest::Client,
    api_url: &str,
    file_id: i64,
    api_key: &str,
    dest_dir: &Path,
) -> Result<PathBuf, OpenSubtitlesError> {
    // Check for already-cached file (srt or vtt).
    for ext in &["srt", "vtt"] {
        let candidate = dest_dir.join(format!("{file_id}.{ext}"));
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // Step 1: POST /download to get a pre-signed download link.
    let response = download_link_request(client, api_url, file_id, api_key)
        .send()
        .await?;
    let dl_response: DownloadResponse = check_status(response)?.json().await?;

    let extension = extract_extension(&dl_response.file_name);
    let extension = if extension.is_empty() {
        "srt".to_string()
    } else {
        extension
    };

    // Step 2: GET the pre-signed link (no auth headers needed).
    // Request uncompressed content so the bytes written to disk are valid SRT/VTT.
    let content = client
        .get(&dl_response.link)
        .header("Accept-Encoding", "identity")
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    std::fs::create_dir_all(dest_dir)?;
    let dest_path = dest_dir.join(format!("{file_id}.{extension}"));
    std::fs::write(&dest_path, content)?;

    Ok(dest_path)
}

fn check_status(response: reqwest::Response) -> Result<reqwest::Response, OpenSubtitlesError> {
    match rejected_key(response.status()) {
        Some(err) => Err(err),
        None => Ok(response.error_for_status()?),
    }
}

/// OpenSubtitles answers a wrong or revoked key with 401 or 403. Reporting that
/// as an API error rather than an HTTP one lets the app tell the user the key is
/// wrong instead of blaming the network.
fn rejected_key(status: StatusCode) -> Option<OpenSubtitlesError> {
    matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        .then(|| OpenSubtitlesError::Api(format!("key rejected with HTTP {}", status.as_u16())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::test_server::{self, header};
    use serde_json::json;
    use std::sync::mpsc::Receiver;

    #[test]
    fn spaces_around_the_key_are_ignored() {
        let client = crate::http::client();
        for request in [
            search_request(client, OPENSUBTITLES_URL, "tt0468569", None, None, " KEY\n"),
            download_link_request(client, OPENSUBTITLES_URL, 1, " KEY\n"),
        ] {
            let request = request.build().unwrap();
            assert_eq!(request.headers()["Api-Key"], "KEY");
        }
    }

    #[test]
    fn episode_searches_name_the_season_and_episode() {
        let request = search_request(
            crate::http::client(),
            OPENSUBTITLES_URL,
            "tt0903747",
            Some(2),
            Some(5),
            "KEY",
        )
        .build()
        .unwrap();
        assert_eq!(
            request.url().query(),
            Some("imdb_id=0903747&type=episode&season_number=2&episode_number=5")
        );
    }

    #[test]
    fn test_strip_tt_prefix() {
        assert_eq!(strip_tt_prefix("tt0468569"), "0468569");
        assert_eq!(strip_tt_prefix("tt1375666"), "1375666");
        // Already numeric — pass through unchanged.
        assert_eq!(strip_tt_prefix("0468569"), "0468569");
        // Edge case: "tt" with no digits.
        assert_eq!(strip_tt_prefix("tt"), "");
    }

    #[test]
    fn test_parse_search_response() {
        let json = json!({
            "total_count": 2,
            "data": [
                {
                    "id": "sub1",
                    "type": "subtitle",
                    "attributes": {
                        "subtitle_id": "1",
                        "language": "en",
                        "release": "The.Dark.Knight.2008.BluRay",
                        "download_count": 5000,
                        "files": [
                            {
                                "file_id": 4052244,
                                "cd_number": 1,
                                "file_name": "The.Dark.Knight.2008.srt"
                            }
                        ]
                    }
                },
                {
                    "id": "sub2",
                    "type": "subtitle",
                    "attributes": {
                        "subtitle_id": "2",
                        "language": "fr",
                        "release": "The.Dark.Knight.2008.FRENCH",
                        "download_count": 1200,
                        "files": [
                            {
                                "file_id": 9988776,
                                "cd_number": 1,
                                "file_name": "The.Dark.Knight.2008.fr.srt"
                            }
                        ]
                    }
                }
            ]
        });

        let result = parse_search_response(json).unwrap();
        assert_eq!(result.entries.len(), 2);

        let en = result
            .entries
            .iter()
            .find(|e| e.language_code == "en")
            .unwrap();
        assert_eq!(en.file_id, 4052244);
        assert_eq!(en.format, "srt");
        assert_eq!(
            en.release_name.as_deref(),
            Some("The.Dark.Knight.2008.BluRay")
        );
        assert_eq!(en.download_count, Some(5000));

        let fr = result
            .entries
            .iter()
            .find(|e| e.language_code == "fr")
            .unwrap();
        assert_eq!(fr.file_id, 9988776);

        // Languages list is sorted and unique.
        assert_eq!(result.languages, vec!["en", "fr"]);
    }

    #[test]
    fn test_parse_empty_search_response() {
        let json = json!({
            "total_count": 0,
            "data": []
        });

        let result = parse_search_response(json).unwrap();
        assert!(result.entries.is_empty());
        assert!(result.languages.is_empty());
    }

    #[test]
    fn test_parse_response_skips_entries_without_files() {
        let json = json!({
            "total_count": 1,
            "data": [
                {
                    "id": "sub1",
                    "attributes": {
                        "language": "en",
                        "download_count": 100,
                        "files": []
                    }
                }
            ]
        });

        let result = parse_search_response(json).unwrap();
        assert!(result.entries.is_empty());
        assert!(result.languages.is_empty());
    }

    #[test]
    fn entries_whose_file_has_no_id_are_skipped() {
        let json = json!({
            "data": [
                {
                    "attributes": {
                        "language": "en",
                        "files": [{ "file_name": "a.srt" }]
                    }
                },
                {
                    "attributes": {
                        "language": "de",
                        "files": [{ "file_id": 2, "file_name": "b.srt" }]
                    }
                }
            ]
        });

        let result = parse_search_response(json).unwrap();
        let ids: Vec<i64> = result.entries.iter().map(|e| e.file_id).collect();
        assert_eq!(ids, [2]);
        assert_eq!(result.languages, ["de"]);
    }

    #[test]
    fn test_extract_extension() {
        assert_eq!(extract_extension("movie.srt"), "srt");
        assert_eq!(extract_extension("movie.vtt"), "vtt");
        assert_eq!(extract_extension("movie.SRT"), "srt"); // lowercased
        assert_eq!(extract_extension("no_extension"), "");
        assert_eq!(extract_extension(""), "");
    }

    #[test]
    fn test_subtitle_entry_serializes_to_camel_case() {
        let entry = SubtitleEntry {
            file_id: 123,
            language_code: "en".into(),
            format: "srt".into(),
            release_name: Some("Test.Release".into()),
            download_count: Some(999),
        };
        let s = serde_json::to_string(&entry).unwrap();
        assert!(s.contains("\"fileId\""));
        assert!(s.contains("\"languageCode\""));
        assert!(!s.contains("\"languageName\""));
        assert!(s.contains("\"releaseName\""));
        assert!(s.contains("\"downloadCount\""));
    }

    #[test]
    fn http_errors_leave_out_the_request_url() {
        let err = OpenSubtitlesError::from(crate::http::error_with_url("unix:/file?token=SECRET"));
        test_server::assert_hides(&err, "SECRET");
    }

    #[test]
    fn a_rejected_key_is_an_api_error() {
        for status in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
            let err = rejected_key(status);
            assert!(matches!(err, Some(OpenSubtitlesError::Api(_))), "{err:?}");
        }
    }

    #[test]
    fn other_statuses_are_left_to_the_http_check() {
        for status in [
            StatusCode::OK,
            StatusCode::NOT_FOUND,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert!(rejected_key(status).is_none(), "{status}");
        }
    }

    // --- Requests against a local server ---

    #[tokio::test]
    async fn a_search_sends_the_title_and_key_and_lists_what_it_finds() {
        let found = json!({
            "data": [{
                "attributes": {
                    "language": "en",
                    "release": "Heat.1995.BluRay",
                    "download_count": 10,
                    "files": [{ "file_id": 7, "file_name": "Heat.1995.srt" }]
                }
            }]
        });
        let (server, client, requests) =
            test_server::serve_once_with_client("200 OK", found.to_string());

        let result = search_from(&client, &server, "tt0113277", None, None, "KEY")
            .await
            .unwrap();

        assert_eq!(result, parse_search_response(found).unwrap());
        let request = requests.try_recv().unwrap();
        assert!(
            request.starts_with("GET /subtitles?imdb_id=0113277&type=movie HTTP/1.1"),
            "{request}"
        );
        assert_eq!(header(&request, "api-key"), Some("KEY"), "{request}");
    }

    #[tokio::test]
    async fn searches_and_downloads_with_a_rejected_key_are_api_errors() {
        let (server, client, _) = test_server::serve_once_with_client("401 Unauthorized", "");
        let result = search_from(&client, &server, "tt0113277", None, None, "KEY").await;
        assert!(
            matches!(&result, Err(OpenSubtitlesError::Api(m)) if m == "key rejected with HTTP 401"),
            "{result:?}"
        );

        let dest = tempfile::tempdir().unwrap();
        let server = test_server::serve_once("403 Forbidden", "");
        let result = download_from(&client, &server, 7, "KEY", dest.path()).await;
        assert!(
            matches!(&result, Err(OpenSubtitlesError::Api(m)) if m == "key rejected with HTTP 403"),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn a_failed_search_is_an_http_error() {
        let (server, client, _) =
            test_server::serve_once_with_client("500 Internal Server Error", "");
        let result = search_from(&client, &server, "tt0113277", None, None, "KEY").await;
        assert!(
            matches!(result, Err(OpenSubtitlesError::Http(_))),
            "{result:?}"
        );
    }

    /// Serves a subtitle file at `/temp/abc`, answering with `status` and
    /// `file`. A separate API server hands out the link to it along with
    /// `file_name`, the name the API reports for the file, the way
    /// OpenSubtitles does. Returns the API's URL, a client and the requests
    /// each server read.
    fn serve_download(
        file_name: &str,
        status: &str,
        file: &str,
    ) -> (String, reqwest::Client, Receiver<String>, Receiver<String>) {
        let (files, file_requests) = test_server::serve_once_recording(status, file);
        let link = json!({ "link": format!("{files}/temp/abc"), "file_name": file_name });
        let (api, client, api_requests) =
            test_server::serve_once_with_client("200 OK", link.to_string());
        (api, client, api_requests, file_requests)
    }

    #[tokio::test]
    async fn a_subtitle_is_saved_from_its_link_without_sending_the_key_there() {
        let (api, client, api_requests, file_requests) =
            serve_download("Heat.1995.VTT", "200 OK", "WEBVTT\n");
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("subtitles");

        let path = download_from(&client, &api, 7, "KEY", &dest).await.unwrap();

        assert_eq!(path, dest.join("7.vtt"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "WEBVTT\n");
        let api_request = api_requests.try_recv().unwrap();
        assert!(
            api_request.starts_with("POST /download HTTP/1.1"),
            "{api_request}"
        );
        assert_eq!(
            header(&api_request, "api-key"),
            Some("KEY"),
            "{api_request}"
        );
        assert!(api_request.ends_with(r#"{"file_id":7}"#), "{api_request}");
        // The link is on another host, which has no business seeing the key.
        let file_request = file_requests.try_recv().unwrap();
        assert!(
            file_request.starts_with("GET /temp/abc HTTP/1.1"),
            "{file_request}"
        );
        assert_eq!(header(&file_request, "api-key"), None, "{file_request}");
        assert_eq!(
            header(&file_request, "accept-encoding"),
            Some("identity"),
            "{file_request}"
        );
    }

    #[tokio::test]
    async fn a_file_name_without_an_extension_is_saved_as_srt() {
        let (api, client, _, _) = serve_download("subtitle", "200 OK", "1\n");
        let dest = tempfile::tempdir().unwrap();
        let path = download_from(&client, &api, 7, "KEY", dest.path())
            .await
            .unwrap();
        assert_eq!(path, dest.path().join("7.srt"));
    }

    #[tokio::test]
    async fn a_subtitle_already_on_disk_is_not_downloaded_again() {
        let dest = tempfile::tempdir().unwrap();
        let saved = dest.path().join("7.vtt");
        std::fs::write(&saved, "WEBVTT\n").unwrap();
        // Any request to this address fails, so only the saved file can
        // give an answer.
        let client = test_server::client();
        let path = download_from(&client, "unix:/", 7, "KEY", dest.path())
            .await
            .unwrap();
        assert_eq!(path, saved);
    }

    #[tokio::test]
    async fn a_link_that_fails_saves_nothing() {
        let (api, client, _, _) = serve_download("Heat.srt", "404 Not Found", "");
        let dest = tempfile::tempdir().unwrap();
        let result = download_from(&client, &api, 7, "KEY", dest.path()).await;
        assert!(
            matches!(result, Err(OpenSubtitlesError::Http(_))),
            "{result:?}"
        );
        assert_eq!(std::fs::read_dir(dest.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn a_folder_that_cannot_be_made_is_an_io_error() {
        let (api, client, _, _) = serve_download("Heat.srt", "200 OK", "1\n");
        let dir = tempfile::tempdir().unwrap();
        let taken = dir.path().join("taken");
        std::fs::write(&taken, "").unwrap();
        let result = download_from(&client, &api, 7, "KEY", &taken.join("subtitles")).await;
        assert!(
            matches!(result, Err(OpenSubtitlesError::Io(_))),
            "{result:?}"
        );
    }
}
