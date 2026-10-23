// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Starts the target when the app starts, and connects it to Tauri: events
//! for the webview, the cache for catalog answers, and DNS-SD.

use super::device::{default_name, device_type};
use super::running::Transfers;
use super::devices::{Devices, RemoteDevice};
use super::link::{self, LinkConfig, LinkHandle, LinkHost, Phase};
use super::target::{
    self, CatalogPage, Exported, Imported, SavedProviders, TargetHandle, TargetHost, TransferEvent,
};
use super::{identity, BLOCKED_KEY, SETTINGS_KEY, SETTINGS_STORE_FILE};
use crate::commands::AppState;
use crate::discovery::{self, Advertisement, Registration};
use mvp_core::models::channel::Channel;
use mvp_core::remote::catalog::CatalogQuery;
use mvp_core::remote::consent::RequestId;
use mvp_core::remote::controller::AskError;
use mvp_core::remote::identity::{DeviceId, DeviceKey};
use mvp_core::remote::message::ErrorCode;
use mvp_core::remote::message::{
    Command, DeviceType, Feature, Hello, VersionedState, PROTOCOL_VERSION,
};
use mvp_core::remote::sessions::RESUME_GRACE;
use mvp_core::remote::settings::RemoteSettings;
use mvp_core::remote::target::{BlockedDevice, ConsentPrompt, SessionInfo};
use mvp_core::remote::transfer::flow::{
    Asked, ControllerEvent as TransferUpdate, Direction, Progress, ProviderName, ProviderOutcome,
    ProviderSettings,
};
use mvp_core::remote::transfer::refs::Salt;
use mvp_core::remote::transfer::{Counts, Export, What};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_store::StoreExt;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

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
    /// The providers the webview asked to send, by link, until the other
    /// device allows it.
    sending: Sending,
    /// See [`SendingHistory`].
    history: SendingHistory,
    /// See [`ProgressWaiter`].
    progress: ProgressWaiter,
    /// How many cancels each link has had, so a send that was cancelled
    /// while it waited for the cache doesn't ask after all.
    cancels: Mutex<std::collections::HashMap<u64, u64>>,
    /// Whether the app is in the foreground, as the system last said.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(mobile), allow(dead_code))]
    wants_foreground: AtomicBool,
    /// Whether the target listens and advertises, as it was last told. Held
    /// while the target is told, so changes reach it one at a time.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(mobile), allow(dead_code))]
    in_foreground: tokio::sync::Mutex<bool>,
}

/// A history "send" waiting for the other device's Allow: the link, and the
/// channel the player had open when it was asked.
type SendingHistory = Arc<Mutex<Option<(u64, Option<String>)>>>;

/// Waiting for the webview to save the player's position before an export,
/// with the channel it has open.
type ProgressWaiter = Arc<Mutex<Option<oneshot::Sender<Option<String>>>>>;

/// How long an export waits for the player to save its position.
const SAVE_PROGRESS_WAIT: Duration = Duration::from_secs(2);

/// Asks the webview to save the player's position now, and waits a moment
/// for it. Returns the channel the player has open, if it said.
async fn save_progress<R: Runtime>(app: &AppHandle<R>, waiter: &ProgressWaiter) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    *lock(waiter) = Some(tx);
    let _ = app.emit("remote://save-progress", ());
    tokio::time::timeout(SAVE_PROGRESS_WAIT, rx)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
}

