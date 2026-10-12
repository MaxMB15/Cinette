// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::commands::AppState;
use crate::downloads::scheduler::start_queued;
use mvp_core::cache::store::CacheStore;
use mvp_core::downloads::ffmpeg::{
    build_ffmpeg_args, container_from_part_path, fold_progress_line, ProgressUpdate,
};
use mvp_core::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use mvp_core::downloads::paths::{
    derive_dest_path, part_path, path_key, unique_dest_path, PART_SUFFIX,
};
use mvp_core::downloads::redact::redact_credentials;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

/// The download folder and concurrency live in the same store file as the
/// other settings so they survive a restart.
const SETTINGS_STORE_FILE: &str = "settings.json";
const FOLDER_KEY: &str = "download_folder";
const CONCURRENCY_KEY: &str = "download_concurrency";
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
    /// Set as the app quits, so a download that ends because the app killed
    /// its ffmpeg isn't marked failed.
    pub exiting: AtomicBool,
    /// Held for a whole `pump`. Two pumps reading the queue at once would
    /// both pick its first download and start it twice.
    pump_lock: Mutex<()>,
}

impl DownloadManager {
    pub fn new(default_root: PathBuf) -> Self {
        Self {
            concurrency: Mutex::new(3),
            root: Mutex::new(default_root),
            running: Mutex::new(HashMap::new()),
            exiting: AtomicBool::new(false),
            pump_lock: Mutex::new(()),
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

/// Apply the download folder and concurrency saved in an earlier session.
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
}

/// Save the download folder so the next launch uses it.
pub fn save_folder<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<(), String> {
    save_setting(app, FOLDER_KEY, serde_json::Value::from(folder))
}

/// Save the download concurrency so the next launch uses it.
pub fn save_concurrency<R: Runtime>(app: &AppHandle<R>, n: usize) -> Result<(), String> {
    save_setting(app, CONCURRENCY_KEY, serde_json::Value::from(n))
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

/// `dest`, or `dest` with " (2)", " (3)" and so on added to the name when
/// another download or a file on disk already uses it. Downloads with the
/// same title would otherwise write one file, and stopping one would delete
/// the partial file the other is writing.
fn unused_dest_path(cache: &CacheStore, dest: &Path) -> Result<PathBuf, String> {
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
            Ok(active.into_iter().map(|r| (r.id, r.status)).collect())
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

/// The stream URL for `rec`, from its channel. M3U channel ids are positions
/// in the playlist, so after a refresh that reorders it the same id can name
/// another title. A download whose channel has a different title from when
/// it was added fails rather than saving another film under its name.
fn source_url(cache: &CacheStore, rec: &DownloadRecord) -> Result<String, String> {
    let channel = cache
        .get_channel_by_id(&rec.channel_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("channel not found: {}", rec.channel_id))?;
    if channel.name != rec.title {
        return Err(
            "The playlist changed after this download was added. Download it again.".to_string(),
        );
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
        .sidecar("ffmpeg")
        .map_err(|e| redact_credentials(&e.to_string()))?
        .args(args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| redact_credentials(&e.to_string()))?;

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
    // A stop between the claim and the insert above found no child to kill.
    // The task below cleans up after it as after any other stop.
    if current_status(app, &rec.id) == Some(DownloadStatus::Cancelled) {
        manager.kill(&rec.id);
    }

    let app = app.clone();
    let id = rec.id.clone();
    let url_for_probe = url.clone();
    // rec.dest_path is the ".part" path; the final path strips that suffix.
    let final_path = rec.dest_path.trim_end_matches(PART_SUFFIX).to_string();
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

        // Remove from running map.
        app.state::<DownloadManager>().running().remove(&id);

        if exit_ok {
            // Rename .part -> final.
            let _ = std::fs::rename(format!("{final_path}{PART_SUFFIX}"), &final_path);
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

fn emit_progress<R: Runtime>(app: &AppHandle<R>, id: &str) {
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
    use mvp_core::models::channel::Channel;

    fn queued(id: &str, dest_path: &str) -> DownloadRecord {
        DownloadRecord {
            id: id.into(),
            channel_id: format!("c-{id}"),
            title: "Dune (2021)".into(),
            kind: DownloadKind::Movie,
            series_channel_id: None,
            status: DownloadStatus::Queued,
            dest_path: dest_path.into(),
            total_bytes: None,
            downloaded_bytes: 0,
            avg_rate_bps: None,
            error: None,
            created_at: 0,
            finished_at: None,
        }
    }

    fn channel(id: &str, name: &str) -> Channel {
        Channel {
            id: id.into(),
            name: name.into(),
            url: format!("http://h/movie/u/p/{id}.mkv"),
            logo_url: None,
            group_title: "Movies".into(),
            tvg_id: None,
            tvg_name: None,
            is_favorite: false,
            content_type: "movie".into(),
            sources: Vec::new(),
            series_title: None,
            season: None,
            episode: None,
        }
    }

    #[test]
    fn a_download_is_claimed_once() {
        let cache = CacheStore::open_in_memory().unwrap();
        cache
            .upsert_download(&queued("a", "/dl/a.mkv.part"))
            .unwrap();

        let claimed = claim_queued(&cache, "a").unwrap().unwrap();
        assert_eq!(claimed.status, DownloadStatus::Downloading);
        assert_eq!(
            cache.get_download("a").unwrap().unwrap().status,
            DownloadStatus::Downloading
        );
        assert!(claim_queued(&cache, "a").unwrap().is_none());
        assert!(claim_queued(&cache, "missing").unwrap().is_none());
    }

    #[test]
    fn a_stopped_download_is_not_claimed() {
        let cache = CacheStore::open_in_memory().unwrap();
        let mut rec = queued("a", "/dl/a.mkv.part");
        rec.status = DownloadStatus::Cancelled;
        cache.upsert_download(&rec).unwrap();

        assert!(claim_queued(&cache, "a").unwrap().is_none());
        assert_eq!(
            cache.get_download("a").unwrap().unwrap().status,
            DownloadStatus::Cancelled
        );
    }

    #[test]
    fn picks_a_path_no_download_or_file_uses() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Dune (2021).mkv");
        let cache = CacheStore::open_in_memory().unwrap();
        assert_eq!(unused_dest_path(&cache, &dest).unwrap(), dest);

        // Another download writing the same file, in another case.
        let upper = dir.path().join("DUNE (2021).MKV");
        cache
            .upsert_download(&queued("a", &part_path(&upper).to_string_lossy()))
            .unwrap();
        let second = dir.path().join("Dune (2021) (2).mkv");
        assert_eq!(unused_dest_path(&cache, &dest).unwrap(), second);

        // A file already in the folder that no download knows about, and a
        // partial file left behind.
        std::fs::write(&second, b"video").unwrap();
        let third = dir.path().join("Dune (2021) (3).mkv");
        std::fs::write(part_path(&third), b"vid").unwrap();
        assert_eq!(
            unused_dest_path(&cache, &dest).unwrap(),
            dir.path().join("Dune (2021) (4).mkv")
        );
    }

    #[test]
    fn starts_only_while_the_channel_keeps_its_title() {
        let cache = CacheStore::open_in_memory().unwrap();
        let rec = queued("a", "/dl/a.mkv.part");
        cache
            .upsert_channel("p1", &channel(&rec.channel_id, "Dune (2021)"))
            .unwrap();
        assert_eq!(
            source_url(&cache, &rec).unwrap(),
            "http://h/movie/u/p/c-a.mkv"
        );

        // A refresh moved another title to this position in the playlist.
        cache
            .upsert_channel("p1", &channel(&rec.channel_id, "Arrival (2016)"))
            .unwrap();
        assert!(source_url(&cache, &rec).is_err());

        let gone = queued("b", "/dl/b.mkv.part");
        assert!(source_url(&cache, &gone).is_err());
    }
}
