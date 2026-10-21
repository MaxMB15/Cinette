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
use std::future::Future;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Duration;

use mvp_core::cast::message::{LoadRequest, StreamType};
use mvp_core::cast::session::{Session, PING_INTERVAL, SILENCE_LIMIT};
use mvp_core::convert::{matroska_copies, pick_audio, AudioPlan, Plan, VideoPlan, CAST_AUDIO};
use mvp_core::models::channel::Channel;
use mvp_core::remote::catalog::{provider_host, shareable_logo};
use mvp_core::streams::format::Container;
use mvp_core::streams::hls::{self, HlsError};
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
use crate::lan_server::{route_to, NoRoute};
use crate::streams::{StreamsState, REFUSED};

/// The event that carries each [`CastUpdate`], with its receiver's id.
pub const UPDATE_EVENT: &str = "cast://update";

/// How the receiver gets the item, as the frontend's route chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "via", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CastRoute {
    /// The receiver fetches the item's URL at `source` itself.
    Direct {
        generation: u64,
        source: usize,
        container: Container,
    },
    /// This computer converts the URL at `source`, which comes as
    /// `container`.
    Converted {
        generation: u64,
        source: usize,
        container: Container,
        video: VideoChoice,
        audio: AudioChoice,
    },
}

impl CastRoute {
    /// The URL list the route was worked out from, and its URL's place in it.
    fn source(self) -> (u64, usize) {
        match self {
            CastRoute::Direct {
                generation, source, ..
            }
            | CastRoute::Converted {
                generation, source, ..
            } => (generation, source),
        }
    }
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
    /// The task that drives the session.
    driver: tauri::async_runtime::JoinHandle<()>,
    /// This computer's address on the session's connection, when known.
    local: Option<IpAddr>,
    /// The converter serving the receiver, for a converted route.
    conversion: Option<Conversion>,
    /// The plan the converter follows, which a seek or a resume of the
    /// same item reuses. It lasts only as long as this cast, since a
    /// channel's tracks can change between casts.
    plan: Option<KnownPlan>,
}

/// How long a load waits to ask the provider again after it refused the
/// stream right after the load closed the receiver's old connection.
const FREED_WAIT: Duration = Duration::from_millis(1500);

/// What a load rejects with when a newer load or a stop for the same
/// receiver came while it ran.
pub const SUPERSEDED: &str = "superseded";

/// A receiver's newest load or stop. An older load gives up.
#[derive(Default, Clone, Copy)]
struct Turn {
    ticket: u64,
    /// The newest was a stop, so a session an older load opened ends too.
    stopped: bool,
}

/// The plan of a receiver's last conversion and what it was made for, so a
/// seek or a resume of the same item doesn't probe the provider again.
#[derive(Clone)]
struct KnownPlan {
    channel_id: String,
    generation: u64,
    source: usize,
    video: VideoChoice,
    audio: AudioChoice,
    plan: Plan,
    /// The source has a length, so a start position applies.
    has_length: bool,
}

/// How often a converted cast checks that the receiver can still reach
/// this computer's address.
const ADDRESS_CHECK: Duration = Duration::from_secs(5);

/// How a cast checks this computer's addresses: its address on the route
/// to the receiver, and whether an address is still one of its own. Tests
/// give it their own.
#[derive(Clone, Copy)]
struct AddressCheck {
    route: fn(IpAddr) -> Result<IpAddr, NoRoute>,
    ours: fn(IpAddr) -> bool,
    every: Duration,
}

impl Default for AddressCheck {
    fn default() -> Self {
        Self {
            route: route_to,
            ours: is_ours,
            every: ADDRESS_CHECK,
        }
    }
}

/// Whether `ip` is still one of this computer's addresses, which it is
/// when a socket can listen on it.
pub(super) fn is_ours(ip: IpAddr) -> bool {
    std::net::UdpSocket::bind((ip, 0)).is_ok()
}

/// How many address checks in a row have to find the converter's address
/// gone before its stream starts again, so a check that lands on a moment
/// of change doesn't end a stream that would have gone on.
const MOVED_CHECKS: u32 = 2;

