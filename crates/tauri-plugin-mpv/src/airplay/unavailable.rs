// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Platforms without AirPlay yet. [`ensure`] fails, so nothing else here
//! runs.

use super::{Route, UNAVAILABLE};
use tauri::{AppHandle, Runtime};

pub fn ensure() -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

pub fn install<R: Runtime>(_app: &AppHandle<R>) {}

pub fn load(
    _url: &str,
    _title: &str,
    _start: f64,
    _live: bool,
    _converted: bool,
    _load: u64,
) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

pub fn set_detection(_enabled: bool) {}

pub fn choose(_x: f64, _y: f64, _width: f64, _height: f64) {}

pub fn current_route() -> Option<Route> {
    None
}

pub fn play() {}

pub fn pause() {}

pub fn seek(_position: f64) {}

pub fn select_subtitle(_index: Option<usize>) {}

pub fn select_audio(_index: usize) {}

pub fn stop() {}
