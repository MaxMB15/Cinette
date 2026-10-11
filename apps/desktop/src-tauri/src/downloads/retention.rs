// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Deletes finished downloads that are past the "Delete downloads after"
//! setting. Checks at launch, then every hour, and whenever the setting changes.

use crate::commands::AppState;
use crate::downloads::manager::{self, DownloadManager};
use mvp_core::downloads::retention;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_mpv::MpvState;

const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Start the hourly check on its own thread. Call once, after the download
/// settings are restored.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("download-retention".into())
        .spawn(move || loop {
            match sweep(&app) {
                Ok(n) if n > 0 => {
                    tracing::info!("Deleted {n} download(s) past the retention setting")
                }
                Err(e) => tracing::warn!("Retention check failed: {e}"),
                _ => {}
            }
            std::thread::sleep(CHECK_INTERVAL);
        });
    if let Err(e) = spawned {
        tracing::warn!("Could not start the retention check: {e}");
    }
}

/// Delete every download that's due under the current setting. Returns how
/// many were deleted.
pub fn sweep<R: Runtime>(app: &AppHandle<R>) -> Result<usize, String> {
    let days = app.state::<DownloadManager>().retention_days();
    let ids = due_ids(app, days)?;
    for id in &ids {
        manager::remove(app, id)?;
    }
    Ok(ids.len())
}

/// The downloads a retention of `days` makes due now. The file the player has
/// open is left out, so a long film isn't deleted while it's being watched.
pub fn due_ids<R: Runtime>(app: &AppHandle<R>, days: Option<u32>) -> Result<Vec<String>, String> {
    if days.is_none() {
        return Ok(Vec::new());
    }
    let records = {
        let app_state = app.state::<AppState>();
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache.list_downloads().map_err(|e| e.to_string())?
    };
    let playing = app
        .try_state::<MpvState>()
        .and_then(|mpv| mpv.get_state().current_url);
    Ok(
        retention::due(&records, days, manager::now_secs(), playing.as_deref())
            .into_iter()
            .map(|r| r.id.clone())
            .collect(),
    )
}