/// How long a session whose connection went with this computer's old
/// address tries to connect to its receiver again, as while Wi-Fi comes
/// back, before it says the cast was lost.
const RECONNECT_FOR: Duration = Duration::from_secs(30);

/// How often it tries.
const RECONNECT_EVERY: Duration = Duration::from_secs(1);

/// How long a session waits on a silent receiver, and how it connects again
/// after this computer's address changed. Tests give their own.
#[derive(Clone, Copy)]
struct Timing {
    ping: Duration,
    silence: Duration,
    reconnect_for: Duration,
    reconnect_every: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ping: PING_INTERVAL,
            silence: SILENCE_LIMIT,
            reconnect_for: RECONNECT_FOR,
            reconnect_every: RECONNECT_EVERY,
        }
    }
}

/// The app's casts, managed by Tauri.
#[derive(Default)]
pub struct CastPlayback {
    active: Mutex<Option<Active>>,
    generation: Mutex<u64>,
    turns: Mutex<HashMap<String, Turn>>,
    /// Changes with every turn, so a load can give up while it waits.
    turned: tokio::sync::watch::Sender<()>,
    /// Held for a whole load, so one load at a time asks the provider for a
    /// stream and opens a session. One that a newer turn overtook lets go
    /// once its ffmpeg has exited, so the next isn't a second connection to
    /// the provider.
    loading: tokio::sync::Mutex<()>,
    addresses: Mutex<AddressCheck>,
    timing: Mutex<Timing>,
}

impl CastPlayback {
    /// Has casts find this computer's address with `route`, and whether an
    /// address is still its own with `ours`, each `every`.
    #[cfg(test)]
    pub(crate) fn check_addresses_with(
        &self,
        route: fn(IpAddr) -> Result<IpAddr, NoRoute>,
        ours: fn(IpAddr) -> bool,
        every: Duration,
    ) {
        *lock(&self.addresses) = AddressCheck { route, ours, every };
    }

    /// Has sessions ping each second and end after `silence` from the
    /// receiver, and try to connect again for `reconnect_for`, every 100 ms.
    #[cfg(test)]
    pub(crate) fn set_timing(&self, silence: Duration, reconnect_for: Duration) {
        *lock(&self.timing) = Timing {
            ping: Duration::from_secs(1),
            silence,
            reconnect_for,
            reconnect_every: Duration::from_millis(100),
        };
    }

    /// Starts a load's or a stop's turn on `receiver_id`, and returns its
    /// ticket.
    fn take_turn(&self, receiver_id: &str, stopped: bool) -> u64 {
        let mut turns = lock(&self.turns);
        let turn = turns.entry(receiver_id.to_string()).or_default();
        turn.ticket += 1;
        turn.stopped = stopped;
        self.turned.send_replace(());
        turn.ticket
    }

    /// Runs `ask`, which asks the provider for the stream, and once more
    /// after [`FREED_WAIT`] when the provider refused it right after this
    /// load closed the receiver's connection, since a provider can count a
    /// closed connection for a moment after. A newer turn ends the wait.
    async fn ask_provider<T, F>(
        &self,
        receiver_id: &str,
        ticket: u64,
        freed: bool,
        mut ask: impl FnMut() -> F,
    ) -> Result<T, String>
    where
        F: Future<Output = Result<T, String>>,
    {
        let asked = ask().await;
        if !freed || asked.as_ref().err().map(String::as_str) != Some(REFUSED) {
            return asked;
        }
        tokio::select! {
            () = tokio::time::sleep(FREED_WAIT) => ask().await,
            () = self.overtaken(receiver_id, ticket) => asked,
        }
    }

    /// Finishes once `ticket` isn't `receiver_id`'s newest turn.
    async fn overtaken(&self, receiver_id: &str, ticket: u64) {
        let mut turned = self.turned.subscribe();
        while self.still_turn(receiver_id, ticket).is_ok() {
            // `self` holds the sender, so this always waits for a change.
            let _ = turned.changed().await;
        }
    }

    /// Rejects with [`SUPERSEDED`] once `ticket` isn't the newest turn.
    fn still_turn(&self, receiver_id: &str, ticket: u64) -> Result<(), String> {
        if lock(&self.turns)
            .get(receiver_id)
            .is_some_and(|t| t.ticket == ticket)
        {
            Ok(())
        } else {
            Err(SUPERSEDED.into())
        }
    }

