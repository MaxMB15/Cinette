// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::commands::AppState;
use crate::downloads::scheduler::ids_to_start;
use mvp_core::downloads::ffmpeg::{
    build_ffmpeg_args, container_from_part_path, fold_progress_line, ProgressUpdate,
};
use mvp_core::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use mvp_core::downloads::paths::derive_dest_path;
use mvp_core::downloads::redact::redact_credentials;
use std::collections::HashMap;
use std::path::PathBuf;
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
}

impl DownloadManager {
    pub fn new(default_root: PathBuf) -> Self {
        Self {
            concurrency: Mutex::new(3),
            root: Mutex::new(default_root),
            running: Mutex::new(HashMap::new()),
            retention_days: Mutex::new(None),
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
        manager.set_retention_days(u32::try_from(days).ok());
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
    let app_state = app.state::<AppState>();
    let manager = app.state::<DownloadManager>();
    let limit = manager.concurrency();

    let active = {
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.list_active_downloads().map_err(|e| e.to_string())?
    };
    let pairs: Vec<(String, DownloadStatus)> =
        active.iter().map(|r| (r.id.clone(), r.status)).collect();
    let start_ids = ids_to_start(&pairs, limit);

    for id in start_ids {
        if let Some(rec) = active.iter().find(|r| r.id == id) {
            start_process(app, rec.clone())?;
        }
    }
    Ok(())
}

pub(crate) fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Lightweight unique id without adding a uuid dependency.
fn uuid_like() -> String {
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

        // Remove from running map.
        {
            let manager = app.state::<DownloadManager>();
            manager.running.lock().unwrap().remove(&id);
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
            // If it was cancelled (child killed), status was already set to
            // Cancelled by stop_download; don't overwrite that.
            let was_cancelled = current_status(&app, &id) == Some(DownloadStatus::Cancelled);
            if !was_cancelled {
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

fn update_record<R: Runtime>(
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
        if let Some(rec) = cache.get_download(id).map_err(|e| e.to_string())? {
            let _ = std::fs::remove_file(&rec.dest_path);
        }
        cache.delete_download(id).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("download://removed", id);
    Ok(())
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
