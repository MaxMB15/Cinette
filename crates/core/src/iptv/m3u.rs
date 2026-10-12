// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::models::channel::Channel;
use rayon::prelude::*;
use std::io::BufRead;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum M3uError {
    #[error("invalid M3U format: missing #EXTM3U header")]
    MissingHeader,
    #[error("network error: {0}")]
    Network(#[source] reqwest::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse error at line {line}: {message}")]
    Parse { line: usize, message: String },
}

// Playlist URLs often carry the login, so it is dropped before the error can
// reach a log or the UI.
impl From<reqwest::Error> for M3uError {
    fn from(e: reqwest::Error) -> Self {
        Self::Network(e.without_url())
    }
}

/// Parse an M3U playlist from an in-memory string.
/// Good for small/medium playlists. For large files use `parse_m3u_file`.
pub fn parse_m3u(content: &str) -> Result<Vec<Channel>, M3uError> {
    let trimmed = strip_bom(content.trim());
    if !trimmed.starts_with("#EXTM3U") {
        return Err(M3uError::MissingHeader);
    }

    let lines: Vec<&str> = trimmed.lines().collect();
    let blocks = collect_blocks_from_lines(&lines);

    let channels: Vec<Channel> = blocks
        .par_iter()
        .enumerate()
        .filter_map(|(idx, (extinf, url))| parse_extinf_block(idx, extinf, url))
        .collect();

    // Deduplicate: same content is often listed under multiple group-title categories
    // (e.g., "Movies Albania" + "Server 4"). Keep first occurrence of each (name, url) pair.
    let mut seen = std::collections::HashSet::<(String, String)>::new();
    let channels: Vec<Channel> = channels
        .into_iter()
        .filter(|ch| seen.insert((ch.name.clone(), ch.url.clone())))
        .collect();

    // Group movies with the same title under a single entry; extra URLs go into sources.
    let channels = group_movie_sources(channels);
    // Group series episodes with the same (series_title, season, episode) similarly.
    let channels = group_series_episodes(channels);

    Ok(channels)
}

/// Parse an M3U file from disk using a memory-mapped view of the file.
/// The OS maps the file into virtual memory without copying it — no per-line
/// allocations, and parallel block detection runs across all CPU cores.
pub fn parse_m3u_file(path: &Path) -> Result<Vec<Channel>, M3uError> {
    let file = std::fs::File::open(path)?;
    // SAFETY: the file is read-only and not modified while the map is live.
    let mmap = unsafe { memmap2::Mmap::map(&file)? };
    parse_m3u_bytes(&mmap)
}

/// Parse M3U from a byte slice (e.g. a memory-mapped file).
/// Lines are zero-copy &str slices into the input; blocks are found in parallel
/// via par_windows(2) and parsed in parallel with rayon.
fn parse_m3u_bytes(bytes: &[u8]) -> Result<Vec<Channel>, M3uError> {
    let content = std::str::from_utf8(bytes).map_err(|e| M3uError::Parse {
        line: 0,
        message: format!("UTF-8 decode error: {e}"),
    })?;
    let content = strip_bom(content.trim_start());
    if !content.starts_with("#EXTM3U") {
        return Err(M3uError::MissingHeader);
    }

    // Collect lines as &str slices into the mmap — no heap allocation per line.
    let lines: Vec<&str> = content.lines().collect();

    // Find (extinf, url) pairs in parallel. par_windows(2) examines every
    // consecutive pair of lines across all rayon threads simultaneously.
    let blocks: Vec<(&str, &str)> = lines
        .par_windows(2)
        .filter_map(|pair| {
            let a = pair[0].trim();
            let b = pair[1].trim();
            if a.starts_with("#EXTINF:") && !b.is_empty() && !b.starts_with('#') {
                Some((a, b))
            } else {
                None
            }
        })
        .collect();

    let channels: Vec<Channel> = blocks
        .par_iter()
        .enumerate()
        .filter_map(|(idx, (extinf, url))| parse_extinf_block(idx, extinf, url))
        .collect();

    // Deduplicate: same content is often listed under multiple group-title categories
    // (e.g., "Movies Albania" + "Server 4"). Keep first occurrence of each (name, url) pair.
    let mut seen = std::collections::HashSet::<(String, String)>::new();
    let channels: Vec<Channel> = channels
        .into_iter()
        .filter(|ch| seen.insert((ch.name.clone(), ch.url.clone())))
        .collect();

    // Group movies with the same title under a single entry; extra URLs go into sources.
    let channels = group_movie_sources(channels);
    // Group series episodes with the same (series_title, season, episode) similarly.
    let channels = group_series_episodes(channels);

    Ok(channels)
}

/// Stream-parse M3U from any `BufRead` source. Collects EXTINF+URL pairs
/// line-by-line, then parses them in parallel with rayon.
pub fn parse_m3u_reader<R: BufRead>(reader: R) -> Result<Vec<Channel>, M3uError> {
    let mut lines_iter = reader.lines();

    let first_line = lines_iter
        .next()
        .ok_or(M3uError::MissingHeader)?
        .map_err(|e| M3uError::Parse {
            line: 0,
            message: e.to_string(),
        })?;
    let first_trimmed = strip_bom(first_line.trim());
    if !first_trimmed.starts_with("#EXTM3U") {
        return Err(M3uError::MissingHeader);
    }

    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut current_extinf: Option<String> = None;

    for line_result in lines_iter {
        let line = line_result.map_err(|e| M3uError::Parse {
            line: blocks.len(),
            message: e.to_string(),
        })?;
        let trimmed = line.trim();

        if trimmed.starts_with("#EXTINF:") {
            current_extinf = Some(trimmed.to_string());
        } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some(extinf) = current_extinf.take() {
                blocks.push((extinf, trimmed.to_string()));
            }
        }
    }

    let channels: Vec<Channel> = blocks
        .par_iter()
        .enumerate()
        .filter_map(|(idx, (extinf, url))| parse_extinf_block(idx, extinf, url))
        .collect();

    // Deduplicate: same content is often listed under multiple group-title categories
    // (e.g., "Movies Albania" + "Server 4"). Keep first occurrence of each (name, url) pair.
    let mut seen = std::collections::HashSet::<(String, String)>::new();
    let channels: Vec<Channel> = channels
        .into_iter()
        .filter(|ch| seen.insert((ch.name.clone(), ch.url.clone())))
        .collect();

    // Group movies with the same title under a single entry; extra URLs go into sources.
    let channels = group_movie_sources(channels);
    // Group series episodes with the same (series_title, season, episode) similarly.
    let channels = group_series_episodes(channels);

    Ok(channels)
}

