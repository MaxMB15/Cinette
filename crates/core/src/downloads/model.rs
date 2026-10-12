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

impl DownloadRecord {
    /// Percentage 0–100 when total size is known, else None (indeterminate).
    pub fn percent(&self) -> Option<u8> {
        match self.total_bytes {
            Some(total) if total > 0 => {
                let pct = (self.downloaded_bytes.saturating_mul(100) / total).clamp(0, 100);
                Some(pct as u8)
            }
            _ => None,
        }
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
        ] {
            assert_eq!(DownloadStatus::from_str(s.as_str()), Some(s));
        }
        assert_eq!(DownloadStatus::from_str("bogus"), None);
    }

    #[test]
    fn percent_is_none_when_total_unknown() {
        let mut r = sample();
        r.total_bytes = None;
        r.downloaded_bytes = 500;
        assert_eq!(r.percent(), None);
    }

    #[test]
    fn percent_computes_and_clamps() {
        let mut r = sample();
        r.total_bytes = Some(1000);
        r.downloaded_bytes = 620;
        assert_eq!(r.percent(), Some(62));
        r.downloaded_bytes = 5000; // overshoot clamps to 100
        assert_eq!(r.percent(), Some(100));
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
        }
    }
}
