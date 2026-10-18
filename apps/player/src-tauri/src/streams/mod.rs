// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The ways of fetching an item and what each one holds, for deciding how a
//! Cast or AirPlay receiver gets it.
//!
//! The frontend only learns the formats and their places in the list. The
//! URLs, which carry logins, stay here, kept under a generation, and a later
//! load names a format by its place in that generation's list.

use std::collections::HashMap;
use std::sync::Mutex;
#[cfg(desktop)]
use std::time::Duration;

use mvp_core::http::origin_for_log;
use mvp_core::iptv::xtream::{XtreamClient, XtreamCredentials};
use mvp_core::models::channel::Channel;
use mvp_core::models::playlist::{Provider, ProviderType};
use mvp_core::streams::format::{Container, PlayingInfo, StreamFormat};
use mvp_core::streams::hls::{self, HlsError, HlsInfo};
use mvp_core::streams::probe::{ProbeError, Probed};
use mvp_core::streams::{candidates, formats_for, is_hls_url, HlsCheck};
use serde::Serialize;
use tauri::{command, AppHandle, Runtime, State};
use tauri_plugin_mpv::{MediaInfo, MpvState};

use crate::commands::AppState;

#[cfg(test)]
mod tests;

/// What a command says when the provider answered 401 or 403. The frontend
/// shows it as a login that may have expired.
pub const REFUSED: &str = "refused";

/// The longest a probe runs. ffmpeg gives up on its own after 10 s without
/// data, so this only stops one that keeps trickling.
#[cfg(desktop)]
const PROBE_LIMIT: Duration = Duration::from_secs(30);

/// What `get_stream_formats` says while mpv is still opening the item,
/// before it knows the codecs. The frontend asks again.
pub const NOT_READY: &str = "notReady";
/// What a load says when its generation's URL list was replaced.
pub const STALE: &str = "stale";

/// What the app learned about providers while it runs.
#[derive(Default)]
pub struct StreamsState {
    /// Each Xtream provider's `allowed_output_formats`, by provider id. A
    /// panel that couldn't be asked counts as allowing nothing more, for
    /// the rest of the run, so an item's URL list stays the same.
    output_formats: Mutex<HashMap<String, Vec<String>>>,
    /// Each item's URLs, by channel id, as last listed, with the generation
    /// that names that list.
    urls: Mutex<HashMap<String, (u64, Vec<String>)>>,
    generation: Mutex<u64>,
    /// Whether each server sent CORS headers for HLS, by origin, so the
    /// picker can say so while the item still plays here.
    cors: Mutex<HashMap<String, bool>>,
}

/// The formats an item comes in, best first.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFormats {
    pub formats: Vec<StreamFormat>,
    /// For each format, its URL's place among the item's URLs, which a load
    /// passes back.
    pub sources: Vec<usize>,
    /// Seconds, when the probe found a length.
    pub duration: Option<f64>,
    /// Names the URL list that `sources` point into, which a load passes
    /// back.
    pub generation: u64,
}

impl StreamsState {
    /// Keeps `urls` as `channel_id`'s list, and returns its generation.
    pub(crate) fn remember(&self, channel_id: &str, urls: Vec<String>) -> u64 {
        let generation = {
            let mut next = lock(&self.generation);
            *next += 1;
            *next
        };
        lock(&self.urls).insert(channel_id.to_string(), (generation, urls));
        generation
    }

    /// The URL at `source` in `channel_id`'s list of `generation`, or
    /// [`STALE`] when that list was replaced or never made.
    // Cast's load names its URL with this from the next step on.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn url(&self, channel_id: &str, generation: u64, source: usize) -> Result<String, String> {
        lock(&self.urls)
            .get(channel_id)
            .filter(|(kept, _)| *kept == generation)
            .and_then(|(_, urls)| urls.get(source).cloned())
            .ok_or_else(|| STALE.to_string())
    }
}