/// Extract the EPG URL from the #EXTM3U header line.
/// Looks for `x-tvg-url="..."` or `url-tvg="..."` attributes.
pub fn extract_epg_url(content: &str) -> Option<String> {
    let header_line = content
        .lines()
        .find(|l| l.trim_start_matches('\u{feff}').starts_with("#EXTM3U"))?;
    extract_attr(header_line, "x-tvg-url")
        .or_else(|| extract_attr(header_line, "url-tvg"))
        .filter(|s| !s.is_empty())
}

/// A parsed M3U playlist containing channels and an optional EPG URL extracted from the header.
#[derive(Debug)]
pub struct M3uPlaylist {
    pub channels: Vec<Channel>,
    pub epg_url: Option<String>,
}

/// Fetch an M3U playlist from a URL, parse channels, and extract the EPG URL from the header.
///
/// The download goes to a temp file instead of memory, because playlists can be
/// over 100 MB.
pub async fn fetch_and_parse_m3u_with_epg(url: &str) -> Result<M3uPlaylist, M3uError> {
    fetch_playlist(crate::http::download_client(), url).await
}

async fn fetch_playlist(client: &reqwest::Client, url: &str) -> Result<M3uPlaylist, M3uError> {
    use tokio::io::AsyncWriteExt;

    let mut response = client.get(url).send().await?.error_for_status()?;

    let download = TempDownload::new();
    let mut file = tokio::fs::File::create(&download.0)
        .await
        .map_err(M3uError::Io)?;
    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk).await.map_err(M3uError::Io)?;
    }
    file.flush().await.map_err(M3uError::Io)?;
    drop(file);

    let path = download.0.clone();
    tokio::task::spawn_blocking(move || {
        // The EPG URL is on the header line, so only that line is read for it.
        let mut first_line = String::new();
        std::io::BufReader::new(std::fs::File::open(&path)?).read_line(&mut first_line)?;
        let epg_url = extract_epg_url(&first_line);
        let channels = parse_m3u_file(&path)?;
        Ok(M3uPlaylist { channels, epg_url })
    })
    .await
    .map_err(|e| M3uError::Parse {
        line: 0,
        message: format!("task join error: {e}"),
    })?
}

/// A temp file for one playlist download, deleted when it goes out of scope so
/// a failed download doesn't leave it behind.
///
/// Each download gets its own name, because the app refreshes several
/// providers at once.
struct TempDownload(std::path::PathBuf);

