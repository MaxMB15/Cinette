// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Google Cast from this computer. For now, the receivers on the local
//! network: one `_googlecast._tcp` browse runs from the first time the
//! frontend asks for them until the app quits, and each change is sent to
//! the frontend as `cast://receivers`.

use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

pub mod receivers;

// The tests use discovery's events, which only desktop builds have.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests;

use receivers::{CastReceiver, Registry};

/// The event that carries the whole list after each change.
pub const RECEIVERS_EVENT: &str = "cast://receivers";

/// The app's receivers, managed by Tauri.
pub struct CastReceivers {
    registry: Mutex<Registry>,
    /// Whether to browse at all. Tests don't, since a browse sends queries
    /// on the real network.
    browse: bool,
    browsing: Mutex<bool>,
}

impl CastReceivers {
    pub fn new(browse: bool) -> Self {
        Self {
            registry: Mutex::default(),
            browse,
            browsing: Mutex::new(false),
        }
    }

    pub fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Changes the registry with `change`, and tells the frontend when the list
/// changed.
pub fn update<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut Registry) -> bool) {
    let state = app.state::<CastReceivers>();
    let mut registry = state.registry();
    if change(&mut registry) {
        let _ = app.emit(RECEIVERS_EVENT, registry.list());
    }
}

/// Starts the browse once. A browse that fails to start is tried again the
/// next time.
fn start_browsing<R: Runtime>(app: &AppHandle<R>, state: &CastReceivers) {
    let mut browsing = state.browsing.lock().unwrap_or_else(|p| p.into_inner());
    if !state.browse || *browsing {
        return;
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    match crate::discovery::browse(receivers::SERVICE_TYPE) {
        Ok(mut browser) => {
            *browsing = true;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = browser.next().await {
                    update(&app, |registry| registry.apply(event));
                }
                *app.state::<CastReceivers>()
                    .browsing
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = false;
            });
        }
        Err(e) => tracing::warn!("Couldn't look for Cast receivers: {e}"),
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = app;
}

/// The receivers found so far. The first call starts looking.
#[tauri::command]
pub fn get_cast_receivers<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CastReceivers>,
) -> Vec<CastReceiver> {
    start_browsing(&app, &state);
    state.registry().list()
}

/// Keeps `ids` listed, as unavailable, if they go away: the active
/// destination and the rows an open picker shows. Each call replaces the
/// last.
#[tauri::command]
pub fn hold_cast_receivers<R: Runtime>(app: AppHandle<R>, ids: Vec<String>) {
    update(&app, |registry| registry.hold(ids));
}
