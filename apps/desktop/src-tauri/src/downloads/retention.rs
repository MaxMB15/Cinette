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
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("download-retention".into())
        .spawn(move || loop {
            // The first check waits an hour. Downloads that came due while
            // the app was closed show "Deletes soon" until then, so there's
            // time to keep one or play it, which starts its count over.
            std::thread::sleep(CHECK_INTERVAL);
            check(&app);
        });
    if let Err(e) = spawned {
        tracing::warn!("Could not start the retention check: {e}");
    }
}

/// One of the hourly checks, which logs what it did rather than returning it.
#[cfg(desktop)]
fn check<R: Runtime>(app: &AppHandle<R>) {
    use std::panic::AssertUnwindSafe;

    // A panic in one check, such as from a poisoned lock, must not end every
    // check after it.
    match std::panic::catch_unwind(AssertUnwindSafe(|| sweep(app))) {
        Ok(Ok(n)) if n > 0 => {
            tracing::info!("Deleted {n} download(s) past the retention setting")
        }
        Ok(Err(e)) => tracing::warn!("Retention check failed: {e}"),
        Err(_) => tracing::error!("Retention check panicked"),
        _ => {}
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

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use crate::downloads::test_support::{add_download, download, finished};
    use crate::test_support::{poison, TestApp};
    use std::path::PathBuf;

    /// An app that deletes downloads after 30 days, with one finished long
    /// ago. Returns the app and the download's file.
    fn app_with_a_due_download() -> (TestApp, PathBuf) {
        let app = TestApp::new();
        app.downloads().set_retention_days(Some(30));
        let dir = app.downloads_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Dune (2021).mkv");
        std::fs::write(&file, b"video").unwrap();
        add_download(&app, &finished("a", &file));
        (app, file)
    }

    #[test]
    fn a_check_deletes_what_is_due() {
        let (app, file) = app_with_a_due_download();
        check(&app.handle());
        assert!(download(&app, "a").is_none());
        assert!(!file.exists());
    }

    #[test]
    fn a_check_with_nothing_due_deletes_nothing() {
        let (app, file) = app_with_a_due_download();
        app.downloads().set_retention_days(None);
        check(&app.handle());
        assert_eq!(download(&app, "a"), Some(finished("a", &file)));
        assert!(file.exists());
    }

    #[test]
    fn a_check_that_fails_leaves_the_downloads_for_the_next() {
        let (app, file) = app_with_a_due_download();
        let state = app.state();
        poison(&state.cache);
        check(&app.handle());
        state.cache.clear_poison();
        assert!(download(&app, "a").is_some() && file.exists());

        check(&app.handle());
        assert!(download(&app, "a").is_none());
    }

    #[test]
    fn a_check_that_panics_doesnt_stop_the_next() {
        let (app, file) = app_with_a_due_download();
        let manager = app.downloads();
        poison(&manager.retention_days);
        check(&app.handle());
        manager.retention_days.clear_poison();
        assert!(download(&app, "a").is_some() && file.exists());

        check(&app.handle());
        assert!(download(&app, "a").is_none());
    }

    #[test]
    fn the_first_check_waits_so_a_due_download_can_still_be_kept() {
        let (app, file) = app_with_a_due_download();
        start(&app.handle());
        assert!(download(&app, "a").is_some() && file.exists());
    }
}