impl TempDownload {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self(std::env::temp_dir().join(format!("mvp_m3u_{}_{n}.tmp", std::process::id())))
    }
}

impl Drop for TempDownload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Strip UTF-8 BOM if present (common in Windows-created M3U files).
fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

fn collect_blocks_from_lines<'a>(lines: &[&'a str]) -> Vec<(&'a str, &'a str)> {
    let mut blocks = Vec::new();
    let mut i = 1;
    while i < lines.len() {
        let line = lines[i].trim();
        if line.starts_with("#EXTINF:") {
            if i + 1 < lines.len() {
                let url_line = lines[i + 1].trim();
                if !url_line.is_empty() && !url_line.starts_with('#') {
                    blocks.push((line, url_line));
                    i += 2;
                    continue;
                }
            }
        }
        i += 1;
    }
    blocks
}

fn parse_extinf_block(index: usize, extinf: &str, url: &str) -> Option<Channel> {
    let after_extinf = extinf.strip_prefix("#EXTINF:")?;

    let comma_pos = after_extinf.rfind(',')?;
    let attrs_part = &after_extinf[..comma_pos];
    let name = after_extinf[comma_pos + 1..].trim().to_string();

    let tvg_id = extract_attr(attrs_part, "tvg-id");
    let tvg_name = extract_attr(attrs_part, "tvg-name");
    let logo_url = extract_attr(attrs_part, "tvg-logo");
    let group_title = extract_attr(attrs_part, "group-title").unwrap_or_default();

    let content_type = extract_attr(attrs_part, "tvg-type")
        .and_then(|t| content_type_from_attr(&t))
        .map(str::to_string)
        .unwrap_or_else(|| classify_url(url, tvg_name.as_deref().unwrap_or(&name)));

    let (series_title, season, episode) = if content_type == "series" {
        match parse_series_name(&name) {
            Some((title, s, e)) => (Some(title), Some(s), Some(e)),
            None => (None, None, None),
        }
    } else {
        (None, None, None)
    };

    Some(Channel {
        id: format!("ch-{index}"),
        name,
        url: url.to_string(),
        logo_url,
        group_title,
        tvg_id,
        tvg_name,
        is_favorite: false,
        content_type,
        sources: Vec::new(),
        series_title,
        season,
        episode,
    })
}

/// Read a `tvg-type` attribute, which some playlists use to mark movies and
/// series whose URLs don't say so. It only ever marks a movie or a series.
/// `live` and unknown values fall back to the URL, so a provider export that
/// tags every entry `live` still files `/movie/` and `/series/` URLs as VOD.
fn content_type_from_attr(value: &str) -> Option<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "movie" | "movies" | "vod" => Some("movie"),
        "series" => Some("series"),
        _ => None,
    }
}

/// Classify a channel by URL path and tvg-name. URL path segments (/series/, /movie/) are
/// definitive; tvg-name SxxExx pattern is checked before .ts extension because many IPTV
/// providers serve series episodes as .ts streams.
fn classify_url(url: &str, tvg_name: &str) -> String {
    if url.contains("/series/") {
        return "series".to_string();
    }
    if url.contains("/movie/") {
        return "movie".to_string();
    }
    // Check tvg-name before .ts extension: series episodes are commonly served as .ts streams
    if has_episode_code(tvg_name) {
        return "series".to_string();
    }
    let path = url.split('?').next().unwrap_or(url);
    if path.ends_with(".ts") {
        return "live".to_string();
    }
    "live".to_string()
}

/// Returns true if `name` contains a season/episode code like S01E01.
fn has_episode_code(name: &str) -> bool {
    let b = name.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'S' || b[i] == b's' {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_digit() { j += 1; }
            if j > i + 1 && j < b.len() && (b[j] == b'E' || b[j] == b'e') {
                let k = j + 1;
                let mut l = k;
                while l < b.len() && b[l].is_ascii_digit() { l += 1; }
                if l > k { return true; }
            }
        }
        i += 1;
    }
    false
}

fn extract_attr(s: &str, key: &str) -> Option<String> {
    let pattern = format!("{key}=\"");
    let start = s.find(&pattern)? + pattern.len();
    let end = s[start..].find('"')? + start;
    let val = s[start..end].trim().to_string();
    if val.is_empty() {
        None
    } else {
        Some(val)
    }
}

