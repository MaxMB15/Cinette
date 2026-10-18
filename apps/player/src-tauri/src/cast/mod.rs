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

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::discovery::Event;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio::sync::mpsc;

/// The event that carries the whole list after each change.
pub const RECEIVERS_EVENT: &str = "cast://receivers";

/// Starts a browse and gives what it finds, for as long as it runs. Tests
/// pass their own, since a real browse sends queries on the network.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub type Browse = Box<dyn Fn() -> Result<mpsc::UnboundedReceiver<Event>, String> + Send + Sync>;

/// The app's receivers, managed by Tauri.
pub struct CastReceivers {
    registry: Mutex<Registry>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    browse: Mutex<Option<Browse>>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    browsing: Mutex<bool>,
}

impl CastReceivers {
    /// The app's own, which browse the local network where the platform can.
    pub fn on_network() -> Self {
        let receivers = Self::idle();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        receivers.set_browse(Box::new(browse_network));
        receivers
    }

    /// Receivers that nothing looks for until a browse is set, as in tests.
    pub fn idle() -> Self {
        Self {
            registry: Mutex::default(),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            browse: Mutex::new(None),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            browsing: Mutex::new(false),
        }
    }

    /// Browses with `browse` from now on.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn set_browse(&self, browse: Browse) {
        *self.browse.lock().unwrap_or_else(|p| p.into_inner()) = Some(browse);
    }

    pub fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn browsing(&self) -> MutexGuard<'_, bool> {
        self.browsing.lock().unwrap_or_else(|p| p.into_inner())
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

/// Browses `_googlecast._tcp` on the local network.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn browse_network() -> Result<mpsc::UnboundedReceiver<Event>, String> {
    let mut browser =
        crate::discovery::browse(receivers::SERVICE_TYPE).map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = browser.next().await {
            if tx.send(event).is_err() {
                return;
            }
        }
    });
    Ok(rx)
}

/// Starts the browse unless it runs. One that fails to start, or stops, is
/// started again the next time.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn start_browsing<R: Runtime>(app: &AppHandle<R>, state: &CastReceivers) {
    let browse = state.browse.lock().unwrap_or_else(|p| p.into_inner());
    let Some(browse) = browse.as_ref() else {
        return;
    };
    let mut browsing = state.browsing();
    if *browsing {
        return;
    }
    match browse() {
        Ok(mut events) => {
            *browsing = true;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    update(&app, |registry| registry.apply(event));
                }
                *app.state::<CastReceivers>().browsing() = false;
            });
        }
        Err(e) => tracing::warn!("Couldn't look for Cast receivers: {e}"),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn start_browsing<R: Runtime>(_: &AppHandle<R>, _: &CastReceivers) {}

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
