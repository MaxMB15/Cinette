// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Runs recordings of live channels. A thread checks the clock when a
//! recording is due to start, stop or hand over, and at least every 30
//! seconds, and carries out what `recording::plan` returns. It starts the
//! recordings that are due, lets a running recording take in the next one on
//! its channel, and stops each at its end time by sending `q` to its ffmpeg,
//! which closes the file cleanly. ffmpeg also gets a length limit a little
//! past the end, so it stops by itself if the app crashes.
//!
//! Recordings don't use the download slots. Many providers allow one stream
//! at a time, so while a channel records, the running downloads from its
//! provider go back in the queue. They start again when it ends. When two
//! recordings from one provider overlap only by their margins, the first
//! stops before the second starts.
//!
//! A recording whose stream fails tries again a few times, in a new file
//! when the first one has something in it.
//!
//! Only the desktop apps record. Phones and tablets build just the parts that
//! keep the records, and `schedule_recording` refuses there, so none starts.

use crate::commands::AppState;
use crate::downloads::manager::{self, DownloadManager};
use mvp_core::cache::store::CacheStore;
use mvp_core::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use mvp_core::downloads::recording::{self, GuideProgram};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::CommandChild;
#[cfg(desktop)]
use {
    crate::keep_awake,
    chrono::NaiveDateTime,
    mvp_core::downloads::ffmpeg::{fold_progress_line, ProgressUpdate},
    mvp_core::downloads::recording::{Action, Outcome, StreamError},
    mvp_core::downloads::redact::{redact_credentials, url_origin},
    mvp_core::models::channel::Channel,
    std::panic::AssertUnwindSafe,
    std::path::Path,
    tauri::async_runtime::Receiver,
    tauri_plugin_shell::process::CommandEvent,
    tauri_plugin_shell::ShellExt,
};

/// The longest the app goes without checking for recordings to start or
/// stop, in seconds.
#[cfg(desktop)]
const CHECK_INTERVAL_SECS: i64 = 30;
/// How long ffmpeg has to close its file after it's asked to stop. After
/// that it's killed.
const STOP_GRACE: Duration = Duration::from_secs(15);
/// How long a recording waits after it stops its provider's downloads or
/// recordings, so the provider sees their connections close first.
#[cfg(desktop)]
const HANDOVER_PAUSE: Duration = Duration::from_secs(3);
/// How long quitting waits for recordings to close their files.
const EXIT_GRACE: Duration = Duration::from_secs(3);
/// How early ffmpeg may reach its length limit, in seconds. The limit counts
/// the stream's own time, and a provider often sends the first seconds of a
/// stream in a burst.
#[cfg(desktop)]
const LENGTH_EARLY_SECS: i64 = 60;

#[cfg(desktop)]
const NO_CHANNEL: &str = "The channel isn't in the playlist anymore.";
const NOTHING_RECORDED: &str = "Nothing was recorded.";
#[cfg(desktop)]
const STREAM_STOPPED: &str = "The stream stopped before the end.";
const APP_CLOSED: &str = "The app closed during the recording.";
#[cfg(desktop)]
const NOT_RUNNING: &str = "The app wasn't open or the computer was asleep at the time.";
#[cfg(desktop)]
const RETRY_NOT_RUNNING: &str =
    "The app wasn't open or the computer was asleep when it was time to try again.";

struct Running {
    child: CommandChild,
    /// Set once the app asks ffmpeg to stop, so its exit counts as the end.
    stopping: bool,
    /// When ffmpeg reaches its length limit, in Unix seconds.
    #[cfg(desktop)]
    limit_at: i64,
}

/// Tauri managed state for the recordings whose ffmpeg is running.
#[derive(Default)]
pub struct Recorder {
    running: Mutex<HashMap<String, Running>>,
    /// One check at a time, so a recording can't start twice.
    #[cfg(desktop)]
    check: Mutex<()>,
    /// How many times each recording has tried again after its stream failed.
    tries: Mutex<HashMap<String, u32>>,
    /// Set to have the checking thread check now.
    wake: Mutex<bool>,
    woken: Condvar,
}

impl Recorder {
    /// A lock that panicked while held still guards a usable map, and every
    /// recording needs it to stop.
    fn running(&self) -> MutexGuard<'_, HashMap<String, Running>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn tries(&self) -> MutexGuard<'_, HashMap<String, u32>> {
        self.tries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Wait for `wait`, or until something calls `wake`.
    #[cfg(desktop)]
    fn sleep(&self, wait: Duration) {
        let woken = self.wake.lock().unwrap_or_else(PoisonError::into_inner);
        let (mut woken, _) = self
            .woken
            .wait_timeout_while(woken, wait, |woken| !*woken)
            .unwrap_or_else(PoisonError::into_inner);
        *woken = false;
    }

    /// Have the checking thread check now.
    fn wake(&self) {
        *self.wake.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.woken.notify_one();
    }
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
/// `end_at`, in Unix seconds, for the guide's `program` when there is one.
pub(crate) fn schedule(
    cache: &CacheStore,
    channel_id: &str,
    start_at: i64,
    end_at: i64,
    program: Option<GuideProgram>,
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
    let rec = recording::new_scheduled(&new_id(), &channel, program, start_at, end_at, now);
    cache.upsert_download(&rec).map_err(|e| e.to_string())?;
    Ok(rec)
}

/// Settle the recordings that were running when the app last quit or
/// crashed. Each keeps what it recorded. One with at least a minute left
/// gets a new recording for the rest, which the first check starts. Call at
/// launch, before the first check. Returns how many it settled.
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
            let next = recording::rest_of(rec, &next_id(), now, now);
            cache.upsert_download(&next).map_err(|e| e.to_string())?;
        }
        settled.push(done.id);
    }
    Ok(settled)
}

/// Keep checking on a thread of its own. Call once, after the first
/// `run_check`, with what it returned.
#[cfg(desktop)]
pub fn start<R: Runtime>(app: &AppHandle<R>, first: Option<i64>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("recordings".into())
        .spawn(move || {
            let mut next_check = first;
            loop {
                let wait = next_check.map_or(CHECK_INTERVAL_SECS, |at| {
                    (at - manager::now_secs()).clamp(1, CHECK_INTERVAL_SECS)
                });
                app.state::<Recorder>()
                    .sleep(Duration::from_secs(wait as u64));
                next_check = run_check(&app);
            }
        });
    if let Err(e) = spawned {
        tracing::warn!("Could not start the recordings check: {e}");
    }
}

/// Check now, as when the user schedules a recording that starts right away.
pub fn check_soon<R: Runtime>(app: &AppHandle<R>) {
    app.state::<Recorder>().wake();
}

