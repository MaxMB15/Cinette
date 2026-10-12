// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Recordings of live channels. A recording is a download record of kind
//! `Recording` with a start and an end time. It waits as `Scheduled`, runs as
//! `Recording` and ends as `Completed`. One whose whole window passed while
//! the app wasn't running becomes `Missed`. The app checks the clock at least
//! every 30 seconds and carries out what [`plan`] returns.

use crate::downloads::ffmpeg::stream_copy_args;
use crate::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use crate::downloads::paths::{sanitize_filename, RECORDINGS_DIR};
use crate::models::channel::Channel;
use chrono::NaiveDateTime;
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Recordings are always MPEG-TS. A TS file stays playable when ffmpeg stops
/// without finishing it, as when the app quits or the stream drops.
pub const CONTAINER: &str = "ts";

/// The longest recording the app accepts, in seconds.
pub const MAX_LENGTH_SECS: i64 = 12 * 60 * 60;

/// How long past its end a recording's ffmpeg runs before it stops by
/// itself, in seconds. See [`backstop_secs`].
const BACKSTOP_SLACK_SECS: i64 = 5 * 60;

/// The shortest part of a program worth recording on its own, in seconds.
/// When less than this is left of a recording that was cut off, the app
/// doesn't record the rest.
pub const MIN_REST_SECS: i64 = 60;

/// How long to wait before each new try at a recording whose stream failed,
/// in seconds.
const RETRY_DELAYS_SECS: [i64; 3] = [30, 60, 120];

/// A recording whose stream ran this long before it failed gets all its
/// tries again, in seconds.
pub const RETRY_RESET_SECS: i64 = 5 * 60;

/// The path for a recording of `channel_name` that starts at `start`, local
/// time, such as `<root>/recordings/City News 2026-10-12 20.00.ts`. Two
/// recordings can share a channel name and a minute, so the caller numbers
/// a path that's in use with [`unique_dest_path`].
///
/// [`unique_dest_path`]: crate::downloads::paths::unique_dest_path
pub fn dest_path(root: &Path, channel_name: &str, start: NaiveDateTime) -> PathBuf {
    let name = format!(
        "{} {}.{CONTAINER}",
        sanitize_filename(channel_name),
        start.format("%Y-%m-%d %H.%M")
    );
    root.join(RECORDINGS_DIR).join(name)
}

/// ffmpeg arguments for recording `url` into `dest` for at most `max_secs`
/// seconds. It's the same stream copy as a download, always to MPEG-TS. The
/// app stops ffmpeg at the end time by sending `q` on its stdin, which lets
/// ffmpeg finish the file, so these must never include `-nostdin`. The length
/// limit is a backstop for when the app can't, as after a crash.
pub fn ffmpeg_args(url: &str, dest: &str, max_secs: i64) -> Vec<String> {
    let input = [
        // A stream that sends nothing for 15 seconds counts as dropped, so
        // ffmpeg stops instead of waiting on it for good, and the recording
        // tries again. In microseconds.
        "-rw_timeout",
        "15000000",
        // Connect again when connecting fails with a network error.
        "-reconnect_on_network_error",
        "1",
        // Report the size of the file every 5 seconds, not twice a second.
        "-stats_period",
        "5",
    ]
    .map(String::from);
    let output = ["-t".to_string(), max_secs.to_string()];
    stream_copy_args(url, dest, CONTAINER, &input, &output)
}

/// How long the ffmpeg for `rec` may run when it starts at `now`, in seconds.
/// That's until the end of `rec` and of the scheduled recordings on its
/// channel that it will take in, plus a few minutes. The app stops ffmpeg
/// before then, so this only matters when it can't.
pub fn backstop_secs(
    records: &[DownloadRecord],
    rec: &DownloadRecord,
    providers: &[String],
    now: i64,
) -> i64 {
    let mut end = rec.end_at.unwrap_or(now);
    let mut next: Vec<&DownloadRecord> = records
        .iter()
        .filter(|r| r.kind == DownloadKind::Recording && r.status == DownloadStatus::Scheduled)
        .filter(|r| r.id != rec.id && same_channel(r, rec, providers))
        .collect();
    next.sort_by_key(|r| r.start_at);
    for r in next {
        if let (Some(start), Some(next_end)) = (r.start_at, r.end_at) {
            if start <= end {
                end = end.max(next_end);
            }
        }
    }
    (end - now).clamp(0, MAX_LENGTH_SECS) + BACKSTOP_SLACK_SECS
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

/// A program from the guide that a recording is for, with its own start and
/// end in Unix seconds.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GuideProgram {
    pub title: String,
    pub start: i64,
    pub end: i64,
}

