// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The "Delete downloads after" setting: which finished downloads are due.

use crate::downloads::model::{DownloadRecord, DownloadStatus};

const DAY_SECS: i64 = 24 * 60 * 60;

/// When the retention setting deletes `rec`, in Unix seconds, with downloads
/// kept for `days`. The count starts when the download finished and starts
/// over each time it's played, so something the user is still watching stays.
/// `None` when nothing will delete it: the setting is off (`None` or 0, as in
/// the app's "Never"), the user chose Keep, or the download hasn't finished.
pub fn delete_at(rec: &DownloadRecord, days: Option<u32>) -> Option<i64> {
    let days = days.filter(|&d| d > 0)?;
    if rec.keep || rec.status != DownloadStatus::Completed {
        return None;
    }
    let since = rec
        .finished_at
        .unwrap_or(rec.created_at)
        .max(rec.last_played_at.unwrap_or(0));
    Some(since + i64::from(days) * DAY_SECS)
}

/// The downloads in `records` that are due for deletion at `now`. `playing`
/// is the file the player has open, which is never deleted.
pub fn due<'a>(
    records: &'a [DownloadRecord],
    days: Option<u32>,
    now: i64,
    playing: Option<&str>,
) -> Vec<&'a DownloadRecord> {
    records
        .iter()
        .filter(|r| delete_at(r, days).is_some_and(|at| at <= now))
        .filter(|r| playing != Some(r.dest_path.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::downloads::model::DownloadKind;

    fn finished(id: &str, finished_at: i64) -> DownloadRecord {
        DownloadRecord {
            id: id.into(),
            channel_id: format!("c-{id}"),
            title: "A Movie".into(),
            kind: DownloadKind::Movie,
            series_channel_id: None,
            status: DownloadStatus::Completed,
            dest_path: format!("/downloads/{id}.mkv"),
            total_bytes: None,
            downloaded_bytes: 0,
            avg_rate_bps: None,
            error: None,
            created_at: 0,
            finished_at: Some(finished_at),
            keep: false,
            last_played_at: None,
            source_channel_id: None,
            start_at: None,
            end_at: None,
            program_title: None,
            program_start: None,
            program_end: None,
        }
    }

    #[test]
    fn counts_from_when_the_download_finished() {
        let rec = finished("a", 1_000);
        assert_eq!(delete_at(&rec, Some(7)), Some(1_000 + 7 * DAY_SECS));
    }

    #[test]
    fn starts_over_when_played() {
        let mut rec = finished("a", 1_000);
        rec.last_played_at = Some(5_000);
        assert_eq!(delete_at(&rec, Some(7)), Some(5_000 + 7 * DAY_SECS));
        // A play time before the finish time, as after a clock change, doesn't
        // bring the date forward.
        rec.last_played_at = Some(10);
        assert_eq!(delete_at(&rec, Some(7)), Some(1_000 + 7 * DAY_SECS));
    }

    #[test]
    fn nothing_is_deleted_when_off_kept_or_unfinished() {
        let rec = finished("a", 1_000);
        assert_eq!(delete_at(&rec, None), None);
        assert_eq!(delete_at(&rec, Some(0)), None);

        let mut kept = finished("a", 1_000);
        kept.keep = true;
        assert_eq!(delete_at(&kept, Some(7)), None);

        for status in [
            DownloadStatus::Queued,
            DownloadStatus::Downloading,
            DownloadStatus::Failed,
            DownloadStatus::Cancelled,
            DownloadStatus::Scheduled,
            DownloadStatus::Recording,
            DownloadStatus::Missed,
        ] {
            let mut rec = finished("a", 1_000);
            rec.status = status;
            assert_eq!(delete_at(&rec, Some(7)), None, "{status:?}");
        }
    }

    #[test]
    fn a_finished_recording_goes_like_any_download() {
        let mut rec = finished("a", 1_000);
        rec.kind = DownloadKind::Recording;
        assert_eq!(delete_at(&rec, Some(7)), Some(1_000 + 7 * DAY_SECS));
    }

    #[test]
    fn picks_due_downloads_and_skips_the_one_playing() {
        let old = finished("old", 0);
        let playing = finished("playing", 0);
        let recent = finished("recent", 6 * DAY_SECS);
        let records = vec![old, playing.clone(), recent];
        let now = 7 * DAY_SECS;

        let ids: Vec<_> = due(&records, Some(7), now, Some(&playing.dest_path))
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(ids, vec!["old"]);
        assert!(due(&records, None, now, None).is_empty());
    }
}