/// What `remote://history-imported` carries: history written here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImported {
    pub from: String,
    #[serde(flatten)]
    pub imported: super::history::Imported,
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
        // Held until the new link is in its slot, as set_settings holds it
        // while it renames the link there, so a rename can't fall between.
        let saved = lock(&self.state);
        let key = saved.key.clone();
        let hello = Hello {
            id: key.device_id(),
            name: saved.settings.name(default_name()),
            device_type: device_type(),
            versions: vec![PROTOCOL_VERSION],
            features: vec![
                Feature::Control,
                Feature::Catalog,
                Feature::History,
                Feature::Providers,
                Feature::Rename,
            ],
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
        drop(saved);
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
    /// restart. One call at a time, so the file and the target agree. A
    /// new name also goes to the device this one controls.
    pub fn set_settings<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: RemoteSettings,
    ) -> Result<(), String> {
        let mut state = lock(&self.state);
        let name = settings.name(default_name());
        if name != state.settings.name(default_name())
            && let Some(link) = lock(&self.link).as_ref()
        {
            link.rename(name);
        }
        state.settings = settings.clone();
        self.handle.update_settings(settings.clone());
        save(app, SETTINGS_KEY, &settings)
    }

    /// Asks the device link `link` controls to take the providers with
    /// these ids. Only their names go now. The logins go once that device's
    /// user allows it, which `remote://transfer` reports.
    pub async fn send_providers<R: Runtime>(
        &self,
        app: AppHandle<R>,
        link: u64,
        ids: Vec<String>,
    ) -> Result<(), String> {
        let handle = self.link(link).ok_or("Not connected to that device.")?;
        let ticket = self.cancel_count(link);
        // This can wait on the cache, for a refresh or a guide save.
        let names = {
            let ids = ids.clone();
            blocking(app, move |state| {
                super::providers::names_for(&state.cache, &ids)
            })
            .await
            .unwrap_or_else(|| Err("This device couldn't read its providers.".into()))?
        };
        {
            let mut slot = lock(&self.sending);
            if self.cancel_count(link) != ticket {
                return Err(CANCELLED.into());
            }
            if slot.as_ref().is_some_and(|(l, _)| *l == link) {
                return Err(BUSY.into());
            }
            *slot = Some((link, ids));
        }
        let asked = handle.ask_providers(names).await;
        if asked.is_err() {
            lock(&self.sending).take_if(|(l, _)| *l == link);
        }
        // Cancelled while the request went out: it's withdrawn.
        if asked.is_ok() && self.cancel_count(link) != ticket {
            handle.cancel_transfer();
            return Err(CANCELLED.into());
        }
        asked.map_err(|e| match e {
            AskError::Unsupported => {
                "That device's Cinette can't take providers. Update it first.".to_string()
            }
            AskError::Busy => BUSY.to_string(),
            AskError::NotConnected => "Not connected to that device.".to_string(),
        })
    }

    /// Asks the device link `link` controls for a history transfer. For
    /// "send", `playing` is the channel this device's player has open,
    /// whose position the webview saved first.
    pub async fn ask_history<R: Runtime>(
        &self,
        app: AppHandle<R>,
        link: u64,
        direction: Direction,
        what: What,
        playing: Option<String>,
    ) -> Result<(), String> {
        let handle = self.link(link).ok_or("Not connected to that device.")?;
        if what.is_empty() {
            return Err("Pick something to copy.".into());
        }
        let ticket = self.cancel_count(link);
        let counts = match direction {
            Direction::Send => Some(
                history_counts(app, what)
                    .await
                    .map_err(|_| "Couldn't read this device's history.")?,
            ),
            Direction::Import => None,
        };
        {
            let mut slot = lock(&self.history);
            if self.cancel_count(link) != ticket {
                return Err(CANCELLED.into());
            }
            if slot.as_ref().is_some_and(|(l, _)| *l == link) {
                return Err(BUSY.into());
            }
            // Only a send needs the player's channel, once it's allowed.
            if direction == Direction::Send {
                *slot = Some((link, playing));
            }
        }
        let asked = handle.ask_history(direction, what, counts).await;
        if asked.is_err() {
            lock(&self.history).take_if(|(l, _)| *l == link);
        }
        // Cancelled while the request went out: it's withdrawn.
        if asked.is_ok() && self.cancel_count(link) != ticket {
            handle.cancel_transfer();
            return Err(CANCELLED.into());
        }
        asked.map_err(|e| match e {
            AskError::Unsupported => {
                "That device's Cinette can't copy history. Update it first.".to_string()
            }
            AskError::Busy => BUSY.to_string(),
            AskError::NotConnected => "Not connected to that device.".to_string(),
        })
    }

    /// "Import": the user confirmed the preview.
    pub fn start_import(&self, link: u64, transfer: String) -> Result<(), String> {
        let handle = self.link(link).ok_or("Not connected to that device.")?;
        handle.start_import(transfer);
        Ok(())
    }

    /// The webview saved the player's position, which an export waits for.
    pub fn progress_saved(&self, playing: Option<String>) {
        if let Some(waiter) = lock(&self.progress).take() {
            let _ = waiter.send(playing);
        }
    }

    /// Stops the transfer on link `link`, if one is going on.
    pub fn cancel_transfer(&self, link: u64) {
        *lock(&self.cancels).entry(link).or_default() += 1;
        if let Some(handle) = self.link(link) {
            handle.cancel_transfer();
        }
        lock(&self.sending).take_if(|(l, _)| *l == link);
        lock(&self.history).take_if(|(l, _)| *l == link);
    }

    /// How many cancels link `link` has had.
    fn cancel_count(&self, link: u64) -> u64 {
        lock(&self.cancels).get(&link).copied().unwrap_or(0)
    }

    /// Notes that the app went to the background or came back. Call
    /// [`Self::follow_foreground`] next.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(mobile), allow(dead_code))]
    pub fn set_foreground(&self, foreground: bool) {
        self.wants_foreground.store(foreground, Ordering::SeqCst);
    }

    /// Brings the target in line with the last [`Self::set_foreground`]:
    /// in the background it stops advertising and listening, and back in
    /// the foreground it listens again and advertises. Open sessions carry
    /// on either way. However the calls overlap, the last word wins.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(mobile), allow(dead_code))]
    pub async fn follow_foreground(&self) {
        self.follow_foreground_with(target::bind_default, &BIND_RETRIES)
            .await;
    }

    /// [`Self::follow_foreground`], listening on what `bind` gives. When it
    /// fails, it tries again after each of `retries` for as long as the app
    /// stays in the foreground.
    // Only the mobile apps go to the background.
    #[cfg_attr(not(mobile), allow(dead_code))]
    async fn follow_foreground_with<F, Fut>(&self, bind: F, retries: &[Duration])
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = std::io::Result<tokio::net::TcpListener>>,
    {
        let mut in_foreground = self.in_foreground.lock().await;
        let wanted = self.wants_foreground.load(Ordering::SeqCst);
        if wanted == *in_foreground {
            return;
        }
        if !wanted {
            tracing::info!("[remote] in the background; not taking new connections");
            self.handle.background().await;
            *in_foreground = false;
            return;
        }
        let mut waits = retries.iter();
        loop {
            let listening = match bind().await {
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
                    return;
                }
                Err(e) => tracing::warn!("[remote] couldn't listen again: {e}"),
            }
            let Some(wait) = waits.next() else {
                return;
            };
            tokio::time::sleep(*wait).await;
            if !self.wants_foreground.load(Ordering::SeqCst) {
                return;
            }
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

/// The providers the webview asked to send, as the link and the provider
/// ids, until the other device allows it.
type Sending = Arc<Mutex<Option<(u64, Vec<String>)>>>;

/// Runs `work` on a blocking thread, where waiting on the cache holds up
/// no async task. `None` when the thread panicked.
async fn blocking<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    work: impl FnOnce(&AppState) -> T + Send + 'static,
) -> Option<T> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<AppState>()))
        .await
        .ok()
}