    /// Whether the newest turn is a stop.
    fn stopped(&self, receiver_id: &str) -> bool {
        lock(&self.turns)
            .get(receiver_id)
            .is_some_and(|t| t.stopped)
    }
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

/// Starts driving a cast to `receiver_id` over `stream`, whose end on this
/// computer is `local`, and makes it the active one in place of any other.
pub(crate) fn begin<R, S>(app: &AppHandle<R>, receiver_id: &str, stream: S, local: Option<IpAddr>)
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
    let timing = *lock(&state.timing);
    let session = session.with_heartbeat(timing.ping, timing.silence);
    let driver = {
        let app = app.clone();
        let id = receiver_id.to_string();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<CastPlayback>();
            let ours = lock(&state.addresses).ours;
            let mut lost = None;
            drive(stream, session, first, receiver, |update| {
                let dropped = matches!(
                    update,
                    CastUpdate::Closed {
                        reason: "timeout" | "connectionLost"
                    }
                );
                if dropped && local.is_some_and(|ip| !ours(ip)) {
                    // The connection went with this computer's old address,
                    // as after a sleep on another network. It's taken up
                    // again below, and the frontend hears of it only if
                    // that fails.
                    lost = Some(update);
                } else if !replaced(&state, &id, generation) {
                    emit(&app, &id, update);
                }
            })
            .await;
            if let Some(closed) = lost {
                if reconnect(&app, &id, generation).await {
                    return;
                }
                emit(&app, &id, closed);
            }
            // Over: the converter stops with it.
            let mut active = lock(&state.active);
            if active.as_ref().is_some_and(|a| a.generation == generation) {
                *active = None;
            }
        })
    };
    let mut active = lock(&state.active);
    let mut old = active.take();
    // A new connection to the same receiver goes on with its cast.
    let (conversion, plan) = match old.as_mut() {
        Some(old) if old.receiver_id == receiver_id => (old.conversion.take(), old.plan.take()),
        _ => (None, None),
    };
    *active = Some(Active {
        receiver_id: receiver_id.to_string(),
        generation,
        commands,
        driver,
        local,
        conversion,
        plan,
    });
    drop(active);
    match old {
        // The same receiver on a new connection, as after this computer's
        // address changed. The old one goes without a word, so the receiver
        // keeps its app and the frontend sees no end.
        Some(old) if old.receiver_id == receiver_id => old.driver.abort(),
        Some(old) => {
            let _ = old.commands.send(Command::Stop);
        }
        None => {}
    }
}

/// Whether a newer session for `receiver_id` replaced session
/// `generation`, so what the older one says no longer counts.
fn replaced(state: &CastPlayback, receiver_id: &str, generation: u64) -> bool {
    lock(&state.active)
        .as_ref()
        .is_some_and(|a| a.receiver_id == receiver_id && a.generation > generation)
}

/// Connects to `receiver_id` again after session `generation` lost its
/// connection with this computer's old address, trying for a while, as
/// while Wi-Fi comes back. Says whether the cast goes on: on the new
/// connection, on one a load opened meanwhile, or not at all because it
/// ended or went to another receiver meanwhile, which says so itself.
async fn reconnect<R: Runtime>(app: &AppHandle<R>, receiver_id: &str, generation: u64) -> bool {
    let state = app.state::<CastPlayback>();
    let timing = *lock(&state.timing);
    let until = tokio::time::Instant::now() + timing.reconnect_for;
    loop {
        let newest = lock(&state.active)
            .as_ref()
            .is_some_and(|a| a.generation == generation);
        if !newest {
            return true;
        }
        if let Ok((stream, local)) = connect(app, receiver_id).await {
            begin(app, receiver_id, stream, local);
            return true;
        }
        if tokio::time::Instant::now() >= until {
            return false;
        }
        tokio::time::sleep(timing.reconnect_every).await;
    }
}

/// A TLS connection to a receiver.
type Connection = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;

