// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// What a download row represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadKind {
    Movie,
    Episode,
    /// A recording of a live channel.
    Recording,
}

/// Lifecycle of a single download item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Completed,
    Failed,
    Cancelled,
    /// A recording waiting for its start time.
    Scheduled,
    /// A recording that is running.
    Recording,
    /// A recording whose time passed while the app was closed.
    Missed,
}

impl DownloadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            DownloadStatus::Queued => "queued",
            DownloadStatus::Downloading => "downloading",
            DownloadStatus::Completed => "completed",
            DownloadStatus::Failed => "failed",
            DownloadStatus::Cancelled => "cancelled",
            DownloadStatus::Scheduled => "scheduled",
            DownloadStatus::Recording => "recording",
            DownloadStatus::Missed => "missed",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(DownloadStatus::Queued),
            "downloading" => Some(DownloadStatus::Downloading),
            "completed" => Some(DownloadStatus::Completed),
            "failed" => Some(DownloadStatus::Failed),
            "cancelled" => Some(DownloadStatus::Cancelled),
            "scheduled" => Some(DownloadStatus::Scheduled),
            "recording" => Some(DownloadStatus::Recording),
            "missed" => Some(DownloadStatus::Missed),
            _ => None,
        }
    }
}

/// One download item, persisted in the `downloads` table.
/// For a series episode, `series_channel_id` links back to the series card so
/// the UI can compute aggregate (partial/complete) state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: String,
    pub channel_id: String,
    pub title: String,
    pub kind: DownloadKind,
    /// Series this episode belongs to (None for movies).
    pub series_channel_id: Option<String>,
    pub status: DownloadStatus,
    pub dest_path: String,
    pub total_bytes: Option<i64>,
    pub downloaded_bytes: i64,
    pub avg_rate_bps: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    /// The user chose Keep, so the retention setting never deletes it.
    #[serde(default)]
    pub keep: bool,
    /// When the downloaded file last started playing. Retention counts from
    /// this or `finished_at`, whichever is later.
    #[serde(default)]
    pub last_played_at: Option<i64>,
    /// Recordings only. The live channel being recorded. A recording's own
    /// `channel_id` is its id, so nothing that looks up downloads by channel,
    /// such as playing the live channel, ever finds it.
    #[serde(default)]
    pub source_channel_id: Option<String>,
    /// Recordings only. When recording starts, in Unix seconds.
    #[serde(default)]
    pub start_at: Option<i64>,
    /// Recordings only. When recording stops, in Unix seconds.
    #[serde(default)]
    pub end_at: Option<i64>,
    /// Recordings only. The guide's title for the program being recorded.
    #[serde(default)]
    pub program_title: Option<String>,
    /// Recordings only. When the program itself starts and ends, in Unix
    /// seconds. The recording's window adds the margins from Settings around
    /// it. None for a time range, which has no margins.
    #[serde(default)]
    pub program_start: Option<i64>,
    #[serde(default)]
    pub program_end: Option<i64>,
}

impl DownloadRecord {
    /// Whether the download finished and its file is still on disk, so it
    /// can play without the network.
    pub fn has_local_file(&self) -> bool {
        self.status == DownloadStatus::Completed && Path::new(&self.dest_path).exists()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_round_trips_through_str() {
        for s in [
            DownloadStatus::Queued,
            DownloadStatus::Downloading,
            DownloadStatus::Completed,
            DownloadStatus::Failed,
            DownloadStatus::Cancelled,
            DownloadStatus::Scheduled,
            DownloadStatus::Recording,
            DownloadStatus::Missed,
        ] {
            assert_eq!(DownloadStatus::from_str(s.as_str()), Some(s));
        }
        assert_eq!(DownloadStatus::from_str("bogus"), None);
    }

    #[test]
    fn a_finished_download_has_a_local_file_while_the_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Movie.mkv");
        std::fs::write(&path, b"video").unwrap();
        let mut r = sample();
        r.status = DownloadStatus::Completed;
        r.dest_path = path.to_string_lossy().into_owned();
        assert!(r.has_local_file());

        r.status = DownloadStatus::Downloading;
        assert!(!r.has_local_file(), "the file isn't finished yet");

        r.status = DownloadStatus::Completed;
        std::fs::remove_file(&path).unwrap();
        assert!(!r.has_local_file(), "the file was deleted");
    }

    #[test]
    fn recording_fields_reach_the_frontend_in_camel_case() {
        let mut r = sample();
        r.kind = DownloadKind::Recording;
        r.status = DownloadStatus::Scheduled;
        r.source_channel_id = Some("c9".into());
        r.start_at = Some(100);
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["kind"], "recording");
        assert_eq!(json["status"], "scheduled");
        assert_eq!(json["sourceChannelId"], "c9");
        assert_eq!(json["startAt"], 100);
        assert!(json["endAt"].is_null());
    }

    fn sample() -> DownloadRecord {
        DownloadRecord {
            id: "d1".into(),
            channel_id: "c1".into(),
            title: "Movie".into(),
            kind: DownloadKind::Movie,
            series_channel_id: None,
            status: DownloadStatus::Downloading,
            dest_path: "/tmp/x.part".into(),
            total_bytes: None,
            downloaded_bytes: 0,
            avg_rate_bps: None,
            error: None,
            created_at: 0,
            finished_at: None,
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
}
