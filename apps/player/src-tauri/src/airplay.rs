// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Starts a channel on the AirPlay receiver the user picked. The URL is
//! resolved here and goes to the mpv plugin's AVPlayer, or to this
//! device's converter, so it never reaches the frontend.

use mvp_core::models::channel::Channel;
use serde::Serialize;
use tauri::{command, AppHandle, Runtime, State};

use crate::commands::AppState;
use crate::streams::{fetch_urls, StreamsState};

#[cfg(target_os = "ios")]
mod ios;
#[cfg(test)]
mod tests;

/// The audio AirPlay receivers play as it is, by FFmpeg's names, so the
/// converter copies a track in one of them. It matches the frontend's
/// `airplayTvProfile`.
#[cfg(any(target_os = "ios", test))]
pub const AIRPLAY_AUDIO: [&str; 2] = ["aac", "mp3"];

/// The URL at `source` in `channel`'s list, as `get_stream_formats`
/// numbered them.
async fn source_url(
    state: &AppState,
    streams: &StreamsState,
    channel: &Channel,
    source: usize,
) -> Result<String, String> {
    let urls = fetch_urls(state, streams, channel).await?;
    urls.into_iter()
        .nth(source)
        .ok_or_else(|| "That stream format is no longer offered".to_string())
}

/// Plays `channel` over AirPlay from the URL at `source`, which the
/// receiver fetches itself. Local playback must already have stopped.
/// `start_at` only counts for movies and episodes.
#[command]
pub async fn airplay_load<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    streams: State<'_, StreamsState>,
    channel: Channel,
    source: usize,
    start_at: Option<f64>,
) -> Result<(), String> {
    let url = source_url(&state, &streams, &channel, source).await?;
    // mutants: skip BinaryOperator: Only iOS reads live, and the plugin fails first elsewhere.
    let live = channel.content_type == "live";
    tracing::info!("[AirPlay] load source={source} live={live}");
    tauri_plugin_mpv::airplay::load(&app, &url, &channel.name, start_at, live, None)
}

/// Converts `channel` from the URL at `source` on this device, serves it
/// on the Wi-Fi network, and plays that over AirPlay from `start_at`.
/// Resolves once the receiver can start, or rejects with why not: the
/// stream's `"refused"`, as `get_stream_formats` does, or a message.
#[command]
pub async fn airplay_load_converted<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    streams: State<'_, StreamsState>,
    channel: Channel,
    source: usize,
    start_at: Option<f64>,
) -> Result<(), String> {
    let url = source_url(&state, &streams, &channel, source).await?;
    #[cfg(target_os = "ios")]
    {
        ios::load_converted(&app, &url, &channel, start_at).await
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, url, start_at);
        Err(tauri_plugin_mpv::airplay::UNAVAILABLE.to_string())
    }
}

/// Stops this device's conversion, if one runs. AirPlay itself stops with
/// the plugin's `airplay_stop`.
// mutants: skip FnValue: Only iOS converts, so elsewhere there's nothing to stop.
#[command]
pub async fn airplay_end_conversion() -> Result<(), String> {
    #[cfg(target_os = "ios")]
    ios::end_conversion();
    Ok(())
}

/// The frontend's `ConverterSupport`, for AirPlay from this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverterSupport {
    pub convert: bool,
    pub hardware_encoder: bool,
}

/// What this device can convert for AirPlay: a remux and AAC audio on
/// iOS, and nothing elsewhere yet. No video transcode yet.
#[command]
pub async fn airplay_converter_support() -> Result<ConverterSupport, String> {
    Ok(ConverterSupport {
        convert: cfg!(target_os = "ios"),
        hardware_encoder: false,
    })
}

/// Called once from setup.
// mutants: skip FnValue: Only iOS paces a conversion by the receiver's state.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "ios")]
    ios::install(app);
    let _ = app;
}