/// What a send or ask cancelled on its way says.
const CANCELLED: &str = "Cancelled.";
/// What a second send while one waits says.
const BUSY: &str = "Another transfer with that device is going on.";

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
    /// What a controller with a session asks for: `None` is control.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asked: Option<AskedEvent>,
}

/// A transfer a controller asks for, as the dialog shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AskedEvent {
    History {
        direction: Direction,
        what: What,
        #[serde(skip_serializing_if = "Option::is_none")]
        counts: Option<Counts>,
    },
    Providers {
        providers: Vec<ProviderName>,
    },
}

impl From<&Asked> for AskedEvent {
    fn from(asked: &Asked) -> Self {
        match asked {
            Asked::History {
                direction,
                what,
                counts,
            } => AskedEvent::History {
                direction: *direction,
                what: *what,
                counts: *counts,
            },
            Asked::Providers(providers) => AskedEvent::Providers {
                providers: providers.clone(),
            },
        }
    }
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
        asked: prompt.asked.as_ref().map(AskedEvent::from),
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
/// The waits before each new try at listening when the app comes back to
/// the foreground and the port can't be bound, such as when the app is out
/// of file descriptors for a moment.
// Only the mobile apps go to the background.
#[cfg_attr(not(mobile), allow(dead_code))]
const BIND_RETRIES: [Duration; 4] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
/// The shortest time between two consent requests that ask for attention.
const RAISE_EVERY: Duration = Duration::from_secs(120);

/// Puts a record on the network, or doesn't.
type Advertiser = Box<dyn Fn(&Registration) -> Option<Advertisement> + Send + Sync>;

struct TauriHost<R: Runtime> {
    app: AppHandle<R>,
    /// The transfers under way, to keep the app running for them.
    transfers: Arc<Transfers>,
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
    /// See [`ProgressWaiter`].
    progress: ProgressWaiter,
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
        // A session that ended, however it ended, took its transfers along,
        // sometimes without a last word about them.
        let devices: HashSet<String> = sessions.iter().map(|s| s.device_id.to_string()).collect();
        self.transfers.retain(|key| match target_key_device(key) {
            Some(device) => devices.contains(device),
            None => true,
        });
        let list: Vec<SessionEvent> = sessions.iter().map(SessionEvent::from).collect();
        let _ = self.app.emit("remote://sessions", list);
    }

