// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Recordings of live channels. A recording is a download record of kind
//! `Recording` with a start and an end time. It waits as `Scheduled`, runs as
//! `Recording` and ends as `Completed`. One whose whole window passed while
//! the app was closed becomes `Missed`. The app checks the clock every 30
//! seconds and carries out what [`plan`] returns.

use crate::downloads::ffmpeg::build_ffmpeg_args;
use crate::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use crate::downloads::paths::{sanitize_filename, RECORDINGS_DIR};
use crate::models::channel::Channel;
use chrono::NaiveDateTime;
use std::path::{Path, PathBuf};

/// Recordings are always MPEG-TS. A TS file stays playable when ffmpeg stops
/// without finishing it, as when the app quits or the stream drops.
pub const CONTAINER: &str = "ts";

/// The longest recording the app accepts, in seconds.
pub const MAX_LENGTH_SECS: i64 = 12 * 60 * 60;

/// The path for a recording of `channel_name` that starts at `start`, local
/// time, such as `<root>/recordings/City News 2026-10-12 20.00.ts`. Two
/// recordings can share a channel name and a minute, so while `taken` says a
/// path is in use this tries ` (2)`, ` (3)` and so on.
pub fn dest_path(
    root: &Path,
    channel_name: &str,
    start: NaiveDateTime,
    taken: impl Fn(&Path) -> bool,
) -> PathBuf {
    let dir = root.join(RECORDINGS_DIR);
    let stem = format!(
        "{} {}",
        sanitize_filename(channel_name),
        start.format("%Y-%m-%d %H.%M")
    );
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{stem}.{CONTAINER}")
        } else {
            format!("{stem} ({n}).{CONTAINER}")
        };
        let path = dir.join(name);
        if !taken(&path) {
            return path;
        }
        n += 1;
    }
}

/// ffmpeg arguments for recording `url` into `dest`. It's the same stream
/// copy as a download, always to MPEG-TS and with no length. The app stops
/// ffmpeg at the end time by sending `q` on its stdin, which lets ffmpeg
/// finish the file, so these must never include `-nostdin`.
pub fn ffmpeg_args(url: &str, dest: &str) -> Vec<String> {
    build_ffmpeg_args(url, dest, CONTAINER)
}

/// Check a window the user asked to record, in Unix seconds.
pub fn check_window(start_at: i64, end_at: i64, now: i64) -> Result<(), &'static str> {
    if end_at <= start_at {
        Err("The recording has to end after it starts.")
    } else if end_at <= now {
        Err("That time has already passed.")
    } else if end_at - start_at > MAX_LENGTH_SECS {
        Err("A recording can be up to 12 hours long.")
    } else {
        Ok(())
    }
}

/// A new scheduled recording of the live channel `source`. Its own id is
/// also its channel id, so looking up downloads by the live channel's id
/// never finds it. It has no file until it starts.
pub fn new_scheduled(
    id: &str,
    source: &Channel,
    program_title: Option<String>,
    start_at: i64,
    end_at: i64,
    now: i64,
) -> DownloadRecord {
    DownloadRecord {
        id: id.to_string(),
        channel_id: id.to_string(),
        title: source.name.clone(),
        kind: DownloadKind::Recording,
        series_channel_id: None,
        status: DownloadStatus::Scheduled,
        dest_path: String::new(),
        total_bytes: None,
        downloaded_bytes: 0,
        avg_rate_bps: None,
        error: None,
        created_at: now,
        finished_at: None,
        keep: false,
        last_played_at: None,
        source_channel_id: Some(source.id.clone()),
        start_at: Some(start_at),
        end_at: Some(end_at),
        program_title,
    }
}

/// A scheduled recording of the rest of `rec`, from `now` to its end, with
/// the id `id`. Used at launch for a recording the app was running when it
/// quit, whose program is still on.
pub fn rest_of(rec: &DownloadRecord, id: &str, now: i64) -> DownloadRecord {
    DownloadRecord {
        id: id.to_string(),
        channel_id: id.to_string(),
        status: DownloadStatus::Scheduled,
        dest_path: String::new(),
        downloaded_bytes: 0,
        avg_rate_bps: None,
        error: None,
        created_at: now,
        finished_at: None,
        keep: false,
        last_played_at: None,
        start_at: Some(now),
        ..rec.clone()
    }
}

