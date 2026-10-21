// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Starts the target when the app starts, and connects it to Tauri: events
//! for the webview, the cache for catalog answers, and DNS-SD.

use super::device::device_type;
use super::devices::{Devices, RemoteDevice};
use super::link::{self, LinkConfig, LinkHandle, LinkHost, Phase};
use super::target::{self, CatalogPage, TargetHandle, TargetHost};
use super::{identity, SETTINGS_KEY, SETTINGS_STORE_FILE};
use crate::commands::AppState;
use crate::discovery::{self, Advertisement, Registration};
use mvp_core::models::channel::Channel;
use mvp_core::remote::catalog::CatalogQuery;
use mvp_core::remote::consent::RequestId;
use mvp_core::remote::identity::{DeviceId, DeviceKey};
use mvp_core::remote::message::{
    Command, DeviceType, Feature, Hello, VersionedState, PROTOCOL_VERSION,
};
use mvp_core::remote::sessions::RESUME_GRACE;
use mvp_core::remote::settings::RemoteSettings;
use mvp_core::remote::target::{ConsentPrompt, SessionInfo};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_store::StoreExt;
use tokio::sync::mpsc;

/// Remote control as Tauri managed state: the running target, the devices
/// discovery found, and the device this one controls, if any.
pub struct RemoteService {
    pub(crate) handle: TargetHandle,
    key_dir: PathBuf,
    state: Mutex<Saved>,
    resetting: Mutex<()>,
    devices: Arc<Mutex<Devices>>,
    link: Arc<Mutex<Option<LinkHandle>>>,
    link_host: Arc<dyn LinkHost>,
    events: Arc<dyn ServiceEvents>,
    /// The consent prompt on screen, as the target host keeps it.
    prompt: Arc<Mutex<Option<ConsentPrompt>>>,
    /// The highest link number the webview has left. A connect numbered
    /// at or below it was overtaken by that leave on the way here.
    left_through: Mutex<u64>,
    /// Whether the app is in the foreground, as the system last said.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    wants_foreground: AtomicBool,
    /// Whether the target listens and advertises, as it was last told. Held
    /// while the target is told, so changes reach it one at a time.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    in_foreground: tokio::sync::Mutex<bool>,
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

    /// The request on screen, if one is and it hasn't run out, for a
    /// webview that started listening after it came.
    pub fn pending_consent(&self) -> Option<ConsentEvent> {
        lock(&self.prompt)
            .as_ref()
            // mutants: skip BinaryOperator: > and >= differ only at one instant of a clock that never stops.
            .filter(|p| p.expires_at > super::clock::now())
            .map(consent_event)
    }

    pub fn device_id(&self) -> DeviceId {
        lock(&self.state).key.device_id()
    }

    /// The other Cinette devices discovery found.
    pub fn devices(&self) -> Vec<RemoteDevice> {
        lock(&self.devices).list()
    }

    /// The link numbered `link`, if it's the one this device holds now.
    pub fn link(&self, link: u64) -> Option<LinkHandle> {
        lock(&self.link)
            .as_ref()
            .filter(|l| l.generation() == link)
            .cloned()
    }

    /// The number of the link this device holds now, if any.
    pub fn current_link(&self) -> Option<u64> {
        lock(&self.link).as_ref().map(LinkHandle::generation)
    }

