// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Which channel logo the lock screen shows, and the last few it showed, so
//! switching back to a channel shows its logo without downloading it again.
//! Only iOS uses it, but it builds for tests on every target. `ios.rs` does
//! the downloads and passes in the call that hands a logo to Swift.

use std::collections::VecDeque;

/// `url` when it's an `http` or `https` address, the only kinds the app
/// downloads logos from. The scheme may be in any case.
pub fn web_address(url: String) -> Option<String> {
    let (scheme, _) = url.split_once("://")?;
    (scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")).then_some(url)
}

/// What the caller does after [`LockScreenArtwork::select`].
#[derive(Debug, PartialEq, Eq)]
pub enum Select {
    /// The logo didn't change, so a download for it carries on.
    Same,
    /// The logo changed and the lock screen already has it, or has none.
    /// Stop any download for the old logo.
    Shown,
    /// Stop any download for the old logo and download this one.
    Download(String),
}

/// The logo the player asked for last, and the logos kept from earlier
/// downloads. `show` hands a logo to the lock screen, or clears it on None.
pub struct LockScreenArtwork {
    url: Option<String>,
    recent: RecentArtwork,
}

impl LockScreenArtwork {
    /// Keeps at most `max_entries` earlier logos and `max_bytes` in all.
    pub const fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            url: None,
            recent: RecentArtwork::new(max_entries, max_bytes),
        }
    }

    /// Takes the logo of the channel the player is about to show, or None
    /// when it has none. A logo kept from earlier shows right away.
    /// Otherwise the old logo is cleared first, so it doesn't stay up beside
    /// the new title while the new one downloads, or for good if that fails.
    pub fn select(&mut self, url: Option<String>, show: impl FnOnce(Option<&[u8]>)) -> Select {
        if self.url == url {
            return Select::Same;
        }
        self.url.clone_from(&url);
        if let Some(bytes) = url.as_deref().and_then(|url| self.recent.get(url)) {
            show(Some(bytes));
            return Select::Shown;
        }
        show(None);
        url.map_or(Select::Shown, Select::Download)
    }

    /// Takes a finished download of `url`, or None when it failed. A logo
    /// shows only if the player still wants it, and is kept for a later
    /// switch back. A failed download forgets the address, so the next play
    /// of the channel tries again.
    pub fn finish(
        &mut self,
        url: String,
        bytes: Option<Vec<u8>>,
        show: impl FnOnce(Option<&[u8]>),
    ) {
        if self.url.as_deref() != Some(url.as_str()) {
            return;
        }
        match bytes {
            Some(bytes) => {
                show(Some(&bytes));
                self.recent.insert(url, bytes);
            }
            None => self.url = None,
        }
    }
}

/// Logos by address, least recently used first. Holds at most `max_entries`
/// logos and `max_bytes` in all, and drops the least recently used ones to
/// stay under both.
struct RecentArtwork {
    entries: VecDeque<(String, Vec<u8>)>,
    max_entries: usize,
    max_bytes: usize,
}

