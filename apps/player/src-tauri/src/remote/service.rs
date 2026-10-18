// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Starts the target when the app starts, and connects it to Tauri: events
//! for the webview, the cache for catalog answers, and DNS-SD.

use super::target::{self, CatalogPage, TargetHandle, TargetHost};
use super::{identity, SETTINGS_KEY, SETTINGS_STORE_FILE};
use crate::commands::AppState;
use crate::discovery::{self, Advertisement, Registration};
use mvp_core::models::channel::Channel;
use mvp_core::remote::catalog::CatalogQuery;
use mvp_core::remote::consent::RequestId;
use mvp_core::remote::identity::{DeviceId, DeviceKey};
use mvp_core::remote::message::{Command, DeviceType, ErrorCode};
use mvp_core::remote::settings::RemoteSettings;
use mvp_core::remote::target::{ConsentPrompt, SessionInfo};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_store::StoreExt;

/// This device's type, as other devices see it.
#[cfg(target_os = "macos")]
pub const DEVICE_TYPE: DeviceType = DeviceType::Mac;
#[cfg(target_os = "linux")]
pub const DEVICE_TYPE: DeviceType = DeviceType::LinuxPc;

/// The running target, as Tauri managed state.
pub struct RemoteService {
    pub(crate) handle: TargetHandle,
    key_dir: PathBuf,
    state: Mutex<Saved>,
    resetting: Mutex<()>,
}

struct Saved {
    settings: RemoteSettings,
    device_id: DeviceId,
}

/// Locks a mutex, taking it over if a thread panicked holding it. The
/// values inside are whole after any single assignment.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl RemoteService {
    pub fn settings(&self) -> RemoteSettings {
        lock(&self.state).settings.clone()
    }

    pub fn device_id(&self) -> DeviceId {
        lock(&self.state).device_id.clone()
    }

    /// Saves the settings and hands them to the target.
    pub fn set_settings<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: RemoteSettings,
    ) -> Result<(), String> {
        let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
        store.set(
            SETTINGS_KEY,
            serde_json::to_value(&settings).map_err(|e| e.to_string())?,
        );
        store.save().map_err(|e| e.to_string())?;
        lock(&self.state).settings = settings.clone();
        self.handle.update_settings(settings);
        Ok(())
    }

    /// Makes and saves a new key, so a new device id. Every session ends.
    pub fn reset_identity(&self) -> Result<DeviceId, String> {
        // One reset at a time, so the saved key and the running one match.
        let _one = lock(&self.resetting);
        let key = DeviceKey::generate();
        identity::save(&self.key_dir, &key).map_err(|e| e.to_string())?;
        let id = key.device_id();
        lock(&self.state).device_id = id.clone();
        self.handle.reset_identity(key);
        tracing::info!("[remote] device identity reset; new id {id}");
        Ok(id)
    }
}

/// What `remote://consent` carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentEvent {
    pub request: RequestId,
    pub device_id: String,
    pub name: String,
    pub device_type: DeviceType,
    pub code: String,
    pub expires_in_ms: u64,
}

/// One controller, as `remote://sessions` lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub session_id: String,
    pub device_id: String,
    pub name: String,
    pub device_type: DeviceType,
    pub connected: bool,
}

impl From<&SessionInfo> for SessionEvent {
    fn from(s: &SessionInfo) -> Self {
        Self {
            session_id: s.session_id.clone(),
            device_id: s.device_id.to_string(),
            name: s.name.clone(),
            device_type: s.device_type,
            connected: s.connected,
        }
    }
}

/// What `remote://command` carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEvent<'a> {
    pub token: u64,
    pub command: &'a Command,
    /// For a load of an episode, the episode: the player's channel list has
    /// no episodes to find it in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<&'a Channel>,
}

/// How many series' episodes the target keeps for loads, newest last.
const REMEMBERED_SERIES: usize = 4;
/// How long a series' episodes are answered from what was loaded before
/// the provider is asked again.
const FRESH_FOR: Duration = Duration::from_secs(60);
/// The shortest time between two consent requests that raise the window.
const RAISE_EVERY: Duration = Duration::from_secs(30);

/// Puts a record on the network, or doesn't.
type Advertiser = Box<dyn Fn(&Registration) -> Option<Advertisement> + Send + Sync>;

struct TauriHost<R: Runtime> {
    app: AppHandle<R>,
    advertiser: Advertiser,
    advertisement: Mutex<Option<Advertisement>>,
    /// The episodes of the series controllers opened last, by series id,
    /// with when they were loaded.
    episodes: Mutex<VecDeque<Remembered>>,
    /// When a consent request last brought the window up.
    raised: Mutex<Option<Instant>>,
}

struct Remembered {
    series_id: String,
    loaded: Instant,
    episodes: Vec<Channel>,
}

impl<R: Runtime> TauriHost<R> {
    /// The episodes of `series_id` if they were loaded in the last
    /// [`FRESH_FOR`]. They count as the newest again.
    fn fresh(&self, series_id: &str) -> Option<Vec<Channel>> {
        let mut remembered = lock(&self.episodes);
        let at = remembered
            .iter()
            // mutants: skip BinaryOperator: < and <= differ only at one instant of a clock that never stops.
            .position(|r| r.series_id == series_id && r.loaded.elapsed() < FRESH_FOR)?;
        let found = remembered.remove(at)?;
        let episodes = found.episodes.clone();
        remembered.push_back(found);
        Some(episodes)
    }

    /// Keeps episodes just loaded.
    fn remember(&self, series_id: String, episodes: Vec<Channel>) {
        let mut remembered = lock(&self.episodes);
        remembered.retain(|r| r.series_id != series_id);
        remembered.push_back(Remembered {
            series_id,
            loaded: Instant::now(),
            episodes,
        });
        if remembered.len() > REMEMBERED_SERIES {
            remembered.pop_front();
        }
    }
}