    /// Starts asking `device` for control, leaving any device controlled now.
    /// `link` numbers the new link.
    pub fn connect(&self, device: DeviceId, link: u64) -> Result<(), String> {
        if link <= *lock(&self.left_through) {
            return Err("That connection was left already.".into());
        }
        let allowed = lock(&self.devices).get(&device).map(|d| d.control_allowed);
        match allowed {
            None => return Err("That device isn't on the network now.".into()),
            Some(false) => return Err("That device doesn't allow remote control.".into()),
            Some(true) => {}
        }
        let (key, name) = {
            let saved = lock(&self.state);
            (saved.key.clone(), saved.settings.name(device_type()))
        };
        let hello = Hello {
            id: key.device_id(),
            name,
            device_type: device_type(),
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
            generation: link,
            limits: link::Limits::STANDARD,
            clock: Arc::new(super::clock::now),
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

    /// Ends link `link`, or stops it asking. The other device keeps
    /// playing. A link that another replaced meanwhile is gone already, so
    /// a late leave for it leaves the new one alone. The webview asked, so
    /// no `remote://controller` event says so.
    pub async fn leave(&self, link: u64) {
        {
            let mut left = lock(&self.left_through);
            *left = (*left).max(link);
        }
        let old = {
            let mut slot = lock(&self.link);
            if slot.as_ref().is_some_and(|l| l.generation() == link) {
                slot.take()
            } else {
                None
            }
        };
        if let Some(old) = old {
            old.leave().await;
        }
        self.forget_kept();
    }

    /// Stops keeping the device left in the list, unless a link to another
    /// started meanwhile, and says what the list is now.
    fn forget_kept(&self) {
        if lock(&self.link).is_some() {
            return;
        }
        let list = {
            let mut devices = lock(&self.devices);
            devices.keep(None);
            devices.list()
        };
        self.events.devices_changed(&list);
    }

    /// Hands the settings to the target, then saves them. The target takes
    /// them first, so Never allow ends the sessions even when the file
    /// can't be written; the error then says the choice won't last past a
    /// restart. One call at a time, so the file and the target agree.
    pub fn set_settings<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: RemoteSettings,
    ) -> Result<(), String> {
        let mut state = lock(&self.state);
        state.settings = settings.clone();
        self.handle.update_settings(settings.clone());
        save_settings(app, &settings)
    }

    /// Notes that the app went to the background or came back. Call
    /// [`Self::follow_foreground`] next.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn set_foreground(&self, foreground: bool) {
        self.wants_foreground.store(foreground, Ordering::SeqCst);
    }

