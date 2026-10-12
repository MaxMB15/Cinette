// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The last few channel logos the lock screen showed, so switching back to a
//! channel shows its logo without downloading it again. Only iOS uses it, but
//! it builds for tests on every target.

use std::collections::VecDeque;

/// Logos by address, least recently used first. Holds at most `max_entries`
/// logos and `max_bytes` in all, and drops the least recently used ones to
/// stay under both.
pub struct RecentArtwork {
    entries: VecDeque<(String, Vec<u8>)>,
    max_entries: usize,
    max_bytes: usize,
}

impl RecentArtwork {
    pub const fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max_entries,
            max_bytes,
        }
    }

    /// The logo for `url`, which then counts as the most recently used.
    pub fn get(&mut self, url: &str) -> Option<&[u8]> {
        let i = self.entries.iter().position(|(u, _)| u == url)?;
        let entry = self.entries.remove(i)?;
        self.entries.push_back(entry);
        self.entries.back().map(|(_, bytes)| bytes.as_slice())
    }

    /// Adds or replaces the logo for `url`. A logo bigger than `max_bytes`
    /// isn't kept, and neither is anything that doesn't start like an image,
    /// such as an error page sent with a 200. Either way the others stay.
    pub fn insert(&mut self, url: String, bytes: Vec<u8>) {
        if bytes.len() > self.max_bytes || !is_image(&bytes) {
            return;
        }
        self.entries.retain(|(u, _)| *u != url);
        self.entries.push_back((url, bytes));
        let mut total: usize = self.entries.iter().map(|(_, b)| b.len()).sum();
        while self.entries.len() > self.max_entries || total > self.max_bytes {
            let Some((_, dropped)) = self.entries.pop_front() else {
                break;
            };
            total -= dropped.len();
        }
    }
}

/// Whether `bytes` start like a PNG, JPEG, GIF or WebP file, the formats
/// channel logos come in. Swift's ImageIO reads a few more, so a logo in
/// another format still shows. It just isn't kept.
fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xFF\xD8\xFF")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(&b"WEBP"[..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn urls(recent: &RecentArtwork) -> Vec<&str> {
        recent.entries.iter().map(|(u, _)| u.as_str()).collect()
    }

    /// `len` bytes that start like a PNG file, padded with `fill`.
    fn png(len: usize, fill: u8) -> Vec<u8> {
        let mut bytes = PNG.to_vec();
        bytes.resize(len, fill);
        bytes
    }

    #[test]
    fn drops_the_least_recently_used_past_the_count() {
        let mut recent = RecentArtwork::new(2, 100);
        recent.insert("a".into(), png(9, 1));
        recent.insert("b".into(), png(9, 2));
        assert_eq!(recent.get("a"), Some(&png(9, 1)[..]));
        recent.insert("c".into(), png(9, 3));

        assert_eq!(urls(&recent), ["a", "c"]);
        assert_eq!(recent.get("b"), None);
    }

    #[test]
    fn drops_the_oldest_past_the_byte_limit() {
        let mut recent = RecentArtwork::new(8, 25);
        recent.insert("a".into(), png(10, 0));
        recent.insert("b".into(), png(10, 0));
        recent.insert("c".into(), png(10, 0));

        assert_eq!(urls(&recent), ["b", "c"]);
    }

    #[test]
    fn keeps_the_others_when_a_logo_is_too_big() {
        let mut recent = RecentArtwork::new(8, 25);
        recent.insert("a".into(), png(10, 0));
        recent.insert("b".into(), png(10, 0));
        recent.insert("big".into(), png(26, 0));

        assert_eq!(urls(&recent), ["a", "b"]);
    }

    #[test]
    fn replaces_a_logo_with_the_same_address() {
        let mut recent = RecentArtwork::new(8, 100);
        recent.insert("a".into(), png(9, 1));
        recent.insert("b".into(), png(9, 2));
        recent.insert("a".into(), png(9, 3));

        assert_eq!(urls(&recent), ["b", "a"]);
        assert_eq!(recent.get("a"), Some(&png(9, 3)[..]));
    }

    #[test]
    fn keeps_only_images() {
        let images: [(&str, &[u8]); 5] = [
            ("png", PNG),
            ("jpeg", b"\xFF\xD8\xFF\xE0\0\x10JFIF"),
            ("gif87a", b"GIF87a"),
            ("gif89a", b"GIF89a"),
            ("webp", b"RIFF\x24\0\0\0WEBPVP8 "),
        ];
        let others: [(&str, &[u8]); 4] = [
            ("html", b"<!DOCTYPE html><html>"),
            ("empty", b""),
            ("wav", b"RIFF\x24\0\0\0WAVEfmt "),
            ("cut short", b"\x89PN"),
        ];
        // Room for the images alone, so one of the others getting in would
        // push an image out.
        let mut recent = RecentArtwork::new(images.len(), 1000);
        for (url, bytes) in images.into_iter().chain(others) {
            recent.insert(url.into(), bytes.to_vec());
        }

        assert_eq!(urls(&recent), ["png", "jpeg", "gif87a", "gif89a", "webp"]);
    }
}