/// A connection to `receiver_id`, and this computer's address on it.
async fn connect<R: Runtime>(
    app: &AppHandle<R>,
    receiver_id: &str,
) -> Result<(Connection, Option<IpAddr>), String> {
    let (addr, port) = app
        .state::<CastReceivers>()
        .registry()
        .get(receiver_id)
        .map(|r| (r.addr, r.port))
        .ok_or("notFound")?;
    let (stream, _) = tls::connect(addr, port)
        .await
        .map_err(|_| "unreachable".to_string())?;
    let local = stream.get_ref().0.local_addr().ok().map(|a| a.ip());
    Ok((stream, local))
}

/// The active cast's command sender, if `receiver_id` has it.
fn commands_for(state: &CastPlayback, receiver_id: &str) -> Option<mpsc::UnboundedSender<Command>> {
    lock(&state.active)
        .as_ref()
        .filter(|a| a.receiver_id == receiver_id)
        .map(|a| a.commands.clone())
}

/// Connects to `receiver_id` unless it's the active cast already, on an
/// address this computer still has. Says whether it opened a new session.
async fn ensure_connected<R: Runtime>(
    app: &AppHandle<R>,
    receiver_id: &str,
) -> Result<bool, String> {
    let state = app.state::<CastPlayback>();
    let ours = lock(&state.addresses).ours;
    let open = lock(&state.active)
        .as_ref()
        .filter(|a| a.receiver_id == receiver_id)
        .is_some_and(|a| !a.commands.is_closed() && a.local.is_none_or(ours));
    if open {
        return Ok(false);
    }
    match connect(app, receiver_id).await {
        Ok((stream, local)) => {
            begin(app, receiver_id, stream, local);
            Ok(true)
        }
        Err(e) if e == "unreachable" => {
            super::mark_unreachable(app, receiver_id);
            Err(e)
        }
        Err(e) => Err(e),
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

/// Checks, just before the receiver gets it, that `url` is still a playlist
/// the receiver may fetch. A panel's `.m3u8` can be missing or not a
/// playlist one time and fine the next, and the formats may come from what
/// played here, which fetched nothing. The receiver still gets `url` itself,
/// not where it redirects, since a redirect can carry a token tied to the
/// address that asked.
async fn check_playlist(url: &str) -> Result<(), String> {
    match hls::inspect(mvp_core::http::download_client(), url).await {
        Ok(info) if info.cors => Ok(()),
        Ok(_) => Err("cors".into()),
        Err(HlsError::Refused(_)) => Err(REFUSED.into()),
        Err(_) => Err("notPlaylist".into()),
    }
}

/// What converting `url`, which comes as `container`, takes.
struct ConversionInput<'a> {
    url: &'a str,
    container: Container,
    video: VideoChoice,
    audio: AudioChoice,
    live: bool,
    start_at: Option<f64>,
}

/// The plan for converting `input.url`, from what a probe finds in it and
/// what this computer's ffmpeg decodes.
async fn conversion_plan<R: Runtime>(
    app: &AppHandle<R>,
    input: &ConversionInput<'_>,
    cancel: impl Future<Output = ()>,
) -> Result<(Plan, bool), String> {
    let support = crate::convert::support::support(app).await;
    let decoders = support.decoders;
    let probed = crate::streams::probe_unless(app, input.url, cancel)
        .await
        .map_err(|e| match e {
            ProbeError::Refused(_) => REFUSED.to_string(),
            _ => "unreachable".to_string(),
        })?;
    // AAC from MPEG-TS or HLS can't be copied into the Matroska the
    // converter writes, so it's converted like any other.
    let playable = matroska_copies(input.container, &CAST_AUDIO);
    let decodable: Vec<&str> = decoders.iter().map(String::as_str).collect();
    let (audio_track, audio) = match input.audio {
        AudioChoice::None => (0, AudioPlan::None),
        // The test TV played 5.1 AAC with sound, so 5.1 stays 5.1.
        AudioChoice::Copy | AudioChoice::Aac => {
            pick_audio(&probed.audio_tracks, None, &playable, &decodable, true)
        }
    };
    let video = match (input.video, probed.video) {
        (VideoChoice::None, _) | (_, None) => VideoPlan::None,
        (VideoChoice::Copy, Some(_)) => VideoPlan::Copy,
        (VideoChoice::Transcode, Some(_)) => VideoPlan::Transcode {
            deinterlace: probed.interlaced,
        },
    };
    let has_length = probed.duration.is_some();
    let plan = Plan {
        video,
        audio,
        live: input.live,
        start_at: input.start_at.filter(|_| has_length),
        audio_track,
    };
    Ok((plan, has_length))
}

/// Starts the converter for `url` by `plan`, and serves it to `receiver`,
/// unless `cancel` finishes first.
async fn start_conversion<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    plan: &Plan,
    receiver: IpAddr,
    cancel: impl Future<Output = ()>,
) -> Result<Conversion, String> {
    let support = crate::convert::support::support(app).await;
    let encoders = support.encoders.ok_or("noConverter")?;
    crate::convert::start(app, url, plan, encoders, receiver, cancel)
        .await
        .map_err(|e| match e {
            ConvertError::Refused(_) => REFUSED.to_string(),
            ConvertError::NoEncoder => "noEncoder".to_string(),
            ConvertError::Unsupported => "unsupported".to_string(),
            ConvertError::NoRoute => "noRoute".to_string(),
            ConvertError::Unreachable => "unreachable".to_string(),
            ConvertError::Failed(_) => "converterFailed".to_string(),
        })
}

