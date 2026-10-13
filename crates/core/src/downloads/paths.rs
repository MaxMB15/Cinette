// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::downloads::model::DownloadKind;
use std::path::{Path, PathBuf};

/// Added to a download's path while ffmpeg is still writing it.
pub const PART_SUFFIX: &str = ".part";

/// The folder under the download folder that holds recordings.
pub const RECORDINGS_DIR: &str = "recordings";

/// The longest name `sanitize_filename` returns, in bytes. File systems
/// allow 255 bytes in a name, which leaves room for a date, a number and an
/// extension.
const MAX_NAME_BYTES: usize = 150;

/// Make a filesystem-safe filename component. Replaces path separators and
/// reserved/control characters with `_`, trims dots and spaces from both ends,
/// and caps the length in bytes to keep within filesystem limits. A leading
/// dot would hide the file on macOS and Linux, and a name made only of dots
/// would turn into `.` or `..`, which as a folder name points outside the
/// download folder.
pub fn sanitize_filename(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    truncate_on_char(&mut s, MAX_NAME_BYTES);
    let s = s.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if s.is_empty() {
        "untitled".to_string()
    } else {
        s.to_string()
    }
}

/// Cut `s` to at most `max` bytes without splitting a character.
fn truncate_on_char(s: &mut String, max: usize) {
    if s.len() > max {
        let end = (0..=max)
            .rev()
            .find(|&i| s.is_char_boundary(i))
            .unwrap_or(0);
        s.truncate(end);
    }
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

/// The path ffmpeg writes to while `dest` downloads.
pub fn part_path(dest: &Path) -> PathBuf {
    let mut path = dest.as_os_str().to_owned();
    path.push(PART_SUFFIX);
    PathBuf::from(path)
}

/// Equal for two download paths that name the same file. A partial path
/// counts as its final file, and case is ignored because the default macOS
/// file system ignores it.
pub fn path_key(path: &str) -> String {
    path.strip_suffix(PART_SUFFIX)
        .unwrap_or(path)
        .to_lowercase()
}

/// `dest`, or the first of "name (2).ext", "name (3).ext" and so on that
/// `is_taken` turns down.
pub fn unique_dest_path(dest: &Path, mut is_taken: impl FnMut(&Path) -> bool) -> PathBuf {
    if !is_taken(dest) {
        return dest.to_path_buf();
    }
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = dest.extension().map(|e| e.to_string_lossy().into_owned());
    let mut n = 2;
    loop {
        let name = match &ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dest.with_file_name(name);
        if !is_taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_separators_and_reserved() {
        assert_eq!(sanitize_filename("a/b:c*?"), "a_b_c__");
        // Control characters, tabs and line breaks too.
        assert_eq!(sanitize_filename("a\tb\u{7}c\nd"), "a_b_c_d");
        assert_eq!(sanitize_filename("  trailing.  "), "trailing");
        assert_eq!(sanitize_filename(""), "untitled");
    }

    #[test]
    fn caps_the_name_in_bytes_without_splitting_a_character() {
        let accented = sanitize_filename(&"é".repeat(100));
        assert_eq!(accented, "é".repeat(75));
        let wide = sanitize_filename(&"字".repeat(100));
        assert_eq!(wide, "字".repeat(50));
        // A cut that lands just before a trailing space or dot is trimmed.
        let spaced = sanitize_filename(&format!("{} x", "a".repeat(149)));
        assert_eq!(spaced, "a".repeat(149));
    }

    #[test]
    fn dot_names_never_leave_the_folder_or_hide_the_file() {
        for name in [".", "..", ".. .", " . . ", "...", "\u{7}.."] {
            let s = sanitize_filename(name);
            assert!(!s.starts_with('.'), "{name:?} became {s:?}");
            assert_ne!(s, "..");
        }
        assert_eq!(sanitize_filename(".. ."), "untitled");
        assert_eq!(sanitize_filename(".hack Sign"), "hack Sign");
        assert_eq!(sanitize_filename("Mr. Robot"), "Mr. Robot");
        let root = Path::new("/data/dl");
        let ep = derive_dest_path(root, DownloadKind::Episode, "E1", Some(".."), "u/1.mkv");
        assert_eq!(ep, Path::new("/data/dl/series/untitled/E1.mkv"));
    }

    #[test]
    fn caps_length_without_leaving_a_trailing_dot() {
        let long = format!("{}.{}", "a".repeat(149), "b".repeat(10));
        assert_eq!(sanitize_filename(&long), "a".repeat(149));
    }

    #[test]
    fn part_paths_count_as_their_final_file_in_any_case() {
        let dest = Path::new("/dl/movies/Dune.mkv");
        assert_eq!(part_path(dest), Path::new("/dl/movies/Dune.mkv.part"));
        assert_eq!(
            path_key("/dl/movies/Dune.mkv.part"),
            path_key("/DL/Movies/dune.MKV")
        );
        assert_ne!(
            path_key("/dl/movies/Dune.mkv"),
            path_key("/dl/movies/Dune 2.mkv")
        );
    }

    #[test]
    fn numbers_a_path_that_is_taken() {
        let dest = Path::new("/dl/movies/Dune (2021).mkv");
        assert_eq!(unique_dest_path(dest, |_| false), dest);

        let taken = [
            Path::new("/dl/movies/Dune (2021).mkv"),
            Path::new("/dl/movies/Dune (2021) (2).mkv"),
        ];
        assert_eq!(
            unique_dest_path(dest, |p| taken.contains(&p)),
            Path::new("/dl/movies/Dune (2021) (3).mkv")
        );
        assert_eq!(
            unique_dest_path(Path::new("/dl/noext"), |p| p == Path::new("/dl/noext")),
            Path::new("/dl/noext (2)")
        );
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
