// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Starts the target when the app starts, and connects it to Tauri: events
//! for the webview, the cache for catalog answers, and DNS-SD.

use super::devices::{Devices, RemoteDevice};
use super::link::{self, LinkConfig, LinkHandle, LinkHost, Phase};
use super::target::{self, CatalogPage, TargetHandle, TargetHost};
use super::{identity, SETTINGS_KEY, SETTINGS_STORE_FILE};
use crate::commands::AppState;
use crate::discovery::{self, Advertisement, Registration};
use mvp_core::remote::catalog::CatalogQuery;
use mvp_core::remote::consent::RequestId;
use mvp_core::remote::identity::{DeviceId, DeviceKey};
use mvp_core::remote::message::{
    Command, DeviceType, ErrorCode, Feature, Hello, VersionedState, PROTOCOL_VERSION,
};
use mvp_core::remote::sessions::RESUME_GRACE;
use mvp_core::remote::settings::RemoteSettings;
use mvp_core::remote::target::{ConsentPrompt, SessionInfo};
use serde::Serialize;
use mvp_core::models::channel::Channel;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_store::StoreExt;
use tokio::sync::mpsc;

/// This device's type, as other devices see it.
#[cfg(target_os = "macos")]
pub const DEVICE_TYPE: DeviceType = DeviceType::Mac;
#[cfg(target_os = "linux")]
pub const DEVICE_TYPE: DeviceType = DeviceType::LinuxPc;

/// Remote control as Tauri managed state: the running target, the devices
/// discovery found, and the device this one controls, if any.
pub struct RemoteService {
    pub(crate) handle: TargetHandle,
    key_dir: PathBuf,
    state: Mutex<Saved>,
    devices: Arc<Mutex<Devices>>,
    link: Arc<Mutex<Option<LinkHandle>>>,
    link_host: Arc<dyn LinkHost>,
    /// The next link's generation.
    links: std::sync::atomic::AtomicU64,
}