    /// Brings the target in line with the last [`Self::set_foreground`]:
    /// in the background it stops advertising and listening, and back in
    /// the foreground it listens again and advertises. Open sessions carry
    /// on either way. However the calls overlap, the last word wins.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub async fn follow_foreground(&self) {
        let mut in_foreground = self.in_foreground.lock().await;
        let wanted = self.wants_foreground.load(Ordering::SeqCst);
        if wanted == *in_foreground {
            return;
        }
        if !wanted {
            tracing::info!("[remote] in the background; not taking new connections");
            self.handle.background();
            *in_foreground = false;
            return;
        }
        let listening = match target::bind_default().await {
            Ok(listener) => self.handle.foreground(listener),
            Err(e) => Err(e),
        };
        match listening {
            Ok(()) => {
                tracing::info!(
                    "[remote] in the foreground; listening on port {}",
                    self.handle.port()
                );
                *in_foreground = true;
            }
            Err(e) => tracing::warn!("[remote] couldn't listen again: {e}"),
        }
    }

    /// Makes and saves a new key, so a new device id. Every session ends.
    pub fn reset_identity(&self) -> Result<DeviceId, String> {
        // One reset at a time, so the saved key and the running one match.
        let _one = lock(&self.resetting);
        let key = DeviceKey::generate();
        identity::save(&self.key_dir, &key).map_err(|e| e.to_string())?;
        let id = key.device_id();
        lock(&self.state).key = key.clone();
        lock(&self.devices).set_own(id.clone());
        self.handle.reset_identity(key);
        // A session this device holds on another one ends too, and the
        // webview didn't ask, so it's told.
        let old = lock(&self.link).take();
        if let Some(old) = old {
            self.events.left(old.generation(), old.device());
            tauri::async_runtime::spawn(async move { old.leave().await });
            self.forget_kept();
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

fn consent_event(prompt: &ConsentPrompt) -> ConsentEvent {
    ConsentEvent {
        request: prompt.request,
        device_id: prompt.device_id.to_string(),
        name: prompt.name.clone(),
        device_type: prompt.device_type,
        code: prompt.code.clone(),
        expires_in_ms: prompt
            .expires_at
            .saturating_duration_since(super::clock::now())
            .as_millis() as u64,
    }
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
/// How many series a controller may have loaded from the provider at once,
/// before it has to wait for [`FETCH_EVERY`] to pass for each one more.
const FETCH_BURST: u32 = 4;
/// How often a controller may load one more series from the provider, so
/// browsing can't make the provider turn this device's account away.
const FETCH_EVERY: Duration = Duration::from_secs(1);
/// The shortest time between two consent requests that ask for attention.
const RAISE_EVERY: Duration = Duration::from_secs(120);

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
    /// The provider loads controllers may still make.
    fetches: Mutex<Bucket>,
    /// One lock per series being loaded, so two queries for it make one
    /// load, and the second answers from what the first loaded.
    loading: Gates,
    /// The consent prompt on screen, for a webview that wasn't listening
    /// when it came.
    prompt: Arc<Mutex<Option<ConsentPrompt>>>,
}

/// A lock for each key in use, made when the first user comes and dropped
/// when the last one goes.
#[derive(Debug, Default)]
struct Gates(Mutex<HashMap<String, Arc<Mutex<()>>>>);

impl Gates {
    /// The lock for `key`, to hold while working on it.
    fn enter(&self, key: &str) -> Arc<Mutex<()>> {
        lock(&self.0).entry(key.to_owned()).or_default().clone()
    }

    /// Done with `gate`. The last one out takes its lock away.
    fn leave(&self, gate: Arc<Mutex<()>>) {
        drop(gate);
        lock(&self.0).retain(|_, gate| Arc::strong_count(gate) > 1);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        lock(&self.0).len()
    }
}

/// A token bucket: [`FETCH_BURST`] at once, then one per [`FETCH_EVERY`].
#[derive(Debug)]
struct Bucket {
    tokens: u32,
    /// When the last token came, or the bucket was full.
    since: Option<Instant>,
}

impl Bucket {
    const fn full() -> Self {
        Self {
            tokens: FETCH_BURST,
            since: None,
        }
    }

    /// Takes a token if there's one by `now`.
    fn take(&mut self, now: Instant) -> bool {
        if let Some(since) = self.since {
            let earned = now.saturating_duration_since(since).as_millis() / FETCH_EVERY.as_millis();
            let earned = u32::try_from(earned).unwrap_or(u32::MAX);
            // mutants: skip BinaryOperator: with nothing earned, adding no tokens and moving the clock by nothing changes nothing.
            if earned > 0 {
                self.tokens = self.tokens.saturating_add(earned).min(FETCH_BURST);
                self.since = Some(since + FETCH_EVERY * earned);
            }
        }
        if self.tokens == 0 {
            return false;
        }
        if self.tokens == FETCH_BURST {
            self.since = Some(now);
        }
        self.tokens -= 1;
        true
    }
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
        *lock(&self.prompt) = Some(prompt.clone());
        let _ = self.app.emit("remote://consent", consent_event(prompt));
        // A dialog behind other windows would time out unseen. Requests
        // can come again and again, so this asks only now and then, and
        // never takes the focus, so a key pressed in another app can't
        // answer the dialog.
        let mut raised = lock(&self.raised);
        let now = Instant::now();
        if may_raise(*raised, now) {
            *raised = Some(now);
            ask_for_attention(&self.app);
        }
    }

    fn hide_consent(&self, request: RequestId) {
        lock(&self.prompt).take_if(|p| p.request == request);
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
            let gate = self.loading.enter(&series_id);
            let episodes = {
                // This runs on a blocking thread, which can wait.
                let _one = lock(&gate);
                match self.fresh(&series_id) {
                    Some(episodes) => Ok(episodes),
                    None => {
                        let may_ask = || lock(&self.fetches).take(Instant::now());
                        tokio::runtime::Handle::current()
                            .block_on(super::catalog::episodes(&state.cache, &series_id, may_ask))
                            .inspect(|loaded| self.remember(series_id.clone(), loaded.clone()))
                    }
                }
            };
            self.loading.leave(gate);
            let episodes = episodes?;
            let providers = super::catalog::read(&state.cache, |c| c.get_providers())?;
            return super::catalog::episode_page(&providers, &episodes, cursor, limit);
        }
        super::catalog::answer(&state.cache, query)
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

// mutants: skip FnValue: it only acts on a real window, which the mock runtime doesn't have.
/// Brings a minimized or hidden main window back without focusing it, and
/// asks for attention: the Dock icon bounces, or the taskbar entry flashes.
/// On a phone or TV the app is on screen whenever a request can come in.
fn ask_for_attention<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(mobile)]
    let _ = app;
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        // mutants: skip UnaryOperator: the mock runtime has no window to show or hide.
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
        }
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

