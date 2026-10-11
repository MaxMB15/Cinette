// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::commands::AppState;
use crate::downloads::recordings;
use crate::downloads::scheduler::{start_queued, waits_for_recording};
use mvp_core::cache::store::CacheStore;
use mvp_core::downloads::ffmpeg::{
    build_ffmpeg_args, container_from_part_path, fold_progress_line, ProgressUpdate,
};
use mvp_core::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use mvp_core::downloads::paths::derive_dest_path;
use mvp_core::downloads::redact::redact_credentials;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

/// The download settings live in the same store file as the other settings
/// so they survive a restart.
const SETTINGS_STORE_FILE: &str = "settings.json";
const FOLDER_KEY: &str = "download_folder";
const CONCURRENCY_KEY: &str = "download_concurrency";
const RETENTION_KEY: &str = "download_retention_days";
/// Matches the range the Settings page allows.
const MAX_CONCURRENCY: usize = 10;

/// Wrapper so we store the plugin's CommandChild (which exposes `kill`).
pub struct RunningChildHandle {
    pub child: tauri_plugin_shell::process::CommandChild,
}

/// Tauri managed state. Holds config + the live child-process map.
/// All persisted state lives in `CacheStore` (via `AppState`); this struct only
/// holds what cannot be serialized (the child handles) plus mutable config.
pub struct DownloadManager {
    pub concurrency: Mutex<usize>,
    pub root: Mutex<PathBuf>,
    pub running: Mutex<HashMap<String, RunningChildHandle>>,
    /// Days to keep a finished download before deleting it, or `None` to keep
    /// downloads until the user removes them.
    pub retention_days: Mutex<Option<u32>>,
    /// Set as the app quits, so a download that ends because the app killed
    /// its ffmpeg isn't marked failed.
    pub exiting: AtomicBool,
}

impl DownloadManager {
    pub fn new(default_root: PathBuf) -> Self {
        Self {
            concurrency: Mutex::new(3),
            root: Mutex::new(default_root),
            running: Mutex::new(HashMap::new()),
            retention_days: Mutex::new(None),
            exiting: AtomicBool::new(false),
        }
    }

    pub fn root(&self) -> PathBuf {
        self.root.lock().unwrap().clone()
    }

    pub fn set_root(&self, p: PathBuf) {
        *self.root.lock().unwrap() = p;
    }

    pub fn concurrency(&self) -> usize {
        *self.concurrency.lock().unwrap()
    }

    pub fn set_concurrency(&self, n: usize) {
        *self.concurrency.lock().unwrap() = n.max(1);
    }

    pub fn retention_days(&self) -> Option<u32> {
        *self.retention_days.lock().unwrap()
    }

    pub fn set_retention_days(&self, days: Option<u32>) {
        *self.retention_days.lock().unwrap() = days;
    }
}

/// Apply the download settings saved in an earlier session.
/// Call once after `DownloadManager` is managed. A missing or unreadable
/// store leaves the defaults in place.
pub fn restore_settings<R: Runtime>(app: &AppHandle<R>) {
    let store = match app.store(SETTINGS_STORE_FILE) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("Could not open the settings store for download settings: {e}");
            return;
        }
    };
    let manager = app.state::<DownloadManager>();
    if let Some(folder) = store
        .get(FOLDER_KEY)
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| !s.is_empty())
    {
        manager.set_root(PathBuf::from(folder));
    }
    if let Some(n) = store.get(CONCURRENCY_KEY).and_then(|v| v.as_u64()) {
        manager.set_concurrency((n as usize).min(MAX_CONCURRENCY));
    }
    if let Some(days) = store.get(RETENTION_KEY).and_then(|v| v.as_u64()) {
        // 0 is "never" in the app, so a hand-edited 0 mustn't mean "delete now".
        manager.set_retention_days(u32::try_from(days).ok().filter(|&d| d > 0));
    }
}

/// Save the download folder so the next launch uses it.
pub fn save_folder<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<(), String> {
    save_setting(app, FOLDER_KEY, serde_json::Value::from(folder))
}

/// Save the download concurrency so the next launch uses it.
pub fn save_concurrency<R: Runtime>(app: &AppHandle<R>, n: usize) -> Result<(), String> {
    save_setting(app, CONCURRENCY_KEY, serde_json::Value::from(n))
}

