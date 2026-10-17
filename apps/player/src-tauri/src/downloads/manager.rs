// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::commands::AppState;
use crate::downloads::recordings;
use crate::downloads::scheduler::{start_queued, waits_for_recording};
use mvp_core::cache::store::{CacheError, CacheStore};
use mvp_core::downloads::ffmpeg::{
    build_ffmpeg_args, container_from_part_path, fold_progress_line, ProgressUpdate,
};
use mvp_core::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use mvp_core::downloads::paths::{
    derive_dest_path, part_path, path_key, unique_dest_path, PART_SUFFIX,
};
use mvp_core::downloads::redact::redact_credentials;
use mvp_core::downloads::size::media_size;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
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
    running: Mutex<HashMap<String, RunningChildHandle>>,
    /// Days to keep a finished download before deleting it, or `None` to keep
    /// downloads until the user removes them.
    pub retention_days: Mutex<Option<u32>>,
    /// Set as the app quits, so a download that ends because the app killed
    /// its ffmpeg isn't marked failed.
    pub exiting: AtomicBool,
    /// Held for a whole `pump`. Two pumps reading the queue at once would
    /// both pick its first download and start it twice.
    pump_lock: Mutex<()>,
    /// The downloads being deleted right now.
    pub(crate) deleting: Deleting,
}