/// The provider that owns `channel_id`, out of `provider_ids`. The app gives
/// each channel an id that starts with its provider's id and a dash.
pub fn provider_of<'a>(channel_id: &str, provider_ids: &'a [String]) -> Option<&'a str> {
    provider_ids
        .iter()
        .filter(|p| {
            channel_id
                .strip_prefix(p.as_str())
                .is_some_and(|rest| rest.starts_with('-'))
        })
        .max_by_key(|p| p.len())
        .map(String::as_str)
}

/// The channel to record for a recording of the channel called `name`.
/// Channel ids follow each channel's place in the playlist, so after a
/// refresh the saved id can belong to another channel. The `saved` channel
/// counts only while its name still matches. Otherwise this looks for the
/// name among `channels`, the provider's channels.
pub fn pick_source<'a>(
    saved: Option<&'a Channel>,
    name: &str,
    channels: &'a [Channel],
) -> Option<&'a Channel> {
    saved.filter(|c| c.name == name).or_else(|| {
        channels
            .iter()
            .find(|c| c.content_type == "live" && c.name == name)
    })
}

/// The program title for a recording that takes in the next one.
pub fn merged_title(first: Option<&str>, next: Option<&str>) -> Option<String> {
    match (first, next) {
        (Some(a), Some(b)) if a != b => Some(format!("{a}, {b}")),
        (Some(a), _) => Some(a.to_string()),
        (None, b) => b.map(str::to_string),
    }
}

/// What the app should do about one recording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Start recording. Its window has begun and hasn't ended.
    Start(String),
    /// `id` is due while `into` records the same channel. Move the end of
    /// `into` to `end_at` and drop `id`, so both programs end up in one file.
    Merge {
        id: String,
        into: String,
        end_at: i64,
    },
    /// The window passed before the recording could start.
    Miss(String),
    /// The recording reached its end time.
    Stop(String),
}

/// What to do at `now` with the recordings in `records`. Other records are
/// ignored. Recordings that are due start in the order of their start times.
/// One that's due while the same channel is recording, and that starts
/// before that recording ends, merges into it instead of starting.
pub fn plan(records: &[DownloadRecord], now: i64) -> Vec<Action> {
    let recordings = records.iter().filter(|r| r.kind == DownloadKind::Recording);
    // (id, channel, end) of each recording that's running, or that this plan
    // starts, with its end as merges move it.
    let mut running: Vec<(String, Option<String>, i64)> = recordings
        .clone()
        .filter(|r| r.status == DownloadStatus::Recording)
        .map(|r| {
            (
                r.id.clone(),
                r.source_channel_id.clone(),
                r.end_at.unwrap_or(now),
            )
        })
        .collect();
    let already_running = running.len();

    let mut due: Vec<&DownloadRecord> = recordings
        .filter(|r| r.status == DownloadStatus::Scheduled)
        .filter(|r| r.start_at.unwrap_or(now) <= now)
        .collect();
    due.sort_by_key(|r| (r.start_at.unwrap_or(now), r.created_at));

    let mut actions = Vec::new();
    for rec in due {
        let start = rec.start_at.unwrap_or(now);
        let end = rec.end_at.unwrap_or(now);
        if end <= now {
            actions.push(Action::Miss(rec.id.clone()));
            continue;
        }
        let target = running
            .iter_mut()
            .find(|(_, channel, run_end)| *channel == rec.source_channel_id && *run_end >= start);
        match target {
            Some((into, _, run_end)) => {
                *run_end = (*run_end).max(end);
                actions.push(Action::Merge {
                    id: rec.id.clone(),
                    into: into.clone(),
                    end_at: *run_end,
                });
            }
            None => {
                actions.push(Action::Start(rec.id.clone()));
                running.push((rec.id.clone(), rec.source_channel_id.clone(), end));
            }
        }
    }
    for (id, _, end) in &running[..already_running] {
        if *end <= now {
            actions.push(Action::Stop(id.clone()));
        }
    }
    actions
}