    fn blocked_changed(&self, blocked: &[BlockedDevice]) {
        // The block holds until Cinette quits even when the file can't be
        // written. There's no one to tell here, since the change came from
        // answering a dialog, so it's only logged.
        if let Err(e) = save(&self.app, BLOCKED_KEY, &blocked) {
            tracing::warn!("[remote] the blocked devices: {e}");
        }
        let _ = self.app.emit("remote://blocked", blocked);
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

    fn save_providers(&self, from: String, providers: Vec<ProviderSettings>, done: SavedProviders) {
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            let results =
                super::providers::save(&state.cache, &super::providers::Network, &from, providers)
                    .await;
            let added: Vec<&str> = results
                .iter()
                .filter(|r| r.outcome == ProviderOutcome::Added)
                .map(|r| r.saved_as.as_deref().unwrap_or(&r.name))
                .collect();
            if !added.is_empty() {
                let _ = app.emit(
                    "remote://providers-added",
                    serde_json::json!({ "from": from, "names": added }),
                );
            }
            done(results);
        });
    }

    fn transfer(&self, event: &TransferEvent) {
        // An import this device is asked for starts with its export right
        // after Allow, before the first progress, so that short moment isn't
        // covered.
        self.transfers.set(
            &target_key(&event.device_id, &event.transfer),
            super::running::under_way(&event.progress),
        );
        let _ = self.app.emit("remote://transfer-target", event);
    }

    fn export_history(&self, salt: Salt, what: What, done: Exported) {
        let app = self.app.clone();
        let waiter = self.progress.clone();
        tauri::async_runtime::spawn(async move {
            let playing = save_progress(&app, &waiter).await;
            // With the player page closed, the place comes from what was
            // handed over to Rust, saved now rather than up to a tick ago.
            crate::progress::save_now(&app);
            let export = run_blocking(app, move |state| {
                super::history::export(&state.cache, &salt, what, playing.as_deref())
            })
            .await;
            done(export);
        });
    }

    fn import_history(&self, from: String, salt: Salt, export: Export, done: Imported) {
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let emit = app.clone();
            let imported = run_blocking(app, move |state| {
                super::history::import(&state.cache, &salt, &export)
            })
            .await;
            done(imported.clone().map(|i| i.report));
            if let Ok(imported) = imported {
                let _ = emit.emit(
                    "remote://history-imported",
                    HistoryImported { from, imported },
                );
            }
        });
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

/// How many of each this device would send, read on a blocking thread.
pub async fn history_counts<R: Runtime>(
    app: AppHandle<R>,
    what: What,
) -> Result<Counts, ErrorCode> {
    run_blocking(app, move |state| super::history::counts(&state.cache, what)).await
}

/// Runs cache work on a blocking thread. A thread that panics fails it.
async fn run_blocking<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    work: impl FnOnce(&AppState) -> Result<T, ErrorCode> + Send + 'static,
) -> Result<T, ErrorCode> {
    blocking(app, work).await.unwrap_or(Err(ErrorCode::Failed))
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

/// What `remote://renamed` carries: the device a link controls has a new
/// name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedEvent<'a> {
    pub device_id: String,
    pub link: u64,
    pub name: &'a str,
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
    /// The transfers under way, to keep the app running for them.
    transfers: Arc<Transfers>,
    devices: Arc<Mutex<Devices>>,
    link: Arc<Mutex<Option<LinkHandle>>>,
    throttle: Arc<Mutex<Throttle>>,
    /// See [`RemoteService::send_providers`].
    sending: Sending,
    /// See [`SendingHistory`].
    history: SendingHistory,
}

