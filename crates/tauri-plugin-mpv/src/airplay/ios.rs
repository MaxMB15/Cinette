// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The calls into `AirPlayHost` in `ios/Sources/AirPlay.swift`, and the
//! callbacks it makes. Swift runs everything on the main thread and queues
//! the calls there, so none of these wait.

use super::{handle_report, Route, EVENT_PICKER_CLOSED, EVENT_ROUTE};
use crate::lock::lock_or_recover;
use std::ffi::{c_char, CStr, CString};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime};

unsafe extern "C" {
    fn mvp_ios_airplay_register(
        available: Option<extern "C" fn(bool)>,
        route: Option<extern "C" fn(*const c_char, *const c_char)>,
        picker_closed: Option<extern "C" fn()>,
        report: Option<extern "C" fn(*const c_char)>,
    );
    fn mvp_ios_airplay_set_detection(enabled: bool);
    fn mvp_ios_airplay_choose(x: f64, y: f64, width: f64, height: f64);
    fn mvp_ios_airplay_load(
        url: *const c_char,
        title: *const c_char,
        start: f64,
        live: bool,
        converted: bool,
    );
    fn mvp_ios_airplay_play();
    fn mvp_ios_airplay_pause();
    fn mvp_ios_airplay_seek(position: f64);
    fn mvp_ios_airplay_select_legible(index: i32);
    fn mvp_ios_airplay_select_audible(index: i32);
    fn mvp_ios_airplay_stop();
}

/// What the callbacks hand events to. Swift calls them on the main thread,
/// and emitting doesn't block.
type Sink = Box<dyn Fn(Callback) + Send + Sync>;
static SINK: OnceLock<Sink> = OnceLock::new();

enum Callback {
    Available(bool),
    Route(Option<Route>),
    PickerClosed,
    Report(String),
}

/// The receiver the audio route went to last, for `airplay_get_route`.
static ROUTE: Mutex<Option<Route>> = Mutex::new(None);

pub fn ensure() -> Result<(), String> {
    Ok(())
}

pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let sink: Sink = Box::new(move |callback| match callback {
        Callback::Available(available) => super::detected(&app, available),
        Callback::Route(route) => {
            *lock_or_recover(&ROUTE) = route.clone();
            let _ = app.emit(EVENT_ROUTE, route);
        }
        Callback::PickerClosed => {
            let _ = app.emit(EVENT_PICKER_CLOSED, ());
        }
        Callback::Report(json) => handle_report(&app, &json, Instant::now()),
    });
    if SINK.set(sink).is_err() {
        return;
    }
    unsafe {
        mvp_ios_airplay_register(
            Some(on_available),
            Some(on_route),
            Some(on_picker_closed),
            Some(on_report),
        )
    };
}

fn send(callback: Callback) {
    if let Some(sink) = SINK.get() {
        sink(callback);
    }
}

/// Copies a C string Swift passed. It frees it when the callback returns.
fn copy(text: *const c_char) -> Option<String> {
    if text.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned(),
    )
}

extern "C" fn on_available(available: bool) {
    send(Callback::Available(available));
}

/// `name` and `uid` are both null when the route isn't AirPlay.
extern "C" fn on_route(name: *const c_char, uid: *const c_char) {
    let route = match (copy(name), copy(uid)) {
        (Some(name), Some(uid)) => Some(Route::new(&uid, &name)),
        _ => None,
    };
    send(Callback::Route(route));
}

extern "C" fn on_picker_closed() {
    send(Callback::PickerClosed);
}

extern "C" fn on_report(json: *const c_char) {
    if let Some(json) = copy(json) {
        send(Callback::Report(json));
    }
}

/// Swift's reports don't carry `_load` yet, so a report about the old item
/// that Swift read just before a quick reload still reaches the new one.
pub fn load(
    url: &str,
    title: &str,
    start: f64,
    live: bool,
    converted: bool,
    _load: u64,
) -> Result<(), String> {
    let url = CString::new(url).map_err(|_| "The stream address isn't valid".to_string())?;
    // A title with a NUL in it just goes without one.
    let title = CString::new(title).unwrap_or_default();
    unsafe { mvp_ios_airplay_load(url.as_ptr(), title.as_ptr(), start, live, converted) };
    Ok(())
}

pub fn set_detection(enabled: bool) {
    unsafe { mvp_ios_airplay_set_detection(enabled) };
}

pub fn choose(x: f64, y: f64, width: f64, height: f64) {
    unsafe { mvp_ios_airplay_choose(x, y, width, height) };
}

pub fn current_route() -> Option<Route> {
    lock_or_recover(&ROUTE).clone()
}

pub fn play() {
    unsafe { mvp_ios_airplay_play() };
}

pub fn pause() {
    unsafe { mvp_ios_airplay_pause() };
}

pub fn seek(position: f64) {
    unsafe { mvp_ios_airplay_seek(position) };
}

pub fn select_subtitle(index: Option<usize>) {
    let index = index.and_then(|i| i32::try_from(i).ok()).unwrap_or(-1);
    unsafe { mvp_ios_airplay_select_legible(index) };
}

pub fn select_audio(index: usize) {
    if let Ok(index) = i32::try_from(index) {
        unsafe { mvp_ios_airplay_select_audible(index) };
    }
}

pub fn stop() {
    unsafe { mvp_ios_airplay_stop() };
}
