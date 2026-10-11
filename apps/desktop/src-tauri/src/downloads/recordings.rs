// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Runs recordings of live channels. A thread checks the clock every 30
//! seconds and carries out what `recording::plan` returns. It starts the
//! recordings that are due, lets a running recording take in the next one on
//! its channel, and stops each at its end time by sending `q` to its ffmpeg,
//! which closes the file cleanly.
//!
//! Recordings don't use the download slots. Many providers allow one stream
//! at a time, so while a channel records, the running downloads from its
//! provider go back in the queue. They start again when it ends.

use crate::commands::AppState;
use crate::downloads::keep_awake;
use crate::downloads::manager::{self, DownloadManager};
use chrono::NaiveDateTime;
use mvp_core::cache::store::CacheStore;
use mvp_core::downloads::ffmpeg::{fold_progress_line, ProgressUpdate};
use mvp_core::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use mvp_core::downloads::recording::{self, Action, Outcome};
use mvp_core::downloads::redact::redact_credentials;
use mvp_core::models::channel::Channel;
use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// How often the app checks for recordings to start or stop.
const CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// How long ffmpeg has to close its file after it's asked to stop. After
/// that it's killed.
const STOP_GRACE: Duration = Duration::from_secs(15);
/// How long a recording waits after it stops its provider's downloads, so
/// the provider sees their connections close first.
const HANDOVER_PAUSE: Duration = Duration::from_secs(3);
/// How long quitting waits for recordings to close their files.
const EXIT_GRACE: Duration = Duration::from_secs(3);

const NO_CHANNEL: &str = "The channel isn't in the playlist anymore.";
const NOTHING_RECORDED: &str = "Nothing was recorded.";
const STREAM_STOPPED: &str = "The stream stopped before the end.";
const APP_CLOSED: &str = "The app closed during the recording.";
const STOPPED_BEFORE_START: &str = "The recording was stopped before it began.";

struct Running {
    child: CommandChild,
    /// Set once the app asks ffmpeg to stop, so its exit counts as the end.
    stopping: bool,
}

/// Tauri managed state for the recordings whose ffmpeg is running.
#[derive(Default)]
pub struct Recorder {
    running: Mutex<HashMap<String, Running>>,
    /// One check at a time, so a recording can't start twice.
    check: Mutex<()>,
}

/// A new id for a recording. It's also the recording's channel id.
fn new_id() -> String {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    format!(
        "rec-{}-{}",
        manager::uuid_like(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    )
}

/// The live channels that are recording now.
pub(crate) fn recording_channels(cache: &CacheStore) -> Result<Vec<String>, String> {
    Ok(cache
        .list_recordings()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| r.status == DownloadStatus::Recording)
        .filter_map(|r| r.source_channel_id)
        .collect())
}

/// The id of every provider.
pub(crate) fn provider_ids(cache: &CacheStore) -> Result<Vec<String>, String> {
    Ok(cache
        .get_providers()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|p| p.id)
        .collect())
}

/// Save a new recording of the live channel `channel_id` from `start_at` to
/// `end_at`, in Unix seconds.
pub(crate) fn schedule(
    cache: &CacheStore,
    channel_id: &str,
    start_at: i64,
    end_at: i64,
    program_title: Option<String>,
    now: i64,
) -> Result<DownloadRecord, String> {
    recording::check_window(start_at, end_at, now)?;
    let channel = cache
        .get_channel_by_id(channel_id)
        .map_err(|e| e.to_string())?
        .ok_or("channel not found")?;
    if channel.content_type != "live" {
        return Err("Only live channels can be recorded.".into());
    }
    let rec = recording::new_scheduled(&new_id(), &channel, program_title, start_at, end_at, now);
    cache.upsert_download(&rec).map_err(|e| e.to_string())?;
    Ok(rec)
}

/// Settle the recordings that were running when the app last quit or
/// crashed. Each keeps what it recorded. One whose end is still ahead gets a
/// new recording for the rest, which the first check starts. Call at launch,
/// before the first check. Returns how many it settled.
pub fn recover(cache: &CacheStore) -> Result<usize, String> {
    recover_records(cache, manager::now_secs(), new_id).map(|ids| ids.len())
}

