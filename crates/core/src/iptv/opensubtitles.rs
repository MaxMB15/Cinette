// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// TTL for OpenSubtitles search cache: 24 hours.
pub const SEARCH_CACHE_TTL_SECS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleEntry {
    pub file_id: i64,
    pub language_code: String,
    pub format: String,
    pub release_name: Option<String>,
    pub download_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSearchResult {
    pub entries: Vec<SubtitleEntry>,
    pub languages: Vec<String>,
}

#[derive(Debug, Error)]
pub enum OpenSubtitlesError {
    #[error("HTTP request failed: {0}")]
    Http(#[source] reqwest::Error),
    #[error("OpenSubtitles API error: {0}")]
    Api(String),
    #[error("Parse error: {0}")]
    Parse(String),
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
    #[allow(dead_code)]
    total_count: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SubtitleItem {
    #[allow(dead_code)]
    id: Option<String>,
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
    #[allow(dead_code)]
    cd_number: Option<i64>,
    file_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DownloadResponse {
    link: String,
    file_name: String,
    #[allow(dead_code)]
    requests: Option<i64>,
    #[allow(dead_code)]
    remaining: Option<i64>,
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
    let numeric_id = strip_tt_prefix(imdb_id);

    let mut query: Vec<(&str, String)> = vec![("imdb_id", numeric_id.to_string())];

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

    let client = crate::http::client();
    let response = client
        .get("https://api.opensubtitles.com/api/v1/subtitles")
        .query(&query)
        .header("Api-Key", api_key)
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    parse_search_response(response)
}

/// Download a subtitle file by file_id to the given directory.
/// Returns the path to the downloaded file.
/// If the file already exists in dest_dir, returns the existing path without downloading.
pub async fn download_subtitle(
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
    let client = crate::http::client();
    let post_body = serde_json::json!({ "file_id": file_id });

    let dl_response: DownloadResponse = client
        .post("https://api.opensubtitles.com/api/v1/download")
        .header("Api-Key", api_key)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&post_body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        assert!(!err.to_string().contains("SECRET"), "{err}");
        assert!(!format!("{err:?}").contains("SECRET"), "{err:?}");
    }
}