/// A new scheduled recording of the live channel `source`. Its own id is
/// also its channel id, so looking up downloads by the live channel's id
/// never finds it. It has no file until it starts.
pub fn new_scheduled(
    id: &str,
    source: &Channel,
    program: Option<GuideProgram>,
    start_at: i64,
    end_at: i64,
    now: i64,
) -> DownloadRecord {
    // A guide entry that ends before it starts has no use as bounds.
    let bounds = program
        .as_ref()
        .filter(|p| p.end > p.start)
        .map(|p| (p.start, p.end));
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
        program_title: program.map(|p| p.title),
        program_start: bounds.map(|(start, _)| start),
        program_end: bounds.map(|(_, end)| end),
    }
}

/// A scheduled recording of the rest of `rec`, from `start_at` to its end,
/// with the id `id`. Used for a recording that was cut off while its program
/// is still on, as when the app quit or the stream failed.
pub fn rest_of(rec: &DownloadRecord, id: &str, start_at: i64, now: i64) -> DownloadRecord {
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
        start_at: Some(start_at),
        ..rec.clone()
    }
}

/// Where the program `rec` is for starts, without the margin before it.
pub fn core_start(rec: &DownloadRecord) -> i64 {
    let start = rec.start_at.unwrap_or(0);
    rec.program_start.map_or(start, |p| p.max(start))
}

/// Where the program `rec` is for ends, without the margin after it.
pub fn core_end(rec: &DownloadRecord) -> i64 {
    let end = rec.end_at.unwrap_or(0);
    rec.program_end.map_or(end, |p| p.min(end))
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

/// The provider of the channel that `rec` records.
fn provider_of_recording<'a>(rec: &DownloadRecord, providers: &'a [String]) -> Option<&'a str> {
    provider_of(rec.source_channel_id.as_deref()?, providers)
}

/// Whether `a` and `b` record channels of one provider.
fn same_provider(a: &DownloadRecord, b: &DownloadRecord, providers: &[String]) -> bool {
    let provider = provider_of_recording(a, providers);
    provider.is_some() && provider == provider_of_recording(b, providers)
}

/// Whether `a` and `b` record one channel. Channel ids follow each channel's
/// place in the playlist, so a refresh can give an id to another channel.
/// A recording's title is its channel's name, and the name decides, within
/// one provider. Without a known provider the ids have to match as well.
pub fn same_channel(a: &DownloadRecord, b: &DownloadRecord, providers: &[String]) -> bool {
    a.title == b.title
        && (same_provider(a, b, providers) || a.source_channel_id == b.source_channel_id)
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

/// Let the running recording `target` take in `next`, which is on the same
/// channel. Its end moves to `end_at`, never earlier, and it takes on the
/// title and the end of the next program.
pub fn merge_into(target: &mut DownloadRecord, next: &DownloadRecord, end_at: i64) {
    let program_end = core_end(target).max(core_end(next));
    target.end_at = Some(target.end_at.map_or(end_at, |end| end.max(end_at)));
    target.program_title = merged_title(
        target.program_title.as_deref(),
        next.program_title.as_deref(),
    );
    target.program_end = Some(program_end);
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
    /// Stop the recording now. It reached its end time, or it hands its
    /// provider's connection over to the next recording.
    Stop(String),
}

/// What [`plan`] decided.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    /// What to do now, in order. Stops come first, so a provider's
    /// connection is free before the recording that needs it starts.
    pub actions: Vec<Action>,
    /// When a recording is next due to start, stop or hand over, in Unix
    /// seconds.
    pub next_check: Option<i64>,
}

/// A recording that's running, or that the plan starts.
struct Slot<'a> {
    rec: &'a DownloadRecord,
    /// Its end, as merges move it.
    end: i64,
    /// The end of its program, as merges move it.
    core_end: i64,
    /// The plan starts it.
    new: bool,
    /// The plan stops it to hand over its provider's connection.
    stopping: bool,
}

