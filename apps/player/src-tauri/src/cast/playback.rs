// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Casting to one receiver at a time: connecting, loading the item the way
//! the frontend's route chose, the controls, and stopping.
//!
//! - The stream's URL is picked here from the item's URLs, by the place the
//!   frontend names. It only goes to the receiver the user chose.
//! - A converted route probes the source, picks its audio track, and starts
//!   the converter, which serves the receiver from this computer.
//! - Everything the receiver reports goes to the frontend as
//!   [`UPDATE_EVENT`].

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;

use mvp_core::cast::message::{LoadRequest, StreamType};
use mvp_core::cast::session::Session;
use mvp_core::convert::{pick_audio, AudioPlan, Plan, VideoPlan, CAST_AUDIO};
use mvp_core::models::channel::Channel;
use mvp_core::remote::catalog::{provider_host, shareable_logo};
use mvp_core::streams::format::Container;
use mvp_core::streams::probe::ProbeError;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use super::link::{drive, CastUpdate, Command};
use super::tls;
use super::CastReceivers;
use crate::commands::AppState;
use crate::convert::{Conversion, ConvertError, Ended};
use crate::streams::{fetch_urls, StreamsState, REFUSED};

/// The event that carries each [`CastUpdate`], with its receiver's id.
pub const UPDATE_EVENT: &str = "cast://update";

