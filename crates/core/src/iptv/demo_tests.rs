// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Checks the demo playlist and guide in docs/demo, which App Review uses.
//! They're read from the repo, so nothing here reaches the network.

use super::epg::parse_epg;
use super::m3u::{extract_epg_url, parse_m3u};
use crate::models::channel::Channel;
use std::collections::BTreeSet;
use std::path::Path;

const PLAYLIST: &str = include_str!("../../../../docs/demo/playlist.m3u");
const GUIDE: &str = include_str!("../../../../docs/demo/guide.xml");

const RAW: &str = "https://raw.githubusercontent.com/MaxMB15/MaxVideoPlayer/main/docs/demo/";

/// 2026-10-15 00:00 and 2028-01-01 00:00 UTC, where scripts/demo-guide.py
/// starts and stops the guide.
const GUIDE_START: i64 = 1_792_022_400;
const GUIDE_END: i64 = 1_830_297_600;

fn channels() -> Vec<Channel> {
    parse_m3u(PLAYLIST).expect("docs/demo/playlist.m3u should parse")
}

fn of_type<'a>(channels: &'a [Channel], content_type: &str) -> Vec<&'a Channel> {
    channels
        .iter()
        .filter(|c| c.content_type == content_type)
        .collect()
}

#[test]
fn the_demo_playlist_has_live_and_movie_entries() {
    let channels = channels();
    assert_eq!(of_type(&channels, "live").len(), 3);
    assert_eq!(of_type(&channels, "movie").len(), 4);
    assert_eq!(channels.len(), 7);
}

#[test]
fn the_demo_playlist_points_at_its_guide() {
    // The app reads the guide's URL from the first line only.
    let first_line = PLAYLIST.lines().next().unwrap_or_default();
    assert_eq!(extract_epg_url(first_line), Some(format!("{RAW}guide.xml")));
}

#[test]
fn the_demo_pictures_match_the_movies() {
    let channels = channels();
    let used: BTreeSet<String> = of_type(&channels, "movie")
        .into_iter()
        .map(|channel| {
            let logo = channel.logo_url.as_deref().unwrap_or_default();
            logo.strip_prefix(RAW)
                .and_then(|rest| rest.strip_prefix("images/"))
                .unwrap_or_else(|| {
                    panic!("{} should have a picture under {RAW}images/", channel.name)
                })
                .to_owned()
        })
        .collect();

    // Hidden files, such as the .DS_Store that Finder leaves, aren't pictures.
    let images = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/demo/images");
    let in_repo: BTreeSet<String> = std::fs::read_dir(&images)
        .expect("docs/demo/images should be readable")
        .map(|entry| {
            entry
                .expect("docs/demo/images should be readable")
                .file_name()
        })
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect();

    // Each movie has its own picture, and each picture belongs to a movie.
    assert_eq!(used.len(), of_type(&channels, "movie").len());
    assert_eq!(used, in_repo);
}

#[test]
fn the_demo_guide_covers_each_live_entry_without_gaps() {
    let guide = parse_epg(GUIDE).expect("docs/demo/guide.xml should parse");
    let channels = channels();
    let live: BTreeSet<&str> = of_type(&channels, "live")
        .into_iter()
        .map(|c| {
            c.tvg_id
                .as_deref()
                .expect("each live entry should have a tvg-id")
        })
        .collect();
    let in_guide: BTreeSet<&str> = guide.channels.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(live, in_guide);

    for id in live {
        let mut programs: Vec<_> = guide
            .programs
            .iter()
            .filter(|p| p.channel_id == id)
            .collect();
        programs.sort_by_key(|p| p.start_time);
        assert_eq!(
            programs.first().map(|p| p.start_time),
            Some(GUIDE_START),
            "{id}"
        );
        assert_eq!(programs.last().map(|p| p.end_time), Some(GUIDE_END), "{id}");
        for pair in programs.windows(2) {
            assert_eq!(
                pair[0].end_time, pair[1].start_time,
                "{id} has a gap or overlap"
            );
        }
        assert!(programs
            .iter()
            .all(|p| !p.title.is_empty() && !p.description.is_empty()));
    }
}