fn recover_records(
    cache: &CacheStore,
    now: i64,
    mut next_id: impl FnMut() -> String,
) -> Result<Vec<String>, String> {
    let records = cache.list_recordings().map_err(|e| e.to_string())?;
    let mut settled = Vec::new();
    for (rec, rest) in recording::interrupted(&records, now) {
        let size = file_size(&rec.dest_path);
        let mut done = rec.clone();
        done.downloaded_bytes = size as i64;
        done.finished_at = Some(modified_at(&rec.dest_path).unwrap_or(now));
        if size > 0 {
            done.status = DownloadStatus::Completed;
            done.error = Some(APP_CLOSED.into());
        } else {
            done.status = DownloadStatus::Failed;
            done.error = Some(NOTHING_RECORDED.into());
            let _ = std::fs::remove_file(&rec.dest_path);
        }
        cache.upsert_download(&done).map_err(|e| e.to_string())?;
        if rest {
            let next = recording::rest_of(rec, &next_id(), now);
            cache.upsert_download(&next).map_err(|e| e.to_string())?;
        }
        settled.push(done.id);
    }
    Ok(settled)
}

/// Start checking every 30 seconds, on a thread of its own. Call once, after
/// the first `run_check`.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("recordings".into())
        .spawn(move || loop {
            std::thread::sleep(CHECK_INTERVAL);
            run_check(&app);
        });
    if let Err(e) = spawned {
        tracing::warn!("Could not start the recordings check: {e}");
    }
}

/// Check now on another thread, as when the user schedules a recording that
/// starts right away. A check can wait a few seconds for downloads to stop.
pub fn check_soon<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("recordings-now".into())
        .spawn(move || run_check(&app));
    if let Err(e) = spawned {
        tracing::warn!("Could not check the recordings: {e}");
    }
}

/// Run `check` and log what goes wrong. A panic in one check, such as from a
/// poisoned lock, must not end every check after it.
pub fn run_check<R: Runtime>(app: &AppHandle<R>) {
    match std::panic::catch_unwind(AssertUnwindSafe(|| check(app))) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!("Recordings check failed: {e}"),
        Err(_) => tracing::error!("Recordings check panicked"),
    }
}

/// Start, extend, stop or miss whatever is due now.
fn check<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if exiting(app) {
        return Ok(());
    }
    let recorder = app.state::<Recorder>();
    let _one_at_a_time = recorder.check.lock().unwrap_or_else(|e| e.into_inner());
    let records = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.list_recordings().map_err(|e| e.to_string())?
    };
    for action in recording::plan(&records, manager::now_secs()) {
        match action {
            Action::Start(id) => begin(app, &id),
            Action::Merge { id, into, end_at } => merge(app, &id, &into, end_at),
            Action::Miss(id) => miss(app, &id),
            // No ffmpeg runs for it, so there's nothing to wait for.
            Action::Stop(id) if !ask_to_stop(app, &id) => settle(app, &id, true, None),
            Action::Stop(_) => {}
        }
    }
    Ok(())
}

fn exiting<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<DownloadManager>()
        .is_some_and(|m| m.exiting.load(Ordering::SeqCst))
}

/// Start recording `id`. One that can't start is marked failed.
fn begin<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Err(e) = try_begin(app, id) else {
        return;
    };
    tracing::warn!("Could not start a recording: {e}");
    let now = manager::now_secs();
    manager::update_record(app, id, |r| {
        if matches!(
            r.status,
            DownloadStatus::Scheduled | DownloadStatus::Recording
        ) {
            r.status = DownloadStatus::Failed;
            r.error = Some(e);
            r.finished_at = Some(now);
        }
    });
    manager::emit_progress(app, id);
    // The provider's downloads were put back in the queue, so let them go on.
    if let Err(e) = manager::pump(app) {
        tracing::warn!("Failed to start queued downloads: {e}");
    }
}

