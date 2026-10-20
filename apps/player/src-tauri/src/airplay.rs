// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Starts a channel on the AirPlay receiver the user picked. The URL is
//! resolved here and goes to the mpv plugin's AVPlayer, or to this
//! device's converter, so it never reaches the frontend.

use mvp_core::models::channel::Channel;
use serde::Serialize;
use tauri::{command, AppHandle, Runtime, State};

use crate::streams::StreamsState;

#[cfg(any(target_os = "ios", all(test, target_os = "linux")))]
mod conversion;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(test)]
mod tests;

/// The audio AirPlay receivers play as it is, by FFmpeg's names, so the
/// converter copies a track in one of them. It matches the frontend's
/// `airplayTvProfile`.
#[cfg(any(target_os = "ios", test))]
pub const AIRPLAY_AUDIO: [&str; 2] = ["aac", "mp3"];

/// Plays `channel` over AirPlay from the URL at `source` in the list that
/// `get_stream_formats` named `generation`. A replaced list fails with
/// `STALE`. Local playback must already have stopped. `start_at` only
/// counts for movies and episodes.
#[command]
pub async fn airplay_load<R: Runtime>(
    app: AppHandle<R>,
    streams: State<'_, StreamsState>,
    channel: Channel,
    generation: u64,
    source: usize,
    start_at: Option<f64>,
) -> Result<(), String> {
    let url = streams.url(&channel.id, generation, source)?;
    // mutants: skip BinaryOperator: Only iOS reads live, and the plugin fails first elsewhere.
    let live = channel.content_type == "live";
    tracing::info!("[AirPlay] load source={source} live={live}");
    tauri_plugin_mpv::airplay::load(&app, &url, &channel.name, start_at, live, None)
}

/// Converts `channel` from the URL at `source` in the list named
/// `generation`, as `airplay_load` finds it, on this device, serves it
/// on the Wi-Fi network, and plays that over AirPlay from `start_at`.
/// Resolves once the receiver can start, or rejects with why not: the
/// stream's `"refused"`, as `get_stream_formats` does, or a message.
#[command]
pub async fn airplay_load_converted<R: Runtime>(
    app: AppHandle<R>,
    streams: State<'_, StreamsState>,
    channel: Channel,
    generation: u64,
    source: usize,
    start_at: Option<f64>,
) -> Result<(), String> {
    let url = streams.url(&channel.id, generation, source)?;
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
