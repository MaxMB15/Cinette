// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! `MpvState` on Android, until libmpv is built for it.
//!
//! The app builds and runs on Android without libmpv, so this stands in for
//! `mpv.rs` there with the same methods. Loading a stream fails with
//! [`UNSUPPORTED`], and the rest do nothing. The Android renderer replaces
//! this file.

use serde::{Deserialize, Serialize};

/// The error a load gets on Android.
pub const UNSUPPORTED: &str = "Playback isn't supported on Android yet";

/// The same fields as `engine::PlayerState`, which can't build without
/// libmpv. Nothing ever plays, so every field keeps its default.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub is_playing: bool,
    pub is_paused: bool,
    pub current_url: Option<String>,
    pub volume: f64,
    pub position: f64,
    pub duration: f64,
    pub playback_started: bool,
    pub open_failed: bool,
    pub reached_end: bool,
    pub waiting: bool,
    pub fallback_active: bool,
}

#[derive(Default)]
pub struct MpvState;

impl MpvState {
    pub fn new() -> Self {
        Self
    }

    pub fn load<R: tauri::Runtime>(
        &self,
        _url: &str,
        _start_pos: Option<f64>,
        _hwdec: bool,
        _keep_subtitles: bool,
        _app: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn set_visible(&self, _visible: bool) {}

    pub fn set_bounds(&self, _x: f64, _y: f64, _w: f64, _h: f64) {}

    pub fn resize(&self, _width: u32, _height: u32) {}

    pub fn play(&self) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn pause(&self) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn stop(&self) {}

    pub fn seek(&self, _position: f64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn seek_relative(&self, _offset: f64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn set_video_enabled(&self, _enabled: bool) {}

    pub fn set_media_info(&self, _title: Option<String>, _live: bool, _artwork: Option<String>) {}

    pub fn set_skip_intervals(&self, _back: f64, _forward: f64) {}

    pub fn set_volume(&self, _volume: f64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn sub_add(&self, _path: &str, _overlay: bool, _url: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn sub_remove(&self, _id: i64, _url: Option<&str>) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn set_sub_delay(&self, _delay: f64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn get_state(&self) -> PlayerState {
        PlayerState::default()
    }
}
