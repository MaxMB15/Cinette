// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The `remote_*` commands the webview calls for remote control.
//!
//! They're registered on every platform, so the frontend's calls are the
//! same everywhere. Where remote control doesn't run (Windows) they fail
//! with [`UNAVAILABLE`].

// Only the error path builds where remote control doesn't run, so the
// types it would read go unused there.
#![cfg_attr(not(remote), allow(dead_code))]

use mvp_core::models::channel::Channel;
use mvp_core::remote::message::{
    Capabilities, ErrorCode, PlaybackError, PlaybackSnapshot, PlaybackStatus, Track,
};
use mvp_core::remote::consent::Answer;
use mvp_core::remote::settings::{ControlMode, RemoteSettings};
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Runtime};

/// The error where remote control doesn't run.
#[cfg_attr(remote, allow(dead_code))]
pub const UNAVAILABLE: &str = "Remote control isn't available on this device yet.";

/// The settings screen's view of remote control.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsView {
    pub discoverable: bool,
    pub remote_control: ControlMode,
    /// The name the user gave, if any.
    pub device_name: Option<String>,
    /// The name used when none is given: the device type.
    pub default_name: String,
    pub device_id: String,
}

/// The settings as the webview sends them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsInput {
    pub discoverable: bool,
    pub remote_control: ControlMode,
    pub device_name: Option<String>,
}

impl RemoteSettingsInput {
    /// A blank or all-control-character name means "use the default".
    fn into_settings(self) -> RemoteSettings {
        RemoteSettings {
            discoverable: self.discoverable,
            remote_control: self.remote_control,
            device_name: self
                .device_name
                .as_deref()
                .and_then(mvp_core::remote::settings::clean_name),
        }
    }
}

/// What's playing, as the player sends it. The item comes as the channel's
/// fields, and only what [`mvp_core::remote::catalog::CatalogItem`] keeps
/// goes on to controllers.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub status: PlaybackStatus,
    pub item: Option<PlayerItem>,
    pub position: f64,
    pub duration: f64,
    pub volume: Option<f64>,
    #[serde(default)]
    pub subtitles: Vec<Track>,
    pub subtitle_id: Option<String>,
    #[serde(default)]
    pub audio: Vec<Track>,
    pub audio_id: Option<String>,
    #[serde(default)]
    pub capabilities: Capabilities,
    pub error: Option<PlaybackError>,
}

/// The playing channel's fields that a controller may see, plus its logo,
/// which is only passed on if it can't point at a provider.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerItem {
    pub id: String,
    pub name: String,
    pub content_type: String,
    #[serde(default)]
    pub group: String,
    pub logo_url: Option<String>,
    pub series_title: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    /// The hosts it streams from. Never sent on; a logo on the same site is
    /// dropped.
    #[serde(default)]
    pub stream_hosts: Vec<String>,
}

/// A number the webview sent, or 0 if it isn't one.
fn finite(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

impl PlayerState {
    /// The snapshot controllers get. `provider_hosts` decide which logos
    /// can go.
    pub fn into_snapshot(self, provider_hosts: &[String]) -> PlaybackSnapshot {
        let item = self.item.map(|i| {
            let mut hosts = provider_hosts.to_vec();
            hosts.extend(i.stream_hosts.iter().map(|h| h.to_ascii_lowercase()));
            let channel = Channel {
                id: i.id,
                name: i.name,
                content_type: i.content_type,
                group_title: i.group,
                logo_url: i.logo_url,
                series_title: i.series_title,
                season: i.season,
                episode: i.episode,
                ..Channel::default()
            };
            let mut item = mvp_core::remote::catalog::CatalogItem::from_channel(&channel, &hosts);
            if item
                .logo
                .as_deref()
                .is_some_and(|logo| super::logos::on_a_provider_site(logo, &hosts))
            {
                item.logo = None;
            }
            item
        });
        PlaybackSnapshot {
            status: self.status,
            item,
            position: finite(self.position),
            duration: finite(self.duration),
            volume: self
                .volume
                .filter(|v| v.is_finite())
                .map(|v| v.round().clamp(0.0, 100.0) as u8),
            subtitles: self.subtitles,
            subtitle_id: self.subtitle_id,
            audio: self.audio,
            audio_id: self.audio_id,
            capabilities: self.capabilities,
            error: self.error,
        }
    }
}

/// What the player answers to a `remote://command`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandOutcome {
    Ok,
    /// The item changed before the command could run.
    StaleItem,
    /// The player can't do this now.
    Unsupported,
    /// The item to load isn't one this device has.
    NotFound,
    /// The player tried and failed.
    Failed,
}

