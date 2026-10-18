// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The conversion AirPlay plays from on iOS. One runs at a time, and it
//! stops when AirPlay ends or the next one starts.

use std::sync::Mutex;

use mvp_core::models::channel::Channel;
use tauri::{AppHandle, Listener, Runtime};
use tauri_plugin_mpv::airplay::{Converted, EVENT_STATE};

use super::AIRPLAY_AUDIO;
use crate::hls_out::{self, HlsConversion, HlsError, HlsRequest};
use crate::wifi;

static CONVERSION: Mutex<Option<HlsConversion>> = Mutex::new(None);

fn conversion() -> std::sync::MutexGuard<'static, Option<HlsConversion>> {
    CONVERSION.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn end_conversion() {
    let old = conversion().take();
    drop(old);
}

pub async fn load_converted<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    channel: &Channel,
    start_at: Option<f64>,
) -> Result<(), String> {
    end_conversion();
    let live = channel.content_type == "live";
    let start = start_at.filter(|_| !live).unwrap_or(0.0);
    let peers =
        wifi::wifi_peers(&wifi::interfaces()).ok_or_else(|| HlsError::NoNetwork.for_player())?;
    let agent = format!("Cinette/{}", app.package_info().version);
    tracing::info!("[AirPlay] converting live={live}");
    let started = hls_out::start(HlsRequest {
        url,
        start_at: start,
        user_agent: Some(&agent),
        language: None,
        playable: &AIRPLAY_AUDIO,
        peers,
    })
    .await;
    let converted = match started {
        Ok(converted) => converted,
        Err(e) => {
            tracing::warn!("[AirPlay] the conversion didn't start: {e}");
            return Err(e.for_player());
        }
    };
    let playing = Converted {
        offset: start,
        duration: converted.duration,
    };
    let result = tauri_plugin_mpv::airplay::load(
        app,
        &converted.url,
        &channel.name,
        None,
        live,
        Some(playing),
    );
    *conversion() = Some(converted);
    result
}

/// Runs the converter's pacer on the receiver's clock: it waits while the
/// receiver is paused, so a paused movie doesn't keep converting.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    app.listen_any(EVENT_STATE, |event| {
        let status = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(str::to_string));
        let Some(status) = status else { return };
        if let Some(conversion) = conversion().as_ref() {
            conversion.set_playing(matches!(
                status.as_str(),
                "playing" | "buffering" | "opening"
            ));
        }
    });
}
