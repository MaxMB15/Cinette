// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Starts a channel on the AirPlay receiver the user picked. The URL is
//! resolved here and goes to the mpv plugin's AVPlayer, or to this
//! device's converter, so it never reaches the frontend.

use mvp_core::models::channel::Channel;
use serde::Serialize;
use tauri::{command, AppHandle, Runtime, State};

use crate::streams::StreamsState;

#[cfg(any(target_os = "ios", target_os = "macos", all(test, target_os = "linux")))]
mod conversion;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "ios")]
use ios as converter;
#[cfg(target_os = "macos")]
use macos as converter;
#[cfg(test)]
mod tests;

/// The audio AirPlay receivers play as it is, by FFmpeg's names, so the
/// converter copies a track in one of them. It matches the frontend's
/// `airplayTvProfile`.
#[cfg(any(target_os = "ios", target_os = "macos", test))]
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
    // mutants: skip BinaryOperator: Only iOS and macOS read live, and the plugin fails first elsewhere.
    let live = channel.content_type == "live";
    tracing::info!("[AirPlay] load source={source} live={live}");
    tauri_plugin_mpv::airplay::load(&app, &url, &channel.name, start_at, live, None)
}

/// Converts `channel` from the URL at `source` in the list named
/// `generation`, as `airplay_load` finds it, on this device, serves it
/// on the local network, and plays that over AirPlay from `start_at`.
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
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        converter::load_converted(&app, &url, &channel, start_at).await
    }
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let _ = (app, url, start_at);
        Err(tauri_plugin_mpv::airplay::UNAVAILABLE.to_string())
    }
}

/// Stops this device's conversion, if one runs. AirPlay itself stops with
/// the plugin's `airplay_stop`.
// mutants: skip FnValue: Only iOS and macOS convert, so elsewhere there's nothing to stop.
#[command]
pub async fn airplay_end_conversion() -> Result<(), String> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    converter::end_conversion();
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
/// iOS, with no video transcode yet, and what the bundled ffmpeg can on a
/// Mac. Nothing elsewhere.
#[command]
pub async fn airplay_converter_support<R: Runtime>(
    app: AppHandle<R>,
) -> Result<ConverterSupport, String> {
    #[cfg(target_os = "macos")]
    {
        let support = crate::convert::support::support(&app).await;
        Ok(ConverterSupport {
            convert: support.convert,
            hardware_encoder: support.hardware_encoder,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(ConverterSupport {
            convert: cfg!(target_os = "ios"),
            hardware_encoder: false,
        })
    }
}

/// Called once from setup.
// mutants: skip FnValue: Only iOS and macOS pace a conversion by the receiver's state.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    converter::install(app);
    let _ = app;
}

/// Keeps the device's conversions in `cell`, runs their pacer on the
/// receiver's state, and has a conversion that ends on its own show as
/// the item's error.
// mutants: skip FnValue: It only builds for iOS and macOS, and mutation runs build on Linux.
#[cfg(any(target_os = "ios", target_os = "macos"))]
fn install_conversions<R: Runtime, C: conversion::Running>(
    app: &AppHandle<R>,
    cell: &std::sync::OnceLock<std::sync::Arc<conversion::Conversions<C>>>,
) {
    use tauri::Listener;
    let failing = app.clone();
    let conversions = conversion::Conversions::new(move |code| {
        tauri_plugin_mpv::airplay::fail_converted(&failing, code);
    });
    if cell.set(conversions.clone()).is_err() {
        return;
    }
    app.listen_any(tauri_plugin_mpv::airplay::EVENT_STATE, move |event| {
        let status = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(str::to_string));
        if let Some(status) = status {
            conversions.set_status(&status);
        }
    });
}