/// The recordings in `records` left `Recording` when the app last quit or
/// crashed. Each keeps its file and is finished. The flag says whether its
/// end is still ahead, so the app records the rest into a new file.
pub fn interrupted(records: &[DownloadRecord], now: i64) -> Vec<(&DownloadRecord, bool)> {
    records
        .iter()
        .filter(|r| r.kind == DownloadKind::Recording && r.status == DownloadStatus::Recording)
        .map(|r| (r, r.end_at.is_some_and(|end| end > now)))
        .collect()
}

/// How a recording turned out once its ffmpeg exited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// It ran until the end time, or until the user stopped it.
    Finished,
    /// ffmpeg stopped on its own before the end, such as when the stream
    /// failed. The file keeps what was recorded.
    EndedEarly,
    /// Nothing was recorded.
    Failed,
}

/// How a recording turned out. `bytes` is the size of its file, and
/// `stopped` says whether the app asked ffmpeg to stop.
pub fn outcome(bytes: u64, stopped: bool) -> Outcome {
    if bytes == 0 {
        Outcome::Failed
    } else if stopped {
        Outcome::Finished
    } else {
        Outcome::EndedEarly
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn channel(id: &str, name: &str, content_type: &str) -> Channel {
        Channel {
            id: id.into(),
            name: name.into(),
            url: format!("http://h/live/{id}.ts"),
            logo_url: None,
            group_title: "News".into(),
            tvg_id: None,
            tvg_name: None,
            is_favorite: false,
            content_type: content_type.into(),
            sources: vec![],
            series_title: None,
            season: None,
            episode: None,
        }
    }

    fn rec(id: &str, source: &str, status: DownloadStatus, start: i64, end: i64) -> DownloadRecord {
        let mut r = new_scheduled(
            id,
            &channel(source, "City News", "live"),
            None,
            start,
            end,
            0,
        );
        r.status = status;
        r
    }

    fn at(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 12)
            .unwrap()
            .and_hms_opt(h, m, 30)
            .unwrap()
    }

    #[test]
    fn names_the_file_after_the_channel_and_local_start_time() {
        let path = dest_path(Path::new("/dl"), "City News", at(20, 0), |_| false);
        assert_eq!(
            path,
            Path::new("/dl/recordings/City News 2026-10-12 20.00.ts")
        );
        let odd = dest_path(Path::new("/dl"), "News: 24/7", at(9, 5), |_| false);
        assert_eq!(
            odd,
            Path::new("/dl/recordings/News_ 24_7 2026-10-12 09.05.ts")
        );
    }

    #[test]
    fn numbers_a_file_name_that_is_taken() {
        let first = Path::new("/dl/recordings/City News 2026-10-12 20.00.ts");
        let second = Path::new("/dl/recordings/City News 2026-10-12 20.00 (2).ts");
        let path = dest_path(Path::new("/dl"), "City News", at(20, 0), |p| {
            p == first || p == second
        });
        assert_eq!(
            path,
            Path::new("/dl/recordings/City News 2026-10-12 20.00 (3).ts")
        );
    }

    #[test]
    fn records_to_mpegts_with_no_length_and_stdin_left_open() {
        let args = ffmpeg_args("http://h/live/u/p/1.ts", "/dl/recordings/a.ts");
        let pos = |flag: &str| args.iter().position(|a| a == flag);
        assert_eq!(args[pos("-f").unwrap() + 1], "mpegts");
        assert_eq!(args[pos("-c").unwrap() + 1], "copy");
        assert_eq!(args[pos("-i").unwrap() + 1], "http://h/live/u/p/1.ts");
        assert_eq!(args.last().unwrap(), "/dl/recordings/a.ts");
        assert!(pos("-t").is_none());
        assert!(pos("-nostdin").is_none());
        assert!(pos("-movflags").is_none());
    }

    #[test]
    fn checks_the_window() {
        assert!(check_window(100, 200, 50).is_ok());
        // Started already but not over, as with Record now.
        assert!(check_window(100, 200, 150).is_ok());
        assert!(check_window(200, 200, 50).is_err());
        assert!(check_window(100, 200, 200).is_err());
        assert!(check_window(0, MAX_LENGTH_SECS + 1, 0).is_err());
    }

    #[test]
    fn a_new_recording_uses_its_own_id_as_its_channel() {
        let source = channel("p1-xt-4", "City News", "live");
        let r = new_scheduled("rec-1", &source, Some("Evening news".into()), 100, 200, 50);
        assert_eq!(r.channel_id, "rec-1");
        assert_eq!(r.source_channel_id.as_deref(), Some("p1-xt-4"));
        assert_eq!(r.title, "City News");
        assert_eq!(r.kind, DownloadKind::Recording);
        assert_eq!(r.status, DownloadStatus::Scheduled);
        assert_eq!((r.start_at, r.end_at), (Some(100), Some(200)));
        assert!(r.dest_path.is_empty());
    }

    #[test]
    fn the_rest_of_a_recording_starts_now_and_ends_on_time() {
        let mut old = rec("rec-1", "c1", DownloadStatus::Recording, 100, 1_000);
        old.dest_path = "/dl/recordings/a.ts".into();
        old.downloaded_bytes = 5_000;
        old.program_title = Some("Evening news".into());
        let rest = rest_of(&old, "rec-2", 400);
        assert_eq!(rest.channel_id, "rec-2");
        assert_eq!(rest.status, DownloadStatus::Scheduled);
        assert_eq!((rest.start_at, rest.end_at), (Some(400), Some(1_000)));
        assert_eq!(rest.downloaded_bytes, 0);
        assert!(rest.dest_path.is_empty());
        assert_eq!(rest.source_channel_id.as_deref(), Some("c1"));
        assert_eq!(rest.program_title.as_deref(), Some("Evening news"));
    }

    #[test]
    fn finds_the_provider_by_the_longest_matching_prefix() {
        let providers = vec!["xt-1a".to_string(), "xt-1".to_string(), "m3u-9".to_string()];
        assert_eq!(provider_of("xt-1-xt-4", &providers), Some("xt-1"));
        assert_eq!(provider_of("xt-1a-ch-2", &providers), Some("xt-1a"));
        assert_eq!(provider_of("xt-1-xt-ep-5-s1-0", &providers), Some("xt-1"));
        assert_eq!(provider_of("xt-12-ch-2", &providers), None);
        assert_eq!(provider_of("rec-1", &providers), None);
    }

    #[test]
    fn records_the_saved_channel_only_while_its_name_matches() {
        let saved = channel("p1-xt-4", "City News", "live");
        let moved = channel("p1-xt-5", "City News", "live");
        let other = channel("p1-xt-4", "Sports One", "live");
        let movie = channel("p1-xt-9", "City News", "movie");
        let all = vec![movie.clone(), moved.clone()];

        assert_eq!(pick_source(Some(&saved), "City News", &all), Some(&saved));
        // A refresh gave the id to another channel and moved this one.
        assert_eq!(pick_source(Some(&other), "City News", &all), Some(&moved));
        assert_eq!(pick_source(None, "City News", &all), Some(&moved));
        assert_eq!(pick_source(Some(&other), "City News", &[movie]), None);
    }

    #[test]
    fn merges_program_titles() {
        assert_eq!(merged_title(Some("A"), Some("B")).as_deref(), Some("A, B"));
        assert_eq!(merged_title(Some("A"), Some("A")).as_deref(), Some("A"));
        assert_eq!(merged_title(Some("A"), None).as_deref(), Some("A"));
        assert_eq!(merged_title(None, Some("B")).as_deref(), Some("B"));
        assert_eq!(merged_title(None, None), None);
    }

    #[test]
    fn starts_what_is_due_and_leaves_the_rest() {
        let records = vec![
            rec("due", "c1", DownloadStatus::Scheduled, 100, 500),
            rec("later", "c2", DownloadStatus::Scheduled, 300, 500),
            rec("done", "c3", DownloadStatus::Completed, 0, 50),
        ];
        assert_eq!(plan(&records, 200), vec![Action::Start("due".into())]);
    }

    #[test]
    fn misses_a_window_that_passed_and_records_the_rest_of_one_still_on() {
        let records = vec![
            rec("gone", "c1", DownloadStatus::Scheduled, 100, 200),
            rec("still-on", "c2", DownloadStatus::Scheduled, 100, 900),
        ];
        assert_eq!(
            plan(&records, 500),
            vec![
                Action::Miss("gone".into()),
                Action::Start("still-on".into())
            ]
        );
    }

    #[test]
    fn stops_a_recording_at_its_end() {
        let records = vec![
            rec("over", "c1", DownloadStatus::Recording, 0, 500),
            rec("on", "c2", DownloadStatus::Recording, 0, 900),
        ];
        assert_eq!(plan(&records, 500), vec![Action::Stop("over".into())]);
    }

    #[test]
    fn extends_a_running_recording_of_the_same_channel() {
        let records = vec![
            rec("first", "c1", DownloadStatus::Recording, 0, 3_900),
            rec("next", "c1", DownloadStatus::Scheduled, 3_480, 7_500),
        ];
        assert_eq!(
            plan(&records, 3_500),
            vec![Action::Merge {
                id: "next".into(),
                into: "first".into(),
                end_at: 7_500,
            }]
        );
    }

    #[test]
    fn a_merge_never_brings_the_end_forward() {
        let records = vec![
            rec("long", "c1", DownloadStatus::Recording, 0, 9_000),
            rec("inside", "c1", DownloadStatus::Scheduled, 100, 500),
        ];
        assert_eq!(
            plan(&records, 200),
            vec![Action::Merge {
                id: "inside".into(),
                into: "long".into(),
                end_at: 9_000,
            }]
        );
    }

    #[test]
    fn keeps_a_recording_running_when_a_merge_moves_its_end() {
        // The tick came late: "first" is past its end, but "next" began
        // before it and takes it over.
        let records = vec![
            rec("first", "c1", DownloadStatus::Recording, 0, 1_000),
            rec("next", "c1", DownloadStatus::Scheduled, 900, 5_000),
        ];
        assert_eq!(
            plan(&records, 1_010),
            vec![Action::Merge {
                id: "next".into(),
                into: "first".into(),
                end_at: 5_000,
            }]
        );
    }

    #[test]
    fn does_not_merge_across_channels_or_a_gap() {
        let records = vec![
            rec("first", "c1", DownloadStatus::Recording, 0, 1_000),
            rec("other", "c2", DownloadStatus::Scheduled, 500, 2_000),
            rec("after-gap", "c1", DownloadStatus::Scheduled, 1_005, 2_000),
        ];
        assert_eq!(
            plan(&records, 1_010),
            vec![
                Action::Start("other".into()),
                Action::Start("after-gap".into()),
                Action::Stop("first".into()),
            ]
        );
    }

    #[test]
    fn merges_two_recordings_that_are_due_together() {
        // At launch, two back to back programs of one channel are both on.
        let records = vec![
            rec("b", "c1", DownloadStatus::Scheduled, 200, 900),
            rec("a", "c1", DownloadStatus::Scheduled, 100, 300),
        ];
        assert_eq!(
            plan(&records, 250),
            vec![
                Action::Start("a".into()),
                Action::Merge {
                    id: "b".into(),
                    into: "a".into(),
                    end_at: 900,
                },
            ]
        );
    }

    #[test]
    fn ignores_downloads() {
        let mut movie = rec("m", "c1", DownloadStatus::Scheduled, 0, 900);
        movie.kind = DownloadKind::Movie;
        assert!(plan(&[movie], 100).is_empty());
    }

    #[test]
    fn finds_recordings_cut_off_by_a_quit() {
        let records = vec![
            rec("over", "c1", DownloadStatus::Recording, 0, 500),
            rec("still-on", "c2", DownloadStatus::Recording, 0, 900),
            rec("waiting", "c3", DownloadStatus::Scheduled, 600, 900),
        ];
        let found: Vec<_> = interrupted(&records, 600)
            .into_iter()
            .map(|(r, rest)| (r.id.as_str(), rest))
            .collect();
        assert_eq!(found, vec![("over", false), ("still-on", true)]);
    }

    #[test]
    fn keeps_whatever_was_recorded() {
        assert_eq!(outcome(1_000, true), Outcome::Finished);
        assert_eq!(outcome(1_000, false), Outcome::EndedEarly);
        assert_eq!(outcome(0, true), Outcome::Failed);
        assert_eq!(outcome(0, false), Outcome::Failed);
    }
}