/// Parse a series episode name into (show_title, season, episode).
/// Recognises patterns like "Breaking Bad S03E07 Say My Name".
/// Returns None if no SxxExx code is found.
pub fn parse_series_name(name: &str) -> Option<(String, u32, u32)> {
    let b = name.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'S' || b[i] == b's' {
            let s_pos = i;
            let mut j = i + 1;
            let mut season: u32 = 0;
            let mut digit_count = 0usize;
            while j < b.len() && b[j].is_ascii_digit() {
                season = season * 10 + (b[j] - b'0') as u32;
                digit_count += 1;
                j += 1;
            }
            if digit_count >= 1 && digit_count <= 3 && j < b.len() && (b[j] == b'E' || b[j] == b'e') {
                let mut k = j + 1;
                let mut episode: u32 = 0;
                let mut ep_digits = 0usize;
                while k < b.len() && b[k].is_ascii_digit() {
                    episode = episode * 10 + (b[k] - b'0') as u32;
                    ep_digits += 1;
                    k += 1;
                }
                if ep_digits >= 1 {
                    let title = name[..s_pos].trim().to_string();
                    if !title.is_empty() {
                        return Some((title, season, episode));
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Group series with the same (series_title, season, episode) under a single Channel entry.
/// Duplicate episode URLs are merged into `sources`. Episodes without parsed metadata pass through.
fn group_series_episodes(channels: Vec<Channel>) -> Vec<Channel> {
    let mut result: Vec<Channel> = Vec::new();
    let mut ep_to_idx: std::collections::HashMap<(String, u32, u32), usize> =
        std::collections::HashMap::new();

    for ch in channels {
        if ch.content_type != "series" {
            result.push(ch);
            continue;
        }
        match (&ch.series_title, ch.season, ch.episode) {
            (Some(title), Some(season), Some(episode)) => {
                let key = (title.to_lowercase(), season, episode);
                if let Some(&idx) = ep_to_idx.get(&key) {
                    result[idx].sources.push(ch.url);
                } else {
                    let idx = result.len();
                    ep_to_idx.insert(key, idx);
                    result.push(ch);
                }
            }
            _ => result.push(ch),
        }
    }
    result
}

/// Group movies with the same title (case-insensitive) under a single Channel entry.
/// The first occurrence keeps its URL as primary; subsequent occurrences with the same
/// name have their URLs appended to `sources`. Non-movie channels pass through unchanged.
fn group_movie_sources(channels: Vec<Channel>) -> Vec<Channel> {
    let mut result: Vec<Channel> = Vec::new();
    let mut movie_name_to_idx: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();

    for ch in channels {
        if ch.content_type != "movie" {
            result.push(ch);
            continue;
        }
        let key = ch.name.to_lowercase();
        if let Some(&idx) = movie_name_to_idx.get(&key) {
            result[idx].sources.push(ch.url);
        } else {
            let idx = result.len();
            movie_name_to_idx.insert(key, idx);
            result.push(ch);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::test_server;
    use std::io::BufReader;

    #[test]
    fn http_errors_leave_out_the_playlist_url() {
        let err = M3uError::from(crate::http::error_with_url(
            "unix:/get.php?username=u&password=SECRET&type=m3u_plus",
        ));
        test_server::assert_hides(&err, "SECRET");
    }

    #[tokio::test]
    async fn playlists_downloaded_at_once_stay_apart() {
        let first = test_server::serve_once(
            "200 OK",
            "#EXTM3U x-tvg-url=\"http://one.test/epg.xml\"\n#EXTINF:-1,One\nhttp://one.test/1\n",
        );
        let second = test_server::serve_once(
            "200 OK",
            "#EXTM3U x-tvg-url=\"http://two.test/epg.xml\"\n#EXTINF:-1,Two\nhttp://two.test/2\n",
        );
        let client = test_server::client();
        let (first, second) = tokio::join!(
            fetch_playlist(&client, &first),
            fetch_playlist(&client, &second)
        );
        let (first, second) = (first.unwrap(), second.unwrap());
        assert_eq!(first.channels[0].name, "One");
        assert_eq!(first.epg_url.as_deref(), Some("http://one.test/epg.xml"));
        assert_eq!(second.channels[0].name, "Two");
        assert_eq!(second.epg_url.as_deref(), Some("http://two.test/epg.xml"));
    }

    #[test]
    fn a_downloaded_playlist_is_deleted_afterwards() {
        let download = TempDownload::new();
        std::fs::write(&download.0, "#EXTM3U").unwrap();
        let path = download.0.clone();
        assert_ne!(path, TempDownload::new().0);
        drop(download);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn an_error_status_is_a_network_error() {
        let url = test_server::serve_once("404 Not Found", "#EXTM3U");
        let result = fetch_playlist(&test_server::client(), &url).await;
        assert!(matches!(result, Err(M3uError::Network(_))), "{result:?}");
    }

    #[test]
    fn test_parse_basic_m3u() {
        let content = r#"#EXTM3U
#EXTINF:-1 tvg-id="ch1" tvg-name="Channel 1" tvg-logo="http://logo.png" group-title="News",Channel 1
http://stream.example.com/ch1
#EXTINF:-1 tvg-id="ch2" group-title="Sports",Channel 2
http://stream.example.com/ch2
"#;
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].name, "Channel 1");
        assert_eq!(channels[0].group_title, "News");
        assert_eq!(channels[0].logo_url, Some("http://logo.png".into()));
        assert_eq!(channels[1].name, "Channel 2");
        assert_eq!(channels[1].group_title, "Sports");
    }

    #[test]
    fn test_parse_with_bom() {
        let content = "\u{FEFF}#EXTM3U\n#EXTINF:-1 group-title=\"Test\",BOM Channel\nhttp://bom.com\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].name, "BOM Channel");
    }

    #[test]
    fn test_parse_via_reader() {
        let content = "#EXTM3U\n#EXTINF:-1 group-title=\"Test\",Channel A\nhttp://a.com\n";
        let reader = BufReader::new(content.as_bytes());
        let channels = parse_m3u_reader(reader).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].name, "Channel A");
    }

    #[test]
    fn test_reader_with_bom() {
        let content = "\u{FEFF}#EXTM3U\n#EXTINF:-1 group-title=\"Test\",BOM Reader\nhttp://b.com\n";
        let reader = BufReader::new(content.as_bytes());
        let channels = parse_m3u_reader(reader).unwrap();
        assert_eq!(channels.len(), 1);
    }

    #[test]
    fn test_missing_header() {
        let content = "#EXTINF:-1,Channel\nhttp://url";
        assert!(parse_m3u(content).is_err());
    }

    #[test]
    fn test_empty_playlist() {
        let content = "#EXTM3U\n";
        let channels = parse_m3u(content).unwrap();
        assert!(channels.is_empty());
    }

    // --- Edge cases ---

    #[test]
    fn test_extinf_without_comma_is_skipped() {
        // EXTINF with no comma → parse_extinf_block returns None → channel silently dropped
        let content = "#EXTM3U\n#EXTINF:-1 group-title=\"Test\"\nhttp://url.com\n";
        let channels = parse_m3u(content).unwrap();
        assert!(channels.is_empty());
    }

    #[test]
    fn test_empty_tvg_attrs_return_none() {
        // extract_attr returns None when the attribute value is an empty string
        let content = "#EXTM3U\n#EXTINF:-1 tvg-id=\"\" tvg-name=\"\" tvg-logo=\"\" group-title=\"News\",Channel\nhttp://url.com\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 1);
        assert!(channels[0].tvg_id.is_none(), "empty tvg-id should be None");
        assert!(channels[0].tvg_name.is_none(), "empty tvg-name should be None");
        assert!(channels[0].logo_url.is_none(), "empty tvg-logo should be None");
    }

    #[test]
    fn test_channel_name_whitespace_trimmed() {
        let content = "#EXTM3U\n#EXTINF:-1 group-title=\"Test\",  Padded Name  \nhttp://url.com\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels[0].name, "Padded Name");
    }

    #[test]
    fn test_no_group_title_defaults_to_empty_string() {
        let content = "#EXTM3U\n#EXTINF:-1,No Group Channel\nhttp://url.com\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].group_title, "");
    }

    #[test]
    fn test_comment_line_after_extinf_skips_channel() {
        // In the line-pair parser, EXTINF must be immediately followed by a URL.
        // A comment line between EXTINF and URL breaks the pair — no channel produced.
        let content =
            "#EXTM3U\n#EXTINF:-1 group-title=\"Test\",Channel\n#EXTVLCOPT:option\nhttp://url.com\n";
        let channels = parse_m3u(content).unwrap();
        assert!(channels.is_empty());
    }

    #[test]
    fn test_reader_tolerates_comment_between_extinf_and_url() {
        // The streaming reader holds current_extinf across comment lines,
        // so a comment between EXTINF and URL still produces a channel.
        let content =
            "#EXTM3U\n#EXTINF:-1 group-title=\"Test\",Channel\n#EXTVLCOPT:option\nhttp://url.com\n";
        let reader = BufReader::new(content.as_bytes());
        let channels = parse_m3u_reader(reader).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].name, "Channel");
    }

    #[test]
    fn test_crlf_line_endings() {
        let content = "#EXTM3U\r\n#EXTINF:-1 group-title=\"Test\",CRLF Channel\r\nhttp://crlf.com\r\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].name, "CRLF Channel");
    }

    #[test]
    fn test_multiple_channels_have_unique_ids() {
        let content = "#EXTM3U\n\
            #EXTINF:-1 group-title=\"News\",BBC\nhttp://bbc.com\n\
            #EXTINF:-1 group-title=\"Sports\",ESPN\nhttp://espn.com\n\
            #EXTINF:-1 group-title=\"Movies\",HBO\nhttp://hbo.com\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 3);
        let ids: std::collections::HashSet<&str> =
            channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids.len(), 3, "each channel must have a unique id");
    }

    #[test]
    fn test_header_only_whitespace_variants() {
        // Just the header with trailing whitespace / blank lines
        let content = "#EXTM3U   \n\n\n";
        let channels = parse_m3u(content).unwrap();
        assert!(channels.is_empty());
    }

    #[test]
    fn test_logo_url_parsed() {
        let content = "#EXTM3U\n#EXTINF:-1 tvg-logo=\"http://logo.example.com/ch.png\" group-title=\"G\",Ch\nhttp://stream\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(
            channels[0].logo_url.as_deref(),
            Some("http://logo.example.com/ch.png")
        );
    }

    #[test]
    fn test_group_title_with_special_chars() {
        let content = "#EXTM3U\n#EXTINF:-1 group-title=\"News & Sports / 24h\",Channel\nhttp://url\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels[0].group_title, "News & Sports / 24h");
    }

    // --- classify_url / series classification ---

    #[test]
    fn test_series_via_url_path() {
        assert_eq!(classify_url("http://host/series/token/ep.ts", "anything"), "series");
    }

    #[test]
    fn test_movie_via_url_path() {
        assert_eq!(classify_url("http://host/movie/token/film.mp4", "anything"), "movie");
    }

    #[test]
    fn test_series_with_ts_url_classified_by_tvg_name() {
        // Provider serves series as .ts streams — tvg-name must win over .ts extension
        assert_eq!(
            classify_url("http://host/stream/12345.ts", "Suits S07E01"),
            "series"
        );
    }

    #[test]
    fn test_plain_ts_url_without_episode_code_is_live() {
        assert_eq!(classify_url("http://host/ch1.ts", "BBC News HD"), "live");
    }

    #[test]
    fn test_tvg_type_marks_movies_and_series() {
        let content = "#EXTM3U\n\
            #EXTINF:-1 tvg-type=\"movie\",Sintel\n\
            https://cdn.example.com/films/sintel.mkv\n\
            #EXTINF:-1 tvg-type=\"Series\",Open Movies S01E02 Sintel\n\
            https://cdn.example.com/films/sintel-ep.mkv\n\
            #EXTINF:-1 tvg-type=\"live\",News\n\
            http://host/live/news.m3u8\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels[0].content_type, "movie");
        assert_eq!(channels[1].content_type, "series");
        assert_eq!(channels[1].series_title.as_deref(), Some("Open Movies"));
        assert_eq!(channels[1].episode, Some(2));
        assert_eq!(channels[2].content_type, "live");
    }

    #[test]
    fn test_tvg_type_live_does_not_beat_vod_urls() {
        let content = "#EXTM3U\n\
            #EXTINF:-1 tvg-type=\"live\",Film\n\
            http://host/movie/1.mp4\n\
            #EXTINF:-1 tvg-type=\"live\",Show S01E02\n\
            http://host/series/2.mkv\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels[0].content_type, "movie");
        assert_eq!(channels[1].content_type, "series");
    }

    #[test]
    fn test_unknown_tvg_type_falls_back_to_url() {
        let content = "#EXTM3U\n#EXTINF:-1 tvg-type=\"radio\",Film\nhttp://host/movie/film.mp4\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels[0].content_type, "movie");
    }

    #[test]
    fn test_series_full_m3u_suits_format() {
        // Simulate the real-world M3U format: tvg-name with SxxExx, .ts URL
        let content = "#EXTM3U\n\
            #EXTINF:-1 tvg-name=\"Suits S07E01\" group-title=\"Server 4\",Suits S07E01\n\
            http://provider.example.com/stream/Suits_S07E01.ts\n\
            #EXTINF:-1 tvg-name=\"Suits S07E02\" group-title=\"Server 4\",Suits S07E02\n\
            http://provider.example.com/stream/Suits_S07E02.ts\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].content_type, "series");
        assert_eq!(channels[0].series_title.as_deref(), Some("Suits"));
        assert_eq!(channels[0].season, Some(7));
        assert_eq!(channels[0].episode, Some(1));
        assert_eq!(channels[1].content_type, "series");
        assert_eq!(channels[1].series_title.as_deref(), Some("Suits"));
        assert_eq!(channels[1].season, Some(7));
        assert_eq!(channels[1].episode, Some(2));
    }

    #[test]
    fn test_series_mp4_via_series_url_path() {
        // Provider serves series as .mp4 via /series/ URL path
        let content = "#EXTM3U\n\
            #EXTINF:-1 tvg-name=\"Suits LA S01E10\" tvg-logo=\"http://provider.example.com/logo.jpg\" group-title=\"Server 2\",Suits LA S01E10\n\
            http://provider.example.com:80/series/user/pass/3184091.mp4\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].content_type, "series");
        assert_eq!(channels[0].series_title.as_deref(), Some("Suits LA"));
        assert_eq!(channels[0].season, Some(1));
        assert_eq!(channels[0].episode, Some(10));
    }

    #[test]
    fn test_parse_series_name_basic() {
        assert_eq!(
            parse_series_name("Suits LA S01E10"),
            Some(("Suits LA".to_string(), 1, 10))
        );
    }

    #[test]
    fn test_parse_series_name_with_trailing_text() {
        assert_eq!(
            parse_series_name("Breaking Bad S03E07 Say My Name"),
            Some(("Breaking Bad".to_string(), 3, 7))
        );
    }

    #[test]
    fn test_parse_series_name_no_match() {
        assert_eq!(parse_series_name("BBC News HD"), None);
    }

    #[test]
    fn test_extract_epg_url_from_x_tvg_url() {
        let content = "#EXTM3U x-tvg-url=\"http://example.com/epg.xml\"\n#EXTINF:-1,Channel\nhttp://url.com\n";
        assert_eq!(extract_epg_url(content), Some("http://example.com/epg.xml".to_string()));
    }

    #[test]
    fn test_extract_epg_url_from_url_tvg() {
        let content = "#EXTM3U url-tvg=\"http://alt.com/guide.xml\"\n#EXTINF:-1,Channel\nhttp://url.com\n";
        assert_eq!(extract_epg_url(content), Some("http://alt.com/guide.xml".to_string()));
    }

    #[test]
    fn test_extract_epg_url_missing_returns_none() {
        let content = "#EXTM3U\n#EXTINF:-1,Channel\nhttp://url.com\n";
        assert_eq!(extract_epg_url(content), None);
    }

    #[test]
    fn test_extract_epg_url_empty_attr_returns_none() {
        let content = "#EXTM3U x-tvg-url=\"\"\n#EXTINF:-1,Channel\nhttp://url.com\n";
        assert_eq!(extract_epg_url(content), None);
    }

    #[test]
    fn test_extract_epg_url_with_bom_header() {
        let content = "\u{FEFF}#EXTM3U x-tvg-url=\"http://bom.com/epg.xml\"\n#EXTINF:-1,Channel\nhttp://url.com\n";
        assert_eq!(extract_epg_url(content), Some("http://bom.com/epg.xml".to_string()));
    }

    // --- Malformed playlists ---

    /// Parses `bytes` from a file, the way a downloaded playlist is read.
    fn parse_file(bytes: &[u8]) -> Result<Vec<Channel>, M3uError> {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), bytes).unwrap();
        parse_m3u_file(file.path())
    }

    /// A playlist saved as Latin-1 instead of UTF-8, as some older tools do.
    const LATIN1_PLAYLIST: &[u8] = b"#EXTM3U\n#EXTINF:-1,Caf\xe9 TV\nhttp://a.test/1\n";

    #[test]
    fn a_playlist_file_that_is_not_utf8_is_a_parse_error() {
        let result = parse_file(LATIN1_PLAYLIST);
        assert!(
            matches!(&result, Err(M3uError::Parse { message, .. }) if message.contains("UTF-8")),
            "{result:?}"
        );
    }

    #[test]
    fn a_playlist_file_without_a_header_is_rejected() {
        for content in [
            "",
            "#EXTINF:-1,One\nhttp://a.test/1\n",
            "<html>Account expired</html>",
        ] {
            let result = parse_file(content.as_bytes());
            assert!(
                matches!(result, Err(M3uError::MissingHeader)),
                "{content:?}: {result:?}"
            );
        }
    }

    #[test]
    fn a_stream_without_a_header_line_is_rejected() {
        for content in ["", "#EXTINF:-1,One\nhttp://a.test/1\n"] {
            let result = parse_m3u_reader(content.as_bytes());
            assert!(
                matches!(result, Err(M3uError::MissingHeader)),
                "{content:?}: {result:?}"
            );
        }
    }

    #[test]
    fn a_stream_that_is_not_utf8_is_a_parse_error() {
        let header: &[u8] = b"#EXTM3U \xff\n#EXTINF:-1,One\nhttp://a.test/1\n";
        for bytes in [header, LATIN1_PLAYLIST] {
            let result = parse_m3u_reader(bytes);
            assert!(matches!(result, Err(M3uError::Parse { .. })), "{result:?}");
        }
    }

    #[test]
    fn an_entry_without_a_link_is_dropped_by_every_parser() {
        // A broken entry must not take the next entry's link.
        let content = "#EXTM3U\n\
            #EXTINF:-1,No Link\n\
            #EXTINF:-1,One\nhttp://a.test/1\n\
            #EXTINF:-1,Last";
        let parsed = [
            parse_m3u(content).unwrap(),
            parse_file(content.as_bytes()).unwrap(),
            parse_m3u_reader(content.as_bytes()).unwrap(),
        ];
        for channels in parsed {
            let entries: Vec<_> = channels
                .iter()
                .map(|ch| (ch.name.as_str(), ch.url.as_str()))
                .collect();
            assert_eq!(entries, [("One", "http://a.test/1")]);
        }
    }

    #[tokio::test]
    async fn a_reply_that_is_not_a_playlist_is_rejected() {
        for body in ["", "<html><body>Account expired</body></html>"] {
            let url = test_server::serve_once("200 OK", body);
            let result = fetch_playlist(&test_server::client(), &url).await;
            assert!(
                matches!(result, Err(M3uError::MissingHeader)),
                "{body:?}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_playlist_that_cannot_be_fetched_does_not_show_the_login() {
        let err =
            fetch_and_parse_m3u_with_epg("unix:/get.php?username=U&password=SECRET&type=m3u_plus")
                .await
                .unwrap_err();
        assert!(matches!(err, M3uError::Network(_)), "{err:?}");
        test_server::assert_hides(&err, "SECRET");
    }

    // --- Grouping ---

    #[test]
    fn the_same_film_on_two_servers_is_one_entry_with_both_links() {
        let content = "#EXTM3U\n\
            #EXTINF:-1 group-title=\"Movies\",Heat (1995)\nhttp://a.test/movie/u/p/1.mkv\n\
            #EXTINF:-1 group-title=\"Server 4\",HEAT (1995)\nhttp://b.test/movie/u/p/1.mkv\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 1, "{channels:?}");
        assert_eq!(channels[0].name, "Heat (1995)");
        assert_eq!(channels[0].url, "http://a.test/movie/u/p/1.mkv");
        assert_eq!(channels[0].sources, ["http://b.test/movie/u/p/1.mkv"]);
    }

    #[test]
    fn the_same_episode_on_two_servers_is_one_entry_with_both_links() {
        let content = "#EXTM3U\n\
            #EXTINF:-1,Suits S01E01\nhttp://a.test/series/u/p/1.mkv\n\
            #EXTINF:-1,suits S01E01 Pilot\nhttp://b.test/series/u/p/1.mkv\n\
            #EXTINF:-1,Suits S01E02\nhttp://a.test/series/u/p/2.mkv\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 2, "{channels:?}");
        assert_eq!(channels[0].url, "http://a.test/series/u/p/1.mkv");
        assert_eq!(channels[0].sources, ["http://b.test/series/u/p/1.mkv"]);
        assert_eq!(channels[1].episode, Some(2));
        assert!(channels[1].sources.is_empty());
    }

    #[test]
    fn series_entries_without_an_episode_code_are_kept_apart() {
        // Without a season and episode there is nothing to tell that two
        // entries are the same episode.
        let content = "#EXTM3U\n\
            #EXTINF:-1 tvg-type=\"series\",Planet Earth\nhttp://a.test/1.mkv\n\
            #EXTINF:-1 tvg-type=\"series\",Planet Earth\nhttp://b.test/1.mkv\n";
        let channels = parse_m3u(content).unwrap();
        assert_eq!(channels.len(), 2, "{channels:?}");
        for ch in &channels {
            assert_eq!(ch.content_type, "series");
            assert_eq!(
                (ch.series_title.as_deref(), ch.season, ch.episode),
                (None, None, None)
            );
            assert!(ch.sources.is_empty());
        }
    }

    #[test]
    fn a_code_without_a_show_or_an_episode_number_is_not_an_episode() {
        assert_eq!(parse_series_name("S01E02"), None);
        assert_eq!(parse_series_name("Doctor Who S01Extras"), None);
    }
}