impl<R: Runtime> TargetHost for TauriHost<R> {
    fn show_consent(&self, prompt: &ConsentPrompt) {
        let event = ConsentEvent {
            request: prompt.request,
            device_id: prompt.device_id.to_string(),
            name: prompt.name.clone(),
            device_type: prompt.device_type,
            code: prompt.code.clone(),
            expires_in_ms: prompt
                .expires_at
                .saturating_duration_since(super::clock::now())
                .as_millis() as u64,
        };
        let _ = self.app.emit("remote://consent", event);
        // A dialog behind other windows would time out unseen. Requests
        // can come again and again, so the window comes up only now and then.
        let mut raised = lock(&self.raised);
        let now = Instant::now();
        if may_raise(*raised, now) {
            *raised = Some(now);
            crate::show_main_window(&self.app);
        }
    }

    fn hide_consent(&self, request: RequestId) {
        let _ = self.app.emit(
            "remote://consent-hidden",
            serde_json::json!({ "request": request }),
        );
    }

    fn sessions_changed(&self, sessions: &[SessionInfo]) {
        let list: Vec<SessionEvent> = sessions.iter().map(SessionEvent::from).collect();
        let _ = self.app.emit("remote://sessions", list);
    }

    fn apply(&self, token: u64, command: &Command) {
        let remembered = lock(&self.episodes);
        let channel = match command {
            Command::Load { item_id, .. } => remembered
                .iter()
                .rev()
                .flat_map(|r| &r.episodes)
                .find(|episode| episode.id == *item_id),
            _ => None,
        };
        let event = CommandEvent {
            token,
            command,
            channel,
        };
        let _ = self.app.emit("remote://command", event);
    }

    fn catalog(&self, query: CatalogQuery) -> CatalogPage {
        let state = self.app.state::<AppState>();
        if let CatalogQuery::Episodes {
            series_id,
            cursor,
            limit,
        } = query
        {
            // A later page, or the same series asked again soon, comes from
            // what was loaded, so paging doesn't ask the provider each time.
            let episodes = match self.fresh(&series_id) {
                Some(episodes) => episodes,
                None => {
                    // This runs on a blocking thread, which can wait for the provider.
                    let loaded = tokio::runtime::Handle::current()
                        .block_on(super::catalog::episodes(&state.cache, &series_id))?;
                    self.remember(series_id, loaded.clone());
                    loaded
                }
            };
            let cache = state.cache.lock().map_err(|_| ErrorCode::Failed)?;
            return super::catalog::episode_page(&cache, &episodes, cursor, limit);
        }
        let cache = state.cache.lock().map_err(|_| ErrorCode::Failed)?;
        super::catalog::answer(&cache, query)
    }

    fn advertise(&self, registration: Option<Registration>) {
        let mut current = lock(&self.advertisement);
        // The old record goes first, with a goodbye, so the name is free.
        *current = None;
        if let Some(registration) = registration {
            *current = (self.advertiser)(&registration);
        }
    }
}

/// Whether a consent request may bring the window up `now`, when one last
/// did at `last`.
fn may_raise(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|at| now.duration_since(at) >= RAISE_EVERY)
}

/// Advertises on the network this device is on.
fn advertise_on_network(registration: &Registration) -> Option<Advertisement> {
    discovery::advertise(registration)
        .inspect_err(|e| tracing::warn!("[remote] couldn't advertise: {e}"))
        .ok()
}

/// The saved settings, or the defaults.
fn load_settings<R: Runtime>(app: &AppHandle<R>) -> RemoteSettings {
    app.store(SETTINGS_STORE_FILE)
        .ok()
        .and_then(|store| store.get(SETTINGS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// Starts the target on every address and advertises it, and manages a
/// [`RemoteService`]. A failure is logged and the app carries on without
/// remote control.
pub fn start<R: Runtime>(app: &AppHandle<R>, key_dir: PathBuf) {
    let started = tauri::async_runtime::block_on(async {
        let listener = target::bind_default().await.map_err(|e| e.to_string())?;
        start_on(app, key_dir, listener, Box::new(advertise_on_network))
    });
    if let Err(e) = started {
        tracing::error!("[remote] remote control didn't start: {e}");
    }
}

/// [`start`] on `listener`, advertising through `advertiser`. Call it inside
/// the async runtime.
fn start_on<R: Runtime>(
    app: &AppHandle<R>,
    key_dir: PathBuf,
    listener: tokio::net::TcpListener,
    advertiser: Advertiser,
) -> Result<(), String> {
    let key = identity::load_or_create(&key_dir)
        .map_err(|e| format!("couldn't load the device key: {e}"))?;
    let settings = load_settings(app);
    let host = Arc::new(TauriHost {
        app: app.clone(),
        advertiser,
        advertisement: Mutex::new(None),
        episodes: Mutex::new(VecDeque::new()),
        raised: Mutex::new(None),
    });
    let device_id = key.device_id();
    let handle = target::start(listener, key, DEVICE_TYPE, settings.clone(), host)
        .map_err(|e| format!("couldn't listen: {e}"))?;
    tracing::info!(
        "[remote] listening on port {} as {device_id}",
        handle.port()
    );
    app.manage(RemoteService {
        handle,
        key_dir,
        state: Mutex::new(Saved {
            settings,
            device_id,
        }),
        resetting: Mutex::new(()),
    });
    Ok(())
}

/// Closes every connection with `shutdown` and withdraws the record.
pub fn stop_for_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(service) = app.try_state::<RemoteService>() {
        tauri::async_runtime::block_on(service.handle.shutdown());
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