/// Save the retention setting so the next launch uses it. `None` saves null.
pub fn save_retention<R: Runtime>(app: &AppHandle<R>, days: Option<u32>) -> Result<(), String> {
    save_setting(app, RETENTION_KEY, serde_json::Value::from(days))
}

fn save_setting<R: Runtime>(
    app: &AppHandle<R>,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    store.set(key, value);
    store.save().map_err(|e| e.to_string())
}

/// Create a queued DownloadRecord for a channel and persist it. Returns the id.
/// `series_channel_id` is set for episodes so aggregate state can be computed.
pub fn enqueue_record<R: Runtime>(
    app: &AppHandle<R>,
    channel_id: &str,
    title: &str,
    url: &str,
    kind: DownloadKind,
    series_channel_id: Option<String>,
    series_title: Option<&str>,
) -> Result<String, String> {
    let app_state = app.state::<AppState>();
    let manager = app.state::<DownloadManager>();
    let root = manager.root();
    let dest = derive_dest_path(&root, kind, title, series_title, url);

    let id = format!("dl-{}", uuid_like());
    let now = now_secs();
    let rec = DownloadRecord {
        id: id.clone(),
        channel_id: channel_id.to_string(),
        title: title.to_string(),
        kind,
        series_channel_id,
        status: DownloadStatus::Queued,
        dest_path: format!("{}.part", dest.to_string_lossy()),
        total_bytes: None,
        downloaded_bytes: 0,
        avg_rate_bps: None,
        error: None,
        created_at: now,
        finished_at: None,
        keep: false,
        last_played_at: None,
        source_channel_id: None,
        start_at: None,
        end_at: None,
        program_title: None,
    };
    {
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        // Clear any prior failed/cancelled attempt for this channel so a retry
        // doesn't leave a duplicate/stale record behind.
        cache
            .delete_terminal_downloads_for_channel(channel_id)
            .map_err(|e| e.to_string())?;
        cache.upsert_download(&rec).map_err(|e| e.to_string())?;
    }
    // Emit immediately so the UI reflects the queued state without waiting for
    // the first ffmpeg progress line.
    emit_progress(app, &id);
    Ok(id)
}

/// Inspect the active set and start ffmpeg for any items the scheduler selects.
pub fn pump<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let manager = app.state::<DownloadManager>();
    // A download that finishes while the app quits mustn't start another one.
    if manager.exiting.load(Ordering::SeqCst) {
        return Ok(());
    }
    let app_state = app.state::<AppState>();
    let limit = manager.concurrency();
    start_queued(
        limit,
        || {
            let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
            let active = cache.list_active_downloads().map_err(|e| e.to_string())?;
            let recording = recordings::recording_channels(&cache)?;
            let providers = if recording.is_empty() {
                Vec::new()
            } else {
                recordings::provider_ids(&cache)?
            };
            Ok(active
                .into_iter()
                // A download that waits for a recording doesn't take a slot.
                .filter(|r| {
                    r.status != DownloadStatus::Queued
                        || !waits_for_recording(&r.channel_id, &recording, &providers)
                })
                .map(|r| (r.id, r.status))
                .collect())
        },
        |id| {
            let rec = {
                let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
                cache.get_download(id).map_err(|e| e.to_string())?
            }
            .ok_or_else(|| format!("download not found: {id}"))?;
            start_process(app, rec.clone()).inspect_err(|e| fail_to_start(app, &rec, e))
        },
    )
}

/// Mark a download that couldn't start as failed and remove its partial file.
/// Otherwise it stays first in line, or stays `Downloading` with no ffmpeg,
/// and holds up the queue.
fn fail_to_start<R: Runtime>(app: &AppHandle<R>, rec: &DownloadRecord, err: &str) {
    update_record(app, &rec.id, |r| {
        // A download the user stopped in the meantime stays cancelled.
        if matches!(
            r.status,
            DownloadStatus::Queued | DownloadStatus::Downloading
        ) {
            r.status = DownloadStatus::Failed;
            r.error = Some(err.to_string());
            r.finished_at = Some(now_secs());
        }
    });
    if rec.dest_path.ends_with(".part") {
        let _ = std::fs::remove_file(&rec.dest_path);
    }
    emit_progress(app, &rec.id);
}