fn try_begin<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let root = app.state::<DownloadManager>().root();
    let claimed = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        claim(
            &cache,
            id,
            &root,
            manager::now_secs(),
            chrono::Local::now().naive_local(),
        )?
    };
    let Some(Claim { url, downloads }) = claimed else {
        return Ok(());
    };
    manager::emit_progress(app, id);

    // Stop the provider's downloads so the recording gets the connection.
    for download in &downloads {
        manager::requeue(app, download);
    }
    if !downloads.is_empty() {
        std::thread::sleep(HANDOVER_PAUSE);
    }

    // The user may have stopped it during the pause.
    let rec = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.get_download(id).map_err(|e| e.to_string())?
    }
    .filter(|r| r.status == DownloadStatus::Recording)
    .ok_or(STOPPED_BEFORE_START)?;
    if rec.end_at.is_some_and(|end| end <= manager::now_secs()) {
        return Err(STOPPED_BEFORE_START.into());
    }

    if let Some(dir) = Path::new(&rec.dest_path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let (rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| redact_credentials(&e.to_string()))?
        .args(recording::ffmpeg_args(&url, &rec.dest_path))
        .spawn()
        .map_err(|e| redact_credentials(&e.to_string()))?;
    let pid = child.pid();
    {
        let recorder = app.state::<Recorder>();
        let mut running = recorder.running.lock().unwrap();
        running.insert(
            id.to_string(),
            Running {
                child,
                stopping: false,
            },
        );
    }
    keep_awake::hold_while_running(pid);
    tauri::async_runtime::spawn(watch(app.clone(), id.to_string(), pid, rx));
    Ok(())
}

/// What a recording needs to start.
#[derive(Debug, PartialEq)]
struct Claim {
    /// The stream to record.
    url: String,
    /// The provider's downloads that have to stop first.
    downloads: Vec<String>,
}

/// Mark the scheduled recording `id` as recording, with its live channel and
/// a file named for `local_now`. This happens under the cache lock, so a
/// cancel either comes first or finds the recording started. Returns `None`
/// when `id` isn't waiting to start.
fn claim(
    cache: &CacheStore,
    id: &str,
    root: &Path,
    now: i64,
    local_now: NaiveDateTime,
) -> Result<Option<Claim>, String> {
    let Some(mut rec) = cache.get_download(id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if rec.kind != DownloadKind::Recording || rec.status != DownloadStatus::Scheduled {
        return Ok(None);
    }
    let providers = provider_ids(cache)?;
    let source = find_source(cache, &rec, &providers)?.ok_or(NO_CHANNEL)?;
    let taken: HashSet<String> = cache
        .list_recordings()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| r.dest_path)
        .collect();
    let dest = recording::dest_path(root, &rec.title, local_now, |p| {
        p.exists() || taken.contains(p.to_string_lossy().as_ref())
    });

    rec.status = DownloadStatus::Recording;
    rec.start_at = Some(now);
    rec.dest_path = dest.to_string_lossy().into_owned();
    rec.source_channel_id = Some(source.id.clone());
    rec.downloaded_bytes = 0;
    rec.error = None;
    cache.upsert_download(&rec).map_err(|e| e.to_string())?;

    let provider = recording::provider_of(&source.id, &providers);
    let downloads = cache
        .list_active_downloads()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|d| d.status == DownloadStatus::Downloading)
        .filter(|d| {
            provider.is_some() && recording::provider_of(&d.channel_id, &providers) == provider
        })
        .map(|d| d.id)
        .collect();
    Ok(Some(Claim {
        url: source.url,
        downloads,
    }))
}

/// The live channel to record. Channel ids follow each channel's place in
/// the playlist, so after a refresh the saved one can point at another
/// channel. Then this looks for the channel by name in the same provider.
fn find_source(
    cache: &CacheStore,
    rec: &DownloadRecord,
    providers: &[String],
) -> Result<Option<Channel>, String> {
    let Some(saved_id) = rec.source_channel_id.as_deref() else {
        return Ok(None);
    };
    let saved = cache
        .get_channel_by_id(saved_id)
        .map_err(|e| e.to_string())?;
    if saved.as_ref().is_some_and(|c| c.name == rec.title) {
        return Ok(saved);
    }
    let Some(provider) = recording::provider_of(saved_id, providers) else {
        return Ok(None);
    };
    let channels = cache.get_channels(provider).map_err(|e| e.to_string())?;
    Ok(recording::pick_source(saved.as_ref(), &rec.title, &channels).cloned())
}