/// When the running recording `slot` hands its provider's connection over to
/// `next`. That's halfway through the gap between their programs, or where
/// one program ends and the next begins, and within the time both windows
/// share.
fn handover_at(slot: &Slot, next: &DownloadRecord) -> i64 {
    let from = slot.core_end.max(next.start_at.unwrap_or(0));
    let to = core_start(next).min(slot.end);
    from + (to - from).max(0) / 2
}

fn soonest(next: &mut Option<i64>, at: i64) {
    *next = Some(next.map_or(at, |n| n.min(at)));
}

/// What to do at `now` with the recordings in `records`. Other records are
/// ignored. `providers` are the ids of every provider.
///
/// Recordings that are due start in the order of their start times. One
/// that's due while the same channel is recording, and that starts before
/// that recording ends, merges into it instead of starting. Many providers
/// allow one stream at a time, so when two recordings from one provider
/// overlap only by their margins, the first stops between their programs
/// and the second starts then.
pub fn plan(records: &[DownloadRecord], providers: &[String], now: i64) -> Plan {
    let recordings: Vec<&DownloadRecord> = records
        .iter()
        .filter(|r| r.kind == DownloadKind::Recording)
        .collect();
    let mut slots: Vec<Slot> = recordings
        .iter()
        .filter(|r| r.status == DownloadStatus::Recording)
        .map(|r| Slot {
            rec: r,
            end: r.end_at.unwrap_or(now),
            core_end: core_end(r),
            new: false,
            stopping: false,
        })
        .collect();
    let mut due: Vec<&DownloadRecord> = recordings
        .iter()
        .copied()
        .filter(|r| r.status == DownloadStatus::Scheduled)
        .collect();
    due.sort_by_key(|r| (r.start_at.unwrap_or(now), r.created_at));

    let mut stops = Vec::new();
    let mut actions = Vec::new();
    let mut next_check = None;
    for rec in due {
        let start = rec.start_at.unwrap_or(now);
        let end = rec.end_at.unwrap_or(now);
        if start > now {
            soonest(&mut next_check, start);
            continue;
        }
        if end <= now {
            actions.push(Action::Miss(rec.id.clone()));
            continue;
        }
        let target = slots
            .iter_mut()
            .find(|s| !s.stopping && s.end >= start && same_channel(s.rec, rec, providers));
        if let Some(slot) = target {
            slot.end = slot.end.max(end);
            slot.core_end = slot.core_end.max(core_end(rec));
            actions.push(Action::Merge {
                id: rec.id.clone(),
                into: slot.rec.id.clone(),
                end_at: slot.end,
            });
            continue;
        }
        let handover = slots.iter_mut().find(|s| {
            !s.stopping
                && s.end > start
                && s.core_end <= core_start(rec)
                && same_provider(s.rec, rec, providers)
        });
        if let Some(slot) = handover {
            let at = handover_at(slot, rec);
            if now < at {
                soonest(&mut next_check, at);
                continue;
            }
            slot.stopping = true;
            let id = slot.rec.id.clone();
            if slot.new {
                // Both came due at once, as at launch, and the program of the
                // first is already over.
                if let Some(action) = actions
                    .iter_mut()
                    .find(|a| **a == Action::Start(id.clone()))
                {
                    *action = Action::Miss(id);
                }
            } else {
                stops.push(Action::Stop(id));
            }
        }
        actions.push(Action::Start(rec.id.clone()));
        slots.push(Slot {
            rec,
            end,
            core_end: core_end(rec),
            new: true,
            stopping: false,
        });
    }
    for slot in slots.iter().filter(|s| !s.stopping) {
        if !slot.new && slot.end <= now {
            stops.push(Action::Stop(slot.rec.id.clone()));
        } else {
            soonest(&mut next_check, slot.end);
        }
    }
    stops.extend(actions);
    Plan {
        actions: stops,
        next_check,
    }
}

/// The recordings in `records` left `Recording` when the app last quit or
/// crashed. Each keeps its file and is finished. The flag says whether
/// enough of its window is left to record the rest into a new file.
pub fn interrupted(records: &[DownloadRecord], now: i64) -> Vec<(&DownloadRecord, bool)> {
    records
        .iter()
        .filter(|r| r.kind == DownloadKind::Recording && r.status == DownloadStatus::Recording)
        .map(|r| (r, r.end_at.is_some_and(|end| end - now >= MIN_REST_SECS)))
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

/// When to try `rec` again after its stream failed at `now`, when it had
/// `tries` tries before. None once it has had all its tries, or when too
/// little of its window would be left by then.
pub fn retry_at(rec: &DownloadRecord, tries: u32, now: i64) -> Option<i64> {
    let at = now + RETRY_DELAYS_SECS.get(tries as usize)?;
    rec.end_at
        .is_some_and(|end| end - at >= MIN_REST_SECS)
        .then_some(at)
}

/// What went wrong with a stream, going by an error line from ffmpeg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamError {
    LoginRefused,
    Refused,
    NotFound,
    ProviderFailed,
    ConnectionFailed,
    DiskFull,
}

