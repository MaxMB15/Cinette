// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Starts a channel on the AirPlay receiver the user picked. The URL is
//! resolved here and goes to the mpv plugin's AVPlayer, so it never reaches
//! the frontend.

use mvp_core::models::channel::Channel;
use tauri::{command, AppHandle, Runtime, State};

use crate::streams::StreamsState;

#[cfg(test)]
mod tests;

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
    tauri_plugin_mpv::airplay::load(&app, &url, &channel.name, start_at, live)
}