/// Follow a recording's ffmpeg until it exits, saving the size of the file
/// as it grows.
async fn watch<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    pid: u32,
    mut rx: Receiver<CommandEvent>,
) {
    let mut acc = ProgressUpdate::default();
    let mut last_error = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let line = String::from_utf8_lossy(&line);
                if fold_progress_line(&mut acc, &line) {
                    if let Some(size) = acc.total_size {
                        manager::update_record(&app, &id, |r| r.downloaded_bytes = size);
                        manager::emit_progress(&app, &id);
                    }
                    acc = ProgressUpdate::default();
                }
            }
            CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line);
                let line = line.trim();
                if !line.is_empty() {
                    last_error = Some(redact_credentials(line));
                }
            }
            _ => {}
        }
    }

    let run = {
        let recorder = app.state::<Recorder>();
        let mut running = recorder.running.lock().unwrap();
        if running.get(&id).is_some_and(|r| r.child.pid() == pid) {
            running.remove(&id)
        } else {
            None
        }
    };
    // The app is quitting. The record stays `Recording`, and the next launch
    // settles it.
    if exiting(&app) {
        return;
    }
    // With no entry left, the app killed ffmpeg after asking it to stop.
    let stopped = run.is_none_or(|r| r.stopping);
    settle(&app, &id, stopped, last_error);
}

/// Finish recording `id` now that its ffmpeg is gone, then let the
/// provider's downloads go on.
fn settle<R: Runtime>(app: &AppHandle<R>, id: &str, stopped: bool, last_error: Option<String>) {
    let settled = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string());
        cache.and_then(|cache| settle_record(&cache, id, stopped, last_error, manager::now_secs()))
    };
    if let Err(e) = settled {
        tracing::warn!("Could not finish a recording: {e}");
    }
    manager::emit_progress(app, id);
    if let Err(e) = manager::pump(app) {
        tracing::warn!("Failed to start queued downloads: {e}");
    }
}

/// Finish the record of a recording whose ffmpeg exited, going by what's in
/// its file. `stopped` says whether the app asked ffmpeg to stop. A
/// recording with an empty file fails, and the file is deleted.
fn settle_record(
    cache: &CacheStore,
    id: &str,
    stopped: bool,
    last_error: Option<String>,
    now: i64,
) -> Result<(), String> {
    let Some(mut rec) = cache.get_download(id).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if rec.status != DownloadStatus::Recording {
        return Ok(());
    }
    let size = file_size(&rec.dest_path);
    rec.downloaded_bytes = size as i64;
    rec.finished_at = Some(now);
    match recording::outcome(size, stopped) {
        Outcome::Finished => {
            rec.status = DownloadStatus::Completed;
            rec.error = None;
        }
        Outcome::EndedEarly => {
            rec.status = DownloadStatus::Completed;
            rec.error = Some(last_error.unwrap_or_else(|| STREAM_STOPPED.into()));
        }
        Outcome::Failed => {
            rec.status = DownloadStatus::Failed;
            rec.error = Some(last_error.unwrap_or_else(|| NOTHING_RECORDED.into()));
            let _ = std::fs::remove_file(&rec.dest_path);
        }
    }
    cache.upsert_download(&rec).map_err(|e| e.to_string())
}

/// Let the running recording `into` take in `id`, which is due on the same
/// channel, so both end up in one file. Starts `id` on its own when `into`
/// is stopping or has ended.
fn merge<R: Runtime>(app: &AppHandle<R>, id: &str, into: &str, end_at: i64) {
    let stopping = {
        let recorder = app.state::<Recorder>();
        let running = recorder.running.lock().unwrap();
        running.get(into).is_some_and(|r| r.stopping)
    };
    let merged = !stopping && {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string());
        match cache.and_then(|cache| merge_records(&cache, id, into, end_at)) {
            Ok(merged) => merged,
            Err(e) => {
                tracing::warn!("Could not extend a recording: {e}");
                false
            }
        }
    };
    if merged {
        manager::emit_progress(app, into);
        manager::emit_removed(app, id);
    } else {
        begin(app, id);
    }
}