impl CommandOutcome {
    pub fn into_result(self) -> Result<(), ErrorCode> {
        match self {
            Self::Ok => Ok(()),
            Self::StaleItem => Err(ErrorCode::StaleItem),
            Self::Unsupported => Err(ErrorCode::Unsupported),
            Self::NotFound => Err(ErrorCode::NotFound),
            Self::Failed => Err(ErrorCode::Failed),
        }
    }
}

#[cfg(remote)]
mod imp {
    use super::*;
    use crate::remote::device::device_type;
    use crate::remote::service::SessionEvent;
    use crate::remote::RemoteService;
    use mvp_core::remote::identity::DeviceId;
    use tauri::{Manager, State};

    /// The device id a command named.
    pub fn device_id(text: &str) -> Result<DeviceId, String> {
        DeviceId::parse(text).ok_or_else(|| "That isn't a device id.".to_owned())
    }

    pub fn service<R: Runtime>(app: &AppHandle<R>) -> Result<State<'_, RemoteService>, String> {
        app.try_state::<RemoteService>()
            .ok_or_else(|| "Remote control didn't start on this device.".to_owned())
    }

    pub fn settings_view(service: &RemoteService) -> RemoteSettingsView {
        let settings = service.settings();
        RemoteSettingsView {
            discoverable: settings.discoverable,
            remote_control: settings.remote_control,
            device_name: settings.device_name,
            default_name: mvp_core::remote::settings::default_name(device_type()).to_owned(),
            device_id: service.device_id().to_string(),
        }
    }

    pub async fn sessions(service: &RemoteService) -> Vec<SessionEvent> {
        service
            .handle
            .sessions()
            .await
            .iter()
            .map(SessionEvent::from)
            .collect()
    }

    pub fn not_connected() -> String {
        "link_not_connected".to_owned()
    }

    /// The error code the webview gets: the other device's, as the protocol
    /// spells it, or the link's own, which start with `link_`.
    pub fn link_error(e: crate::remote::link::LinkError) -> String {
        match e {
            crate::remote::link::LinkError::NotConnected => not_connected(),
            crate::remote::link::LinkError::TimedOut => "link_timed_out".to_owned(),
            crate::remote::link::LinkError::Busy => "link_busy".to_owned(),
            crate::remote::link::LinkError::Refused(code) => serde_json::to_value(code)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "failed".to_owned()),
        }
    }

    pub fn provider_hosts<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
        let state = app.state::<crate::commands::AppState>();
        let Ok(cache) = state.cache.lock() else {
            return Vec::new();
        };
        cache
            .get_providers()
            .unwrap_or_default()
            .iter()
            .flat_map(|p| [Some(p.url.as_str()), p.epg_url.as_deref()])
            .flatten()
            .filter_map(mvp_core::remote::catalog::provider_host)
            .collect()
    }
}

/// The remote-control settings and this device's id.
#[command]
pub async fn remote_get_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<RemoteSettingsView, String> {
    #[cfg(remote)]
    {
        Ok(imp::settings_view(&*imp::service(&app)?))
    }
    #[cfg(not(remote))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// Saves the settings. Never allow ends every session at once.
#[command]
pub async fn remote_set_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: RemoteSettingsInput,
) -> Result<RemoteSettingsView, String> {
    #[cfg(remote)]
    {
        let service = imp::service(&app)?;
        service.set_settings(&app, settings.into_settings())?;
        Ok(imp::settings_view(&service))
    }
    #[cfg(not(remote))]
    {
        let _ = (app, settings);
        Err(UNAVAILABLE.into())
    }
}

/// Makes a new device key, so a new device id. Every session ends.
#[command]
pub async fn remote_reset_identity<R: Runtime>(
    app: AppHandle<R>,
) -> Result<RemoteSettingsView, String> {
    #[cfg(remote)]
    {
        let service = imp::service(&app)?;
        service.reset_identity()?;
        Ok(imp::settings_view(&service))
    }
    #[cfg(not(remote))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// The user's answer to a consent dialog: `allow`, `deny`, which blocks a
/// device asking for control, or `dismiss`, for a dialog closed without a
/// choice, which refuses only this request.
#[command]
pub async fn remote_answer_consent<R: Runtime>(
    app: AppHandle<R>,
    request: u64,
    answer: Answer,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?.handle.answer(request, answer);
        Ok(())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, request, answer);
        Err(UNAVAILABLE.into())
    }
}