/// What `remote://transfer` carries: a transfer this device asked for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferNotice {
    pub device_id: String,
    pub link: u64,
    #[serde(flatten)]
    pub update: TransferStep,
}

/// How a transfer this device asked for is going.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "step",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransferStep {
    /// The other device's user is deciding.
    Pending { expires_in_ms: u64 },
    /// The other device said no, or couldn't be asked.
    Refused {
        code: mvp_core::remote::message::ErrorCode,
    },
    Progress {
        transfer: String,
        progress: Progress,
    },
    /// "Import" was allowed: what the other device has, until the user
    /// starts it.
    Preview { transfer: String, counts: Counts },
    /// "Send" was allowed, and this device is reading its history out.
    Granted { transfer: String },
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
            // Whatever it was sending ended with it.
            self.transfers.set(&link_key(link), false);
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

    fn renamed(&self, link: u64, device: &DeviceId, name: &str) {
        if !self.current(link) {
            return;
        }
        let _ = self.app.emit(
            "remote://renamed",
            RenamedEvent {
                device_id: device.to_string(),
                link,
                name,
            },
        );
    }

    fn transfer(&self, link: u64, device: &DeviceId, event: &TransferUpdate) {
        if !self.current(link) {
            return;
        }
        let under_way = match event {
            TransferUpdate::Refused(_) => false,
            TransferUpdate::Progress { progress, .. } => super::running::under_way(progress),
            _ => true,
        };
        self.transfers.set(&link_key(link), under_way);
        let update = match event {
            TransferUpdate::ProvidersGranted { grant } => {
                return self.send_granted(link, device, grant.clone());
            }
            TransferUpdate::Pending { expires_in } => TransferStep::Pending {
                expires_in_ms: u64::from(*expires_in) * 1000,
            },
            TransferUpdate::Refused(code) => {
                self.ended(link);
                TransferStep::Refused { code: *code }
            }
            TransferUpdate::Progress { transfer, progress } => {
                if matches!(
                    progress,
                    Progress::Failed(_) | Progress::Done(_) | Progress::ProvidersDone(_)
                ) {
                    self.ended(link);
                }
                TransferStep::Progress {
                    transfer: transfer.clone(),
                    progress: progress.clone(),
                }
            }
            TransferUpdate::Preview { transfer, counts } => TransferStep::Preview {
                transfer: transfer.clone(),
                counts: *counts,
            },
            TransferUpdate::ExportNeeded {
                transfer,
                salt,
                what,
            } => {
                self.notify(
                    link,
                    device,
                    TransferStep::Granted {
                        transfer: transfer.clone(),
                    },
                );
                return self.export_granted(link, transfer.clone(), *salt, *what);
            }
            TransferUpdate::ImportReady {
                transfer,
                salt,
                export,
            } => {
                return self.import_arrived(
                    link,
                    device,
                    transfer.clone(),
                    *salt,
                    (**export).clone(),
                );
            }
        };
        self.notify(link, device, update);
    }
}

impl<R: Runtime> TauriLinkHost<R> {
    /// The transfer on `link` ended, however it ended: nothing waits for an
    /// Allow on it any more, so the next one can be asked for.
    fn ended(&self, link: u64) {
        lock(&self.sending).take_if(|(l, _)| *l == link);
        lock(&self.history).take_if(|(l, _)| *l == link);
    }

    fn notify(&self, link: u64, device: &DeviceId, update: TransferStep) {
        let _ = self.app.emit(
            "remote://transfer",
            TransferNotice {
                device_id: device.to_string(),
                link,
                update,
            },
        );
    }

