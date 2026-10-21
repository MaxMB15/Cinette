// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The conversions AirPlay plays from on macOS. [`super::conversion`] runs
//! them in order, and this file joins it to the bundled ffmpeg's HLS output
//! and the mpv plugin.
//!
//! The source is probed first, after mpv has stopped, so the probe isn't a
//! second connection to the provider. While mpv played, only its codecs
//! were known, not every audio track.

use std::sync::{Arc, OnceLock};

use mvp_core::models::channel::Channel;
use mvp_core::streams::probe::ProbeError;
use tauri::{AppHandle, Runtime};
use tauri_plugin_mpv::airplay::Converted;
use tokio::sync::watch;

use super::conversion::{Conversions, Running};
use super::AIRPLAY_AUDIO;
use crate::convert::hls::{self, Ended, FfmpegHls, HlsError};
use crate::convert::support::support;
use crate::wifi;

/// A conversion, with what the receiver's position needs.
pub struct MacConversion {
    hls: FfmpegHls,
    /// The source's length, for a movie or an episode.
    duration: Option<f64>,
}

impl Running for MacConversion {
    fn ended(&self) -> watch::Receiver<Option<Ended>> {
        self.hls.ended.clone()
    }

    fn set_playing(&self, playing: bool) {
        self.hls.set_playing(playing);
    }
}

static CONVERSIONS: OnceLock<Arc<Conversions<MacConversion>>> = OnceLock::new();

pub fn end_conversion() {
    if let Some(conversions) = CONVERSIONS.get() {
        conversions.stop();
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
    let peers = wifi::lan_peers(wifi::default_route_address(), &wifi::interfaces())
        .ok_or_else(|| HlsError::NoNetwork.for_player())?;
    tracing::info!("[AirPlay] converting live={live}");
    let starting = async {
        let probed = crate::streams::probe(app, url).await.map_err(|e| match e {
            ProbeError::Refused(_) => HlsError::Refused,
            _ => HlsError::Unreachable,
        })?;
        let support = support(app).await;
        let (plan, encoders, audio) = hls::plan(&probed, start, live, &AIRPLAY_AUDIO, &support)?;
        let hls = hls::start(app, url, &plan, encoders, peers, audio).await?;
        Ok(MacConversion {
            hls,
            duration: probed.duration.filter(|_| !live),
        })
    };
    let title = channel.name.as_str();
    conversions
        .load(live, starting, |converted| {
            // ffmpeg starts at the keyframe before `start`, so the TV's
            // position runs up to one group of pictures ahead, as on Cast.
            let playing = Converted {
                offset: start,
                duration: converted.duration,
            };
            tauri_plugin_mpv::airplay::load(
                app,
                &converted.hls.url,
                title,
                None,
                live,
                Some(playing),
            )
        })
        .await
}

/// Runs the converter's pacer on the receiver's state, and has a
/// conversion that ends on its own show as the item's error.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    super::install_conversions(app, &CONVERSIONS);
}