/// Whether a consent request may ask for attention `now`, when one last
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

/// What `remote://controller` carries: the device and where the connection
/// to it stands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEvent<'a> {
    pub device_id: String,
    pub link: u64,
    #[serde(flatten)]
    pub phase: &'a Phase,
}

/// What `remote://state` carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub device_id: String,
    pub link: u64,
    pub state: VersionedState,
}

/// What the service tells the webview besides what links report.
trait ServiceEvents: Send + Sync {
    /// The device list changed.
    fn devices_changed(&self, devices: &[RemoteDevice]);
    /// Link `link` to `device` ended without the webview asking.
    fn left(&self, link: u64, device: &DeviceId);
}

/// States from a controlled device, kept to at most one every
/// [`STATE_EVERY`] so a device that floods can't flood the webview.
#[derive(Default)]
struct Throttle {
    last: Option<Instant>,
    /// The newest state held back, sent when its turn comes.
    held: Option<StateEvent>,
}

/// The shortest time between two `remote://state` events.
const STATE_EVERY: Duration = Duration::from_millis(100);

struct TauriLinkHost<R: Runtime> {
    app: AppHandle<R>,
    devices: Arc<Mutex<Devices>>,
    link: Arc<Mutex<Option<LinkHandle>>>,
    throttle: Arc<Mutex<Throttle>>,
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
                link,
                phase,
            },
        );
    }

    fn state(&self, link: u64, device: &DeviceId, state: &VersionedState) {
        if !self.current(link) {
            return;
        }
        let mut state = state.clone();
        state.state.item = state.state.item.map(super::logos::checked);
        let event = StateEvent {
            device_id: device.to_string(),
            link,
            state,
        };
        let mut throttle = lock(&self.throttle);
        let now = Instant::now();
        let wait = throttle.last.map_or(Duration::ZERO, |at| {
            STATE_EVERY.saturating_sub(now.duration_since(at))
        });
        if wait.is_zero() {
            throttle.last = Some(now);
            let _ = self.app.emit("remote://state", event);
            return;
        }
        // One held state at a time; a newer one takes its place.
        let already_waiting = throttle.held.replace(event).is_some();
        if already_waiting {
            return;
        }
        let (app, slot, throttle) = (self.app.clone(), self.link.clone(), self.throttle.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(wait).await;
            let mut throttle = lock(&throttle);
            let Some(event) = throttle.held.take() else {
                return;
            };
            throttle.last = Some(Instant::now());
            let current = lock(&slot).as_ref().map(LinkHandle::generation);
            if current == Some(event.link) {
                let _ = app.emit("remote://state", event);
            }
        });
    }
}

impl<R: Runtime> ServiceEvents for TauriLinkHost<R> {
    fn devices_changed(&self, devices: &[RemoteDevice]) {
        let _ = self.app.emit("remote://devices", devices);
    }