/// Run `check` and log what goes wrong. A panic in one check must not end
/// every check after it. Returns when to check next.
#[cfg(desktop)]
pub fn run_check<R: Runtime>(app: &AppHandle<R>) -> Option<i64> {
    match std::panic::catch_unwind(AssertUnwindSafe(|| check(app))) {
        Ok(Ok(next_check)) => next_check,
        Ok(Err(e)) => {
            tracing::warn!("Recordings check failed: {e}");
            None
        }
        Err(_) => {
            tracing::error!("Recordings check panicked");
            None
        }
    }
}

/// Start, extend, stop or miss whatever is due now. Returns when to check
/// next.
#[cfg(desktop)]
fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<i64>, String> {
    if exiting(app) {
        return Ok(None);
    }
    let recorder = app.state::<Recorder>();
    let _one_at_a_time = recorder
        .check
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let (records, providers) = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        (
            cache.list_recordings().map_err(|e| e.to_string())?,
            provider_ids(&cache)?,
        )
    };
    let plan = recording::plan(&records, &providers, manager::now_secs());
    for action in plan.actions {
        match action {
            Action::Start(id) => begin(app, &id),
            Action::Merge { id, into, end_at } => merge(app, &id, &into, end_at),
            Action::Miss(id) => miss(app, &id),
            Action::Stop(id) => finish(app, &id),
        }
    }
    Ok(plan.next_check)
}

#[cfg(desktop)]
fn exiting<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<DownloadManager>()
        .is_some_and(|m| m.exiting.load(Ordering::SeqCst))
}

/// Start recording `id`. One that can't start is marked failed.
#[cfg(desktop)]
fn begin<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Err(e) = try_begin(app, id) {
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
    }
    // When it didn't start, the downloads it put back in the queue go on.
    if let Err(e) = manager::pump(app) {
        tracing::warn!("Failed to start queued downloads: {e}");
    }
}

#[cfg(desktop)]
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
    let Some(claim) = claimed else {
        return Ok(());
    };
    manager::emit_progress(app, id);

    // Free the provider's connection. Its downloads go back in the queue, and
    // a recording that hands over to this one closes its file first.
    for download in &claim.downloads {
        manager::requeue(app, download);
    }
    let handed_over = wait_for_stops(app, &claim.recordings);
    if handed_over || !claim.downloads.is_empty() {
        std::thread::sleep(HANDOVER_PAUSE);
    }

    // The user may have stopped it while it waited. Then it never began.
    let rec = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.get_download(id).map_err(|e| e.to_string())?
    };
    let Some(rec) = rec.filter(|r| r.status == DownloadStatus::Recording) else {
        return Ok(());
    };
    if rec.end_at.is_some_and(|end| end <= manager::now_secs()) {
        with_cache(app, |cache| {
            cache.delete_download(id).map_err(|e| e.to_string())
        });
        manager::emit_removed(app, id);
        return Ok(());
    }
    // A recording that starts as the app quits waits for the next launch.
    if exiting(app) {
        with_cache(app, |cache| unclaim(cache, id));
        return Ok(());
    }

    if let Some(dir) = Path::new(&rec.dest_path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let (rx, child) = app
        .shell()
        .sidecar(super::FFMPEG_SIDECAR)
        .map_err(|e| redact_credentials(&e.to_string()))?
        .args(recording::ffmpeg_args(
            &claim.url,
            &rec.dest_path,
            claim.max_secs,
        ))
        .spawn()
        .map_err(|e| redact_credentials(&e.to_string()))?;
    let pid = child.pid();
    let quitting = {
        let recorder = app.state::<Recorder>();
        let mut running = recorder.running();
        // Quitting sets this before it stops what's running, so a recording
        // added after this check is one it stops.
        if exiting(app) {
            Some(child)
        } else {
            let limit_at = manager::now_secs() + claim.max_secs;
            let run = Running {
                child,
                stopping: false,
                limit_at,
            };
            running.insert(id.to_string(), run);
            None
        }
    };
    if let Some(child) = quitting {
        let _ = child.kill();
        with_cache(app, |cache| unclaim(cache, id));
        return Ok(());
    }
    keep_awake::hold_while_running(pid, keep_awake::Reason::Recording);
    tauri::async_runtime::spawn(watch(app.clone(), id.to_string(), pid, claim.url, rx));

    // A stop that came while ffmpeg started found nothing to stop yet.
    let ended = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.get_download(id).map_err(|e| e.to_string())?
    }
    .is_none_or(|r| {
        r.status != DownloadStatus::Recording
            || r.end_at.is_some_and(|end| end <= manager::now_secs())
    });
    if ended {
        ask_to_stop(app, id);
    }
    Ok(())
}

/// Run `f` on the cache and log what goes wrong.
#[cfg(desktop)]
fn with_cache<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&CacheStore) -> Result<(), String>) {
    let app_state = app.state::<AppState>();
    let done = app_state
        .cache
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|cache| f(&cache));
    if let Err(e) = done {
        tracing::warn!("Could not update a recording: {e}");
    }
}

/// Wait for those of the recordings `ids` that were asked to stop to close
/// their files. Returns whether there were any.
#[cfg(desktop)]
fn wait_for_stops<R: Runtime>(app: &AppHandle<R>, ids: &[String]) -> bool {
    let recorder = app.state::<Recorder>();
    let stopping = || {
        let running = recorder.running();
        ids.iter()
            .any(|id| running.get(id).is_some_and(|r| r.stopping))
    };
    if !stopping() {
        return false;
    }
    // A recording that doesn't stop is killed after STOP_GRACE.
    let deadline = Instant::now() + STOP_GRACE + Duration::from_secs(1);
    while Instant::now() < deadline && stopping() {
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

/// What a recording needs to start.
#[cfg(desktop)]
#[derive(Debug, PartialEq)]
struct Claim {
    /// The stream to record.
    url: String,
    /// The provider's downloads that have to stop first.
    downloads: Vec<String>,
    /// The provider's other running recordings.
    recordings: Vec<String>,
    /// How long ffmpeg may run, in seconds.
    max_secs: i64,
}

/// Mark the scheduled recording `id` as recording, with its live channel and
/// a file named for when its program starts, or for `local_now` once it has.
/// This happens under the cache lock, so a cancel either comes first or finds
/// the recording started. Returns `None` when `id` isn't waiting to start.
#[cfg(desktop)]
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
    let records = cache.list_recordings().map_err(|e| e.to_string())?;
    rec.start_at = Some(now);
    let named_at = local_now + chrono::Duration::seconds(recording::core_start(&rec) - now);
    let dest = manager::unused_dest_path(cache, &recording::dest_path(root, &rec.title, named_at))?;

    rec.status = DownloadStatus::Recording;
    rec.dest_path = dest.to_string_lossy().into_owned();
    rec.source_channel_id = Some(source.id.clone());
    rec.downloaded_bytes = 0;
    rec.error = None;
    cache.upsert_download(&rec).map_err(|e| e.to_string())?;

    let provider = recording::provider_of(&source.id, &providers);
    let same_provider = |channel_id: &str| {
        provider.is_some() && recording::provider_of(channel_id, &providers) == provider
    };
    let downloads = cache
        .list_active_downloads()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|d| d.status == DownloadStatus::Downloading && same_provider(&d.channel_id))
        .map(|d| d.id)
        .collect();
    let recordings = records
        .iter()
        .filter(|r| r.id != rec.id && r.status == DownloadStatus::Recording)
        .filter(|r| r.source_channel_id.as_deref().is_some_and(same_provider))
        .map(|r| r.id.clone())
        .collect();
    Ok(Some(Claim {
        url: source.url,
        downloads,
        recordings,
        max_secs: recording::backstop_secs(&records, &rec, &providers, now),
    }))
}