struct Saved {
    settings: RemoteSettings,
    key: DeviceKey,
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
        lock(&self.state).key.device_id()
    }

    /// The other Cinette devices discovery found.
    pub fn devices(&self) -> Vec<RemoteDevice> {
        lock(&self.devices).list()
    }

    /// The link to the device this one controls, if any.
    pub fn link(&self) -> Option<LinkHandle> {
        lock(&self.link).clone()
    }

    /// Starts asking `device` for control, leaving any device controlled now.
    pub fn connect(&self, device: DeviceId) -> Result<(), String> {
        let allowed = lock(&self.devices).get(&device).map(|d| d.control_allowed);
        match allowed {
            None => return Err("That device isn't on the network now.".into()),
            Some(false) => return Err("That device doesn't allow remote control.".into()),
            Some(true) => {}
        }
        let (key, name) = {
            let saved = lock(&self.state);
            (saved.key.clone(), saved.settings.name(DEVICE_TYPE))
        };
        let hello = Hello {
            id: key.device_id(),
            name,
            device_type: DEVICE_TYPE,
            versions: vec![PROTOCOL_VERSION],
            features: vec![Feature::Control, Feature::Catalog],
        };
        let devices = self.devices.clone();
        let target = device.clone();
        let config = LinkConfig {
            key,
            hello,
            target: device.clone(),
            addresses: Arc::new(move || lock(&devices).addresses(&target)),
            grace: RESUME_GRACE,
            generation: self
                .links
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            timeouts: link::Timeouts::STANDARD,
        };
        lock(&self.devices).keep(Some(device));
        // The slot stays locked until the new link is in it, so the link's
        // first event already finds itself current.
        let mut slot = lock(&self.link);
        let old = slot.replace(link::start(config, self.link_host.clone()));
        drop(slot);
        if let Some(old) = old {
            tauri::async_runtime::spawn(async move { old.leave().await });
        }
        Ok(())
    }

    /// Ends the session, or stops asking. The other device keeps playing.
    pub async fn leave(&self) {
        let old = lock(&self.link).take();
        if let Some(old) = old {
            old.leave().await;
        }
        lock(&self.devices).keep(None);
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
        let key = DeviceKey::generate();
        identity::save(&self.key_dir, &key).map_err(|e| e.to_string())?;
        let id = key.device_id();
        lock(&self.state).key = key.clone();
        lock(&self.devices).set_own(id.clone());
        self.handle.reset_identity(key);
        // A session this device holds on another one ends too.
        if let Some(old) = lock(&self.link).take() {
            tauri::async_runtime::spawn(async move { old.leave().await });
        }
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

/// Puts a record on the network, or doesn't.
type Advertiser = Box<dyn Fn(&Registration) -> Option<Advertisement> + Send + Sync>;

struct TauriHost<R: Runtime> {
    app: AppHandle<R>,
    advertiser: Advertiser,
    advertisement: Mutex<Option<Advertisement>>,
    /// The episodes of the series controllers opened last, by series id.
    episodes: Mutex<VecDeque<(String, Vec<Channel>)>>,
}

impl<R: Runtime> TauriHost<R> {
    fn remember(&self, series_id: String, episodes: Vec<Channel>) {
        let mut remembered = lock(&self.episodes);
        remembered.retain(|(id, _)| *id != series_id);
        remembered.push_back((series_id, episodes));
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
        // A dialog behind other windows would time out unseen.
        crate::show_main_window(&self.app);
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
                .flat_map(|(_, episodes)| episodes)
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
        if let CatalogQuery::Episodes { series_id } = query {
            // This runs on a blocking thread, which can wait for the provider.
            let episodes = tokio::runtime::Handle::current()
                .block_on(super::catalog::episodes(&state.cache, &series_id))?;
            let page = {
                let cache = state.cache.lock().map_err(|_| ErrorCode::Failed)?;
                super::catalog::episode_page(&cache, &episodes)?
            };
            self.remember(series_id, episodes);
            return Ok(page);
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

/// Advertises on the network this device is on.
fn advertise_on_network(registration: &Registration) -> Option<Advertisement> {
    discovery::advertise(registration)
        .inspect_err(|e| tracing::warn!("[remote] couldn't advertise: {e}"))
        .ok()
}

/// What `remote://controller` carries: the device and where the connection
/// to it stands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEvent<'a> {
    pub device_id: String,
    #[serde(flatten)]
    pub phase: &'a Phase,
}

/// What `remote://state` carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent<'a> {
    pub device_id: String,
    pub state: &'a VersionedState,
}

struct TauriLinkHost<R: Runtime> {
    app: AppHandle<R>,
    devices: Arc<Mutex<Devices>>,
    link: Arc<Mutex<Option<LinkHandle>>>,
}

impl<R: Runtime> TauriLinkHost<R> {
    /// Whether `link` is still the one this device uses. One that was
    /// replaced or left says nothing more to the webview.
    fn current(&self, link: u64) -> bool {
        lock(&self.link)
            .as_ref()
            .is_some_and(|l| l.generation() == link)
    }
}

impl<R: Runtime> LinkHost for TauriLinkHost<R> {
    fn phase(&self, link: u64, device: &DeviceId, phase: &Phase) {
        if let Phase::Closed { reason } = phase {
            tracing::info!("[remote] the session with {device} ended: {reason:?}");
            let mut slot = lock(&self.link);
            if !slot.as_ref().is_some_and(|l| l.generation() == link) {
                return;
            }
            *slot = None;
            drop(slot);
            let list = {
                let mut devices = lock(&self.devices);
                devices.keep(None);
                devices.list()
            };
            let _ = self.app.emit("remote://devices", list);
        } else if !self.current(link) {
            return;
        }
        let _ = self.app.emit(
            "remote://controller",
            ControllerEvent {
                device_id: device.to_string(),
                phase,
            },
        );
    }

    fn state(&self, link: u64, device: &DeviceId, state: &VersionedState) {
        if !self.current(link) {
            return;
        }
        let _ = self.app.emit(
            "remote://state",
            StateEvent {
                device_id: device.to_string(),
                state,
            },
        );
    }
}

/// Browses for other Cinette devices on the network.
fn browse_network() -> mpsc::UnboundedReceiver<discovery::Event> {
    let (tx, rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        let mut browser = match discovery::browse(mvp_core::remote::target::SERVICE_TYPE) {
            Ok(browser) => browser,
            Err(e) => {
                tracing::warn!("[remote] couldn't look for other devices: {e}");
                return;
            }
        };
        while let Some(event) = browser.next().await {
            if tx.send(event).is_err() {
                return;
            }
        }
    });
    rx
}

/// Keeps the device list up to date from discovery, and tells the webview
/// when it changes.
fn follow_discovery<R: Runtime>(
    app: AppHandle<R>,
    devices: Arc<Mutex<Devices>>,
    mut found: mpsc::UnboundedReceiver<discovery::Event>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = found.recv().await {
            let list = {
                let mut devices = lock(&devices);
                devices.apply(event).then(|| devices.list())
            };
            if let Some(list) = list {
                let _ = app.emit("remote://devices", list);
            }
        }
    });
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
        start_on(
            app,
            key_dir,
            listener,
            Box::new(advertise_on_network),
            browse_network(),
        )
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
    found: mpsc::UnboundedReceiver<discovery::Event>,
) -> Result<(), String> {
    let key = identity::load_or_create(&key_dir)
        .map_err(|e| format!("couldn't load the device key: {e}"))?;
    let settings = load_settings(app);
    let host = Arc::new(TauriHost {
        app: app.clone(),
        advertiser,
        advertisement: Mutex::new(None),
        episodes: Mutex::new(VecDeque::new()),
    });
    let device_id = key.device_id();
    let handle = target::start(listener, key.clone(), DEVICE_TYPE, settings.clone(), host)
        .map_err(|e| format!("couldn't listen: {e}"))?;
    let devices = Arc::new(Mutex::new(Devices::new(device_id.clone())));
    let link = Arc::new(Mutex::new(None));
    follow_discovery(app.clone(), devices.clone(), found);
    tracing::info!(
        "[remote] listening on port {} as {device_id}",
        handle.port()
    );
    app.manage(RemoteService {
        handle,
        key_dir,
        state: Mutex::new(Saved { settings, key }),
        link_host: Arc::new(TauriLinkHost {
            app: app.clone(),
            devices: devices.clone(),
            link: link.clone(),
        }),
        devices,
        link,
        links: std::sync::atomic::AtomicU64::new(0),
    });
    Ok(())
}

/// Closes every connection with `shutdown` and withdraws the record.
pub fn stop_for_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(service) = app.try_state::<RemoteService>() {
        tauri::async_runtime::block_on(async {
            service.leave().await;
            service.handle.shutdown().await;
        });
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