/// Put a running download back in the queue and stop its ffmpeg, without
/// marking it failed. A recording that needs the provider's connection does
/// this. The download starts over once no recording of its provider runs.
pub fn requeue<R: Runtime>(app: &AppHandle<R>, id: &str) {
    update_record(app, id, |r| {
        if r.status == DownloadStatus::Downloading {
            r.status = DownloadStatus::Queued;
            r.downloaded_bytes = 0;
            r.avg_rate_bps = None;
        }
    });
    let child = {
        let manager = app.state::<DownloadManager>();
        let mut running = manager.running.lock().unwrap();
        running.remove(id)
    };
    if let Some(handle) = child {
        let _ = handle.child.kill();
    }
    emit_progress(app, id);
}

/// Stop every running ffmpeg as the app quits. The shell plugin only stops
/// processes started from JavaScript, so these would keep downloading after
/// the app is gone. Their records stay `Downloading`, and the next launch
/// queues them again.
pub fn stop_all_for_exit<R: Runtime>(app: &AppHandle<R>) {
    let Some(manager) = app.try_state::<DownloadManager>() else {
        return;
    };
    manager.exiting.store(true, Ordering::SeqCst);
    let children: Vec<_> = manager.running.lock().unwrap().drain().collect();
    for (_, handle) in children {
        let _ = handle.child.kill();
    }
}

pub(crate) fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Lightweight unique id without adding a uuid dependency.
pub(crate) fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/// Probe Content-Length so the UI can show a byte-based percentage. Best-effort.
async fn probe_total_bytes(url: &str) -> Option<i64> {
    let client = reqwest::Client::new();
    let resp = client.head(url).send().await.ok()?;
    resp.headers()
        .get(reqwest::header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

/// Start ffmpeg for a single record. Spawns the sidecar, streams progress,
/// persists updates, emits `download://progress`, and finalizes on exit.
pub fn start_process<R: Runtime>(app: &AppHandle<R>, mut rec: DownloadRecord) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let url = {
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache
            .get_channel_by_id(&rec.channel_id)
            .map_err(|e| e.to_string())?
            .map(|c| c.url)
            .ok_or_else(|| format!("channel not found: {}", rec.channel_id))?
    };

    // Ensure destination directory exists.
    if let Some(parent) = std::path::Path::new(&rec.dest_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // An ffmpeg left over from a crash may still have the old partial file
    // open. Removing the file gives this run a new one the old process can't
    // write into.
    if rec.dest_path.ends_with(".part") {
        let _ = std::fs::remove_file(&rec.dest_path);
    }

    // Mark downloading + persist.
    rec.status = DownloadStatus::Downloading;
    {
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.upsert_download(&rec).map_err(|e| e.to_string())?;
    }
    // Surface the downloading transition immediately.
    emit_progress(app, &rec.id);

    // The final file's extension (dest_path minus ".part") selects the muxer.
    let container = container_from_part_path(&rec.dest_path).to_string();
    let args = build_ffmpeg_args(&url, &rec.dest_path, &container);
    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| redact_credentials(&e.to_string()))?
        .args(args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| redact_credentials(&e.to_string()))?;
    let pid = child.pid();

    // Track the child so it can be killed on stop.
    {
        let manager = app.state::<DownloadManager>();
        let mut running = manager.running.lock().unwrap();
        running.insert(rec.id.clone(), RunningChildHandle { child });
    }

    let app = app.clone();
    let id = rec.id.clone();
    let url_for_probe = url.clone();
    // rec.dest_path is the ".part" path; the final path strips that suffix.
    let final_path = rec.dest_path.trim_end_matches(".part").to_string();
    let started = now_secs();

    tauri::async_runtime::spawn(async move {
        // Probe size up front (best-effort).
        let total = probe_total_bytes(&url_for_probe).await;
        if let Some(t) = total {
            update_record(&app, &id, |r| r.total_bytes = Some(t));
        }

        let mut acc = ProgressUpdate::default();
        let mut last_bytes: i64 = 0;
        let mut exit_ok = false;
        let mut err_text: Option<String> = None;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    if fold_progress_line(&mut acc, &line) {
                        if let Some(size) = acc.total_size {
                            last_bytes = size;
                        }
                        let elapsed = (now_secs() - started).max(1);
                        let rate = last_bytes / elapsed;
                        update_record(&app, &id, |r| {
                            r.downloaded_bytes = last_bytes;
                            r.avg_rate_bps = Some(rate);
                        });
                        emit_progress(&app, &id);
                        acc = ProgressUpdate::default();
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    err_text = Some(redact_credentials(&line));
                }
                CommandEvent::Terminated(payload) => {
                    exit_ok = payload.code == Some(0);
                }
                _ => {}
            }
        }

        // The app is quitting and killed this ffmpeg. Leave the record as it
        // is, so the next launch queues it again.
        let exiting = app
            .state::<DownloadManager>()
            .exiting
            .load(Ordering::SeqCst);
        if !exit_ok && exiting {
            return;
        }

        // Take this run out of the running map. A download that was stopped,
        // or put back in the queue for a recording, has left the map already.
        // It may be running again under a new ffmpeg, which then owns the
        // record and the file.
        let ours = {
            let manager = app.state::<DownloadManager>();
            let mut running = manager.running.lock().unwrap();
            let ours = running.get(&id).is_some_and(|h| h.child.pid() == pid);
            if ours {
                running.remove(&id);
            }
            ours
        };
        if !ours && !exiting {
            let _ = pump(&app);
            return;
        }

        if exit_ok {
            // Rename .part -> final.
            let _ = std::fs::rename(format!("{final_path}.part"), &final_path);
            update_record(&app, &id, |r| {
                r.status = DownloadStatus::Completed;
                r.dest_path = final_path.clone();
                r.finished_at = Some(now_secs());
            });
        } else {
            // A download the user stopped is already Cancelled, and one put
            // back in the queue is Queued. Neither failed.
            let was_stopped = matches!(
                current_status(&app, &id),
                Some(DownloadStatus::Cancelled | DownloadStatus::Queued)
            );
            if !was_stopped {
                update_record(&app, &id, |r| {
                    r.status = DownloadStatus::Failed;
                    r.error = err_text.clone().or(Some("ffmpeg exited non-zero".into()));
                    r.finished_at = Some(now_secs());
                });
            }
            let _ = std::fs::remove_file(format!("{final_path}.part"));
        }
        emit_progress(&app, &id);

        // A slot freed up — schedule the next queued item.
        let _ = pump(&app);
    });

    Ok(())
}