/// Move the end of the recording `into` to `end_at`, never earlier, and drop
/// the scheduled recording `id`. Returns false, changing nothing, when
/// `into` isn't recording or `id` isn't waiting.
fn merge_records(cache: &CacheStore, id: &str, into: &str, end_at: i64) -> Result<bool, String> {
    let get = |id: &str| cache.get_download(id).map_err(|e| e.to_string());
    let (Some(mut target), Some(next)) = (get(into)?, get(id)?) else {
        return Ok(false);
    };
    if target.status != DownloadStatus::Recording || next.status != DownloadStatus::Scheduled {
        return Ok(false);
    }
    target.end_at = Some(target.end_at.map_or(end_at, |end| end.max(end_at)));
    target.program_title = recording::merged_title(
        target.program_title.as_deref(),
        next.program_title.as_deref(),
    );
    cache.upsert_download(&target).map_err(|e| e.to_string())?;
    cache.delete_download(id).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Mark a recording whose window passed before it could start.
fn miss<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let now = manager::now_secs();
    manager::update_record(app, id, |r| {
        if r.status == DownloadStatus::Scheduled {
            r.status = DownloadStatus::Missed;
            r.finished_at = Some(now);
        }
    });
    manager::emit_progress(app, id);
}

/// Ask the ffmpeg recording `id` to close its file and exit. It's killed if
/// it's still running after a while. Returns false when no ffmpeg runs for
/// `id`.
fn ask_to_stop<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let pid = {
        let recorder = app.state::<Recorder>();
        let mut running = recorder.running.lock().unwrap();
        let Some(run) = running.get_mut(id) else {
            return false;
        };
        if run.stopping {
            return true;
        }
        run.stopping = true;
        if let Err(e) = run.child.write(b"q") {
            tracing::warn!("Could not ask a recording to stop: {e}");
        }
        run.child.pid()
    };
    let app = app.clone();
    let id = id.to_string();
    let spawned = std::thread::Builder::new()
        .name("recording-stop".into())
        .spawn(move || {
            std::thread::sleep(STOP_GRACE);
            let run = {
                let recorder = app.state::<Recorder>();
                let mut running = recorder.running.lock().unwrap();
                if running.get(&id).is_some_and(|r| r.child.pid() == pid) {
                    running.remove(&id)
                } else {
                    None
                }
            };
            if let Some(run) = run {
                tracing::warn!("A recording didn't stop when asked, so it was killed");
                let _ = run.child.kill();
            }
        });
    if let Err(e) = spawned {
        tracing::warn!("Could not watch a recording stop: {e}");
    }
    true
}

/// What stopping a recording did to its record.
#[derive(Debug, PartialEq)]
enum Stopped {
    /// It hadn't started, so it's gone.
    Cancelled,
    /// It's recording and now ends at once.
    Ending,
    /// It isn't scheduled or recording.
    Nothing,
}

/// Stop the recording `id` at `now`. One that hasn't started is deleted.
fn end_now(cache: &CacheStore, id: &str, now: i64) -> Result<Stopped, String> {
    let Some(mut rec) = cache.get_download(id).map_err(|e| e.to_string())? else {
        return Ok(Stopped::Nothing);
    };
    if rec.kind != DownloadKind::Recording {
        return Ok(Stopped::Nothing);
    }
    match rec.status {
        DownloadStatus::Scheduled => {
            cache.delete_download(id).map_err(|e| e.to_string())?;
            Ok(Stopped::Cancelled)
        }
        DownloadStatus::Recording => {
            rec.end_at = Some(rec.end_at.map_or(now, |end| end.min(now)));
            cache.upsert_download(&rec).map_err(|e| e.to_string())?;
            Ok(Stopped::Ending)
        }
        _ => Ok(Stopped::Nothing),
    }
}

/// Stop a recording now and keep what it recorded. One that hasn't started
/// is cancelled and removed.
pub fn stop<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let stopped = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        end_now(&cache, id, manager::now_secs())?
    };
    match stopped {
        Stopped::Cancelled => manager::emit_removed(app, id),
        Stopped::Ending => {
            manager::emit_progress(app, id);
            // With no ffmpeg yet, it's waiting for downloads to stop. It
            // sees the new end time before it starts.
            ask_to_stop(app, id);
        }
        Stopped::Nothing => {}
    }
    Ok(())
}