    /// The other device allowed the providers: their settings go now, read
    /// from the cache only at this point.
    fn send_granted(&self, link: u64, device: &DeviceId, grant: String) {
        let handle = lock(&self.link)
            .as_ref()
            .filter(|l| l.generation() == link)
            .cloned();
        let ids = lock(&self.sending)
            .take_if(|(l, _)| *l == link)
            .map(|(_, ids)| ids);
        let (Some(handle), Some(ids)) = (handle, ids) else {
            return;
        };
        // The logins are read on a blocking thread, so a cache that's busy
        // doesn't hold up this link.
        let app = self.app.clone();
        let device = device.to_string();
        tauri::async_runtime::spawn(async move {
            let settings = blocking(app.clone(), move |state| {
                super::providers::settings_for(&state.cache, &ids)
            })
            .await;
            match settings {
                Some(Ok(settings)) => handle.send_providers(grant, settings),
                _ => {
                    handle.cancel_transfer();
                    let _ = app.emit(
                        "remote://transfer",
                        TransferNotice {
                            device_id: device,
                            link,
                            update: TransferStep::Refused {
                                code: mvp_core::remote::message::ErrorCode::Failed,
                            },
                        },
                    );
                }
            }
        });
    }
}

impl<R: Runtime> TauriLinkHost<R> {
    fn handle(&self, link: u64) -> Option<LinkHandle> {
        lock(&self.link)
            .as_ref()
            .filter(|l| l.generation() == link)
            .cloned()
    }

