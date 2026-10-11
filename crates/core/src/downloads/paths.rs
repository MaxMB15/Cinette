// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::downloads::model::DownloadKind;
use std::path::{Path, PathBuf};

/// The folder under the download folder that holds recordings.
pub const RECORDINGS_DIR: &str = "recordings";

/// Make a filesystem-safe filename component. Replaces path separators and
/// reserved/control characters with `_`, trims trailing dots/spaces, and caps
/// length to keep within filesystem limits.
pub fn sanitize_filename(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    s = s.trim().trim_end_matches('.').trim().to_string();
    if s.is_empty() {
        s = "untitled".to_string();
    }
    s.chars().take(150).collect()
}

/// Pick a file extension from the source URL, defaulting to `mkv` when the URL
/// has no usable extension (stream-copy preserves the source container).
pub fn extension_from_url(url: &str) -> String {
    let tail = url.split('?').next().unwrap_or(url);
    let ext = Path::new(tail)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let ext = ext.to_ascii_lowercase();
    let valid = matches!(
        ext.as_str(),
        "mkv" | "mp4" | "ts" | "avi" | "mov" | "m4v" | "webm"
    );
    if valid { ext } else { "mkv".to_string() }
}

/// Derive the final destination path under `root`.
/// Movies:   `<root>/movies/<title>.<ext>`
/// Episodes: `<root>/series/<series_title>/<title>.<ext>`
/// Recordings: `<root>/recordings/<title>.<ext>`. The recording module names
/// recordings itself, with the start time in the name.
pub fn derive_dest_path(
    root: &Path,
    kind: DownloadKind,
    title: &str,
    series_title: Option<&str>,
    url: &str,
) -> PathBuf {
    let ext = extension_from_url(url);
    let file = format!("{}.{ext}", sanitize_filename(title));
    match kind {
        DownloadKind::Movie => root.join("movies").join(file),
        DownloadKind::Episode => {
            let show = sanitize_filename(series_title.unwrap_or("Unknown Series"));
            root.join("series").join(show).join(file)
        }
        DownloadKind::Recording => root.join(RECORDINGS_DIR).join(file),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_separators_and_reserved() {
        assert_eq!(sanitize_filename("a/b:c*?"), "a_b_c__");
        assert_eq!(sanitize_filename("  trailing.  "), "trailing");
        assert_eq!(sanitize_filename(""), "untitled");
    }

    #[test]
    fn extension_falls_back_to_mkv() {
        assert_eq!(extension_from_url("http://h/movie/u/p/1.mp4"), "mp4");
        assert_eq!(extension_from_url("http://h/movie/u/p/1.mp4?token=x"), "mp4");
        assert_eq!(extension_from_url("http://h/stream/playlist.m3u8"), "mkv");
        assert_eq!(extension_from_url("xtream://series/55"), "mkv");
    }

    #[test]
    fn derives_movie_and_episode_paths() {
        let root = Path::new("/data/dl");
        let movie = derive_dest_path(root, DownloadKind::Movie, "Sr. (2022)", None, "u/1.mp4");
        assert_eq!(movie, Path::new("/data/dl/movies/Sr. (2022).mp4"));

        let ep = derive_dest_path(
            root,
            DownloadKind::Episode,
            "Breaking Bad S01E01",
            Some("Breaking Bad"),
            "u/1.mkv",
        );
        assert_eq!(
            ep,
            Path::new("/data/dl/series/Breaking Bad/Breaking Bad S01E01.mkv")
        );
    }
}
