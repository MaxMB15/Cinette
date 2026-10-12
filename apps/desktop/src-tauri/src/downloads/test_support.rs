// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Records, channels, a loopback video server and event waiting for the
//! download tests.
//!
//! The tests run the real bundled ffmpeg. The build copies it next to the
//! test binaries, which is where the shell plugin looks for the sidecar, so
//! they need `scripts/fetch-ffmpeg.sh` to have run, as every build does.

use crate::test_support::TestApp;
use mvp_core::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use mvp_core::http::test_server::{route, serve_routes};
use mvp_core::models::channel::Channel;
use std::cell::RefCell;
use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::Listener;

/// A source ffmpeg reads from its standard input. The shell plugin keeps that
/// pipe open and never writes to it, so the download runs until it's
/// stopped, and the size probe turns the URL down at once.
pub(crate) const STALLS: &str = "pipe:0";

/// Audio samples in the video `video_url` serves.
const SAMPLES: usize = 1_000_000;

/// The length of the video `video_url` serves. It's over a megabyte, so the
/// size probe takes it for a video rather than a playlist.
pub(crate) const VIDEO_BYTES: i64 = 44 + SAMPLES as i64;

/// The longest a test waits for a download to get somewhere. ffmpeg takes a
/// few hundredths of a second with the video here, so this only matters on a
/// badly overloaded machine.
const WAIT_LIMIT: Duration = Duration::from_secs(30);

/// A download of `dest_path` with the title the channel fixtures use.
pub(crate) fn record(id: &str, status: DownloadStatus, dest_path: &str) -> DownloadRecord {
    DownloadRecord {
        id: id.into(),
        channel_id: format!("c-{id}"),
        title: "Dune (2021)".into(),
        kind: DownloadKind::Movie,
        series_channel_id: None,
        status,
        dest_path: dest_path.into(),
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

/// A download that finished at the start of 1970, so any retention setting
/// finds it due.
pub(crate) fn finished(id: &str, dest_path: &Path) -> DownloadRecord {
    DownloadRecord {
        finished_at: Some(0),
        ..record(id, DownloadStatus::Completed, &dest_path.to_string_lossy())
    }
}

/// A movie channel that plays `url`.
pub(crate) fn movie(id: &str, name: &str, url: &str) -> Channel {
    Channel {
        id: id.into(),
        name: name.into(),
        url: url.into(),
        group_title: "Movies".into(),
        content_type: "movie".into(),
        ..Channel::default()
    }
}

/// Save `channel` in the app's cache, as a playlist load would.
pub(crate) fn add_channel(app: &TestApp, channel: &Channel) {
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    cache.upsert_channel("p1", channel).unwrap();
}

/// Save `rec` in the app's cache.
pub(crate) fn add_download(app: &TestApp, rec: &DownloadRecord) {
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    cache.upsert_download(rec).unwrap();
}

/// The app's record of download `id`.
pub(crate) fn download(app: &TestApp, id: &str) -> Option<DownloadRecord> {
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    cache.get_download(id).unwrap()
}

/// The URL of a video the loopback server sends whole, with a
/// `Content-Length`.
pub(crate) fn video_url(name: &str) -> String {
    format!("{}/video/{name}.mkv", server())
}

/// A URL on the loopback server that answers 404 Not Found.
pub(crate) fn missing_url(name: &str) -> String {
    format!("{}/missing/{name}.mkv", server())
}

/// One server for every test, since each video is a megabyte.
fn server() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| serve_routes(vec![route("/video/", "200 OK", wav())]).0)
}

/// A WAV file of 8-bit mono samples at 8 kHz, all the same value. The test
/// server sends text, and every byte of this one is ASCII.
fn wav() -> String {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(36 + SAMPLES as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    // The format chunk's length, then PCM, one channel, the sample rate, the
    // byte rate, the bytes per sample and the bits per sample.
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8000u32.to_le_bytes());
    bytes.extend_from_slice(&8000u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(SAMPLES as u32).to_le_bytes());
    bytes.resize(VIDEO_BYTES as usize, b'@');
    String::from_utf8(bytes).expect("every byte is ASCII")
}

/// An event the app sent the frontend about a download.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DownloadEvent {
    Progress(DownloadRecord),
    Removed(String),
}

/// The download events one app sends, kept from when the test starts
/// watching.
pub(crate) struct Events {
    incoming: Receiver<DownloadEvent>,
    seen: RefCell<Vec<DownloadEvent>>,
}

impl Events {
    pub(crate) fn watch(app: &TestApp) -> Self {
        let (progress, incoming) = mpsc::channel();
        let removed = progress.clone();
        let handle = app.handle();
        handle.listen_any("download://progress", move |event| {
            let rec = serde_json::from_str(event.payload()).expect("a download record");
            let _ = progress.send(DownloadEvent::Progress(rec));
        });
        handle.listen_any("download://removed", move |event| {
            let id = serde_json::from_str(event.payload()).expect("a download id");
            let _ = removed.send(DownloadEvent::Removed(id));
        });
        Self {
            incoming,
            seen: RefCell::default(),
        }
    }

    /// Every event sent so far, oldest first.
    pub(crate) fn sent(&self) -> Vec<DownloadEvent> {
        let mut seen = self.seen.borrow_mut();
        seen.extend(self.incoming.try_iter());
        seen.clone()
    }

    /// The records sent so far for download `id`, oldest first.
    pub(crate) fn progress(&self, id: &str) -> Vec<DownloadRecord> {
        self.sent()
            .into_iter()
            .filter_map(|event| match event {
                DownloadEvent::Progress(rec) if rec.id == id => Some(rec),
                _ => None,
            })
            .collect()
    }

    /// Waits for a record of download `id` with `status` and returns it. A
    /// download's last record goes out once ffmpeg has stopped and its files
    /// are dealt with, so a test can check them right after.
    pub(crate) fn wait_for(&self, id: &str, status: DownloadStatus) -> DownloadRecord {
        let mut found = None;
        self.wait_until(&format!("{id} is {status:?}"), || {
            found = self.progress(id).into_iter().find(|r| r.status == status);
            found.is_some()
        });
        found.expect("checked by wait_until")
    }

    /// Waits until `done` holds. It's checked after each event and at least
    /// every 50 ms, because an event sent while another thread sends one can
    /// reach listeners late. Panics when it takes too long.
    pub(crate) fn wait_until(&self, what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + WAIT_LIMIT;
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting until {what}");
            if let Ok(event) = self.incoming.recv_timeout(Duration::from_millis(50)) {
                self.seen.borrow_mut().push(event);
            }
        }
    }
}