    /// "Send" was allowed: this device's history goes now.
    fn export_granted(&self, link: u64, transfer: String, salt: Salt, what: What) {
        let Some(handle) = self.handle(link) else {
            return;
        };
        let playing = lock(&self.history)
            .take_if(|(l, _)| *l == link)
            .and_then(|(_, playing)| playing);
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            // As in an export the other device asks for.
            crate::progress::save_now(&app);
            let export = run_blocking(app, move |state| {
                super::history::export(&state.cache, &salt, what, playing.as_deref())
            })
            .await;
            handle.send_export(transfer, export);
        });
    }

    /// "Import": the other device's history arrived; it's written here.
    fn import_arrived(
        &self,
        link: u64,
        device: &DeviceId,
        transfer: String,
        salt: Salt,
        export: Export,
    ) {
        let Some(handle) = self.handle(link) else {
            return;
        };
        let from = lock(&self.devices)
            .get(device)
            .map(|d| d.name.clone())
            .unwrap_or_default();
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let emit = app.clone();
            let imported = run_blocking(app, move |state| {
                super::history::import(&state.cache, &salt, &export)
            })
            .await;
            handle.imported(transfer, imported.clone().map(|i| i.report));
            if let Ok(imported) = imported {
                let _ = emit.emit(
                    "remote://history-imported",
                    HistoryImported { from, imported },
                );
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

/// Writes `value` under `key` in the settings file. When that fails, the
/// store keeps what it had, so a later write of the file doesn't save it
/// after all.
fn save<R: Runtime, T: Serialize>(app: &AppHandle<R>, key: &str, value: &T) -> Result<(), String> {
    let couldnt = |e: &dyn std::fmt::Display| {
        format!("This works until Cinette quits, but it couldn't be saved: {e}")
    };
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| couldnt(&e))?;
    let before = store.get(key);
    store.set(key, serde_json::to_value(value).map_err(|e| couldnt(&e))?);
    store.save().map_err(|e| {
        match before {
            Some(value) => store.set(key, value),
            None => {
                store.delete(key);
            }
        }
        couldnt(&e)
    })
}

/// What's saved under `key` in the settings file, or the default.
fn load<R: Runtime, T: serde::de::DeserializeOwned + Default>(app: &AppHandle<R>, key: &str) -> T {
    app.store(SETTINGS_STORE_FILE)
        .ok()
        .and_then(|store| store.get(key))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// The key a transfer on link `link`, which this device asked for, is
/// tracked under.
fn link_key(link: u64) -> String {
    format!("link:{link}")
}

/// The key a transfer another device runs with this one is tracked under.
fn target_key(device: &str, transfer: &str) -> String {
    format!("in:{device}:{transfer}")
}

/// The device a [`target_key`] belongs to, or `None` for another key.
fn target_key_device(key: &str) -> Option<&str> {
    key.strip_prefix("in:")?.split_once(':').map(|(device, _)| device)
}

/// The transfers tracker for this platform: on iOS it asks for time to
/// finish in the background. Android keeps running for a while anyway once
/// the app leaves the screen, and computers don't suspend it.
fn platform_transfers() -> Transfers {
    #[cfg(target_os = "ios")]
    return Transfers::new(Box::new(tauri_plugin_mpv::keep_running));
    #[cfg(not(target_os = "ios"))]
    Transfers::untracked()
}

/// Where the store says the user has opened Devices or the Remote control
/// settings once, after which remote control starts with the app.
const OPENED_KEY: &str = "remoteOpened";

/// Whether remote control waits for the user before it starts. On iOS it
/// does until they first open Devices or the Remote control settings, so
/// the local network prompt, which starting it raises, comes when they
/// can tell what it's for.
pub fn waits_for_user(ios: bool, opened_before: bool) -> bool {
    ios && !opened_before
}

fn opened_before<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.store(SETTINGS_STORE_FILE)
        .ok()
        .and_then(|store| store.get(OPENED_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn remember_opened<R: Runtime>(app: &AppHandle<R>) {
    let saved = app.store(SETTINGS_STORE_FILE).and_then(|store| {
        store.set(OPENED_KEY, true);
        store.save()
    });
    if let Err(e) = saved {
        tracing::warn!("[remote] couldn't remember that remote control was opened: {e}");
    }
}

/// Starts remote control with the app, unless it waits for the user (see
/// [`waits_for_user`]). Says whether it started.
pub fn start_at_launch<R: Runtime>(app: &AppHandle<R>, key_dir: PathBuf) -> bool {
    start_at_launch_with(cfg!(target_os = "ios"), opened_before(app), || {
        start(app, key_dir)
    })
}

/// [`start_at_launch`] on iOS or not, with the user having opened it before
/// or not, starting with `start`.
fn start_at_launch_with(ios: bool, opened_before: bool, start: impl FnOnce() -> bool) -> bool {
    if waits_for_user(ios, opened_before) {
        tracing::info!("[remote] waiting for Devices or the settings before starting");
        return false;
    }
    start()
}

/// Starts the target on every address and advertises it, and manages a
/// [`RemoteService`]. A failure is logged and the app carries on without
/// remote control, which [`open`] tries again. Says whether it started.
pub fn start<R: Runtime>(app: &AppHandle<R>, key_dir: PathBuf) -> bool {
    let started = tauri::async_runtime::block_on(start_on_network(app, key_dir));
    if let Err(e) = &started {
        tracing::error!("[remote] remote control didn't start: {e}");
    }
    started.is_ok()
}

async fn start_on_network<R: Runtime>(app: &AppHandle<R>, key_dir: PathBuf) -> Result<(), String> {
    let listener = target::bind_default().await.map_err(|e| e.to_string())?;
    start_on(
        app,
        key_dir,
        listener,
        Box::new(advertise_on_network),
        browse_network,
        target::Limits::STANDARD,
        platform_transfers(),
    )
}

/// Starts remote control if it isn't running: on iOS the first time the
/// user opens Devices or the Remote control settings, and anywhere after a
/// start that failed. Once it starts, the app starts it from then on, and
/// `multicast` is told to hold the Wi-Fi multicast lock if the app is still
/// in the foreground.
pub async fn open<R: Runtime>(
    app: &AppHandle<R>,
    key_dir: PathBuf,
    multicast: impl FnOnce(bool),
) -> Result<(), String> {
    open_with(app, start_on_network(app, key_dir), multicast).await
}

/// [`open`], starting with `start`.
async fn open_with<R: Runtime>(
    app: &AppHandle<R>,
    start: impl std::future::Future<Output = Result<(), String>>,
    multicast: impl FnOnce(bool),
) -> Result<(), String> {
    // One start at a time, so two quick opens don't start it twice.
    static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = STARTING.lock().await;
    if app.try_state::<RemoteService>().is_some() {
        return Ok(());
    }
    start.await.inspect_err(|e| {
        tracing::error!("[remote] remote control didn't start: {e}");
    })?;
    // Only a start that worked counts, so a failed one doesn't make every
    // later launch start it, and ask about the local network, by itself.
    remember_opened(app);
    // The app may have gone to the background while it started.
    if let Some(service) = app.try_state::<RemoteService>()
        && service.wants_foreground.load(Ordering::SeqCst)
    {
        multicast(true);
    }
    Ok(())
}

/// [`start`] on `listener`, advertising through `advertiser`, with `limits`. Call it inside
/// the async runtime.
fn start_on<R: Runtime>(
    app: &AppHandle<R>,
    key_dir: PathBuf,
    listener: tokio::net::TcpListener,
    advertiser: Advertiser,
    browse: impl FnOnce() -> mpsc::UnboundedReceiver<discovery::Event>,
    limits: target::Limits,
    transfers: Transfers,
) -> Result<(), String> {
    let transfers = Arc::new(transfers);
    let key = identity::load_or_create(&key_dir)
        .map_err(|e| format!("couldn't load the device key: {e}"))?;
    let settings: RemoteSettings = load(app, SETTINGS_KEY);
    let prompt = Arc::new(Mutex::new(None));
    let progress: ProgressWaiter = Arc::new(Mutex::new(None));
    let history: SendingHistory = Arc::new(Mutex::new(None));
    let host = Arc::new(TauriHost {
        app: app.clone(),
        transfers: transfers.clone(),
        advertiser,
        advertisement: Mutex::new(None),
        episodes: Mutex::new(VecDeque::new()),
        raised: Mutex::new(None),
        fetches: Mutex::new(Bucket::full()),
        loading: Gates::default(),
        prompt: prompt.clone(),
        progress: progress.clone(),
    });
    let device_id = key.device_id();
    let handle = target::start_with(
        listener,
        key.clone(),
        device_type(),
        settings.clone(),
        // A list with an id that doesn't read loads as none: the app wrote
        // it, so only a damaged file does that.
        load(app, BLOCKED_KEY),
        host,
        limits,
    )
    .map_err(|e| format!("couldn't listen: {e}"))?;
    let devices = Arc::new(Mutex::new(Devices::new(device_id.clone())));
    let link = Arc::new(Mutex::new(None));
    // Only now, with the key loaded and the target listening, so a start
    // that failed leaves no browse running, which on iOS would raise the
    // local network prompt by itself.
    follow_discovery(app.clone(), devices.clone(), browse());
    tracing::info!(
        "[remote] listening on port {} as {device_id}",
        handle.port()
    );
    let sending = Arc::new(Mutex::new(None));
    let link_host = Arc::new(TauriLinkHost {
        app: app.clone(),
        transfers,
        devices: devices.clone(),
        link: link.clone(),
        throttle: Arc::new(Mutex::new(Throttle::default())),
        sending: sending.clone(),
        history: history.clone(),
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
        sending,
        history,
        progress,
        cancels: Mutex::default(),
        wants_foreground: AtomicBool::new(true),
        in_foreground: tokio::sync::Mutex::new(true),
    });
    Ok(())
}

/// Where the app is, as the system says. Each platform maps its own events
/// to these, so the mapping reads the same in each and can't swap a bare
/// true and false.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// Only the mobile apps go to the background.
#[cfg_attr(not(mobile), allow(dead_code))]
pub enum Lifecycle {
    /// Android's onResume, iOS's willEnterForeground.
    Foreground,
    /// Android's onPause, which also comes while a system panel or a share
    /// sheet covers part of the app, and iOS's didEnterBackground.
    Background,
}

impl Lifecycle {
    /// From whether the app is in the background, as the mpv plugin passes
    /// on iOS's didEnterBackground (`true`) and willEnterForeground
    /// (`false`). Not Tauri's own Suspended, which iOS sends on
    /// applicationWillResignActive.
    // Only iOS reports it this way.
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub fn from_background(background: bool) -> Self {
        if background {
            Self::Background
        } else {
            Self::Foreground
        }
    }
}

/// Tells remote control that the app went to the background or came back.
/// On a phone, tablet or TV, the device can only be found while the app is
/// in the foreground.
// Only the mobile apps go to the background.
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn set_foreground<R: Runtime>(app: &AppHandle<R>, state: Lifecycle) {
    set_foreground_with(app, state, |hold| {
        #[cfg(target_os = "android")]
        crate::android_device::hold_multicast(hold);
        #[cfg(not(target_os = "android"))]
        let _ = hold;
    });
}

/// [`set_foreground`], calling `multicast` to hold the Wi-Fi multicast lock
/// or let it go, but only when remote control runs.
// Only the mobile apps go to the background.
#[cfg_attr(not(mobile), allow(dead_code))]
fn set_foreground_with<R: Runtime>(
    app: &AppHandle<R>,
    state: Lifecycle,
    multicast: impl FnOnce(bool),
) {
    let Some(service) = app.try_state::<RemoteService>() else {
        return;
    };
    let foreground = state == Lifecycle::Foreground;
    multicast(foreground);
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