impl DownloadManager {
    pub fn new(default_root: PathBuf) -> Self {
        Self {
            concurrency: Mutex::new(3),
            root: Mutex::new(default_root),
            running: Mutex::new(HashMap::new()),
            retention_days: Mutex::new(None),
            exiting: AtomicBool::new(false),
            pump_lock: Mutex::new(()),
            deleting: Deleting::default(),
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

    /// The running children. Nothing panics while holding this lock, but a
    /// poisoned one still holds valid handles, and quitting mustn't panic.
    fn running(&self) -> MutexGuard<'_, HashMap<String, RunningChildHandle>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Kill the ffmpeg running for `id`, if there is one.
    fn kill(&self, id: &str) {
        let child = self.running().remove(id);
        if let Some(handle) = child {
            let _ = handle.child.kill();
        }
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

/// Points a saved download folder inside the folder `from` at the same place
/// inside `to`, after `from` was renamed to `to`. Any other saved folder
/// stays as it is.
#[cfg(desktop)]
pub fn move_saved_folder<R: Runtime>(
    app: &AppHandle<R>,
    from: &Path,
    to: &Path,
) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let Some(folder) = store
        .get(FOLDER_KEY)
        .and_then(|v| v.as_str().map(PathBuf::from))
    else {
        return Ok(());
    };
    let Ok(rest) = folder.strip_prefix(from) else {
        return Ok(());
    };
    match to.join(rest).to_str() {
        Some(moved) => save_folder(app, moved),
        None => Ok(()),
    }
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
/// A channel that already has a finished download keeps it, and its id is
/// returned instead of downloading the channel again.
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
    let finished = {
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        finished_download(&cache, channel_id).map_err(|e| e.to_string())?
    };
    match finished {
        Finished::Playable(id) => {
            // The downloads list may be missing it, so it gets the record again.
            emit_progress(app, &id);
            return Ok(id);
        }
        Finished::Removed(id) => emit_removed(app, &id),
        Finished::Nothing => {}
    }

    let manager = app.state::<DownloadManager>();
    let root = manager.root();
    let dest = derive_dest_path(&root, kind, title, series_title, url);

    let id = format!("dl-{}", uuid_like());
    let now = now_secs();
    let mut rec = DownloadRecord {
        id: id.clone(),
        channel_id: channel_id.to_string(),
        title: title.to_string(),
        kind,
        series_channel_id,
        status: DownloadStatus::Queued,
        dest_path: String::new(),
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
        program_start: None,
        program_end: None,
    };
    {
        // One lock for choosing the path and saving the record, so two
        // downloads added at once can't choose the same path.
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        // Clear any prior failed/cancelled attempt for this channel so a retry
        // doesn't leave a duplicate/stale record behind.
        cache
            .delete_terminal_downloads_for_channel(channel_id)
            .map_err(|e| e.to_string())?;
        let dest = unused_dest_path(&cache, &dest)?;
        rec.dest_path = part_path(&dest).to_string_lossy().into_owned();
        cache.upsert_download(&rec).map_err(|e| e.to_string())?;
    }
    // Emit immediately so the UI reflects the queued state without waiting for
    // the first ffmpeg progress line.
    emit_progress(app, &id);
    Ok(id)
}

/// A channel's finished download, as `enqueue_record` finds it.
#[derive(Debug, PartialEq)]
enum Finished {
    /// The channel has no finished download.
    Nothing,
    /// The id of a finished download whose file is still on disk.
    Playable(String),
    /// The id of a finished download whose file was gone, now removed.
    Removed(String),
}

/// The channel's finished download. A finished record whose file is gone is
/// removed, so the channel downloads again and the list doesn't keep a
/// download that can't play.
fn finished_download(cache: &CacheStore, channel_id: &str) -> Result<Finished, CacheError> {
    match cache.completed_download_for_channel(channel_id)? {
        Some(done) if done.has_local_file() => Ok(Finished::Playable(done.id)),
        Some(gone) => {
            cache.delete_download(&gone.id)?;
            Ok(Finished::Removed(gone.id))
        }
        None => Ok(Finished::Nothing),
    }
}

/// `dest`, or `dest` with " (2)", " (3)" and so on added to the name when
/// another download or a file on disk already uses it. Downloads with the
/// same title would otherwise write one file, and stopping one would delete
/// the partial file the other is writing.
pub(crate) fn unused_dest_path(cache: &CacheStore, dest: &Path) -> Result<PathBuf, String> {
    let in_use: HashSet<String> = cache
        .list_download_paths()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|p| path_key(p))
        .collect();
    Ok(unique_dest_path(dest, |p| {
        in_use.contains(&path_key(&p.to_string_lossy())) || p.exists() || part_path(p).exists()
    }))
}

/// Inspect the active set and start ffmpeg for any items the scheduler selects.
pub fn pump<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let manager = app.state::<DownloadManager>();
    let _pumping = manager
        .pump_lock
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
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
            let claimed = {
                let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
                claim_queued(&cache, id)?
            };
            // Stopped or removed since the queue was read.
            let Some(rec) = claimed else {
                return Ok(());
            };
            start_process(app, rec.clone()).inspect_err(|e| fail_to_start(app, &rec, e))
        },
    )
}