/// What mpv says about `urls` while it plays one of them. `now` is what
/// mpv has loaded. Another item, or nothing, is `None`. An item mpv hasn't
/// opened yet is [`NOT_READY`].
pub fn playing_info(
    now: Option<(String, MediaInfo)>,
    urls: &[String],
    own_url: &str,
) -> Result<Option<PlayingInfo>, String> {
    let Some((url, info)) = now else {
        return Ok(None);
    };
    if url != own_url && !urls.contains(&url) {
        return Ok(None);
    }
    if info.file_format.is_none() {
        return Err(NOT_READY.into());
    }
    Ok(Some(PlayingInfo {
        file_format: info.file_format,
        video_codec: info.video_codec,
        audio_codec: info.audio_codec,
        interlaced: info.interlaced,
    }))
}

/// The URLs `channel` can be fetched from, best first.
pub(crate) async fn fetch_urls(
    app_state: &AppState,
    streams: &StreamsState,
    channel: &Channel,
) -> Result<Vec<String>, String> {
    let provider = {
        let cache = app_state.cache.lock().map_err(|e| e.to_string())?;
        cache
            .get_provider_for_channel(&channel.id)
            .map_err(|e| e.to_string())?
    };
    let allowed = match &provider {
        Some(p) if p.provider_type == ProviderType::Xtream && channel.content_type == "live" => {
            output_formats(streams, p).await
        }
        _ => Vec::new(),
    };
    let provider_type = provider.map_or(ProviderType::M3u, |p| p.provider_type);
    Ok(candidates(
        &provider_type,
        &channel.content_type,
        &channel.url,
        &allowed,
    ))
}

/// The provider's allowed formats, asked once per run. A panel that can't
/// be asked allows only what the channel already uses.
async fn output_formats(streams: &StreamsState, provider: &Provider) -> Vec<String> {
    if let Some(known) = lock(&streams.output_formats).get(&provider.id) {
        return known.clone();
    }
    let client = XtreamClient::new(XtreamCredentials::new(
        &provider.url,
        provider.username.as_deref().unwrap_or_default(),
        provider.password.as_deref().unwrap_or_default(),
    ));
    match client.output_formats().await {
        Ok(formats) => {
            lock(&streams.output_formats).insert(provider.id.clone(), formats.clone());
            formats
        }
        Err(e) => {
            tracing::warn!("[Streams] couldn't read the provider's output formats: {e}");
            lock(&streams.output_formats).insert(provider.id.clone(), Vec::new());
            Vec::new()
        }
    }
}

/// The formats `channel` comes in.
///
/// While mpv plays the channel, what it says is used and nothing new is
/// fetched from the provider, since many accounts allow one connection.
/// HLS gets the CORS answer last seen from its server, or none. While mpv
/// is still opening it, this rejects with [`NOT_READY`]. Otherwise the
/// bundled ffmpeg probes the stream and each HLS playlist is checked.
#[command]
pub async fn get_stream_formats<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    streams: State<'_, StreamsState>,
    mpv: State<'_, MpvState>,
    channel: Channel,
) -> Result<StreamFormats, String> {
    stream_formats(&app, &state, &streams, channel, mpv.playing()).await
}

/// [`get_stream_formats`] with `now`, what mpv has loaded.
pub(crate) async fn stream_formats<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    streams: &StreamsState,
    channel: Channel,
    now: Option<(String, MediaInfo)>,
) -> Result<StreamFormats, String> {
    let urls = fetch_urls(state, streams, &channel).await?;
    let playing = playing_info(now, &urls, &channel.url)?;
    let source = urls
        .iter()
        .position(|u| *u == channel.url)
        .unwrap_or(urls.len() - 1);
    let (codecs, duration) = match &playing {
        Some(info) => (info.format(), None),
        None => match probe(app, &urls[source]).await {
            Ok(probed) => (format_of(&probed), probed.duration),
            Err(ProbeError::Refused(_)) => return Err(REFUSED.into()),
            Err(e) => {
                tracing::info!("[Streams] the probe found nothing to cast: {e}");
                return Ok(StreamFormats {
                    formats: Vec::new(),
                    sources: Vec::new(),
                    duration: None,
                    generation: streams.remember(&channel.id, urls),
                });
            }
        },
    };
    let mut result = check_hls(streams, &urls, codecs, source, playing.is_some()).await?;
    result.duration = duration;
    result.generation = streams.remember(&channel.id, urls);
    Ok(result)
}

