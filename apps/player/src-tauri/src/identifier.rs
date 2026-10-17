// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Moves what the app saved under its identifier before 0.8.0.
//!
//! Tauri names the app's data, config and cache folders after the
//! identifier. On macOS, WebKit names the folder that holds the page's local
//! storage, such as each provider's settings and the player's preferences,
//! after it too. So when the identifier changed from `com.maxvideoplayer.app`
//! to `app.cinette`, each of those folders has to move to its new name, or
//! the app would start as if it had never run.

use mvp_core::cache::store::CacheStore;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

/// The identifier before 0.8.0.
pub(crate) const OLD_IDENTIFIER: &str = "com.maxvideoplayer.app";

/// The folders that hold a folder named after the identifier. Some of them
/// are the same folder on some systems, such as the data and config folders
/// on macOS.
pub(crate) fn parent_folders() -> Vec<PathBuf> {
    // Linux's WebKit names its folders after the program, not the
    // identifier, so only macOS has one to move.
    let webkit = if cfg!(target_os = "macos") {
        dirs::home_dir().map(|home| home.join("Library").join("WebKit"))
    } else {
        None
    };
    [
        dirs::data_dir(),
        dirs::data_local_dir(),
        dirs::config_dir(),
        dirs::cache_dir(),
        webkit,
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Renames the folder `old` in each of `parents` to `new`. A folder stays
/// where it is when something already has its new name, so nothing is
/// overwritten. Run it before the app is built, since Tauri opens the
/// window, and with it WebKit's storage, before the app's setup runs.
pub(crate) fn move_folders(parents: &[PathBuf], old: &str, new: &str) {
    for parent in parents {
        let (from, to) = (parent.join(old), parent.join(new));
        if !from.is_dir() || to.symlink_metadata().is_ok() {
            continue;
        }
        match std::fs::rename(&from, &to) {
            Ok(()) => tracing::info!("Moved {} to {}", from.display(), to.display()),
            Err(e) => tracing::warn!("Could not move {} to {}: {e}", from.display(), to.display()),
        }
    }
}

/// Points the saved paths that led into the old data folder at `app_dir`,
/// the data folder it moved to. Downloads go inside the data folder unless
/// the user picked another one, so their paths name it, and so can a
/// download folder picked inside it. Does nothing while the old folder is
/// still there, since then it didn't move.
pub(crate) fn update_moved_paths<R: Runtime>(
    app: &AppHandle<R>,
    cache: &CacheStore,
    app_dir: &Path,
) {
    let old_dir = app_dir.with_file_name(OLD_IDENTIFIER);
    if old_dir.symlink_metadata().is_ok() {
        return;
    }
    match cache.move_download_paths(&old_dir, app_dir) {
        Ok(n) if n > 0 => {
            tracing::info!("Moved the paths of {n} download(s) to the new data folder")
        }
        Err(e) => tracing::warn!("Could not move the download paths to the new data folder: {e}"),
        _ => {}
    }
    if let Err(e) = crate::downloads::manager::move_saved_folder(app, &old_dir, app_dir) {
        tracing::warn!("Could not move the download folder setting to the new data folder: {e}");
    }
}

#[cfg(test)]
mod tests;