/// Ask every recording to close its file as the app quits, and wait a moment
/// for them. Their records stay `Recording`, so the next launch keeps their
/// files and records the rest of any program that's still on.
pub fn stop_all_for_exit<R: Runtime>(app: &AppHandle<R>) {
    let Some(recorder) = app.try_state::<Recorder>() else {
        return;
    };
    if let Some(manager) = app.try_state::<DownloadManager>() {
        manager.exiting.store(true, Ordering::SeqCst);
    }
    for run in recorder.running.lock().unwrap().values_mut() {
        run.stopping = true;
        let _ = run.child.write(b"q");
    }
    let deadline = Instant::now() + EXIT_GRACE;
    while Instant::now() < deadline && !recorder.running.lock().unwrap().is_empty() {
        std::thread::sleep(Duration::from_millis(50));
    }
    for (_, run) in recorder.running.lock().unwrap().drain() {
        let _ = run.child.kill();
    }
}

fn file_size(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// When the file was last written, in Unix seconds.
fn modified_at(path: &str) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use mvp_core::models::playlist::{Provider, ProviderType};

    fn channel(id: &str, name: &str, content_type: &str) -> Channel {
        Channel {
            id: id.into(),
            name: name.into(),
            url: format!("http://h/live/u/p/{id}.ts"),
            logo_url: None,
            group_title: "News".into(),
            tvg_id: None,
            tvg_name: None,
            is_favorite: false,
            content_type: content_type.into(),
            sources: vec![],
            series_title: None,
            season: None,
            episode: None,
        }
    }

    fn provider(id: &str) -> Provider {
        Provider {
            id: id.into(),
            name: id.into(),
            provider_type: ProviderType::Xtream,
            url: "http://h".into(),
            username: None,
            password: None,
            last_updated: None,
            channel_count: 0,
            epg_url: None,
        }
    }

    /// A cache with the providers `xt-1` and `xt-2`, each with the live
    /// channel "City News" and a movie.
    fn cache() -> CacheStore {
        let cache = CacheStore::open_in_memory().unwrap();
        for p in ["xt-1", "xt-2"] {
            cache.upsert_provider(&provider(p)).unwrap();
            cache
                .save_channels(
                    p,
                    &[
                        channel(&format!("{p}-xt-0"), "City News", "live"),
                        channel(&format!("{p}-vod-0"), "Dune (2021)", "movie"),
                    ],
                )
                .unwrap();
        }
        cache
    }

    fn download(id: &str, channel_id: &str, status: DownloadStatus) -> DownloadRecord {
        let mut rec = recording::new_scheduled(
            id,
            &channel(channel_id, "Dune (2021)", "movie"),
            None,
            0,
            1,
            0,
        );
        rec.kind = DownloadKind::Movie;
        rec.channel_id = channel_id.into();
        rec.source_channel_id = None;
        rec.start_at = None;
        rec.end_at = None;
        rec.status = status;
        rec
    }

    fn local(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 12)
            .unwrap()
            .and_hms_opt(h, m, 0)
            .unwrap()
    }

    fn get(cache: &CacheStore, id: &str) -> DownloadRecord {
        cache.get_download(id).unwrap().unwrap()
    }

    fn put(cache: &CacheStore, rec: &DownloadRecord) {
        cache.upsert_download(rec).unwrap();
    }

    #[test]
    fn schedules_only_live_channels_and_times_ahead() {
        let cache = cache();
        let rec = schedule(&cache, "xt-1-xt-0", 100, 200, Some("News".into()), 50).unwrap();
        assert_eq!(get(&cache, &rec.id).status, DownloadStatus::Scheduled);
        assert_eq!(rec.channel_id, rec.id);
        assert!(schedule(&cache, "xt-1-vod-0", 100, 200, None, 50).is_err());
        assert!(schedule(&cache, "xt-1-xt-0", 100, 200, None, 300).is_err());
        assert!(schedule(&cache, "xt-9-xt-0", 100, 200, None, 50).is_err());
    }

    #[test]
    fn claiming_starts_the_recording_and_stops_its_providers_downloads() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let rec = schedule(&cache, "xt-1-xt-0", 100, 200, None, 50).unwrap();
        put(
            &cache,
            &download("same", "xt-1-vod-0", DownloadStatus::Downloading),
        );
        put(
            &cache,
            &download("waiting", "xt-1-vod-1", DownloadStatus::Queued),
        );
        put(
            &cache,
            &download("other", "xt-2-vod-0", DownloadStatus::Downloading),
        );

        let claimed = claim(&cache, &rec.id, dir.path(), 120, local(20, 0)).unwrap();
        assert_eq!(
            claimed,
            Some(Claim {
                url: "http://h/live/u/p/xt-1-xt-0.ts".into(),
                downloads: vec!["same".into()],
            })
        );
        let started = get(&cache, &rec.id);
        assert_eq!(started.status, DownloadStatus::Recording);
        assert_eq!(started.start_at, Some(120));
        assert_eq!(
            Path::new(&started.dest_path),
            dir.path().join("recordings/City News 2026-10-12 20.00.ts")
        );
        assert_eq!(recording_channels(&cache).unwrap(), vec!["xt-1-xt-0"]);

        // It's no longer waiting, so a second claim does nothing.
        assert_eq!(
            claim(&cache, &rec.id, dir.path(), 130, local(20, 0)).unwrap(),
            None
        );
    }

    #[test]
    fn two_recordings_that_start_together_get_their_own_files() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let a = schedule(&cache, "xt-1-xt-0", 100, 200, None, 50).unwrap();
        let b = schedule(&cache, "xt-2-xt-0", 100, 200, None, 50).unwrap();
        claim(&cache, &a.id, dir.path(), 120, local(20, 0)).unwrap();
        claim(&cache, &b.id, dir.path(), 120, local(20, 0)).unwrap();
        assert_eq!(
            Path::new(&get(&cache, &b.id).dest_path),
            dir.path()
                .join("recordings/City News 2026-10-12 20.00 (2).ts")
        );
    }

    #[test]
    fn finds_the_channel_by_name_after_a_refresh_moves_it() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let rec = schedule(&cache, "xt-1-xt-0", 100, 200, None, 50).unwrap();
        cache
            .save_channels(
                "xt-1",
                &[
                    channel("xt-1-xt-0", "Sports One", "live"),
                    channel("xt-1-xt-1", "City News", "live"),
                ],
            )
            .unwrap();
        let claimed = claim(&cache, &rec.id, dir.path(), 120, local(20, 0))
            .unwrap()
            .unwrap();
        assert_eq!(claimed.url, "http://h/live/u/p/xt-1-xt-1.ts");
        assert_eq!(
            get(&cache, &rec.id).source_channel_id.as_deref(),
            Some("xt-1-xt-1")
        );
    }

    #[test]
    fn a_channel_that_left_the_playlist_cant_be_recorded() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let rec = schedule(&cache, "xt-1-xt-0", 100, 200, None, 50).unwrap();
        cache.save_channels("xt-1", &[]).unwrap();
        assert_eq!(
            claim(&cache, &rec.id, dir.path(), 120, local(20, 0)),
            Err(NO_CHANNEL.to_string())
        );
        assert_eq!(get(&cache, &rec.id).status, DownloadStatus::Scheduled);
    }

    #[test]
    fn a_merge_extends_the_running_recording_and_drops_the_next() {
        let cache = cache();
        let first = schedule(&cache, "xt-1-xt-0", 100, 1_000, Some("A".into()), 50).unwrap();
        let next = schedule(&cache, "xt-1-xt-0", 900, 2_000, Some("B".into()), 50).unwrap();
        let mut running = get(&cache, &first.id);
        running.status = DownloadStatus::Recording;
        put(&cache, &running);

        assert!(merge_records(&cache, &next.id, &first.id, 2_000).unwrap());
        let merged = get(&cache, &first.id);
        assert_eq!(merged.end_at, Some(2_000));
        assert_eq!(merged.program_title.as_deref(), Some("A, B"));
        assert!(cache.get_download(&next.id).unwrap().is_none());
    }

    #[test]
    fn a_merge_needs_a_running_recording() {
        let cache = cache();
        let first = schedule(&cache, "xt-1-xt-0", 100, 1_000, None, 50).unwrap();
        let next = schedule(&cache, "xt-1-xt-0", 900, 2_000, None, 50).unwrap();
        let mut failed = get(&cache, &first.id);
        failed.status = DownloadStatus::Failed;
        put(&cache, &failed);

        assert!(!merge_records(&cache, &next.id, &first.id, 2_000).unwrap());
        assert_eq!(get(&cache, &first.id).end_at, Some(1_000));
        assert_eq!(get(&cache, &next.id).status, DownloadStatus::Scheduled);
    }

    #[test]
    fn stopping_cancels_a_scheduled_recording_and_ends_a_running_one() {
        let cache = cache();
        let waiting = schedule(&cache, "xt-1-xt-0", 100, 1_000, None, 50).unwrap();
        assert_eq!(
            end_now(&cache, &waiting.id, 60).unwrap(),
            Stopped::Cancelled
        );
        assert!(cache.get_download(&waiting.id).unwrap().is_none());

        let on = schedule(&cache, "xt-1-xt-0", 100, 1_000, None, 50).unwrap();
        let mut running = get(&cache, &on.id);
        running.status = DownloadStatus::Recording;
        put(&cache, &running);
        assert_eq!(end_now(&cache, &on.id, 400).unwrap(), Stopped::Ending);
        assert_eq!(get(&cache, &on.id).end_at, Some(400));

        put(
            &cache,
            &download("movie", "xt-1-vod-0", DownloadStatus::Downloading),
        );
        assert_eq!(end_now(&cache, "movie", 400).unwrap(), Stopped::Nothing);
    }

    fn running_with_file(cache: &CacheStore, file: &Path, contents: &[u8]) -> String {
        std::fs::write(file, contents).unwrap();
        let rec = schedule(cache, "xt-1-xt-0", 100, 1_000, None, 50).unwrap();
        let mut running = get(cache, &rec.id);
        running.status = DownloadStatus::Recording;
        running.dest_path = file.to_string_lossy().into_owned();
        put(cache, &running);
        rec.id
    }

    #[test]
    fn a_recording_that_was_stopped_is_complete() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let id = running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        settle_record(&cache, &id, true, None, 900).unwrap();
        let done = get(&cache, &id);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.downloaded_bytes, 5);
        assert_eq!(done.finished_at, Some(900));
        assert_eq!(done.error, None);
    }

    #[test]
    fn a_recording_whose_stream_ended_keeps_what_it_got() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let id = running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        settle_record(&cache, &id, false, None, 500).unwrap();
        let done = get(&cache, &id);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.error.as_deref(), Some(STREAM_STOPPED));
        assert!(dir.path().join("a.ts").exists());
    }

    #[test]
    fn a_recording_with_nothing_in_it_fails_and_its_file_goes() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.ts");
        let id = running_with_file(&cache, &file, b"");
        settle_record(&cache, &id, true, Some("404 Not Found".into()), 500).unwrap();
        let done = get(&cache, &id);
        assert_eq!(done.status, DownloadStatus::Failed);
        assert_eq!(done.error.as_deref(), Some("404 Not Found"));
        assert!(!file.exists());
    }

    #[test]
    fn launch_keeps_a_cut_off_recording_and_records_the_rest() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let kept = running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        let empty_file = dir.path().join("b.ts");
        let empty = running_with_file(&cache, &empty_file, b"");
        let mut over = get(&cache, &empty);
        over.end_at = Some(300);
        put(&cache, &over);

        let settled = recover_records(&cache, 500, || "rec-rest".to_string()).unwrap();
        assert_eq!(settled.len(), 2);

        let done = get(&cache, &kept);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.downloaded_bytes, 5);
        assert_eq!(done.error.as_deref(), Some(APP_CLOSED));
        let rest = get(&cache, "rec-rest");
        assert_eq!(rest.status, DownloadStatus::Scheduled);
        assert_eq!((rest.start_at, rest.end_at), (Some(500), Some(1_000)));

        // The other one recorded nothing, and its program is over.
        assert_eq!(get(&cache, &empty).status, DownloadStatus::Failed);
        assert!(!empty_file.exists());
        assert_eq!(cache.list_recordings().unwrap().len(), 3);
    }
}