impl StreamError {
    /// The kind of error in the ffmpeg error line `line`, when it's one the
    /// app knows.
    pub fn classify(line: &str) -> Option<Self> {
        let line = line.to_ascii_lowercase();
        let has = |words: &[&str]| words.iter().any(|w| line.contains(w));
        if has(&["no space left"]) {
            Some(Self::DiskFull)
        } else if has(&["401 unauthorized"]) {
            Some(Self::LoginRefused)
        } else if has(&["404 not found"]) {
            Some(Self::NotFound)
        } else if has(&["403 forbidden", "4xx client error"]) {
            Some(Self::Refused)
        } else if has(&["5xx server error"]) {
            Some(Self::ProviderFailed)
        } else if has(&[
            "connection refused",
            "connection reset",
            "timed out",
            "network is unreachable",
            "failed to resolve",
            "input/output error",
            "broken pipe",
        ]) {
            Some(Self::ConnectionFailed)
        } else {
            None
        }
    }

    /// What happened, in plain words.
    pub fn message(self) -> &'static str {
        match self {
            Self::LoginRefused => "The provider didn't accept the login.",
            Self::Refused => {
                "The provider refused the stream. Some providers allow one stream at a time."
            }
            Self::NotFound => "The provider couldn't find the channel.",
            Self::ProviderFailed => "The provider had a problem sending the stream.",
            Self::ConnectionFailed => "The connection to the provider failed.",
            Self::DiskFull => "The disk is full.",
        }
    }

    /// Whether trying again later could help.
    pub fn worth_retrying(self) -> bool {
        matches!(
            self,
            Self::Refused | Self::ProviderFailed | Self::ConnectionFailed
        )
    }
}

/// Whether to try again after a stream failed with the ffmpeg error `detail`.
/// An error the app doesn't know gets its tries too.
pub fn worth_retrying(detail: Option<&str>) -> bool {
    detail
        .and_then(StreamError::classify)
        .is_none_or(StreamError::worth_retrying)
}

