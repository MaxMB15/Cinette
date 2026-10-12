// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Deletes finished downloads that are past the "Delete downloads after"
//! setting. Checks an hour after launch, then every hour, and whenever the
//! setting changes.

use crate::commands::AppState;
use crate::downloads::manager::{self, DownloadManager, MissingFile};
use mvp_core::downloads::retention;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_mpv::MpvState;

#[cfg(desktop)]
const CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Start the hourly check on its own thread. Call once, after the download
/// settings are restored. Only the desktop apps download.
#[cfg(desktop)]
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    use std::panic::AssertUnwindSafe;

    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("download-retention".into())
        .spawn(move || loop {
            // The first check waits an hour. Downloads that came due while
            // the app was closed show "Deletes soon" until then, so there's
            // time to keep one or play it, which starts its count over.
            std::thread::sleep(CHECK_INTERVAL);
            // A panic in one check, such as from a poisoned lock, must not
            // end every check after it.
            match std::panic::catch_unwind(AssertUnwindSafe(|| sweep(&app))) {
                Ok(Ok(n)) if n > 0 => {
                    tracing::info!("Deleted {n} download(s) past the retention setting")
                }
                Ok(Err(e)) => tracing::warn!("Retention check failed: {e}"),
                Err(_) => tracing::error!("Retention check panicked"),
                _ => {}
            }
        });
    if let Err(e) = spawned {
        tracing::warn!("Could not start the retention check: {e}");
    }
}

/// Delete every download that's due under the current setting. Returns how
/// many were deleted. A download that can't be deleted is logged and skipped.
pub fn sweep<R: Runtime>(app: &AppHandle<R>) -> Result<usize, String> {
    let days = app.state::<DownloadManager>().retention_days();
    if days.is_none() {
        return Ok(0);
    }
    // Read before taking the cache lock, so the two locks are never held together.
    let playing = playing_file(app);
    let deleted = manager::delete_downloads(app, MissingFile::KeepWithoutFolder, |cache| {
        let records = cache.list_downloads().map_err(|e| e.to_string())?;
        let due = retention::due(&records, days, manager::now_secs(), playing.as_deref());
        Ok(due.into_iter().cloned().collect())
    })?;
    for e in &deleted.errors {
        tracing::warn!("Retention could not delete a download: {e}");
    }
    Ok(deleted.removed.len())
}

/// How many downloads a retention of `days` would delete now, so Settings can
/// ask before saving a shorter one.
pub fn count_due<R: Runtime>(app: &AppHandle<R>, days: Option<u32>) -> Result<usize, String> {
    if days.is_none() {
        return Ok(0);
    }
    let playing = playing_file(app);
    let records = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.list_downloads().map_err(|e| e.to_string())?
    };
    Ok(retention::due(&records, days, manager::now_secs(), playing.as_deref()).len())
}

/// The file the player has open. Retention leaves it alone, so a long film
/// isn't deleted while it's being watched.
fn playing_file<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.try_state::<MpvState>()
        .and_then(|mpv| mpv.get_state().current_url)
}