/// The devices the user denied, oldest first.
#[command]
pub async fn remote_blocked<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(remote)]
    {
        let blocked = imp::service(&app)?.handle.blocked().await;
        serde_json::to_value(blocked).map_err(|e| e.to_string())
    }
    #[cfg(not(remote))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// Lets a device the user denied ask again.
#[command]
pub async fn remote_unblock<R: Runtime>(
    app: AppHandle<R>,
    device_id: String,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        let device = imp::device_id(&device_id)?;
        imp::service(&app)?.handle.unblock(device);
        Ok(())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, device_id);
        Err(UNAVAILABLE.into())
    }
}

/// The controllers, connected or waiting to resume.
#[command]
pub async fn remote_sessions<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(remote)]
    {
        let sessions = imp::sessions(&*imp::service(&app)?).await;
        serde_json::to_value(sessions).map_err(|e| e.to_string())
    }
    #[cfg(not(remote))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// The consent request on screen, or null, for a webview that wasn't
/// listening when `remote://consent` brought it, as after a reload.
#[command]
pub async fn remote_pending_consent<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    #[cfg(remote)]
    {
        serde_json::to_value(imp::service(&app)?.pending_consent()).map_err(|e| e.to_string())
    }
    #[cfg(not(remote))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// Ends one controller's session.
#[command]
pub async fn remote_disconnect<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?.handle.disconnect(session_id);
        Ok(())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, session_id);
        Err(UNAVAILABLE.into())
    }
}

/// The player's state, for controllers.
#[command]
pub async fn remote_set_state<R: Runtime>(
    app: AppHandle<R>,
    state: PlayerState,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        let service = imp::service(&app)?;
        let hosts = imp::provider_hosts(&app);
        service.handle.set_state(state.into_snapshot(&hosts));
        Ok(())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, state);
        Err(UNAVAILABLE.into())
    }
}

/// The player's answer to a `remote://command`.
#[command]
pub async fn remote_finish_command<R: Runtime>(
    app: AppHandle<R>,
    token: u64,
    outcome: CommandOutcome,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?
            .handle
            .finish_command(token, outcome.into_result());
        Ok(())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, token, outcome);
        Err(UNAVAILABLE.into())
    }
}

/// The other Cinette devices on the network.
#[command]
pub async fn remote_devices<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(remote)]
    {
        serde_json::to_value(imp::service(&app)?.devices()).map_err(|e| e.to_string())
    }
    #[cfg(not(remote))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// Starts remote control if it isn't running yet: on iOS when the user first
/// opens Devices or the Remote control settings, and anywhere after a start
/// that failed. The webview calls it before either of those loads.
#[command]
pub async fn remote_open<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(remote)]
    {
        use tauri::Manager;
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        // The multicast lock goes with remote control running, and the
        // launch didn't take it if this is what starts it.
        crate::remote::open(&app, dir, |hold| {
            #[cfg(target_os = "android")]
            crate::android_device::hold_multicast(hold);
            #[cfg(not(target_os = "android"))]
            let _ = hold;
        })
        .await
    }
    #[cfg(not(remote))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// Whether macOS or iOS refuses this app the local network, so no device can
/// be found. Always false elsewhere.
// mutants: skip FnValue: mutation runs build on Linux, where nothing refuses local network access, so false is what the code returns there too.
#[command]
pub async fn remote_local_network_denied() -> bool {
    #[cfg(remote)]
    {
        crate::discovery::local_network_denied()
    }
    #[cfg(not(remote))]
    {
        false
    }
}

/// Asks a device for control. Progress comes as `remote://controller`.
/// `link` is a number the webview picks to tell this link from others: its
/// events carry it, and its commands name it.
#[command]
pub async fn remote_connect<R: Runtime>(
    app: AppHandle<R>,
    device_id: String,
    link: u64,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        let id = imp::device_id(&device_id)?;
        imp::service(&app)?.connect(id, link)
    }
    #[cfg(not(remote))]
    {
        let _ = (app, device_id, link);
        Err(UNAVAILABLE.into())
    }
}

/// The link this device holds now, if any, as the number `remote_connect`
/// was given. A webview that reloaded uses it to drop a link it forgot.
#[command]
pub async fn remote_link<R: Runtime>(app: AppHandle<R>) -> Result<Option<u64>, String> {
    #[cfg(remote)]
    {
        Ok(imp::service(&app)?.current_link())
    }
    #[cfg(not(remote))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// Ends link `link` to the controlled device, or stops it asking. That
/// device keeps playing. Another link that took its place stays.
#[command]
pub async fn remote_leave<R: Runtime>(app: AppHandle<R>, link: u64) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?.leave(link).await;
        Ok(())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, link);
        Err(UNAVAILABLE.into())
    }
}

