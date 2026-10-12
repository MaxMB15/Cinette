// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use serde::{Deserialize, Serialize};

/// What a download row represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadKind {
    Movie,
    Episode,
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
}

impl DownloadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            DownloadStatus::Queued => "queued",
            DownloadStatus::Downloading => "downloading",
            DownloadStatus::Completed => "completed",
            DownloadStatus::Failed => "failed",
            DownloadStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(DownloadStatus::Queued),
            "downloading" => Some(DownloadStatus::Downloading),
            "completed" => Some(DownloadStatus::Completed),
            "failed" => Some(DownloadStatus::Failed),
            "cancelled" => Some(DownloadStatus::Cancelled),
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
        ] {
            assert_eq!(DownloadStatus::from_str(s.as_str()), Some(s));
        }
        assert_eq!(DownloadStatus::from_str("bogus"), None);
    }
}