/// Mark the queued download `id` as downloading and return it, or `None` when
/// it's no longer queued. Call with the cache lock held from the check to the
/// save, so a stop can't land in between and be overwritten.
fn claim_queued(cache: &CacheStore, id: &str) -> Result<Option<DownloadRecord>, String> {
    let Some(mut rec) = cache.get_download(id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if rec.status != DownloadStatus::Queued {
        return Ok(None);
    }
    rec.status = DownloadStatus::Downloading;
    cache.upsert_download(&rec).map_err(|e| e.to_string())?;
    Ok(Some(rec))
}

/// Why a download can't start again once its channel changed or went away.
const PLAYLIST_CHANGED: &str =
    "The playlist changed after this download was added. Download it again.";

/// The stream URL for `rec`, from its channel. M3U channel ids are positions
/// in the playlist, so after a refresh that reorders it the same id can name
/// another title. A download whose channel is gone, or has a different title
/// from when it was added, fails rather than saving another film under its
/// name.
fn source_url(cache: &CacheStore, rec: &DownloadRecord) -> Result<String, String> {
    let channel = cache
        .get_channel_by_id(&rec.channel_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| PLAYLIST_CHANGED.to_string())?;
    if channel.name != rec.title {
        return Err(PLAYLIST_CHANGED.to_string());
    }
    Ok(channel.url)
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
    if rec.dest_path.ends_with(PART_SUFFIX) {
        let _ = std::fs::remove_file(&rec.dest_path);
    }
    emit_progress(app, &rec.id);
}

/// Put a running download back in the queue and stop its ffmpeg, without
/// marking it failed. A recording that needs the provider's connection does
/// this. The download starts over once no recording of its provider runs.
#[cfg(desktop)]
pub fn requeue<R: Runtime>(app: &AppHandle<R>, id: &str) {
    update_record(app, id, |r| {
        if r.status == DownloadStatus::Downloading {
            r.status = DownloadStatus::Queued;
            r.downloaded_bytes = 0;
            r.avg_rate_bps = None;
        }
    });
    app.state::<DownloadManager>().kill(id);
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
    let children: Vec<_> = manager.running().drain().collect();
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

/// Ask the server how big the video is, so the UI can show a percentage.
/// None when it can't say, as for an HLS stream, whose URL is a playlist.
///
/// The URL is an IPTV panel's, so this goes through the panel client. It gets
/// the API limit, because the download's progress isn't read until it returns.
async fn probe_total_bytes(url: &str) -> Option<i64> {
    let resp = mvp_core::http::download_client()
        .head(url)
        .timeout(mvp_core::http::API_TIMEOUT)
        .send()
        .await
        .ok()?;
    media_size(resp.url().as_str(), resp.status(), resp.headers())
}

/// Start ffmpeg for a record `claim_queued` returned. Spawns the sidecar,
/// streams progress, persists updates, emits `download://progress`, and
/// finalizes on exit.
fn start_process<R: Runtime>(app: &AppHandle<R>, rec: DownloadRecord) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let url = {
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        source_url(&cache, &rec)?
    };

    // Ensure destination directory exists.
    if let Some(parent) = std::path::Path::new(&rec.dest_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // An ffmpeg left over from a crash may still have the old partial file
    // open. Removing the file gives this run a new one the old process can't
    // write into.
    if rec.dest_path.ends_with(PART_SUFFIX) {
        let _ = std::fs::remove_file(&rec.dest_path);
    }

    // Surface the downloading transition immediately.
    emit_progress(app, &rec.id);

    // The final file's extension (dest_path minus ".part") selects the muxer.
    let container = container_from_part_path(&rec.dest_path).to_string();
    let args = build_ffmpeg_args(&url, &rec.dest_path, &container);
    let sidecar = app
        .shell()
        .sidecar(super::FFMPEG_SIDECAR)
        .map_err(|e| redact_credentials(&e.to_string()))?
        .args(args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| redact_credentials(&e.to_string()))?;
    let pid = child.pid();

    // Track the child so it can be killed on stop.
    let manager = app.state::<DownloadManager>();
    {
        let mut running = manager.running();
        // Checked under the lock stop_all_for_exit drains the map with, so a
        // child started as the app quits is either drained there or killed
        // here. The task below then sees `exiting` and leaves the record.
        if manager.exiting.load(Ordering::SeqCst) {
            let _ = child.kill();
        } else {
            running.insert(rec.id.clone(), RunningChildHandle { child });
        }
    }
    // A stop, or a recording putting the download back in the queue, between
    // the claim and the insert above found no child to kill. The task below
    // cleans up after it as after any other stop.
    if matches!(
        current_status(app, &rec.id),
        Some(DownloadStatus::Cancelled | DownloadStatus::Queued)
    ) {
        manager.kill(&rec.id);
    }

    let app = app.clone();
    let id = rec.id.clone();
    let url_for_probe = url.clone();
    // rec.dest_path is the ".part" path; the final path strips that suffix.
    let final_path = rec.dest_path.trim_end_matches(PART_SUFFIX).to_string();
    let started = now_secs();

    tauri::async_runtime::spawn(async move {
        // Save the size on every start, even when there's none, so a wrong
        // size from an older version, such as an HLS playlist's, doesn't
        // outlive a restart.
        let total = probe_total_bytes(&url_for_probe).await;
        update_record(&app, &id, |r| r.total_bytes = total);

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
            let mut running = manager.running();
            let ours = running.get(&id).is_some_and(|h| h.child.pid() == pid);
            if ours {
                running.remove(&id);
            }
            ours
        };
        if !ours && !exiting {
            // A stopped download never runs again, so its partial file goes.
            // The stop deleted it already unless ffmpeg made it afterwards.
            if current_status(&app, &id) == Some(DownloadStatus::Cancelled) {
                let _ = std::fs::remove_file(format!("{final_path}{PART_SUFFIX}"));
            }
            // The record stays as the stop or the new run left it. Sending it
            // tells the page this ffmpeg is gone.
            emit_progress(&app, &id);
            let _ = pump(&app);
            return;
        }

        if exit_ok {
            // Rename .part -> final.
            let _ = std::fs::rename(format!("{final_path}{PART_SUFFIX}"), &final_path);
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
            let _ = std::fs::remove_file(format!("{final_path}{PART_SUFFIX}"));
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
    // A stopped recording keeps its file, so it has its own stop. When the
    // cache can't be read, a running recording is still asked to stop, and
    // the plain stop below kills a running download.
    let kind = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock();
        cache.ok().and_then(|c| c.get_download(id).ok().flatten()).map(|r| r.kind)
    };
    match kind {
        Some(DownloadKind::Recording) => return recordings::stop(app, id),
        None => {
            recordings::ask_to_stop(app, id);
        }
        Some(_) => {}
    }

    // Mark cancelled first so the spawn task's exit handler won't flip it to Failed.
    update_record(app, id, |r| {
        if r.status == DownloadStatus::Queued || r.status == DownloadStatus::Downloading {
            r.status = DownloadStatus::Cancelled;
            r.finished_at = Some(now_secs());
        }
    });

    app.state::<DownloadManager>().kill(id);

    // Remove the partial file. A download that finished just before the stop
    // has its final path here, and that file stays.
    let dest_path = {
        let app_state = app.state::<AppState>();
        let Ok(cache) = app_state.cache.lock() else {
            emit_progress(app, id);
            return Ok(());
        };
        cache.get_download(id).ok().flatten().map(|r| r.dest_path)
    };
    if let Some(path) = dest_path.filter(|p| p.ends_with(PART_SUFFIX)) {
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
    let cache = app_state.cache.lock().ok()?;
    cache.get_download(id).ok().flatten().map(|r| r.status)
}

/// What deleting a download does when its file is already gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MissingFile {
    /// Remove the record anyway. The user asked for the download to go.
    Forget,
    /// Keep the record when the file's folder is gone too, as it is while the
    /// drive the downloads are on isn't connected. A deletion the user didn't
    /// ask for mustn't lose track of files that come back with the drive.
    KeepWithoutFolder,
}

/// What `delete_downloads` did.
#[derive(Debug, Default)]
pub(crate) struct Deleted {
    /// The downloads deleted, with their files.
    pub removed: Vec<String>,
    /// Why each of the others couldn't be. Their records stay.
    pub errors: Vec<String>,
    /// The downloads whose files stayed, back in the cache.
    pub put_back: Vec<String>,
}

/// Delete downloads and their files at the user's request, carrying on past
/// any that fail. The error lists the ones that couldn't be deleted.
pub fn remove<R: Runtime>(app: &AppHandle<R>, ids: &[String]) -> Result<(), String> {
    let deleted = delete_downloads(app, MissingFile::Forget, |cache| {
        let mut seen = HashSet::new();
        let mut records = Vec::new();
        for id in ids.iter().filter(|id| seen.insert(*id)) {
            if let Some(rec) = cache.get_download(id).map_err(|e| e.to_string())? {
                records.push(rec);
            }
        }
        Ok(records)
    })?;
    removal_error(&deleted).map_or(Ok(()), Err)
}

/// The message for the downloads `remove` couldn't delete, or `None` when it
/// deleted them all.
fn removal_error(deleted: &Deleted) -> Option<String> {
    match deleted.errors.as_slice() {
        [] => None,
        [only] if deleted.removed.is_empty() => Some(only.clone()),
        errors => Some(format!(
            "Deleted {} of {}.\n{}",
            deleted.removed.len(),
            deleted.removed.len() + errors.len(),
            errors.join("\n")
        )),
    }
}

/// Delete the downloads `select` picks and their files, carrying on past any
/// that fail, then tell the frontend which ones went. `select` runs under the
/// cache lock, and the records leave the cache under that same lock, so a
/// Keep or a play that lands meanwhile is either seen by `select` or finds
/// the download gone. The files are deleted after the lock is let go, so a
/// slow drive doesn't hold up the rest of the app. A download whose file
/// can't be deleted goes back in the cache, so the app keeps showing the
/// space it takes, with any Keep the user set while it was out.
pub(crate) fn delete_downloads<R: Runtime>(
    app: &AppHandle<R>,
    missing: MissingFile,
    select: impl FnOnce(&CacheStore) -> Result<Vec<DownloadRecord>, String>,
) -> Result<Deleted, String> {
    let deleting = &app.state::<DownloadManager>().deleting;
    let deleted = delete_selected(&app.state::<AppState>().cache, deleting, missing, select)?;
    for id in &deleted.removed {
        emit_removed(app, id);
    }
    for id in &deleted.put_back {
        emit_progress(app, id);
    }
    Ok(deleted)
}

/// `delete_downloads` without the events.
fn delete_selected(
    cache: &Mutex<CacheStore>,
    deleting: &Deleting,
    missing: MissingFile,
    select: impl FnOnce(&CacheStore) -> Result<Vec<DownloadRecord>, String>,
) -> Result<Deleted, String> {
    let (taken, refused) = take_selected(cache, deleting, select)?;
    let (mut deleted, failed) = delete_files(taken, missing);
    deleted.errors.extend(refused);
    deleted.put_back = put_back(cache, deleting, &deleted.removed, failed)?;
    Ok(deleted)
}

/// The downloads `delete_selected` has taken out of the cache while it
/// deletes their files, each with the Keep the user set on it meanwhile, if
/// any. Only used while the cache lock is held, so it always agrees with the
/// cache about which downloads are out.
#[derive(Default)]
pub(crate) struct Deleting(Mutex<HashMap<String, Option<bool>>>);

impl Deleting {
    fn ids(&self) -> MutexGuard<'_, HashMap<String, Option<bool>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Keep a download even when the retention setting would delete it, or stop
/// keeping it. A download that's out of the cache while its file is deleted
/// gets the Keep when it comes back because the file stayed.
pub(crate) fn set_keep(
    cache: &Mutex<CacheStore>,
    deleting: &Deleting,
    id: &str,
    keep: bool,
) -> Result<(), String> {
    let cache = cache.lock().map_err(|e| e.to_string())?;
    let found = cache
        .set_download_keep(id, keep)
        .map_err(|e| e.to_string())?;
    if !found && let Some(pending) = deleting.ids().get_mut(id) {
        *pending = Some(keep);
    }
    Ok(())
}

/// Downloads taken out of the cache to delete, each paired with whether its
/// file goes too.
type Taken = Vec<(DownloadRecord, bool)>;

/// Take the downloads `select` picks out of the cache and note them in
/// `deleting`. A recording that's running stays, and the second list says
/// why.
fn take_selected(
    cache: &Mutex<CacheStore>,
    deleting: &Deleting,
    select: impl FnOnce(&CacheStore) -> Result<Vec<DownloadRecord>, String>,
) -> Result<(Taken, Vec<String>), String> {
    let cache = cache.lock().map_err(|e| e.to_string())?;
    let (running, records): (Vec<_>, Vec<_>) = select(&cache)?
        .into_iter()
        .partition(|r| r.status == DownloadStatus::Recording);
    let refused = running
        .iter()
        .map(|r| format!("Stop the recording of {} before deleting it.", r.title))
        .collect();
    let taken = take_records(&cache, records)?;
    let mut ids = deleting.ids();
    for (rec, _) in &taken {
        ids.insert(rec.id.clone(), None);
    }
    Ok((taken, refused))
}

/// Delete the files of the downloads `take_selected` took. Returns what was
/// deleted and the downloads whose files couldn't be.
fn delete_files(taken: Taken, missing: MissingFile) -> (Deleted, Vec<DownloadRecord>) {
    let mut deleted = Deleted::default();
    let mut failed = Vec::new();
    for (rec, file_unused) in taken {
        // A recording that hasn't started has no file yet.
        let result = if file_unused && !rec.dest_path.is_empty() {
            delete_file(&rec.dest_path, missing)
        } else {
            Ok(())
        };
        match result {
            Ok(()) => deleted.removed.push(rec.id),
            Err(e) => {
                deleted.errors.push(e);
                failed.push(rec);
            }
        }
    }
    (deleted, failed)
}

/// Put the downloads whose files stayed back in the cache, with any Keep set
/// on them while they were out, and drop everything `take_selected` noted
/// from `deleting`. Returns the ids put back.
fn put_back(
    cache: &Mutex<CacheStore>,
    deleting: &Deleting,
    removed: &[String],
    failed: Vec<DownloadRecord>,
) -> Result<Vec<String>, String> {
    let cache = cache.lock().map_err(|e| e.to_string())?;
    let mut ids = deleting.ids();
    for id in removed {
        ids.remove(id);
    }
    let mut put_back = Vec::new();
    for mut rec in failed {
        if let Some(Some(keep)) = ids.remove(&rec.id) {
            rec.keep = keep;
        }
        match cache.upsert_download(&rec) {
            Ok(()) => put_back.push(rec.id),
            Err(e) => tracing::warn!("Could not put back a download whose file stayed: {e}"),
        }
    }
    Ok(put_back)
}

/// Take `records` out of the cache, each paired with whether its file goes
/// too. Downloads added by older versions can share a file with another of
/// the same title, so a file stays while a download not in `records` uses
/// it, or is writing it now, compared the way `path_key` does.
fn take_records(cache: &CacheStore, records: Vec<DownloadRecord>) -> Result<Taken, String> {
    let mut users: HashMap<String, usize> = HashMap::new();
    for path in cache.list_download_paths().map_err(|e| e.to_string())? {
        *users.entry(path_key(&path)).or_default() += 1;
    }
    for rec in &records {
        if let Some(n) = users.get_mut(&path_key(&rec.dest_path)) {
            *n = n.saturating_sub(1);
        }
    }
    let ids: Vec<String> = records.iter().map(|r| r.id.clone()).collect();
    cache.delete_downloads(&ids).map_err(|e| e.to_string())?;
    Ok(records
        .into_iter()
        .map(|rec| {
            let unused = users.get(&path_key(&rec.dest_path)).is_none_or(|&n| n == 0);
            (rec, unused)
        })
        .collect())
}

/// Delete a download's file. One that's already gone counts as deleted,
/// unless `missing` keeps it while its folder is gone too.
fn delete_file(path: &str, missing: MissingFile) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let folder_there = Path::new(path).parent().is_some_and(Path::is_dir);
            if folder_there || missing == MissingFile::Forget {
                Ok(())
            } else {
                Err(format!(
                    "The folder of {path} is missing. Its drive may not be connected."
                ))
            }
        }
        Err(e) => Err(format!("Could not delete {path}: {e}")),
    }
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
mod tests;