/// Sends a playback command to the controlled device through link `link`. Resolves with that
/// device's state version once it carried the command out; fails with an
/// error code as the protocol spells it, such as `stale_item`, or one of
/// the link's own: `link_not_connected` with no session, `link_timed_out`
/// when no answer came, and `link_busy` when too many wait for one.
#[command]
pub async fn remote_command<R: Runtime>(
    app: AppHandle<R>,
    command: mvp_core::remote::message::Command,
    link: u64,
) -> Result<u64, String> {
    #[cfg(remote)]
    {
        let link = imp::service(&app)?
            .link(link)
            .ok_or_else(imp::not_connected)?;
        link.command(command).await.map_err(imp::link_error)
    }
    #[cfg(not(remote))]
    {
        let _ = (app, command, link);
        Err(UNAVAILABLE.into())
    }
}

/// A page of the controlled device's catalog, through link `link`.
#[command]
pub async fn remote_catalog<R: Runtime>(
    app: AppHandle<R>,
    catalog_query: mvp_core::remote::catalog::CatalogQuery,
    link: u64,
) -> Result<serde_json::Value, String> {
    #[cfg(remote)]
    {
        let link = imp::service(&app)?
            .link(link)
            .ok_or_else(imp::not_connected)?;
        let (items, next) = link.catalog(catalog_query).await.map_err(imp::link_error)?;
        let items: Vec<_> = items.into_iter().map(super::logos::checked).collect();
        Ok(serde_json::json!({ "items": items, "next": next }))
    }
    #[cfg(not(remote))]
    {
        let _ = (app, catalog_query, link);
        Err(UNAVAILABLE.into())
    }
}

/// Asks the device link `link` controls to take the providers with these
/// ids. Only their names go now; how it goes comes as `remote://transfer`.
#[command]
pub async fn remote_send_providers<R: Runtime>(
    app: AppHandle<R>,
    link: u64,
    provider_ids: Vec<String>,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?
            .send_providers(app.clone(), link, provider_ids)
            .await
    }
    #[cfg(not(remote))]
    {
        let _ = (app, link, provider_ids);
        Err(UNAVAILABLE.into())
    }
}

/// Asks the device link `link` controls to copy history one way or the
/// other. For "send", `playing` is the channel this device's player has
/// open, whose position the webview saved first. How it goes comes as
/// `remote://transfer`.
#[command]
pub async fn remote_ask_history<R: Runtime>(
    app: AppHandle<R>,
    link: u64,
    direction: mvp_core::remote::transfer::flow::Direction,
    what: mvp_core::remote::transfer::What,
    playing: Option<String>,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?
            .ask_history(app.clone(), link, direction, what, playing)
            .await
    }
    #[cfg(not(remote))]
    {
        let _ = (app, link, direction, what, playing);
        Err(UNAVAILABLE.into())
    }
}

/// How many of each this device would send, for the preview before asking.
#[command]
pub async fn remote_history_counts<R: Runtime>(
    app: AppHandle<R>,
    what: mvp_core::remote::transfer::What,
) -> Result<mvp_core::remote::transfer::Counts, String> {
    #[cfg(remote)]
    {
        super::service::history_counts(app, what)
            .await
            .map_err(|_| "Couldn't read this device's history.".to_string())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, what);
        Err(UNAVAILABLE.into())
    }
}

/// Starts an import the other device allowed, after its preview.
#[command]
pub async fn remote_start_import<R: Runtime>(
    app: AppHandle<R>,
    link: u64,
    transfer: String,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?.start_import(link, transfer)
    }
    #[cfg(not(remote))]
    {
        let _ = (app, link, transfer);
        Err(UNAVAILABLE.into())
    }
}

/// The player saved its position, as `remote://save-progress` asked, and
/// has `playing` open.
#[command]
pub async fn remote_progress_saved<R: Runtime>(
    app: AppHandle<R>,
    playing: Option<String>,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?.progress_saved(playing);
        Ok(())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, playing);
        Err(UNAVAILABLE.into())
    }
}

/// Stops the transfer on link `link`, unless one side already has it all
/// and is writing it, which then goes on. Stopped in time, nothing is
/// written on either device.
#[command]
pub async fn remote_cancel_transfer<R: Runtime>(
    app: AppHandle<R>,
    link: u64,
) -> Result<(), String> {
    #[cfg(remote)]
    {
        imp::service(&app)?.cancel_transfer(link);
        Ok(())
    }
    #[cfg(not(remote))]
    {
        let _ = (app, link);
        Err(UNAVAILABLE.into())
    }
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