/// How the receiver gets the item, as the frontend's route chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "via", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CastRoute {
    /// The receiver fetches the item's URL at `source` itself.
    Direct { source: usize, container: Container },
    /// This computer converts the URL at `source`.
    Converted {
        source: usize,
        video: VideoChoice,
        audio: AudioChoice,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoChoice {
    Copy,
    Transcode,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioChoice {
    Copy,
    Aac,
    None,
}

/// A control for the receiver.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum CastAction {
    Play,
    Pause,
    /// To an absolute position, in seconds.
    Seek {
        to: f64,
    },
    /// 0 to 1.
    Volume {
        level: f64,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    receiver_id: String,
    update: CastUpdate,
}

/// The cast that runs now.
struct Active {
    receiver_id: String,
    /// Tells a cast from the one before it, so an old one ending doesn't
    /// clear a new one.
    generation: u64,
    commands: mpsc::UnboundedSender<Command>,
    /// The converter serving the receiver, for a converted route.
    conversion: Option<Conversion>,
}

/// The app's casts, managed by Tauri.
#[derive(Default)]
pub struct CastPlayback {
    active: Mutex<Option<Active>>,
    generation: Mutex<u64>,
    /// Each receiver's certificate, from its first connection in this run.
    pins: Mutex<HashMap<String, Vec<u8>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn emit<R: Runtime>(app: &AppHandle<R>, receiver_id: &str, update: CastUpdate) {
    let event = UpdateEvent {
        receiver_id: receiver_id.to_string(),
        update,
    };
    let _ = app.emit(UPDATE_EVENT, event);
}

/// A sender id for one connection.
fn sender_id() -> String {
    format!("sender-{}", &mvp_core::convert::serve::token()[..8])
}

/// Starts driving a cast to `receiver_id` over `stream`, and makes it the
/// active one in place of any other.
pub(crate) fn begin<R, S>(app: &AppHandle<R>, receiver_id: &str, stream: S)
where
    R: Runtime,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let state = app.state::<CastPlayback>();
    let generation = {
        let mut generation = lock(&state.generation);
        *generation += 1;
        *generation
    };
    let (commands, receiver) = mpsc::unbounded_channel();
    let (session, first) = Session::start(sender_id(), std::time::Instant::now());
    let old = lock(&state.active).replace(Active {
        receiver_id: receiver_id.to_string(),
        generation,
        commands,
        conversion: None,
    });
    if let Some(old) = old {
        let _ = old.commands.send(Command::Stop);
    }
    let app = app.clone();
    let id = receiver_id.to_string();
    tauri::async_runtime::spawn(async move {
        drive(stream, session, first, receiver, |update| {
            emit(&app, &id, update)
        })
        .await;
        // Over: the converter stops with it.
        let state = app.state::<CastPlayback>();
        let mut active = lock(&state.active);
        if active.as_ref().is_some_and(|a| a.generation == generation) {
            *active = None;
        }
    });
}

/// The active cast's command sender, if `receiver_id` has it.
fn commands_for(state: &CastPlayback, receiver_id: &str) -> Option<mpsc::UnboundedSender<Command>> {
    lock(&state.active)
        .as_ref()
        .filter(|a| a.receiver_id == receiver_id)
        .map(|a| a.commands.clone())
}

/// Connects to `receiver_id` unless it's the active cast already.
async fn ensure_connected<R: Runtime>(app: &AppHandle<R>, receiver_id: &str) -> Result<(), String> {
    let state = app.state::<CastPlayback>();
    if commands_for(&state, receiver_id).is_some_and(|c| !c.is_closed()) {
        return Ok(());
    }
    let (addr, port) = app
        .state::<CastReceivers>()
        .registry()
        .get(receiver_id)
        .map(|r| (r.addr, r.port))
        .ok_or("notFound")?;
    let pin = lock(&state.pins).get(receiver_id).cloned();
    match tls::connect(addr, port, pin.as_deref()).await {
        Ok((stream, presented)) => {
            lock(&state.pins).insert(receiver_id.to_string(), presented);
            begin(app, receiver_id, stream);
            Ok(())
        }
        Err(e) => {
            super::update(app, |registry| registry.unreachable(receiver_id));
            Err(match e {
                tls::TlsError::NotPinned => "notPinned",
                _ => "unreachable",
            }
            .into())
        }
    }
}

/// The MIME type a receiver expects for `container`, and whether it's HLS
/// with MPEG-TS segments.
pub(crate) fn content_type(container: Container) -> (&'static str, bool) {
    match container {
        Container::HlsTs => ("application/x-mpegURL", true),
        Container::HlsFmp4 => ("application/x-mpegURL", false),
        Container::Mp4 => ("video/mp4", false),
        Container::Mkv => ("video/x-matroska", false),
        Container::Ts => ("video/mp2t", false),
        Container::Other => ("application/octet-stream", false),
    }
}

/// The channel's logo, when it can leave this computer: no login, no query
/// and not on a provider's server.
fn logo<R: Runtime>(app: &AppHandle<R>, channel: &Channel) -> Option<String> {
    let logo = channel.logo_url.as_deref()?;
    let hosts: Vec<String> = {
        let state = app.state::<AppState>();
        let cache = state.cache.lock().ok()?;
        cache
            .get_providers()
            .unwrap_or_default()
            .iter()
            .flat_map(|p| [Some(p.url.as_str()), p.epg_url.as_deref()])
            .flatten()
            .filter_map(provider_host)
            .collect()
    };
    shareable_logo(logo, &hosts).then(|| logo.to_string())
}

/// The plan for converting `url`, from what a probe finds in it.
async fn conversion_plan<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    video: VideoChoice,
    audio: AudioChoice,
    start_at: Option<f64>,
) -> Result<Plan, String> {
    let probed = crate::streams::probe(app, url).await.map_err(|e| match e {
        ProbeError::Refused(_) => REFUSED.to_string(),
        _ => "unreachable".to_string(),
    })?;
    let (audio_track, audio) = match audio {
        AudioChoice::None => (0, AudioPlan::None),
        AudioChoice::Copy | AudioChoice::Aac => pick_audio(&probed.audio_tracks, None, &CAST_AUDIO),
    };
    let video = match (video, probed.video) {
        (VideoChoice::None, _) | (_, None) => VideoPlan::None,
        (VideoChoice::Copy, Some(_)) => VideoPlan::Copy,
        (VideoChoice::Transcode, Some(_)) => VideoPlan::Transcode {
            deinterlace: probed.interlaced,
        },
    };
    Ok(Plan {
        video,
        audio,
        start_at: start_at.filter(|_| probed.duration.is_some()),
        audio_track,
    })
}

/// Starts the converter for `url` and serves it to `receiver`.
async fn start_conversion<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    plan: &Plan,
    receiver: IpAddr,
) -> Result<Conversion, String> {
    let encoders = crate::convert::support::support(app)
        .await
        .encoders
        .ok_or("noConverter")?;
    crate::convert::start(app, url, plan, encoders, receiver)
        .await
        .map_err(|e| match e {
            ConvertError::Refused(_) => REFUSED.to_string(),
            ConvertError::NoEncoder => "noEncoder".to_string(),
            ConvertError::NoRoute => "noRoute".to_string(),
            ConvertError::Unreachable => "unreachable".to_string(),
            ConvertError::Failed(_) => "converterFailed".to_string(),
        })
}