/// The formats of `urls`, with `codecs` from `urls[source]`, after checking
/// each HLS one. While the item plays here (`playing`), nothing is fetched,
/// and HLS gets the CORS answer last seen from its server, or none.
async fn check_hls(
    streams: &StreamsState,
    urls: &[String],
    codecs: StreamFormat,
    source: usize,
    playing: bool,
) -> Result<StreamFormats, String> {
    let source_is_hls = matches!(codecs.container, Container::HlsTs | Container::HlsFmp4);
    let mut checks = Vec::with_capacity(urls.len());
    for (i, url) in urls.iter().enumerate() {
        let check = if !(is_hls_url(url) || (i == source && source_is_hls)) {
            HlsCheck::NotHls
        } else if playing {
            // mpv calls all HLS `hls`, so its segments are taken to be
            // MPEG-TS, as Xtream's are.
            let container = Container::HlsTs;
            let cors = lock(&streams.cors)
                .get(&origin_for_log(url))
                .copied()
                .unwrap_or(false);
            HlsCheck::Checked(HlsInfo { container, cors })
        } else {
            match hls::inspect(mvp_core::http::download_client(), url).await {
                Ok(info) => {
                    lock(&streams.cors).insert(origin_for_log(url), info.cors);
                    HlsCheck::Checked(info)
                }
                Err(HlsError::Refused(_)) => return Err(REFUSED.into()),
                Err(e) => {
                    tracing::info!("[Streams] an HLS check failed: {e}");
                    HlsCheck::Failed
                }
            }
        };
        checks.push(check);
    }
    let (sources, formats) = formats_for(urls, codecs, source, &checks)
        .into_iter()
        .unzip();
    Ok(StreamFormats {
        formats,
        sources,
        duration: None,
        generation: 0,
    })
}

fn format_of(probed: &Probed) -> StreamFormat {
    StreamFormat {
        container: probed.container,
        video: probed.video,
        interlaced: probed.interlaced,
        audio: probed.audio,
        cors: false,
    }
}

/// Runs the bundled ffmpeg on `url`. Its output names the URL, so none of
/// it is logged. Phones and tablets have no ffmpeg to probe with, so only
/// what mpv says while it plays is known there.
pub(crate) async fn probe<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<Probed, ProbeError> {
    #[cfg(desktop)]
    return probe_within(app, url, PROBE_LIMIT).await;
    #[cfg(mobile)]
    {
        let _ = (app, url);
        Err(ProbeError::Unreachable)
    }
}

/// [`probe`] with `limit`, which tests shorten. An ffmpeg still running at
/// the limit is killed, so it doesn't keep holding the provider's
/// connection, which many accounts allow only one of.
#[cfg(desktop)]
async fn probe_within<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    limit: Duration,
) -> Result<Probed, ProbeError> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;
    let (mut events, child) = app
        .shell()
        .sidecar(crate::downloads::FFMPEG_SIDECAR)
        .map_err(|_| ProbeError::Unreachable)?
        .args(mvp_core::streams::probe::args(url))
        .spawn()
        .map_err(|_| ProbeError::Unreachable)?;
    let mut stderr = Vec::new();
    let read = async {
        // The events end once ffmpeg has exited.
        while let Some(event) = events.recv().await {
            if let CommandEvent::Stderr(line) = event {
                stderr.extend(line);
                stderr.push(b'\n');
            }
        }
    };
    if tokio::time::timeout(limit, read).await.is_err() {
        let _ = child.kill();
        return Err(ProbeError::Unreachable);
    }
    mvp_core::streams::probe::parse(&String::from_utf8_lossy(&stderr))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