/// Stop a single in-progress or queued download: mark Cancelled, kill the child
/// if running, and delete any partial file. Safe to call on any state.
pub fn stop_one<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    // A stopped recording keeps its file, so it has its own stop.
    let kind = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.get_download(id).ok().flatten().map(|r| r.kind)
    };
    if kind == Some(DownloadKind::Recording) {
        return recordings::stop(app, id);
    }

    // Mark cancelled first so the spawn task's exit handler won't flip it to Failed.
    update_record(app, id, |r| {
        if r.status == DownloadStatus::Queued || r.status == DownloadStatus::Downloading {
            r.status = DownloadStatus::Cancelled;
            r.finished_at = Some(now_secs());
        }
    });

    // Kill the running child if present.
    let child = {
        let manager = app.state::<DownloadManager>();
        let mut running = manager.running.lock().unwrap();
        running.remove(id)
    };
    if let Some(handle) = child {
        let _ = handle.child.kill();
    }

    // Remove partial file.
    let dest_path = {
        let app_state = app.state::<AppState>();
        let Ok(cache) = app_state.cache.lock() else {
            emit_progress(app, id);
            return Ok(());
        };
        cache.get_download(id).ok().flatten().map(|r| r.dest_path)
    };
    if let Some(path) = dest_path {
        let _ = std::fs::remove_file(&path);
    }

    emit_progress(app, id);
    Ok(())
}

pub(crate) fn update_record<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    f: impl FnOnce(&mut DownloadRecord),
) {
    let app_state = app.state::<AppState>();
    let Ok(cache) = app_state.cache.lock() else {
        return;
    };
    if let Ok(Some(mut rec)) = cache.get_download(id) {
        f(&mut rec);
        let _ = cache.upsert_download(&rec);
    }
}

fn current_status<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<DownloadStatus> {
    let app_state = app.state::<AppState>();
    let status = {
        let cache = app_state.cache.lock().ok()?;
        cache.get_download(id).ok().flatten().map(|r| r.status)
    };
    status
}

/// Delete a download's file and record, then tell the frontend so it drops
/// the download from its list.
pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        delete_record_and_file(&cache, id)?;
    }
    emit_removed(app, id);
    Ok(())
}