impl RecentArtwork {
    const fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max_entries,
            max_bytes,
        }
    }

    /// The logo for `url`, which then counts as the most recently used.
    fn get(&mut self, url: &str) -> Option<&[u8]> {
        let i = self.entries.iter().position(|(u, _)| u == url)?;
        let entry = self.entries.remove(i)?;
        self.entries.push_back(entry);
        self.entries.back().map(|(_, bytes)| bytes.as_slice())
    }

    /// Adds or replaces the logo for `url`. A logo bigger than `max_bytes`
    /// isn't kept, and neither is anything that doesn't start like an image,
    /// such as an error page sent with a 200. Either way the others stay.
    fn insert(&mut self, url: String, bytes: Vec<u8>) {
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

    /// What one call handed to the lock screen, None meaning a clear.
    type Shown = Vec<Option<Vec<u8>>>;

    fn select(artwork: &mut LockScreenArtwork, url: Option<&str>) -> (Select, Shown) {
        let mut shown = Vec::new();
        let next = artwork.select(url.map(String::from), |bytes| {
            shown.push(bytes.map(<[u8]>::to_vec));
        });
        (next, shown)
    }

    fn finish(artwork: &mut LockScreenArtwork, url: &str, bytes: Option<Vec<u8>>) -> Shown {
        let mut shown = Vec::new();
        artwork.finish(url.into(), bytes, |bytes| {
            shown.push(bytes.map(<[u8]>::to_vec))
        });
        shown
    }

    #[test]
    fn a_new_logo_clears_the_old_one_and_downloads() {
        let mut artwork = LockScreenArtwork::new(8, 100);

        assert_eq!(
            select(&mut artwork, Some("a")),
            (Select::Download("a".into()), vec![None])
        );
    }

    #[test]
    fn the_same_logo_again_lets_its_download_carry_on() {
        let mut artwork = LockScreenArtwork::new(8, 100);
        select(&mut artwork, Some("a"));

        assert_eq!(select(&mut artwork, Some("a")), (Select::Same, vec![]));
        assert_eq!(
            finish(&mut artwork, "a", Some(png(9, 1))),
            [Some(png(9, 1))]
        );
        assert_eq!(select(&mut artwork, Some("a")), (Select::Same, vec![]));
    }

    #[test]
    fn a_downloaded_logo_shows_again_without_downloading() {
        let mut artwork = LockScreenArtwork::new(8, 100);
        select(&mut artwork, Some("a"));
        finish(&mut artwork, "a", Some(png(9, 1)));

        assert_eq!(
            select(&mut artwork, Some("b")),
            (Select::Download("b".into()), vec![None])
        );
        assert_eq!(
            select(&mut artwork, Some("a")),
            (Select::Shown, vec![Some(png(9, 1))])
        );
    }

    #[test]
    fn a_download_finishing_after_a_switch_is_dropped() {
        let mut artwork = LockScreenArtwork::new(8, 100);
        select(&mut artwork, Some("a"));
        select(&mut artwork, Some("b"));

        assert_eq!(finish(&mut artwork, "a", Some(png(9, 1))), []);
        assert_eq!(
            select(&mut artwork, Some("a")),
            (Select::Download("a".into()), vec![None])
        );
    }

    #[test]
    fn a_failed_download_is_tried_again_on_the_next_play() {
        let mut artwork = LockScreenArtwork::new(8, 100);
        select(&mut artwork, Some("a"));

        assert_eq!(finish(&mut artwork, "a", None), []);
        assert_eq!(
            select(&mut artwork, Some("a")),
            (Select::Download("a".into()), vec![None])
        );
    }

    #[test]
    fn a_logo_that_isnt_kept_still_shows() {
        let mut artwork = LockScreenArtwork::new(8, 100);
        select(&mut artwork, Some("a"));

        assert_eq!(
            finish(&mut artwork, "a", Some(b"<html>".to_vec())),
            [Some(b"<html>".to_vec())]
        );
        select(&mut artwork, Some("b"));
        assert_eq!(
            select(&mut artwork, Some("a")),
            (Select::Download("a".into()), vec![None])
        );
    }

    #[test]
    fn a_channel_without_a_logo_clears_the_lock_screen() {
        let mut artwork = LockScreenArtwork::new(8, 100);
        assert_eq!(select(&mut artwork, None), (Select::Same, vec![]));
        select(&mut artwork, Some("a"));

        assert_eq!(select(&mut artwork, None), (Select::Shown, vec![None]));
        assert_eq!(select(&mut artwork, None), (Select::Same, vec![]));
    }

    #[test]
    fn downloads_only_web_addresses() {
        for url in [
            "http://host.test/logo.png",
            "https://host.test/logo.png",
            "HTTP://host.test/logo.png",
            "Https://host.test",
        ] {
            assert_eq!(web_address(url.into()).as_deref(), Some(url), "{url}");
        }
        for url in [
            "file:///logo.png",
            "data:image/png;base64,AAAA",
            "ftp://host.test/logo.png",
            "host.test/logo.png",
            "",
        ] {
            assert_eq!(web_address(url.into()), None, "{url}");
        }
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