/// The error to save for a recording that failed or stopped early. Its first
/// line says what happened in plain words, `fallback` when ffmpeg's error
/// line `detail` isn't one the app knows. The line itself follows, for
/// anyone who wants the detail.
pub fn failure_message(fallback: &str, detail: Option<&str>) -> String {
    match detail {
        None => fallback.to_string(),
        Some(detail) => {
            let plain = StreamError::classify(detail).map_or(fallback, |e| e.message());
            format!("{plain}\n{detail}")
        }
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
        named(id, source, "City News", status, start, end)
    }

    fn named(
        id: &str,
        source: &str,
        name: &str,
        status: DownloadStatus,
        start: i64,
        end: i64,
    ) -> DownloadRecord {
        let mut r = new_scheduled(id, &channel(source, name, "live"), None, start, end, 0);
        r.status = status;
        r
    }

    /// A recording of a program from `start` to `end` on `source`, with two
    /// minutes of margin on each side.
    fn program(
        id: &str,
        source: &str,
        name: &str,
        status: DownloadStatus,
        start: i64,
        end: i64,
    ) -> DownloadRecord {
        let mut r = named(id, source, name, status, start - 120, end + 120);
        r.program_start = Some(start);
        r.program_end = Some(end);
        r
    }

    fn providers() -> Vec<String> {
        vec!["p1".to_string(), "p2".to_string()]
    }

    fn actions(records: &[DownloadRecord], now: i64) -> Vec<Action> {
        plan(records, &providers(), now).actions
    }

    fn at(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 12)
            .unwrap()
            .and_hms_opt(h, m, 30)
            .unwrap()
    }

    #[test]
    fn names_the_file_after_the_channel_and_local_start_time() {
        let path = dest_path(Path::new("/dl"), "City News", at(20, 0));
        assert_eq!(
            path,
            Path::new("/dl/recordings/City News 2026-10-12 20.00.ts")
        );
        let odd = dest_path(Path::new("/dl"), "News: 24/7", at(9, 5));
        assert_eq!(
            odd,
            Path::new("/dl/recordings/News_ 24_7 2026-10-12 09.05.ts")
        );
    }

    #[test]
    fn records_to_mpegts_for_a_limited_time_with_stdin_left_open() {
        let args = ffmpeg_args("http://h/live/u/p/1.ts", "/dl/recordings/a.ts", 3_900);
        let pos = |flag: &str| args.iter().position(|a| a == flag);
        let input = pos("-i").unwrap();
        assert_eq!(args[pos("-f").unwrap() + 1], "mpegts");
        assert_eq!(args[pos("-c").unwrap() + 1], "copy");
        assert_eq!(args[input + 1], "http://h/live/u/p/1.ts");
        assert_eq!(args.last().unwrap(), "/dl/recordings/a.ts");
        // Options for the stream go before it, the length after it.
        assert_eq!(args[pos("-rw_timeout").unwrap() + 1], "15000000");
        assert!(pos("-rw_timeout").unwrap() < input);
        assert_eq!(args[pos("-reconnect_on_network_error").unwrap() + 1], "1");
        assert_eq!(args[pos("-stats_period").unwrap() + 1], "5");
        assert_eq!(args[pos("-t").unwrap() + 1], "3900");
        assert!(pos("-t").unwrap() > input);
        assert!(pos("-nostdin").is_none());
        assert!(pos("-movflags").is_none());
    }

    #[test]
    fn lets_ffmpeg_run_a_little_past_the_end_of_everything_it_will_take_in() {
        let first = rec("first", "c1", DownloadStatus::Recording, 0, 1_000);
        assert_eq!(backstop_secs(&[], &first, &[], 100), 900 + 300);

        let records = vec![
            first.clone(),
            rec("next", "c1", DownloadStatus::Scheduled, 1_000, 2_000),
            rec("after", "c1", DownloadStatus::Scheduled, 1_900, 3_000),
            rec("gap", "c1", DownloadStatus::Scheduled, 3_500, 4_000),
            rec("other", "c2", DownloadStatus::Scheduled, 500, 9_000),
        ];
        assert_eq!(backstop_secs(&records, &first, &[], 100), 2_900 + 300);

        let long = rec("long", "c1", DownloadStatus::Recording, 0, 100_000);
        assert_eq!(
            backstop_secs(&[], &long, &[], 0),
            MAX_LENGTH_SECS + BACKSTOP_SLACK_SECS
        );
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
        let news = GuideProgram {
            title: "Evening news".into(),
            start: 120,
            end: 180,
        };
        let r = new_scheduled("rec-1", &source, Some(news), 100, 200, 50);
        assert_eq!(r.channel_id, "rec-1");
        assert_eq!(r.source_channel_id.as_deref(), Some("p1-xt-4"));
        assert_eq!(r.title, "City News");
        assert_eq!(r.kind, DownloadKind::Recording);
        assert_eq!(r.status, DownloadStatus::Scheduled);
        assert_eq!((r.start_at, r.end_at), (Some(100), Some(200)));
        assert_eq!(r.program_title.as_deref(), Some("Evening news"));
        assert_eq!((r.program_start, r.program_end), (Some(120), Some(180)));
        assert!(r.dest_path.is_empty());
    }

    #[test]
    fn ignores_program_times_that_make_no_sense() {
        let source = channel("p1-xt-4", "City News", "live");
        let odd = GuideProgram {
            title: "Evening news".into(),
            start: 180,
            end: 120,
        };
        let r = new_scheduled("rec-1", &source, Some(odd), 100, 200, 50);
        assert_eq!(r.program_title.as_deref(), Some("Evening news"));
        assert_eq!((r.program_start, r.program_end), (None, None));
        // Without them the program is the whole window.
        assert_eq!((core_start(&r), core_end(&r)), (100, 200));
    }

    #[test]
    fn finds_the_program_inside_its_margins() {
        let r = program(
            "a",
            "p1-ch-1",
            "City News",
            DownloadStatus::Scheduled,
            1_000,
            2_000,
        );
        assert_eq!((r.start_at, r.end_at), (Some(880), Some(2_120)));
        assert_eq!((core_start(&r), core_end(&r)), (1_000, 2_000));
        // A recording that starts late, as Record now does, starts its
        // program then too.
        let mut late = r.clone();
        late.start_at = Some(1_500);
        assert_eq!(core_start(&late), 1_500);
    }

    #[test]
    fn the_rest_of_a_recording_starts_when_asked_and_ends_on_time() {
        let mut old = rec("rec-1", "c1", DownloadStatus::Recording, 100, 1_000);
        old.dest_path = "/dl/recordings/a.ts".into();
        old.downloaded_bytes = 5_000;
        old.program_title = Some("Evening news".into());
        old.error = Some("The connection to the provider failed.".into());
        let rest = rest_of(&old, "rec-2", 430, 400);
        assert_eq!(rest.channel_id, "rec-2");
        assert_eq!(rest.status, DownloadStatus::Scheduled);
        assert_eq!((rest.start_at, rest.end_at), (Some(430), Some(1_000)));
        assert_eq!(rest.created_at, 400);
        assert_eq!(rest.downloaded_bytes, 0);
        assert!(rest.dest_path.is_empty());
        assert!(rest.error.is_none());
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
    fn tells_recordings_of_one_channel_by_name_within_a_provider() {
        let status = DownloadStatus::Scheduled;
        let news = named("a", "p1-ch-1", "City News", status, 0, 10);
        // A refresh moved the channel to another id.
        let moved = named("b", "p1-ch-7", "City News", status, 0, 10);
        // Another channel got its old id.
        let other = named("c", "p1-ch-1", "Sports One", status, 0, 10);
        let elsewhere = named("d", "p2-ch-1", "City News", status, 0, 10);
        let unknown = named("e", "gone-ch-1", "City News", status, 0, 10);
        let unknown_too = named("f", "gone-ch-1", "City News", status, 0, 10);

        assert!(same_channel(&news, &moved, &providers()));
        assert!(!same_channel(&news, &other, &providers()));
        assert!(!same_channel(&news, &elsewhere, &providers()));
        assert!(!same_channel(&unknown, &moved, &providers()));
        assert!(same_channel(&unknown, &unknown_too, &providers()));
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
    fn a_merge_takes_on_the_next_program() {
        let mut first = program(
            "a",
            "p1-ch-1",
            "City News",
            DownloadStatus::Recording,
            1_000,
            2_000,
        );
        first.program_title = Some("Early news".into());
        let mut next = program(
            "b",
            "p1-ch-1",
            "City News",
            DownloadStatus::Scheduled,
            2_000,
            3_000,
        );
        next.program_title = Some("Late news".into());
        merge_into(&mut first, &next, 3_120);
        assert_eq!(first.end_at, Some(3_120));
        assert_eq!(first.program_end, Some(3_000));
        assert_eq!(
            first.program_title.as_deref(),
            Some("Early news, Late news")
        );

        // A program inside the window never brings the end forward.
        let inside = program(
            "c",
            "p1-ch-1",
            "City News",
            DownloadStatus::Scheduled,
            2_200,
            2_400,
        );
        merge_into(&mut first, &inside, 2_520);
        assert_eq!(
            (first.end_at, first.program_end),
            (Some(3_120), Some(3_000))
        );
    }

    #[test]
    fn starts_what_is_due_and_leaves_the_rest() {
        let records = vec![
            rec("due", "c1", DownloadStatus::Scheduled, 100, 500),
            rec("later", "c2", DownloadStatus::Scheduled, 300, 500),
            rec("done", "c3", DownloadStatus::Completed, 0, 50),
        ];
        assert_eq!(
            plan(&records, &[], 200),
            Plan {
                actions: vec![Action::Start("due".into())],
                next_check: Some(300),
            }
        );
    }

    #[test]
    fn checks_again_when_a_recording_ends() {
        let records = vec![rec("on", "c1", DownloadStatus::Recording, 0, 900)];
        assert_eq!(
            plan(&records, &[], 200),
            Plan {
                actions: vec![],
                next_check: Some(900),
            }
        );
        assert_eq!(plan(&[], &[], 200).next_check, None);
    }

    #[test]
    fn misses_a_window_that_passed_and_records_the_rest_of_one_still_on() {
        let records = vec![
            rec("gone", "c1", DownloadStatus::Scheduled, 100, 200),
            rec("still-on", "c2", DownloadStatus::Scheduled, 100, 900),
        ];
        assert_eq!(
            actions(&records, 500),
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
        assert_eq!(actions(&records, 500), vec![Action::Stop("over".into())]);
    }

    #[test]
    fn extends_a_running_recording_of_the_same_channel() {
        let records = vec![
            rec("first", "c1", DownloadStatus::Recording, 0, 3_900),
            rec("next", "c1", DownloadStatus::Scheduled, 3_480, 7_500),
        ];
        assert_eq!(
            actions(&records, 3_500),
            vec![Action::Merge {
                id: "next".into(),
                into: "first".into(),
                end_at: 7_500,
            }]
        );
    }

    #[test]
    fn extends_a_recording_of_a_channel_that_moved_to_another_id() {
        let status = DownloadStatus::Recording;
        let records = vec![
            named("first", "p1-ch-1", "City News", status, 0, 3_900),
            named(
                "next",
                "p1-ch-7",
                "City News",
                DownloadStatus::Scheduled,
                3_480,
                7_500,
            ),
        ];
        assert_eq!(
            actions(&records, 3_500),
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
            actions(&records, 200),
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
            actions(&records, 1_010),
            vec![Action::Merge {
                id: "next".into(),
                into: "first".into(),
                end_at: 5_000,
            }]
        );
    }

    #[test]
    fn stops_before_it_starts_and_never_merges_across_channels_or_a_gap() {
        let records = vec![
            rec("first", "c1", DownloadStatus::Recording, 0, 1_000),
            rec("other", "c2", DownloadStatus::Scheduled, 500, 2_000),
            rec("after-gap", "c1", DownloadStatus::Scheduled, 1_005, 2_000),
        ];
        assert_eq!(
            actions(&records, 1_010),
            vec![
                Action::Stop("first".into()),
                Action::Start("other".into()),
                Action::Start("after-gap".into()),
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
            actions(&records, 250),
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
    fn hands_the_connection_over_where_one_program_ends_and_the_next_begins() {
        // The margins overlap from 1 880 to 2 120, the programs don't.
        let records = vec![
            program(
                "news",
                "p1-ch-1",
                "City News",
                DownloadStatus::Recording,
                1_000,
                2_000,
            ),
            program(
                "match",
                "p1-ch-2",
                "Sports One",
                DownloadStatus::Scheduled,
                2_000,
                5_000,
            ),
        ];
        assert_eq!(
            plan(&records, &providers(), 1_900),
            Plan {
                actions: vec![],
                next_check: Some(2_000),
            }
        );
        assert_eq!(
            plan(&records, &providers(), 2_000),
            Plan {
                actions: vec![Action::Stop("news".into()), Action::Start("match".into())],
                next_check: Some(5_120),
            }
        );
    }

    #[test]
    fn hands_over_halfway_through_a_gap_between_programs() {
        let records = vec![
            program(
                "news",
                "p1-ch-1",
                "City News",
                DownloadStatus::Recording,
                1_000,
                2_000,
            ),
            program(
                "match",
                "p1-ch-2",
                "Sports One",
                DownloadStatus::Scheduled,
                2_100,
                5_000,
            ),
        ];
        assert_eq!(plan(&records, &providers(), 1_990).next_check, Some(2_050));
        assert_eq!(
            actions(&records, 2_050),
            vec![Action::Stop("news".into()), Action::Start("match".into())]
        );
    }

    #[test]
    fn skips_a_program_that_is_already_over_when_both_are_due_at_launch() {
        let records = vec![
            program(
                "news",
                "p1-ch-1",
                "City News",
                DownloadStatus::Scheduled,
                1_000,
                2_000,
            ),
            program(
                "match",
                "p1-ch-2",
                "Sports One",
                DownloadStatus::Scheduled,
                2_000,
                5_000,
            ),
        ];
        assert_eq!(
            actions(&records, 2_050),
            vec![Action::Miss("news".into()), Action::Start("match".into())]
        );
    }

    #[test]
    fn records_both_when_the_programs_overlap_or_the_providers_differ() {
        let overlapping = vec![
            program(
                "news",
                "p1-ch-1",
                "City News",
                DownloadStatus::Recording,
                1_000,
                2_000,
            ),
            program(
                "match",
                "p1-ch-2",
                "Sports One",
                DownloadStatus::Scheduled,
                1_900,
                5_000,
            ),
        ];
        assert_eq!(
            actions(&overlapping, 1_800),
            vec![Action::Start("match".into())]
        );
        let elsewhere = vec![
            program(
                "news",
                "p1-ch-1",
                "City News",
                DownloadStatus::Recording,
                1_000,
                2_000,
            ),
            program(
                "match",
                "p2-ch-2",
                "Sports One",
                DownloadStatus::Scheduled,
                2_000,
                5_000,
            ),
        ];
        assert_eq!(
            actions(&elsewhere, 1_900),
            vec![Action::Start("match".into())]
        );
    }

    #[test]
    fn ignores_downloads() {
        let mut movie = rec("m", "c1", DownloadStatus::Scheduled, 0, 900);
        movie.kind = DownloadKind::Movie;
        assert_eq!(plan(&[movie], &[], 100), Plan::default());
    }

    #[test]
    fn finds_recordings_cut_off_by_a_quit() {
        let records = vec![
            rec("over", "c1", DownloadStatus::Recording, 0, 500),
            rec("still-on", "c2", DownloadStatus::Recording, 0, 900),
            rec("nearly-over", "c3", DownloadStatus::Recording, 0, 630),
            rec("waiting", "c4", DownloadStatus::Scheduled, 600, 900),
        ];
        let found: Vec<_> = interrupted(&records, 600)
            .into_iter()
            .map(|(r, rest)| (r.id.as_str(), rest))
            .collect();
        assert_eq!(
            found,
            vec![("over", false), ("still-on", true), ("nearly-over", false)]
        );
    }

    #[test]
    fn keeps_whatever_was_recorded() {
        assert_eq!(outcome(1_000, true), Outcome::Finished);
        assert_eq!(outcome(1_000, false), Outcome::EndedEarly);
        assert_eq!(outcome(0, true), Outcome::Failed);
        assert_eq!(outcome(0, false), Outcome::Failed);
    }

    #[test]
    fn tries_again_a_few_times_while_enough_is_left() {
        let r = rec("a", "c1", DownloadStatus::Recording, 0, 10_000);
        assert_eq!(retry_at(&r, 0, 1_000), Some(1_030));
        assert_eq!(retry_at(&r, 1, 1_000), Some(1_060));
        assert_eq!(retry_at(&r, 2, 1_000), Some(1_120));
        assert_eq!(retry_at(&r, 3, 1_000), None);
        // Less than a minute would be left by then.
        assert_eq!(retry_at(&r, 0, 9_920), None);
    }

    #[test]
    fn explains_ffmpeg_errors_in_plain_words() {
        let line = "[http @ 0x1] HTTP error 401 Unauthorized";
        assert_eq!(StreamError::classify(line), Some(StreamError::LoginRefused));
        assert_eq!(
            StreamError::classify("Server returned 403 Forbidden (access denied)"),
            Some(StreamError::Refused)
        );
        assert_eq!(
            StreamError::classify("Server returned 404 Not Found"),
            Some(StreamError::NotFound)
        );
        assert_eq!(
            StreamError::classify("Server returned 5XX Server Error reply"),
            Some(StreamError::ProviderFailed)
        );
        assert_eq!(
            StreamError::classify("http://h:80: Connection timed out"),
            Some(StreamError::ConnectionFailed)
        );
        assert_eq!(
            StreamError::classify("Error writing trailer: No space left on device"),
            Some(StreamError::DiskFull)
        );
        assert_eq!(StreamError::classify("Invalid data found"), None);

        assert_eq!(
            failure_message("Nothing was recorded.", Some(line)),
            format!("The provider didn't accept the login.\n{line}")
        );
        assert_eq!(
            failure_message("Nothing was recorded.", Some("Invalid data found")),
            "Nothing was recorded.\nInvalid data found"
        );
        assert_eq!(
            failure_message("Nothing was recorded.", None),
            "Nothing was recorded."
        );
    }

    #[test]
    fn tries_again_only_when_it_could_help() {
        assert!(worth_retrying(None));
        assert!(worth_retrying(Some("Invalid data found")));
        assert!(worth_retrying(Some("Server returned 403 Forbidden")));
        assert!(worth_retrying(Some("Connection reset by peer")));
        assert!(!worth_retrying(Some("Server returned 401 Unauthorized")));
        assert!(!worth_retrying(Some("Server returned 404 Not Found")));
        assert!(!worth_retrying(Some("No space left on device")));
    }
}