/// Plays `channel` on `receiver_id` the way `route` says, from `start_at`
/// seconds for an item with a length. Connects first when needed.
///
/// The receiver's conversion, if any, stops before this asks the provider
/// for anything, since many accounts allow one connection. The receiver
/// stops that media first. A seek or a resume of the same item reuses the
/// plan its cast made, unless that plan failed. A newer load or
/// a stop for the same receiver makes this one give up wherever it is, with
/// [`SUPERSEDED`], dropping what it started.
///
/// Rejects with `notFound`, `unreachable`, `refused`,
/// `noConverter`, `noEncoder`, `unsupported`, `noRoute`, `converterFailed`,
/// `stale` or `superseded`, or, for a direct HLS route, `notPlaylist` or
/// `cors`, after which the frontend routes the item again without that
/// format.
pub async fn load<R: Runtime>(
    app: &AppHandle<R>,
    receiver_id: &str,
    channel: &Channel,
    route: CastRoute,
    start_at: Option<f64>,
    restart: bool,
) -> Result<(), String> {
    let state = app.state::<CastPlayback>();
    // Starting a stream again goes on with the cast it belongs to, and
    // never opens one: a cast that ended, or went to another receiver,
    // stays as it is.
    if restart && commands_for(&state, receiver_id).is_none() {
        return Err("notConnected".into());
    }
    let ticket = state.take_turn(receiver_id, false);
    // The URL the route was worked out for, which a newer list of the
    // item's URLs makes stale.
    let (generation, source) = route.source();
    let url = &app
        .state::<StreamsState>()
        .url(&channel.id, generation, source)?;
    let playback: &CastPlayback = &state;
    let _loading = state.loading.lock().await;
    state.still_turn(receiver_id, ticket)?;
    let old = lock(&state.active)
        .as_mut()
        .filter(|a| a.receiver_id == receiver_id)
        .and_then(|a| Some((a.conversion.take()?, a.commands.clone())));
    // This load closed the receiver's connection to the provider.
    let freed = old.is_some();
    if let Some((old, commands)) = old {
        // The receiver ends the old media as cancelled before its stream
        // goes away, rather than fetch from a stream that's gone and give
        // up with an error while the new one starts.
        let _ = commands.send(Command::StopMedia);
        old.stop().await;
    }
    state.still_turn(receiver_id, ticket)?;
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
    let mut plan_used = None;
    match route {
        CastRoute::Direct { container, .. } => {
            if matches!(container, Container::HlsTs | Container::HlsFmp4) {
                // A newer turn needn't wait out a provider that doesn't
                // answer.
                let checked = tokio::select! {
                    checked = check_playlist(url) => checked,
                    () = playback.overtaken(receiver_id, ticket) => Ok(()),
                };
                state.still_turn(receiver_id, ticket)?;
                checked?;
            }
            let (content_type, ts) = content_type(container);
            request.url = url.clone();
            request.content_type = content_type.into();
            request.hls_ts_segments = ts;
        }
        CastRoute::Converted {
            container,
            video,
            audio,
            ..
        } => {
            let receiver = app
                .state::<CastReceivers>()
                .registry()
                .get(receiver_id)
                .map(|r| r.addr)
                .ok_or("notFound")?;
            let made_for = |known: &KnownPlan| {
                known.channel_id == channel.id
                    && known.generation == generation
                    && known.source == source
                    && known.video == video
                    && known.audio == audio
            };
            let known = lock(&state.active)
                .as_ref()
                .filter(|a| a.receiver_id == receiver_id)
                .and_then(|a| a.plan.clone())
                .filter(made_for);
            // A seek or a resume of the same item keeps its plan, with the
            // new start, rather than asking the provider again.
            let known = match known {
                Some(known) => KnownPlan {
                    plan: Plan {
                        start_at: start_at.filter(|_| known.has_length),
                        ..known.plan
                    },
                    ..known
                },
                None => {
                    let input = ConversionInput {
                        url,
                        container,
                        video,
                        audio,
                        live,
                        start_at,
                    };
                    let input = &input;
                    let planned = playback
                        .ask_provider(receiver_id, ticket, freed, move || {
                            conversion_plan(app, input, playback.overtaken(receiver_id, ticket))
                        })
                        .await;
                    state.still_turn(receiver_id, ticket)?;
                    let (plan, has_length) = planned?;
                    KnownPlan {
                        channel_id: channel.id.clone(),
                        generation,
                        source,
                        video,
                        audio,
                        plan,
                        has_length,
                    }
                }
            };
            let plan = &known.plan;
            let started = playback
                .ask_provider(receiver_id, ticket, freed, move || {
                    let cancel = playback.overtaken(receiver_id, ticket);
                    start_conversion(app, url, plan, receiver, cancel)
                })
                .await;
            if let Err(e) = state.still_turn(receiver_id, ticket) {
                // It lets go of the provider before the next load may ask.
                if let Ok(started) = started {
                    started.stop().await;
                }
                return Err(e);
            }
            let started = match started {
                Ok(started) => started,
                Err(e) => {
                    // The next load probes again rather than repeat a plan
                    // that just failed.
                    forget_plan(&state, receiver_id);
                    return Err(e);
                }
            };
            // The converted stream starts where the plan does, and has no
            // length the receiver can seek in.
            request.url = started.url.clone();
            request.content_type = "video/x-matroska".into();
            request.stream_type = StreamType::Live;
            request.start_at = None;
            conversion = Some((started, receiver));
            plan_used = Some(known);
        }
    }
    let sent = async {
        // A restart whose cast ended while it started stays out of the
        // way, rather than open a cast the user just ended.
        if restart && commands_for(&state, receiver_id).is_none() {
            return Err("notConnected".to_string());
        }
        let opened = ensure_connected(app, receiver_id).await?;
        if let Err(e) = state.still_turn(receiver_id, ticket) {
            // A stop that came while this connected ends the session it
            // opened.
            if opened && state.stopped(receiver_id) {
                end_session(&state, receiver_id);
            }
            return Err(e);
        }
        let mut active = lock(&state.active);
        let active = active
            .as_mut()
            .filter(|a| a.receiver_id == receiver_id)
            .ok_or("unreachable")?;
        active
            .commands
            .send(Command::Load(Box::new(request)))
            .map_err(|_| "unreachable")?;
        if let Some((started, receiver)) = conversion.take() {
            watch_conversion(app, receiver_id, receiver, &started);
            active.conversion = Some(started);
        }
        active.plan = plan_used;
        Ok(())
    }
    .await;
    if sent.is_err()
        && let Some((started, _)) = conversion
    {
        // The converter this load started lets go of the provider before
        // the next load may ask.
        started.stop().await;
    }
    sent
}

