// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Google Cast from this computer.
//!
//! - The receivers on the local network: one `_googlecast._tcp` browse runs
//!   from the first time the frontend asks for them until the app quits,
//!   and changes are sent to the frontend as `cast://receivers`, at most one
//!   list every [`ANNOUNCE_GAP`].
//! - Casting to one of them ([`playback`]), over TLS ([`tls`]) through the
//!   session loop ([`link`]). macOS and Linux only for now.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime};

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod link;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod playback;
pub mod receivers;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod tls;

// The tests use discovery's events, which only desktop builds have.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod fake_receiver;
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod link_tests;
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod playback_tests;
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests;
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tls_tests;

use receivers::{ReceiverList, Registry};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::discovery::Event;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio::sync::mpsc;

/// The event that carries the whole list after a change, as a
/// [`ReceiverList`].
pub const RECEIVERS_EVENT: &str = "cast://receivers";

/// The shortest time between two lists sent to the frontend. Changes in
/// between go out together in the next one.
pub const ANNOUNCE_GAP: Duration = Duration::from_millis(200);

/// Starts a browse and gives what it finds, for as long as it runs. Tests
/// pass their own, since a real browse sends queries on the network.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub type Browse = Box<dyn Fn() -> Result<mpsc::UnboundedReceiver<Event>, String> + Send + Sync>;

/// The app's receivers, managed by Tauri.
pub struct CastReceivers {
    registry: Mutex<Registry>,
    /// When the last list went out, and whether a later one is due.
    announced: Mutex<(Option<Instant>, bool)>,
    /// A browse that can't start says so once.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    warned: AtomicBool,
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
            announced: Mutex::new((None, false)),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            warned: AtomicBool::new(false),
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
    let changed = change(&mut app.state::<CastReceivers>().registry());
    if changed {
        announce(app);
    }
}

/// Whether macOS refuses this app local network access now.
fn local_network_denied() -> bool {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    return crate::discovery::local_network_denied();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    false
}

/// The list as it is now.
fn snapshot<R: Runtime>(app: &AppHandle<R>) -> ReceiverList {
    let denied = local_network_denied();
    app.state::<CastReceivers>().registry().snapshot(denied)
}

/// Sends the list now, or once [`ANNOUNCE_GAP`] has passed since the last
/// one. The list is read when it goes, so it's the newest.
fn announce<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<CastReceivers>();
    let mut announced = state.announced.lock().unwrap_or_else(|p| p.into_inner());
    let (last, due) = *announced;
    if due {
        return;
    }
    let now = Instant::now();
    let wait = last.map_or(Duration::ZERO, |last| {
        ANNOUNCE_GAP.saturating_sub(now.duration_since(last))
    });
    if wait.is_zero() {
        *announced = (Some(now), false);
        drop(announced);
        // Built and sent outside the registry's lock.
        let _ = app.emit(RECEIVERS_EVENT, snapshot(app));
        return;
    }
    *announced = (last, true);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(wait).await;
        let state = app.state::<CastReceivers>();
        *state.announced.lock().unwrap_or_else(|p| p.into_inner()) = (Some(Instant::now()), false);
        let _ = app.emit(RECEIVERS_EVENT, snapshot(&app));
    });
}

/// A connection to `id` failed. It shows as unavailable for
/// [`receivers::UNREACHABLE_FOR`], after which it can be tried again.
#[cfg(any(target_os = "linux", target_os = "macos"))]
// The Cast destination uses it from step 6.
#[cfg_attr(not(test), allow(dead_code))]
pub fn mark_unreachable<R: Runtime>(app: &AppHandle<R>, id: &str) {
    update(app, |registry| registry.unreachable(id, Instant::now()));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(receivers::UNREACHABLE_FOR).await;
        update(&app, |registry| registry.expire(Instant::now()));
    });
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
                // What it found can't be counted on now.
                update(&app, Registry::ended);
                *app.state::<CastReceivers>().browsing() = false;
            });
        }
        Err(e) => {
            if !state.warned.swap(true, Ordering::Relaxed) {
                tracing::warn!("Couldn't look for Cast receivers: {e}");
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn start_browsing<R: Runtime>(_: &AppHandle<R>, _: &CastReceivers) {}

/// The receivers found so far. The first call starts looking. It's async so
/// that starting a browse doesn't hold the main thread.
#[tauri::command]
pub async fn get_cast_receivers<R: Runtime>(app: AppHandle<R>) -> ReceiverList {
    start_browsing(&app, &app.state::<CastReceivers>());
    snapshot(&app)
}

/// Keeps `ids` listed, as unavailable, if they go away: the active
/// destination and the rows an open picker shows. Each call replaces the
/// last.
#[tauri::command]
pub fn hold_cast_receivers<R: Runtime>(app: AppHandle<R>, ids: Vec<String>) {
    update(&app, |registry| registry.hold(ids));
}

/// Plays `channel` on the receiver `receiverId`, the way `route` says: the
/// route the frontend's `chooseRoute` gave, with the place of its URL.
#[tauri::command]
pub async fn cast_load<R: Runtime>(
    app: AppHandle<R>,
    receiver_id: String,
    channel: mvp_core::models::channel::Channel,
    route: serde_json::Value,
    start_at: Option<f64>,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let route = serde_json::from_value(route).map_err(|e| e.to_string())?;
        playback::load(&app, &receiver_id, &channel, route, start_at).await
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, receiver_id, channel, route, start_at);
        Err(UNSUPPORTED.into())
    }
}

/// Play, pause, seek or set the volume on the receiver being cast to.
#[tauri::command]
pub fn cast_control<R: Runtime>(
    app: AppHandle<R>,
    receiver_id: String,
    action: serde_json::Value,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let action = serde_json::from_value(action).map_err(|e| e.to_string())?;
        playback::control(&app.state::<playback::CastPlayback>(), &receiver_id, action)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, receiver_id, action);
        Err(UNSUPPORTED.into())
    }
}

/// Ends the cast to `receiverId`. The receiver goes back to what it showed.
#[tauri::command]
pub fn cast_stop<R: Runtime>(app: AppHandle<R>, receiver_id: String) {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    playback::stop(&app.state::<playback::CastPlayback>(), &receiver_id);
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = (app, receiver_id);
}

/// Has the cast let go of the provider's stream and keeps it, for a switch
/// to another item on an account that allows one connection. Resolves once
/// the converter, if any, has stopped.
#[tauri::command]
pub async fn cast_release<R: Runtime>(
    app: AppHandle<R>,
    receiver_id: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        playback::release(&app.state::<playback::CastPlayback>(), &receiver_id).await
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, receiver_id);
        Err(UNSUPPORTED.into())
    }
}

/// What the commands say where casting isn't built yet.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const UNSUPPORTED: &str = "unsupported";

/// Whether a VPN looks to hold the default route, for the pickers' hint
/// when no receiver is found or one can't be reached. Phones and tablets
/// say false until they check.
#[tauri::command]
pub fn get_vpn_active() -> bool {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    return crate::vpn::vpn_active();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    false
}
