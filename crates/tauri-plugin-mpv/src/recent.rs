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
    /// isn't kept.
    pub fn insert(&mut self, url: String, bytes: Vec<u8>) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn urls(recent: &RecentArtwork) -> Vec<&str> {
        recent.entries.iter().map(|(u, _)| u.as_str()).collect()
    }

    #[test]
    fn drops_the_least_recently_used_past_the_count() {
        let mut recent = RecentArtwork::new(2, 100);
        recent.insert("a".into(), vec![1]);
        recent.insert("b".into(), vec![2]);
        assert_eq!(recent.get("a"), Some(&[1][..]));
        recent.insert("c".into(), vec![3]);

        assert_eq!(urls(&recent), ["a", "c"]);
        assert_eq!(recent.get("b"), None);
    }

    #[test]
    fn drops_the_oldest_past_the_byte_limit() {
        let mut recent = RecentArtwork::new(8, 10);
        recent.insert("a".into(), vec![0; 4]);
        recent.insert("b".into(), vec![0; 4]);
        recent.insert("c".into(), vec![0; 4]);

        assert_eq!(urls(&recent), ["b", "c"]);
    }

    #[test]
    fn keeps_nothing_bigger_than_the_byte_limit() {
        let mut recent = RecentArtwork::new(8, 10);
        recent.insert("a".into(), vec![0; 4]);
        recent.insert("big".into(), vec![0; 11]);

        assert!(urls(&recent).is_empty());
    }

    #[test]
    fn replaces_a_logo_with_the_same_address() {
        let mut recent = RecentArtwork::new(8, 100);
        recent.insert("a".into(), vec![1]);
        recent.insert("b".into(), vec![2]);
        recent.insert("a".into(), vec![3]);

        assert_eq!(urls(&recent), ["b", "a"]);
        assert_eq!(recent.get("a"), Some(&[3][..]));
    }
}