/// Drops the plan of the cast on `receiver_id`, if it has one.
fn forget_plan(state: &CastPlayback, receiver_id: &str) {
    if let Some(active) = lock(&state.active)
        .as_mut()
        .filter(|a| a.receiver_id == receiver_id)
    {
        active.plan = None;
    }
}

/// Tells the frontend when `conversion`, while the cast still has it, stops
/// with an error, or when its stream has to start again: a live channel
/// whose connection ended, or an address the receiver can no longer reach,
/// as after a sleep on another network. The receiver would otherwise wait on a
/// stream that never comes. A file that finished keeps being served, since
/// the receiver may not have all of it yet.
fn watch_conversion<R: Runtime>(
    app: &AppHandle<R>,
    receiver_id: &str,
    receiver: IpAddr,
    conversion: &Conversion,
) {
    let app = app.clone();
    let id = receiver_id.to_string();
    // Its stream's address, which no other conversion has. A new connection
    // to the receiver keeps the conversion.
    let url = conversion.url.clone();
    let served = conversion.server.local;
    let mut ended = conversion.ended.clone();
    let check = *lock(&app.state::<CastPlayback>().addresses);
    tauri::async_runtime::spawn(async move {
        let mut ticks = tokio::time::interval(check.every);
        // The checks in a row that found the converter's address gone.
        let mut gone = 0;
        let update = loop {
            tokio::select! {
                end = ended.wait_for(Option::is_some) => {
                    // The conversion went, replaced or stopped.
                    let Ok(end) = end.map(|e| e.clone()) else {
                        return;
                    };
                    break match end {
                        Some(Ended::Failed(e)) => CastUpdate::ConversionFailed {
                            refused: matches!(e, ConvertError::Refused(_)),
                        },
                        Some(Ended::Dropped) => CastUpdate::ConversionStopped { why: "dropped" },
                        _ => return,
                    };
                }
                _ = ticks.tick() => match (check.route)(receiver) {
                    // The route goes from another address, and the one the
                    // receiver was given is no longer this computer's. A new
                    // address alongside it, such as a cable plugged in,
                    // changes nothing.
                    Ok(local) if local != served && !(check.ours)(served) => {
                        gone += 1;
                        if gone >= MOVED_CHECKS {
                            break CastUpdate::ConversionStopped { why: "moved" };
                        }
                    }
                    Ok(_) => gone = 0,
                    // No route at all, as for a moment while the network
                    // changes, says nothing either way.
                    Err(NoRoute) => {}
                },
            }
        };
        let state = app.state::<CastPlayback>();
        let current = match lock(&state.active)
            .as_mut()
            .filter(|a| a.conversion.as_ref().is_some_and(|c| c.url == url))
        {
            Some(active) => {
                // A retry probes again rather than repeat a plan that failed.
                // A stream that only has to start again keeps it.
                if matches!(update, CastUpdate::ConversionFailed { .. }) {
                    active.plan = None;
                }
                true
            }
            None => false,
        };
        if current {
            emit(&app, &id, update);
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

/// Has the cast on `receiver_id` let go of the provider's stream, and keeps
/// it: the receiver stops its media, and the converter stops and waits for
/// ffmpeg to exit. A switch to another item does this before it asks the
/// provider for the new one, for accounts that allow one connection. A
/// load still under way gives up. Rejects with `notConnected` when nothing
/// is cast there.
pub async fn release(state: &CastPlayback, receiver_id: &str) -> Result<(), String> {
    state.take_turn(receiver_id, false);
    // A load under way gives up, and lets go of the provider, first.
    let _loading = state.loading.lock().await;
    let (commands, conversion) = {
        let mut active = lock(&state.active);
        let active = active
            .as_mut()
            .filter(|a| a.receiver_id == receiver_id)
            .ok_or("notConnected")?;
        (active.commands.clone(), active.conversion.take())
    };
    // A receiver with no media has nothing to stop, which is fine.
    let _ = commands.send(Command::StopMedia);
    if let Some(conversion) = conversion {
        conversion.stop().await;
    }
    Ok(())
}

/// Ends the cast on `receiver_id`: the receiver goes back to what it
/// showed, and the converter stops. A load still under way gives up, and
/// nothing it started plays.
pub fn stop(state: &CastPlayback, receiver_id: &str) {
    state.take_turn(receiver_id, true);
    end_session(state, receiver_id);
}

/// Ends the session to `receiver_id`, if it has one.
fn end_session(state: &CastPlayback, receiver_id: &str) {
    let ended = lock(&state.active).take_if(|a| a.receiver_id == receiver_id);
    if let Some(ended) = ended {
        let _ = ended.commands.send(Command::Stop);
    }
}