/// Put the recording `id` back to waiting, as when the app quits while it
/// starts. The next launch starts it again, or misses it.
#[cfg(desktop)]
fn unclaim(cache: &CacheStore, id: &str) -> Result<(), String> {
    let Some(mut rec) = cache.get_download(id).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if rec.status != DownloadStatus::Recording {
        return Ok(());
    }
    if !rec.dest_path.is_empty() {
        let _ = std::fs::remove_file(&rec.dest_path);
    }
    rec.status = DownloadStatus::Scheduled;
    rec.dest_path = String::new();
    rec.downloaded_bytes = 0;
    cache.upsert_download(&rec).map_err(|e| e.to_string())
}

/// The live channel to record. M3U channel ids follow each channel's place
/// in the playlist, so after a refresh the saved one can point at another
/// channel. Then this looks for the channel by name in the same provider.
#[cfg(desktop)]
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

/// How a recording's ffmpeg exited.
#[cfg(desktop)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Exit {
    /// The app asked it to stop.
    Stopped,
    /// It reached its length limit. The limit is past the end, so this
    /// happens when a merge moved the end after ffmpeg started.
    LimitReached,
    /// It stopped by itself, as when the stream failed.
    Failed,
}

/// Follow a recording's ffmpeg until it exits, saving the size of the file
/// as it grows. `url` is the stream, which ffmpeg's errors can name.
#[cfg(desktop)]
async fn watch<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    pid: u32,
    url: String,
    mut rx: Receiver<CommandEvent>,
) {
    // Errors name the stream, and its address can hold the login. Only the
    // provider's address is kept, and the redaction covers other forms.
    let origin = url_origin(&url);
    let mut acc = ProgressUpdate::default();
    let mut last_line = None;
    let mut known_error = None;
    while let Some(event) = rx.recv().await {
        match event {
            // ffmpeg reports every 5 seconds.
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
                if line.is_empty() {
                    continue;
                }
                let line = redact_credentials(&line.replace(url.as_str(), &origin));
                if StreamError::classify(&line).is_some() {
                    known_error = Some(line.clone());
                }
                last_line = Some(line);
            }
            _ => {}
        }
    }

    let run = {
        let recorder = app.state::<Recorder>();
        let mut running = recorder.running();
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
    let exit = match run {
        // With no entry left, the app killed ffmpeg after asking it to stop.
        None => Exit::Stopped,
        Some(run) if run.stopping => Exit::Stopped,
        Some(run) if manager::now_secs() >= run.limit_at - LENGTH_EARLY_SECS => Exit::LimitReached,
        Some(_) => Exit::Failed,
    };
    settle(&app, &id, exit, known_error.or(last_line));
}

/// Finish recording `id` now that its ffmpeg is gone, then let the
/// provider's downloads go on. `detail` is ffmpeg's error.
#[cfg(desktop)]
fn settle<R: Runtime>(app: &AppHandle<R>, id: &str, exit: Exit, detail: Option<String>) {
    let recorder = app.state::<Recorder>();
    let next = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string());
        cache.and_then(|cache| {
            settle_record(
                &cache,
                id,
                exit,
                detail.as_deref(),
                manager::now_secs(),
                &mut recorder.tries(),
                new_id,
            )
        })
    };
    match next {
        Ok(Some(next)) => {
            if next != id {
                manager::emit_progress(app, &next);
            }
            recorder.wake();
        }
        Ok(None) => {}
        Err(e) => tracing::warn!("Could not finish a recording: {e}"),
    }
    manager::emit_progress(app, id);
    if let Err(e) = manager::pump(app) {
        tracing::warn!("Failed to start queued downloads: {e}");
    }
}

