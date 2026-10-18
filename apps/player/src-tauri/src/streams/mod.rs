// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The ways of fetching an item and what each one holds, for deciding how a
//! Cast or AirPlay receiver gets it.
//!
//! The frontend only learns the formats and their places in the list. The
//! URLs, which carry logins, stay here, and a later load names a format by
//! its place.

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

/// What the app learned about providers while it runs.
#[derive(Default)]
pub struct StreamsState {
    /// Each Xtream provider's `allowed_output_formats`, by provider id.
    output_formats: Mutex<HashMap<String, Vec<String>>>,
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
            Vec::new()
        }
    }
}

/// The formats `channel` comes in.
///
/// `playing` is what mpv says while it plays the channel. Then nothing new
/// is fetched from the provider, since many accounts allow one connection.
/// HLS gets the CORS answer last seen from its server, or none. Without it,
/// the bundled ffmpeg probes the stream and each HLS playlist is checked.
#[command]
pub async fn get_stream_formats<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    streams: State<'_, StreamsState>,
    channel: Channel,
    playing: Option<PlayingInfo>,
) -> Result<StreamFormats, String> {
    let urls = fetch_urls(&state, &streams, &channel).await?;
    let source = urls
        .iter()
        .position(|u| *u == channel.url)
        .unwrap_or(urls.len() - 1);
    let (codecs, duration) = match &playing {
        Some(info) => (info.format(), None),
        None => match probe(&app, &urls[source]).await {
            Ok(probed) => (format_of(&probed), probed.duration),
            Err(ProbeError::Refused(_)) => return Err(REFUSED.into()),
            Err(e) => {
                tracing::info!("[Streams] the probe found nothing to cast: {e}");
                return Ok(StreamFormats {
                    formats: Vec::new(),
                    sources: Vec::new(),
                    duration: None,
                });
            }
        },
    };
    let mut result = check_hls(&streams, &urls, codecs, source, playing.is_some()).await?;
    result.duration = duration;
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
        let check = if !is_hls_url(url) && !(i == source && source_is_hls) {
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
async fn probe<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<Probed, ProbeError> {
    #[cfg(desktop)]
    {
        use tauri_plugin_shell::ShellExt;
        let command = app
            .shell()
            .sidecar(crate::downloads::FFMPEG_SIDECAR)
            .map_err(|_| ProbeError::Unreachable)?
            .args(mvp_core::streams::probe::args(url));
        let output = tokio::time::timeout(PROBE_LIMIT, command.output())
            .await
            .map_err(|_| ProbeError::Unreachable)?
            .map_err(|_| ProbeError::Unreachable)?;
        mvp_core::streams::probe::parse(&String::from_utf8_lossy(&output.stderr))
    }
    #[cfg(mobile)]
    {
        let _ = (app, url);
        Err(ProbeError::Unreachable)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