    fn left(&self, link: u64, device: &DeviceId) {
        let _ = self.app.emit(
            "remote://controller",
            ControllerEvent {
                device_id: device.to_string(),
                link,
                phase: &Phase::Closed {
                    reason: super::link::Ended::Left,
                },
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

/// Writes `settings` to the settings file. When that fails, the store keeps
/// what it had, so a later write of the file doesn't save them after all.
fn save_settings<R: Runtime>(app: &AppHandle<R>, settings: &RemoteSettings) -> Result<(), String> {
    let couldnt = |e: &dyn std::fmt::Display| {
        format!("This works until Cinette quits, but it couldn't be saved: {e}")
    };
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| couldnt(&e))?;
    let before = store.get(SETTINGS_KEY);
    store.set(
        SETTINGS_KEY,
        serde_json::to_value(settings).map_err(|e| couldnt(&e))?,
    );
    store.save().map_err(|e| {
        match before {
            Some(value) => store.set(SETTINGS_KEY, value),
            None => {
                store.delete(SETTINGS_KEY);
            }
        }
        couldnt(&e)
    })
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
            target::Limits::STANDARD,
        )
    });
    if let Err(e) = started {
        tracing::error!("[remote] remote control didn't start: {e}");
    }
}

/// [`start`] on `listener`, advertising through `advertiser`, with `limits`. Call it inside
/// the async runtime.
fn start_on<R: Runtime>(
    app: &AppHandle<R>,
    key_dir: PathBuf,
    listener: tokio::net::TcpListener,
    advertiser: Advertiser,
    found: mpsc::UnboundedReceiver<discovery::Event>,
    limits: target::Limits,
) -> Result<(), String> {
    let key = identity::load_or_create(&key_dir)
        .map_err(|e| format!("couldn't load the device key: {e}"))?;
    let settings = load_settings(app);
    let prompt = Arc::new(Mutex::new(None));
    let host = Arc::new(TauriHost {
        app: app.clone(),
        advertiser,
        advertisement: Mutex::new(None),
        episodes: Mutex::new(VecDeque::new()),
        raised: Mutex::new(None),
        fetches: Mutex::new(Bucket::full()),
        loading: Gates::default(),
        prompt: prompt.clone(),
    });
    let device_id = key.device_id();
    let handle = target::start_with(
        listener,
        key.clone(),
        device_type(),
        settings.clone(),
        host,
        limits,
    )
    .map_err(|e| format!("couldn't listen: {e}"))?;
    let devices = Arc::new(Mutex::new(Devices::new(device_id.clone())));
    let link = Arc::new(Mutex::new(None));
    follow_discovery(app.clone(), devices.clone(), found);
    tracing::info!(
        "[remote] listening on port {} as {device_id}",
        handle.port()
    );
    let link_host = Arc::new(TauriLinkHost {
        app: app.clone(),
        devices: devices.clone(),
        link: link.clone(),
        throttle: Arc::new(Mutex::new(Throttle::default())),
    });
    app.manage(RemoteService {
        handle,
        key_dir,
        state: Mutex::new(Saved { settings, key }),
        link_host: link_host.clone(),
        events: link_host,
        resetting: Mutex::new(()),
        devices,
        link,
        left_through: Mutex::new(0),
        prompt,
        wants_foreground: AtomicBool::new(true),
        in_foreground: tokio::sync::Mutex::new(true),
    });
    Ok(())
}

/// Tells remote control that the app went to the background or came back.
/// On a phone, tablet or TV, the device can only be found while the app is
/// in the foreground.
// Only the mobile apps go to the background.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn set_foreground<R: Runtime>(app: &AppHandle<R>, foreground: bool) {
    #[cfg(target_os = "android")]
    crate::android_device::hold_multicast(foreground);
    let Some(service) = app.try_state::<RemoteService>() else {
        return;
    };
    service.set_foreground(foreground);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(service) = app.try_state::<RemoteService>() {
            service.follow_foreground().await;
        }
    });
}

/// Closes every connection with `shutdown` and withdraws the record.
pub fn stop_for_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(service) = app.try_state::<RemoteService>() {
        tauri::async_runtime::block_on(async {
            if let Some(link) = service.current_link() {
                service.leave(link).await;
            }
            service.handle.shutdown().await;
        });
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