/// Finish the record of a recording whose ffmpeg exited, going by `exit` and
/// what's in its file. A recording with an empty file fails, and the file is
/// deleted. When the stream failed, the recording tries again after a while,
/// in a new record when the first one keeps what it got. `tries` counts the
/// tries of each recording. Returns the id of the recording to start next.
#[cfg(desktop)]
fn settle_record(
    cache: &CacheStore,
    id: &str,
    exit: Exit,
    detail: Option<&str>,
    now: i64,
    tries: &mut HashMap<String, u32>,
    next_id: impl FnOnce() -> String,
) -> Result<Option<String>, String> {
    let Some(mut rec) = cache.get_download(id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if rec.status != DownloadStatus::Recording {
        return Ok(None);
    }
    // A stream that ran a good while before it failed gets all its tries.
    let ran = now - rec.start_at.unwrap_or(now);
    let tried = tries
        .remove(id)
        .filter(|_| ran < recording::RETRY_RESET_SECS)
        .unwrap_or(0);
    let retry_at = (exit == Exit::Failed && recording::worth_retrying(detail))
        .then(|| recording::retry_at(&rec, tried, now))
        .flatten();
    let left = rec.end_at.map_or(0, |end| end - now);

    let size = file_size(&rec.dest_path);
    rec.downloaded_bytes = size as i64;
    rec.finished_at = Some(now);
    let mut next = None;
    match recording::outcome(size, exit != Exit::Failed) {
        Outcome::Finished => {
            rec.status = DownloadStatus::Completed;
            rec.error = None;
            // The rest goes on in a new file.
            if exit == Exit::LimitReached && left >= recording::MIN_REST_SECS {
                next = Some(recording::rest_of(&rec, &next_id(), now, now));
                rec.end_at = Some(now);
            }
        }
        Outcome::EndedEarly => {
            let error = recording::failure_message(STREAM_STOPPED, detail);
            if let Some(at) = retry_at {
                let mut rest = recording::rest_of(&rec, &next_id(), at, now);
                rest.error = Some(error.clone());
                tries.insert(rest.id.clone(), tried + 1);
                next = Some(rest);
                rec.end_at = Some(now);
            }
            rec.status = DownloadStatus::Completed;
            rec.error = Some(error);
        }
        Outcome::Failed => {
            let _ = std::fs::remove_file(&rec.dest_path);
            rec.error = Some(recording::failure_message(NOTHING_RECORDED, detail));
            match retry_at {
                Some(at) => {
                    rec.status = DownloadStatus::Scheduled;
                    rec.start_at = Some(at);
                    rec.dest_path = String::new();
                    rec.downloaded_bytes = 0;
                    rec.finished_at = None;
                    tries.insert(rec.id.clone(), tried + 1);
                    cache.upsert_download(&rec).map_err(|e| e.to_string())?;
                    return Ok(Some(rec.id));
                }
                None => rec.status = DownloadStatus::Failed,
            }
        }
    }
    cache.upsert_download(&rec).map_err(|e| e.to_string())?;
    match next {
        Some(next) => {
            cache.upsert_download(&next).map_err(|e| e.to_string())?;
            Ok(Some(next.id))
        }
        None => Ok(None),
    }
}

/// Let the running recording `into` take in `id`, which is due on the same
/// channel, so both end up in one file. Starts `id` on its own when `into`
/// is stopping or has ended.
#[cfg(desktop)]
fn merge<R: Runtime>(app: &AppHandle<R>, id: &str, into: &str, end_at: i64) {
    let stopping = app
        .state::<Recorder>()
        .running()
        .get(into)
        .is_some_and(|r| r.stopping);
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
#[cfg(desktop)]
fn merge_records(cache: &CacheStore, id: &str, into: &str, end_at: i64) -> Result<bool, String> {
    let get = |id: &str| cache.get_download(id).map_err(|e| e.to_string());
    let (Some(mut target), Some(next)) = (get(into)?, get(id)?) else {
        return Ok(false);
    };
    if target.status != DownloadStatus::Recording || next.status != DownloadStatus::Scheduled {
        return Ok(false);
    }
    recording::merge_into(&mut target, &next, end_at);
    cache.upsert_download(&target).map_err(|e| e.to_string())?;
    cache.delete_download(id).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Mark a recording whose window passed before it could start.
#[cfg(desktop)]
fn miss<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let now = manager::now_secs();
    manager::update_record(app, id, |r| mark_missed(r, now));
    manager::emit_progress(app, id);
}

/// Mark `r` missed at `now` if it's still waiting. Only a new try after the
/// stream failed waits with an error, and that error stays below the new
/// first line, since it says why there was a new try at all.
#[cfg(desktop)]
fn mark_missed(r: &mut DownloadRecord, now: i64) {
    if r.status != DownloadStatus::Scheduled {
        return;
    }
    r.status = DownloadStatus::Missed;
    r.error = Some(match r.error.take() {
        Some(earlier) => format!("{RETRY_NOT_RUNNING}\n{earlier}"),
        None => NOT_RUNNING.into(),
    });
    r.finished_at = Some(now);
}

/// Stop the running recording `id`, which reached its end or hands its
/// provider's connection over to the next recording.
#[cfg(desktop)]
fn finish<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let ended = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string());
        cache.and_then(|cache| end_now(&cache, id, manager::now_secs()))
    };
    match ended {
        Ok(Stopped::Ending) => manager::emit_progress(app, id),
        Ok(Stopped::Cancelled) => return manager::emit_removed(app, id),
        Ok(Stopped::Nothing) => return,
        // Stopping ffmpeg matters more than the record.
        Err(e) => tracing::warn!("Could not end a recording: {e}"),
    }
    // A check doesn't run while a recording starts, so with no ffmpeg there's
    // nothing left to wait for.
    if !ask_to_stop(app, id) {
        settle(app, id, Exit::Stopped, None);
    }
}

