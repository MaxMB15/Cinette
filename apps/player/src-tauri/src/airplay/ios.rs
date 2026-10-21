// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The conversions AirPlay plays from on iOS. [`super::conversion`] runs
//! them in order, and this file joins it to `hls_out` and the mpv plugin.

use std::sync::{Arc, OnceLock};

use mvp_core::models::channel::Channel;
use tauri::{AppHandle, Runtime};
use tauri_plugin_mpv::airplay::Converted;
use tokio::sync::watch;

use super::conversion::{Conversions, Running};
use super::AIRPLAY_AUDIO;
use crate::hls_out::{self, Ended, HlsConversion, HlsError, HlsRequest};
use crate::wifi;

impl Running for HlsConversion {
    fn ended(&self) -> watch::Receiver<Option<Ended>> {
        self.ended.clone()
    }

    fn set_playing(&self, playing: bool) {
        HlsConversion::set_playing(self, playing);
    }
}

static CONVERSIONS: OnceLock<Arc<Conversions<HlsConversion>>> = OnceLock::new();

pub async fn end_conversion() {
    if let Some(conversions) = CONVERSIONS.get() {
        conversions.stop().await;
    }
}

pub async fn load_converted<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    channel: &Channel,
    start_at: Option<f64>,
) -> Result<(), String> {
    let conversions = CONVERSIONS
        .get()
        .ok_or_else(|| HlsError::Failed.for_player())?
        .clone();
    let live = channel.content_type == "live";
    let start = start_at.filter(|_| !live).unwrap_or(0.0);
    let peers =
        wifi::wifi_peers(&wifi::interfaces()).ok_or_else(|| HlsError::NoNetwork.for_player())?;
    let agent = format!("Cinette/{}", app.package_info().version);
    tracing::info!("[AirPlay] converting live={live}");
    let request = HlsRequest {
        url,
        start_at: start,
        user_agent: Some(&agent),
        language: None,
        playable: &AIRPLAY_AUDIO,
        peers,
        live,
    };
    let title = channel.name.as_str();
    conversions
        .load(live, hls_out::start(request), |converted| {
            // The first segment starts at the keyframe before `start`, so
            // the position counts from there.
            let playing = Converted {
                offset: if live { 0.0 } else { converted.start },
                duration: converted.duration,
            };
            tauri_plugin_mpv::airplay::load(app, &converted.url, title, None, live, Some(playing))
        })
        .await
}

/// Runs the converter's pacer on the receiver's state, and has a
/// conversion that ends on its own show as the item's error.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    super::install_conversions(app, &CONVERSIONS);
}
