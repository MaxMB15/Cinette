// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Records, channels, a loopback video server and event waiting for the
//! download tests.
//!
//! The tests run the real bundled ffmpeg. The build copies it into the
//! profile's folder, such as `target/debug`, and that's where the shell
//! plugin looks for a sidecar when a test runs, one folder above the test
//! binaries in `deps`. So the tests need `scripts/fetch-ffmpeg.sh` to have
//! run, as every build does.

use super::FFMPEG_SIDECAR;
use crate::test_support::TestApp;
use mvp_core::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use mvp_core::http::test_server::{route, serve_routes};
use mvp_core::models::channel::Channel;
use std::cell::RefCell;
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::Listener;

/// A source that never sends anything, so a download of it runs until the
/// app kills its ffmpeg. ffmpeg connects to a loopback port that takes the
/// connection and keeps it open without a word. Closing ffmpeg's standard
/// input doesn't end it, so a test can tell an ffmpeg the app killed from
/// one it only let go of. The size probe turns the URL down at once.
pub(crate) fn stalls() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let addr = listener.local_addr().expect("read the bound address");
        std::thread::spawn(move || {
            // Every connection stays open until the test process ends.
            let mut open = Vec::new();
            for stream in listener.incoming().flatten() {
                open.push(stream);
            }
        });
        format!("tcp://{addr}")
    })
}

/// Audio samples in the video `video_url` serves.
const SAMPLES: usize = 1_000_000;

/// The length of the video `video_url` serves. The size probe ignores a
/// video length under a megabyte, set by the private `MIN_VIDEO_BYTES` in
/// `mvp_core::downloads::size`, so this has to stay above it by hand.
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

/// One server for every test, since each video is a megabyte. It answers
/// one request at a time, so downloads that run at once take turns.
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

/// An event the app sent the frontend about a download. Tests hold only a
/// handful, so the record isn't boxed to shrink the enum.
#[allow(clippy::large_enum_variant)]
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
    #[track_caller]
    pub(crate) fn wait_for(&self, id: &str, status: DownloadStatus) -> DownloadRecord {
        let mut found = None;
        // The id stays out of the panic message, since CodeQL takes the ids
        // `uuid_like` makes for secrets. The panic points at the test's
        // call, which names the status.
        wait_until("the download gets the status the test waits for", || {
            found = self.progress(id).into_iter().find(|r| r.status == status);
            found.is_some()
        });
        found.expect("checked by wait_until")
    }
}

/// Waits until `done` holds, checking it every few milliseconds. Panics when
/// it takes too long, at the line of the test that waited, with `what` in
/// the message.
#[track_caller]
pub(crate) fn wait_until(what: &'static str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT_LIMIT;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting until {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Whether process `pid` is still there.
pub(crate) fn process_runs(pid: u32) -> bool {
    let out = Command::new("ps")
        .args(["-o", "pid=", "-p", &pid.to_string()])
        .output()
        .expect("run ps");
    !String::from_utf8_lossy(&out.stdout).trim().is_empty()
}

/// Whether an ffmpeg is writing into `dir`. This reads every process's
/// arguments, since an ffmpeg the app killed rather than tracked leaves no
/// handle behind to ask.
pub(crate) fn ffmpeg_writes_into(dir: &Path) -> bool {
    let out = Command::new("ps")
        .args(["-A", "-ww", "-o", "args="])
        .output()
        .expect("run ps");
    let dir = dir.to_string_lossy();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|line| line.contains(FFMPEG_SIDECAR) && line.contains(dir.as_ref()))
}