/// Ask the ffmpeg recording `id` to close its file and exit. It's killed if
/// it's still running after a while. Returns false when no ffmpeg runs for
/// `id`.
pub(crate) fn ask_to_stop<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let pid = {
        let recorder = app.state::<Recorder>();
        let mut running = recorder.running();
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
                let mut running = recorder.running();
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
        Stopped::Cancelled => {
            app.state::<Recorder>().tries().remove(id);
            manager::emit_removed(app, id);
        }
        Stopped::Ending => {
            manager::emit_progress(app, id);
            // With no ffmpeg yet, it's waiting for its provider's connection.
            // It sees the new end time before or just after it starts.
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
    for run in recorder.running().values_mut() {
        run.stopping = true;
        let _ = run.child.write(b"q");
    }
    let deadline = Instant::now() + EXIT_GRACE;
    while Instant::now() < deadline && !recorder.running().is_empty() {
        std::thread::sleep(Duration::from_millis(50));
    }
    for (_, run) in recorder.running().drain() {
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

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use crate::downloads::test_support::{
        self, add_channel, missing_url, process_runs, stalls, video_url, wait_until, DownloadEvent,
        Events,
    };
    use crate::test_support::{poison, TestApp};
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
    /// channels "City News" and "Sports One" and a movie.
    fn cache() -> CacheStore {
        let cache = CacheStore::open_in_memory().unwrap();
        for p in ["xt-1", "xt-2"] {
            cache.upsert_provider(&provider(p)).unwrap();
            cache
                .save_channels(
                    p,
                    &[
                        channel(&format!("{p}-xt-0"), "City News", "live"),
                        channel(&format!("{p}-xt-1"), "Sports One", "live"),
                        channel(&format!("{p}-vod-0"), "Dune (2021)", "movie"),
                    ],
                )
                .unwrap();
        }
        cache
    }

    fn program(title: &str, start: i64, end: i64) -> Option<GuideProgram> {
        Some(GuideProgram {
            title: title.into(),
            start,
            end,
        })
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
        let rec = schedule(&cache, "xt-1-xt-0", 100, 200, program("News", 120, 180), 50).unwrap();
        let saved = get(&cache, &rec.id);
        assert_eq!(saved.status, DownloadStatus::Scheduled);
        assert_eq!(saved.program_title.as_deref(), Some("News"));
        assert_eq!(
            (saved.program_start, saved.program_end),
            (Some(120), Some(180))
        );
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
                recordings: vec![],
                // Until the end, plus five minutes.
                max_secs: 80 + 300,
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
    fn a_claim_lists_the_providers_other_recordings() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let news = schedule(&cache, "xt-1-xt-0", 100, 1_000, None, 50).unwrap();
        let elsewhere = schedule(&cache, "xt-2-xt-1", 100, 1_000, None, 50).unwrap();
        let sports = schedule(&cache, "xt-1-xt-1", 900, 2_000, None, 50).unwrap();
        // One that hasn't started has no connection to give up.
        schedule(&cache, "xt-1-xt-0", 1_500, 2_500, None, 50).unwrap();
        claim(&cache, &news.id, dir.path(), 120, local(20, 0)).unwrap();
        claim(&cache, &elsewhere.id, dir.path(), 120, local(20, 0)).unwrap();

        let claimed = claim(&cache, &sports.id, dir.path(), 950, local(20, 14))
            .unwrap()
            .unwrap();
        assert_eq!(claimed.recordings, vec![news.id]);
    }

    #[test]
    fn names_the_file_for_when_the_program_starts() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        // Two minutes of margin before the program.
        let rec = schedule(&cache, "xt-1-xt-0", 100, 900, program("News", 220, 800), 50).unwrap();
        claim(&cache, &rec.id, dir.path(), 100, local(20, 0)).unwrap();
        assert_eq!(
            Path::new(&get(&cache, &rec.id).dest_path),
            dir.path().join("recordings/City News 2026-10-12 20.02.ts")
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
    fn file_names_that_differ_only_in_case_count_as_taken() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let earlier = schedule(&cache, "xt-1-xt-0", 100, 200, None, 50).unwrap();
        let mut old = get(&cache, &earlier.id);
        old.status = DownloadStatus::Completed;
        old.dest_path = dir
            .path()
            .join("recordings/CITY NEWS 2026-10-12 20.00.ts")
            .to_string_lossy()
            .into_owned();
        put(&cache, &old);
        let rec = schedule(&cache, "xt-1-xt-0", 100, 200, None, 50).unwrap();
        claim(&cache, &rec.id, dir.path(), 120, local(20, 0)).unwrap();
        assert_eq!(
            Path::new(&get(&cache, &rec.id).dest_path),
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
    fn a_recording_that_starts_as_the_app_quits_waits_for_the_next_launch() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let rec = schedule(&cache, "xt-1-xt-0", 100, 200, None, 50).unwrap();
        claim(&cache, &rec.id, dir.path(), 120, local(20, 0)).unwrap();
        let file = get(&cache, &rec.id).dest_path;
        std::fs::create_dir_all(Path::new(&file).parent().unwrap()).unwrap();
        std::fs::write(&file, b"").unwrap();

        unclaim(&cache, &rec.id).unwrap();
        let waiting = get(&cache, &rec.id);
        assert_eq!(waiting.status, DownloadStatus::Scheduled);
        assert!(waiting.dest_path.is_empty());
        assert!(!Path::new(&file).exists());
    }

    #[test]
    fn a_merge_extends_the_running_recording_and_drops_the_next() {
        let cache = cache();
        let first = schedule(&cache, "xt-1-xt-0", 100, 1_000, program("A", 220, 880), 50).unwrap();
        let next = schedule(
            &cache,
            "xt-1-xt-0",
            760,
            2_000,
            program("B", 880, 1_880),
            50,
        )
        .unwrap();
        let mut running = get(&cache, &first.id);
        running.status = DownloadStatus::Recording;
        put(&cache, &running);

        assert!(merge_records(&cache, &next.id, &first.id, 2_000).unwrap());
        let merged = get(&cache, &first.id);
        assert_eq!(merged.end_at, Some(2_000));
        assert_eq!(merged.program_title.as_deref(), Some("A, B"));
        assert_eq!(merged.program_end, Some(1_880));
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

    /// A recording of "City News" from 100 to 1 000 that started at 100 and
    /// is writing `contents` to `file`.
    fn running_with_file(cache: &CacheStore, file: &Path, contents: &[u8]) -> String {
        std::fs::write(file, contents).unwrap();
        let rec = schedule(cache, "xt-1-xt-0", 100, 1_000, None, 50).unwrap();
        let mut running = get(cache, &rec.id);
        running.status = DownloadStatus::Recording;
        running.dest_path = file.to_string_lossy().into_owned();
        put(cache, &running);
        rec.id
    }

    fn settle_at(
        cache: &CacheStore,
        id: &str,
        exit: Exit,
        detail: Option<&str>,
        now: i64,
        tries: &mut HashMap<String, u32>,
    ) -> Option<String> {
        settle_record(cache, id, exit, detail, now, tries, || "rec-next".into()).unwrap()
    }

    #[test]
    fn a_recording_that_was_stopped_is_complete() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let id = running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        let next = settle_at(&cache, &id, Exit::Stopped, None, 900, &mut HashMap::new());
        assert_eq!(next, None);
        let done = get(&cache, &id);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.downloaded_bytes, 5);
        assert_eq!(done.finished_at, Some(900));
        assert_eq!(done.error, None);
    }

    #[test]
    fn a_recording_whose_stream_ended_keeps_what_it_got_and_tries_again() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let id = running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        let mut tries = HashMap::new();
        let detail = "Connection reset by peer";
        let next = settle_at(&cache, &id, Exit::Failed, Some(detail), 200, &mut tries);
        assert_eq!(next.as_deref(), Some("rec-next"));

        let done = get(&cache, &id);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.end_at, Some(200));
        let error = format!("The connection to the provider failed.\n{detail}");
        assert_eq!(done.error.as_deref(), Some(error.as_str()));
        assert!(dir.path().join("a.ts").exists());

        let rest = get(&cache, "rec-next");
        assert_eq!(rest.status, DownloadStatus::Scheduled);
        assert_eq!((rest.start_at, rest.end_at), (Some(230), Some(1_000)));
        assert_eq!(rest.error.as_deref(), Some(error.as_str()));
        assert_eq!(tries.get("rec-next"), Some(&1));
    }

    #[test]
    fn a_recording_whose_login_was_refused_does_not_try_again() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let id = running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        let detail = "Server returned 401 Unauthorized";
        let next = settle_at(
            &cache,
            &id,
            Exit::Failed,
            Some(detail),
            200,
            &mut HashMap::new(),
        );
        assert_eq!(next, None);
        let done = get(&cache, &id);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.end_at, Some(1_000));
        assert!(done
            .error
            .unwrap()
            .starts_with("The provider didn't accept the login."));
    }

    #[test]
    fn a_recording_with_nothing_in_it_waits_to_try_again() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.ts");
        let id = running_with_file(&cache, &file, b"");
        let mut tries = HashMap::new();
        let next = settle_at(&cache, &id, Exit::Failed, None, 200, &mut tries);
        assert_eq!(next.as_deref(), Some(id.as_str()));

        let waiting = get(&cache, &id);
        assert_eq!(waiting.status, DownloadStatus::Scheduled);
        assert_eq!(waiting.start_at, Some(230));
        assert!(waiting.dest_path.is_empty());
        assert_eq!(waiting.error.as_deref(), Some(NOTHING_RECORDED));
        assert!(!file.exists());
        assert_eq!(tries.get(&id), Some(&1));
    }

    #[test]
    fn a_recording_fails_once_it_has_had_its_tries() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.ts");
        let id = running_with_file(&cache, &file, b"");
        let mut tries = HashMap::from([(id.clone(), 3)]);
        // It started at 100, so it ran for two and a half minutes.
        let detail = "Connection reset by peer";
        let next = settle_at(&cache, &id, Exit::Failed, Some(detail), 250, &mut tries);
        assert_eq!(next, None);
        let done = get(&cache, &id);
        assert_eq!(done.status, DownloadStatus::Failed);
        assert_eq!(
            done.error.as_deref(),
            Some(format!("The connection to the provider failed.\n{detail}").as_str())
        );
        assert!(!file.exists());
        assert!(tries.is_empty());
    }

    #[test]
    fn a_stream_that_ran_a_good_while_gets_all_its_tries_again() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let id = running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        let mut tries = HashMap::from([(id.clone(), 3)]);
        // It started at 100.
        let next = settle_at(&cache, &id, Exit::Failed, None, 100 + 300, &mut tries);
        assert_eq!(next.as_deref(), Some("rec-next"));
        assert_eq!(tries.get("rec-next"), Some(&1));
    }

    #[test]
    fn a_recording_stopped_before_it_got_anything_does_not_try_again() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let id = running_with_file(&cache, &dir.path().join("a.ts"), b"");
        let next = settle_at(&cache, &id, Exit::Stopped, None, 200, &mut HashMap::new());
        assert_eq!(next, None);
        assert_eq!(get(&cache, &id).status, DownloadStatus::Failed);
    }

    #[test]
    fn a_recording_that_reached_its_limit_goes_on_in_a_new_file() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let id = running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        let next = settle_at(
            &cache,
            &id,
            Exit::LimitReached,
            None,
            600,
            &mut HashMap::new(),
        );
        assert_eq!(next.as_deref(), Some("rec-next"));
        let done = get(&cache, &id);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!((done.end_at, done.error), (Some(600), None));
        let rest = get(&cache, "rec-next");
        assert_eq!((rest.start_at, rest.end_at), (Some(600), Some(1_000)));

        // With under a minute left, it's done.
        let other = running_with_file(&cache, &dir.path().join("b.ts"), b"video");
        let next = settle_at(
            &cache,
            &other,
            Exit::LimitReached,
            None,
            970,
            &mut HashMap::new(),
        );
        assert_eq!(next, None);
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
        let nearly = running_with_file(&cache, &dir.path().join("c.ts"), b"video");
        let mut nearly_over = get(&cache, &nearly);
        nearly_over.end_at = Some(530);
        put(&cache, &nearly_over);

        let settled = recover_records(&cache, 500, || "rec-rest".to_string()).unwrap();
        assert_eq!(settled.len(), 3);

        let done = get(&cache, &kept);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.downloaded_bytes, 5);
        assert_eq!(done.error.as_deref(), Some(APP_CLOSED));
        let rest = get(&cache, "rec-rest");
        assert_eq!(rest.status, DownloadStatus::Scheduled);
        assert_eq!((rest.start_at, rest.end_at), (Some(500), Some(1_000)));

        // The second one recorded nothing, and its program is over.
        assert_eq!(get(&cache, &empty).status, DownloadStatus::Failed);
        assert!(!empty_file.exists());
        // The third has under a minute left, so there's no rest of it.
        assert_eq!(get(&cache, &nearly).status, DownloadStatus::Completed);
        assert_eq!(cache.list_recordings().unwrap().len(), 4);
    }

    #[test]
    fn a_missed_new_try_keeps_the_reason_for_it() {
        let mut waiting = download("rec", "xt-1-xt-0", DownloadStatus::Scheduled);
        mark_missed(&mut waiting, 500);
        assert_eq!(
            (
                waiting.status,
                waiting.error.as_deref(),
                waiting.finished_at
            ),
            (DownloadStatus::Missed, Some(NOT_RUNNING), Some(500))
        );

        let mut retry = download("rest", "xt-1-xt-0", DownloadStatus::Scheduled);
        retry.error = Some(format!("{STREAM_STOPPED}\nConnection reset by peer"));
        mark_missed(&mut retry, 500);
        assert_eq!(
            retry.error.unwrap(),
            format!("{RETRY_NOT_RUNNING}\n{STREAM_STOPPED}\nConnection reset by peer")
        );

        let mut done = download("done", "xt-1-xt-0", DownloadStatus::Completed);
        mark_missed(&mut done, 500);
        assert_eq!((done.status, done.error), (DownloadStatus::Completed, None));
    }

    /// An app with the live channel "City News", which plays `url`, and a
    /// recording of it from a minute ago to half an hour from now that no
    /// check has started yet. Returns the app and the recording's id.
    fn app_scheduled(url: &str) -> (TestApp, String) {
        let app = TestApp::new();
        // The URL goes in on a line of its own. cargo-mutants deletes the
        // fields of a struct update even in tests, and without this URL
        // ffmpeg would look up the fixture's made-up host.
        let mut live = channel("n1", "City News", "live");
        live.url = url.into();
        add_channel(&app, &live);
        let now = manager::now_secs();
        let rec = {
            let state = app.state();
            let cache = state.cache.lock().unwrap();
            schedule(&cache, "n1", now - 60, now + 1_800, None, now).unwrap()
        };
        (app, rec.id)
    }

    /// An app recording the live channel "City News" since a minute ago, and
    /// the recording's id. The stream never sends anything, and the real
    /// ffmpeg waits 15 seconds for it, longer than a test runs.
    fn app_recording() -> (TestApp, String) {
        let (app, id) = app_scheduled(stalls());
        run_check(&app.handle());
        assert_eq!(download_of(&app, &id).status, DownloadStatus::Recording);
        assert_eq!(stopping(&app, &id), Some(false));
        (app, id)
    }

    fn download_of(app: &TestApp, id: &str) -> DownloadRecord {
        test_support::download(app, id).unwrap()
    }

    /// Whether the app asked the ffmpeg of recording `id` to stop, or None
    /// when none runs.
    fn stopping(app: &TestApp, id: &str) -> Option<bool> {
        let handle = app.handle();
        let recorder = handle.state::<Recorder>();
        let running = recorder.running();
        running.get(id).map(|r| r.stopping)
    }

    #[test]
    fn stopping_a_running_recording_asks_its_ffmpeg_to_stop() {
        let (app, id) = app_recording();
        let before = manager::now_secs();

        manager::stop_one(&app.handle(), &id).unwrap();

        assert_eq!(stopping(&app, &id), Some(true));
        let ending = download_of(&app, &id);
        assert_eq!(ending.status, DownloadStatus::Recording);
        assert!((before..=manager::now_secs()).contains(&ending.end_at.unwrap()));
    }

    #[test]
    fn a_recording_stops_when_its_record_cant_be_read() {
        let (app, id) = app_recording();
        let state = app.state();
        poison(&state.cache);

        assert_eq!(manager::stop_one(&app.handle(), &id), Ok(()));
        assert_eq!(stopping(&app, &id), Some(true));

        state.cache.clear_poison();
        assert_eq!(download_of(&app, &id).status, DownloadStatus::Recording);
    }

    /// Kill process `pid` at once, as when ffmpeg crashes.
    fn kill(pid: u32) {
        let killed = std::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .unwrap();
        assert!(killed.success());
    }

    /// The process id of the ffmpeg recording `id`.
    fn pid_of(app: &TestApp, id: &str) -> u32 {
        let handle = app.handle();
        let recorder = handle.state::<Recorder>();
        let running = recorder.running();
        running[id].child.pid()
    }

    /// The app's recordings other than `id`.
    fn others(app: &TestApp, id: &str) -> Vec<DownloadRecord> {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        let recordings = cache.list_recordings().unwrap();
        recordings.into_iter().filter(|r| r.id != id).collect()
    }

    /// Waits for the app to send a record of recording `id` that's no longer
    /// recording, and returns it.
    fn settled(events: &Events, id: &str) -> DownloadRecord {
        let mut found = None;
        wait_until("the recording settles", || {
            found = events
                .progress(id)
                .into_iter()
                .find(|r| r.status != DownloadStatus::Recording);
            found.is_some()
        });
        found.unwrap()
    }

    #[test]
    fn the_check_thread_sleeps_for_the_time_it_was_given() {
        let recorder = Recorder::default();
        let started = Instant::now();
        recorder.sleep(Duration::from_millis(200));
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[test]
    fn checking_soon_wakes_the_check_thread() {
        let app = TestApp::new();
        let handle = app.handle();
        let waker = handle.clone();
        let woke = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            check_soon(&waker);
        });
        let started = Instant::now();
        handle.state::<Recorder>().sleep(Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_secs(5));
        woke.join().unwrap();

        // A wake counts once, so the next sleep lasts.
        let started = Instant::now();
        handle.state::<Recorder>().sleep(Duration::from_millis(200));
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[test]
    fn the_check_thread_starts_a_recording_when_it_comes_due() {
        let (app, id) = app_scheduled(stalls());
        let started = Instant::now();
        start(&app.handle(), Some(manager::now_secs()));
        // The thread checks a second after it starts, not half a minute
        // later.
        while stopping(&app, &id).is_none() {
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "the check thread didn't start the recording"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(download_of(&app, &id).status, DownloadStatus::Recording);
        // Like the app's own, the thread never ends. It goes on checking
        // this test's app until the test process exits.
    }

    #[test]
    fn launch_counts_the_recordings_it_settled() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        running_with_file(&cache, &dir.path().join("a.ts"), b"video");
        running_with_file(&cache, &dir.path().join("b.ts"), b"video");
        assert_eq!(recover(&cache), Ok(2));
        assert_eq!(recover(&cache), Ok(0));
    }

    #[test]
    fn a_cut_off_recording_finished_when_its_file_was_last_written() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.ts");
        let id = running_with_file(&cache, &file, b"video");
        let written = UNIX_EPOCH + Duration::from_secs(1_000_000_000);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(written)
            .unwrap();

        recover_records(&cache, 2_000_000_000, || "rec-rest".to_string()).unwrap();
        assert_eq!(get(&cache, &id).finished_at, Some(1_000_000_000));
    }

    #[test]
    fn a_recording_that_comes_due_as_the_app_quits_waits_for_the_next_launch() {
        let (app, id) = app_scheduled(stalls());
        app.downloads().exiting.store(true, Ordering::SeqCst);

        begin(&app.handle(), &id);

        let waiting = download_of(&app, &id);
        assert_eq!(waiting.status, DownloadStatus::Scheduled);
        assert!(waiting.dest_path.is_empty());
        assert_eq!(stopping(&app, &id), None);
    }

    #[test]
    fn a_recording_with_no_connection_to_take_over_starts_at_once() {
        let (app, id) = app_scheduled(stalls());
        let started = Instant::now();
        run_check(&app.handle());
        assert!(started.elapsed() < HANDOVER_PAUSE);
        assert_eq!(stopping(&app, &id), Some(false));
    }

    #[test]
    fn a_recording_stopped_while_its_provider_lets_go_never_begins() {
        let app = TestApp::new();
        let handle = app.handle();
        {
            let state = app.state();
            let cache = state.cache.lock().unwrap();
            cache.upsert_provider(&provider("xt-1")).unwrap();
        }
        let live = Channel {
            url: stalls().into(),
            ..channel("xt-1-xt-0", "City News", "live")
        };
        add_channel(&app, &live);
        let movie = test_support::movie("xt-1-vod-0", "Dune (2021)", stalls());
        add_channel(&app, &movie);
        let download = manager::enqueue_record(
            &handle,
            "xt-1-vod-0",
            "Dune (2021)",
            stalls(),
            DownloadKind::Movie,
            None,
            None,
        )
        .unwrap();
        manager::pump(&handle).unwrap();
        assert_eq!(
            download_of(&app, &download).status,
            DownloadStatus::Downloading
        );
        let now = manager::now_secs();
        let rec = {
            let state = app.state();
            let cache = state.cache.lock().unwrap();
            schedule(&cache, "xt-1-xt-0", now - 60, now + 1_800, None, now).unwrap()
        };
        let events = Events::watch(&app);

        // The user stops the recording while it waits for its provider's
        // download to let go.
        let stopper = {
            let handle = handle.clone();
            let rec = rec.id.clone();
            std::thread::spawn(move || {
                wait_until("the check claims the recording", || {
                    let state = handle.state::<AppState>();
                    let cache = state.cache.lock().unwrap();
                    let claimed = cache.get_download(&rec).unwrap().unwrap();
                    claimed.status == DownloadStatus::Recording
                });
                manager::stop_one(&handle, &rec).unwrap();
            })
        };
        let started = Instant::now();
        run_check(&handle);
        stopper.join().unwrap();

        // The download went back in the queue, and the recording waited for
        // the provider to see its connection close.
        assert!(events
            .progress(&download)
            .iter()
            .any(|r| r.status == DownloadStatus::Queued));
        assert!(started.elapsed() >= HANDOVER_PAUSE);
        assert!(test_support::download(&app, &rec.id).is_none());
        assert!(events
            .sent()
            .contains(&DownloadEvent::Removed(rec.id.clone())));
        assert_eq!(stopping(&app, &rec.id), None);
        // The download goes on.
        assert_eq!(
            download_of(&app, &download).status,
            DownloadStatus::Downloading
        );
    }

    #[test]
    fn a_live_stream_that_ends_early_is_tried_again_in_a_new_file() {
        let (app, id) = app_scheduled(&video_url("news"));
        let end = download_of(&app, &id).end_at;
        let events = Events::watch(&app);
        run_check(&app.handle());

        let done = settled(&events, &id);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.error.as_deref(), Some(STREAM_STOPPED));
        assert!(done.downloaded_bytes > 0);
        // The size went out while it recorded.
        assert!(events
            .progress(&id)
            .iter()
            .any(|r| r.status == DownloadStatus::Recording && r.downloaded_bytes > 0));
        assert_eq!(stopping(&app, &id), None);

        let rest = others(&app, &id);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].status, DownloadStatus::Scheduled);
        assert!(rest[0].start_at > done.finished_at);
        assert_eq!(rest[0].end_at, end);
        assert_eq!(events.progress(&rest[0].id), vec![rest[0].clone()]);
    }

    #[test]
    fn a_channel_the_provider_cant_find_fails_without_trying_again() {
        let (app, id) = app_scheduled(&missing_url("news"));
        let events = Events::watch(&app);
        run_check(&app.handle());

        let failed = settled(&events, &id);
        assert_eq!(failed.status, DownloadStatus::Failed);
        let error = failed.error.unwrap();
        assert!(
            error.starts_with("The provider couldn't find the channel.\n"),
            "{error}"
        );
        assert!(error.contains("404"), "{error}");
        assert!(others(&app, &id).is_empty());
    }

    /// The app counts an ffmpeg that stops near the time limit it was given
    /// as done, so that limit has to fall a little after the recording ends.
    #[test]
    fn a_recordings_time_limit_is_a_little_after_it_ends() {
        let (app, id) = app_recording();
        let end_at = download_of(&app, &id).end_at.unwrap();
        let limit_at = app.handle().state::<Recorder>().running()[&id].limit_at;
        assert!(
            limit_at > end_at && limit_at <= end_at + 60 * 60,
            "limit {limit_at}, end {end_at}"
        );
    }

    #[test]
    fn ffmpeg_at_its_length_limit_leaves_the_rest_to_a_new_file() {
        let (app, id) = app_recording();
        let handle = app.handle();
        let rec = download_of(&app, &id);
        let pid = pid_of(&app, &id);
        // A merge moved the end past the limit ffmpeg was given, and ffmpeg
        // got there.
        handle
            .state::<Recorder>()
            .running()
            .get_mut(&id)
            .unwrap()
            .limit_at = manager::now_secs();
        std::fs::write(&rec.dest_path, b"video").unwrap();
        let events = Events::watch(&app);
        kill(pid);

        let done = settled(&events, &id);
        assert_eq!(done.status, DownloadStatus::Completed);
        assert_eq!(done.error, None);
        let rest = others(&app, &id);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].status, DownloadStatus::Scheduled);
        assert_eq!(rest[0].start_at, done.finished_at);
        assert_eq!(rest[0].end_at, rec.end_at);
    }

    #[test]
    fn a_handover_waits_for_the_recordings_asked_to_stop() {
        let (app, id) = app_recording();
        let handle = app.handle();
        let ids = [id.clone()];
        assert!(!wait_for_stops(&handle, &[]));
        // One that wasn't asked to stop has nothing to hand over.
        assert!(!wait_for_stops(&handle, &ids));

        let events = Events::watch(&app);
        assert!(ask_to_stop(&handle, &id));
        // This ffmpeg ignores the request while it waits for the stream, so
        // it's killed a moment later, well inside the grace period.
        let pid = pid_of(&app, &id);
        let killer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            kill(pid);
        });
        let started = Instant::now();
        assert!(wait_for_stops(&handle, &ids));
        assert!(started.elapsed() < STOP_GRACE);
        assert_eq!(stopping(&app, &id), None);
        killer.join().unwrap();

        // It stopped before it recorded anything.
        let done = settled(&events, &id);
        assert_eq!(done.status, DownloadStatus::Failed);
        assert_eq!(done.error.as_deref(), Some(NOTHING_RECORDED));
        assert!(others(&app, &id).is_empty());
    }

    #[test]
    fn quitting_gives_recordings_a_moment_then_leaves_them_for_the_next_launch() {
        let (app, id) = app_recording();
        let pid = pid_of(&app, &id);
        let started = Instant::now();

        stop_all_for_exit(&app.handle());

        assert!(app.downloads().exiting.load(Ordering::SeqCst));
        // This ffmpeg ignores the request to stop, so quitting waits the
        // whole grace period, then kills it.
        assert!(started.elapsed() >= EXIT_GRACE);
        assert_eq!(stopping(&app, &id), None);
        wait_until("the recording's ffmpeg ends", || !process_runs(pid));
        assert_eq!(download_of(&app, &id).status, DownloadStatus::Recording);
    }

    #[test]
    fn quitting_with_nothing_recording_doesnt_wait() {
        let app = TestApp::new();
        let started = Instant::now();
        stop_all_for_exit(&app.handle());
        assert!(app.downloads().exiting.load(Ordering::SeqCst));
        assert!(started.elapsed() < EXIT_GRACE);
    }

    #[test]
    fn a_recording_due_on_a_channel_that_records_extends_it() {
        let (app, id) = app_recording();
        let now = manager::now_secs();
        let next = {
            let state = app.state();
            let cache = state.cache.lock().unwrap();
            schedule(&cache, "n1", now - 10, now + 3_600, None, now).unwrap()
        };
        let events = Events::watch(&app);

        run_check(&app.handle());

        assert_eq!(download_of(&app, &id).end_at, Some(now + 3_600));
        assert!(test_support::download(&app, &next.id).is_none());
        assert!(events.sent().contains(&DownloadEvent::Removed(next.id)));
        let handle = app.handle();
        assert_eq!(handle.state::<Recorder>().running().len(), 1);
    }

    #[test]
    fn a_recording_whose_time_passed_is_missed() {
        let (app, id) = app_scheduled(stalls());
        let now = manager::now_secs();
        manager::update_record(&app.handle(), &id, |r| {
            r.start_at = Some(now - 3_600);
            r.end_at = Some(now - 1_800);
        });
        let events = Events::watch(&app);

        run_check(&app.handle());

        let missed = download_of(&app, &id);
        assert_eq!(missed.status, DownloadStatus::Missed);
        assert_eq!(missed.error.as_deref(), Some(NOT_RUNNING));
        assert_eq!(events.progress(&id), vec![missed]);
    }

    #[test]
    fn a_recording_at_its_end_asks_its_ffmpeg_to_stop() {
        let (app, id) = app_recording();
        let now = manager::now_secs();
        manager::update_record(&app.handle(), &id, |r| r.end_at = Some(now - 1));
        let events = Events::watch(&app);

        run_check(&app.handle());

        assert_eq!(stopping(&app, &id), Some(true));
        // It stays recording until ffmpeg closes the file.
        let ending = download_of(&app, &id);
        assert_eq!(ending.status, DownloadStatus::Recording);
        assert_eq!(events.progress(&id), vec![ending]);
    }
}