/// Plays `channel` on `receiver_id` the way `route` says, from `start_at`
/// seconds for an item with a length. Connects first when needed. Rejects
/// with `notFound`, `unreachable`, `notPinned`, `refused`, `noConverter`,
/// `noEncoder`, `noRoute`, `converterFailed` or `noSource`.
pub async fn load<R: Runtime>(
    app: &AppHandle<R>,
    receiver_id: &str,
    channel: &Channel,
    route: CastRoute,
    start_at: Option<f64>,
) -> Result<(), String> {
    let urls = {
        let state = app.state::<AppState>();
        let streams = app.state::<StreamsState>();
        fetch_urls(&state, &streams, channel).await?
    };
    let source = match route {
        CastRoute::Direct { source, .. } | CastRoute::Converted { source, .. } => source,
    };
    let url = urls.get(source).ok_or("noSource")?;
    let live = channel.content_type == "live";
    let mut request = LoadRequest {
        url: String::new(),
        content_type: String::new(),
        stream_type: if live {
            StreamType::Live
        } else {
            StreamType::Buffered
        },
        hls_ts_segments: false,
        title: channel.name.clone(),
        image: logo(app, channel),
        start_at: start_at.filter(|_| !live),
        text_tracks: Vec::new(),
        active_track_ids: Vec::new(),
    };
    let mut conversion = None;
    match route {
        CastRoute::Direct { container, .. } => {
            let (content_type, ts) = content_type(container);
            request.url = url.clone();
            request.content_type = content_type.into();
            request.hls_ts_segments = ts;
        }
        CastRoute::Converted { video, audio, .. } => {
            let receiver = app
                .state::<CastReceivers>()
                .registry()
                .get(receiver_id)
                .map(|r| r.addr)
                .ok_or("notFound")?;
            let plan = conversion_plan(app, url, video, audio, start_at).await?;
            let started = start_conversion(app, url, &plan, receiver).await?;
            // The converted stream starts where the plan does, and has no
            // length the receiver can seek in.
            request.url = started.url.clone();
            request.content_type = "video/x-matroska".into();
            request.stream_type = StreamType::Live;
            request.start_at = None;
            conversion = Some(started);
        }
    }
    ensure_connected(app, receiver_id).await?;
    let state = app.state::<CastPlayback>();
    let mut active = lock(&state.active);
    let active = active
        .as_mut()
        .filter(|a| a.receiver_id == receiver_id)
        .ok_or("unreachable")?;
    // Any earlier conversion stops here, after the receiver was told of the
    // new stream.
    active
        .commands
        .send(Command::Load(Box::new(request)))
        .map_err(|_| "unreachable")?;
    if let Some(conversion) = &conversion {
        watch_conversion(
            app,
            receiver_id,
            active.generation,
            conversion.ended.clone(),
        );
    }
    active.conversion = conversion;
    Ok(())
}

/// Tells the frontend when the converter for cast `generation` stops with
/// an error, such as a live stream that dropped. The receiver would
/// otherwise wait on a stream that never comes.
fn watch_conversion<R: Runtime>(
    app: &AppHandle<R>,
    receiver_id: &str,
    generation: u64,
    mut ended: tokio::sync::watch::Receiver<Option<Ended>>,
) {
    let app = app.clone();
    let id = receiver_id.to_string();
    tauri::async_runtime::spawn(async move {
        let Ok(end) = ended.wait_for(Option::is_some).await.map(|e| e.clone()) else {
            return;
        };
        let Some(Ended::Failed(e)) = end else {
            return;
        };
        let state = app.state::<CastPlayback>();
        let current = lock(&state.active)
            .as_ref()
            .is_some_and(|a| a.generation == generation);
        if current {
            let refused = matches!(e, ConvertError::Refused(_));
            emit(&app, &id, CastUpdate::ConversionFailed { refused });
        }
    });
}

/// Sends `action` to the active cast on `receiver_id`.
pub fn control(state: &CastPlayback, receiver_id: &str, action: CastAction) -> Result<(), String> {
    let commands = commands_for(state, receiver_id).ok_or("notConnected")?;
    let command = match action {
        CastAction::Play => Command::Play,
        CastAction::Pause => Command::Pause,
        CastAction::Seek { to } => Command::Seek(to),
        CastAction::Volume { level } => Command::Volume(level),
    };
    commands
        .send(command)
        .map_err(|_| "notConnected".to_string())
}

/// Ends the cast on `receiver_id`: the receiver goes back to what it
/// showed, and the converter stops.
pub fn stop(state: &CastPlayback, receiver_id: &str) {
    let mut active = lock(&state.active);
    if let Some(ended) = active.take_if(|a| a.receiver_id == receiver_id) {
        let _ = ended.commands.send(Command::Stop);
    }
}