/// Delete the record `id` and its file. Downloads with the same title share
/// one file, so the file stays while another record still points at it. When
/// the file can't be deleted the record stays too, so the app keeps showing
/// the space it takes. A recording that's running can't be deleted, and one
/// that hasn't started has no file yet.
pub(crate) fn delete_record_and_file(cache: &CacheStore, id: &str) -> Result<(), String> {
    let Some(rec) = cache.get_download(id).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if rec.status == DownloadStatus::Recording {
        return Err("Stop the recording before deleting it.".into());
    }
    let shared = cache
        .list_downloads()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|r| r.id != rec.id && r.dest_path == rec.dest_path);
    if !shared && !rec.dest_path.is_empty() {
        match std::fs::remove_file(&rec.dest_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not delete {}: {e}", rec.dest_path)),
        }
    }
    cache.delete_download(id).map_err(|e| e.to_string())
}

/// Tell the frontend a download is gone so it drops it from its list.
pub(crate) fn emit_removed<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit("download://removed", id);
}

/// Send the download's current record to the frontend.
pub(crate) fn emit_progress<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let app_state = app.state::<AppState>();
    let rec = {
        let Ok(cache) = app_state.cache.lock() else {
            return;
        };
        cache.get_download(id).ok().flatten()
    };
    if let Some(rec) = rec {
        let _ = app.emit("download://progress", rec);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn completed(id: &str, dest_path: &std::path::Path) -> DownloadRecord {
        DownloadRecord {
            id: id.into(),
            channel_id: format!("c-{id}"),
            title: "Dune (2021)".into(),
            kind: DownloadKind::Movie,
            series_channel_id: None,
            status: DownloadStatus::Completed,
            dest_path: dest_path.to_string_lossy().into_owned(),
            total_bytes: None,
            downloaded_bytes: 0,
            avg_rate_bps: None,
            error: None,
            created_at: 0,
            finished_at: Some(0),
            keep: false,
            last_played_at: None,
            source_channel_id: None,
            start_at: None,
            end_at: None,
            program_title: None,
        }
    }

    #[test]
    fn a_file_two_records_share_stays_until_the_last_one_goes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Dune (2021).mkv");
        std::fs::write(&file, b"video").unwrap();
        let cache = CacheStore::open_in_memory().unwrap();
        cache.upsert_download(&completed("a", &file)).unwrap();
        cache.upsert_download(&completed("b", &file)).unwrap();

        delete_record_and_file(&cache, "a").unwrap();
        assert!(cache.get_download("a").unwrap().is_none());
        assert!(file.exists(), "b still points at the file");

        delete_record_and_file(&cache, "b").unwrap();
        assert!(cache.get_download("b").unwrap().is_none());
        assert!(!file.exists());
    }

    #[test]
    fn a_missing_file_still_removes_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let cache = CacheStore::open_in_memory().unwrap();
        cache
            .upsert_download(&completed("a", &dir.path().join("gone.mkv")))
            .unwrap();
        delete_record_and_file(&cache, "a").unwrap();
        assert!(cache.get_download("a").unwrap().is_none());
    }

    #[test]
    fn a_running_recording_cant_be_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("City News 2026-10-12 20.00.ts");
        std::fs::write(&file, b"video").unwrap();
        let cache = CacheStore::open_in_memory().unwrap();
        let mut rec = completed("r", &file);
        rec.kind = DownloadKind::Recording;
        rec.status = DownloadStatus::Recording;
        cache.upsert_download(&rec).unwrap();
        assert!(delete_record_and_file(&cache, "r").is_err());
        assert!(file.exists());
        assert!(cache.get_download("r").unwrap().is_some());
    }

    #[test]
    fn a_scheduled_recording_has_no_file_to_delete() {
        let cache = CacheStore::open_in_memory().unwrap();
        let mut rec = completed("a", std::path::Path::new(""));
        rec.kind = DownloadKind::Recording;
        rec.status = DownloadStatus::Scheduled;
        cache.upsert_download(&rec).unwrap();
        delete_record_and_file(&cache, "a").unwrap();
        assert!(cache.get_download("a").unwrap().is_none());
    }

    #[test]
    fn a_file_that_cant_be_deleted_keeps_its_record() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be makes remove_file fail with
        // something other than NotFound.
        let blocked = dir.path().join("blocked.mkv");
        std::fs::create_dir(&blocked).unwrap();
        let cache = CacheStore::open_in_memory().unwrap();
        cache.upsert_download(&completed("a", &blocked)).unwrap();
        assert!(delete_record_and_file(&cache, "a").is_err());
        assert!(cache.get_download("a").unwrap().is_some());
    }
}
