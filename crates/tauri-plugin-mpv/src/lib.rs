// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

#![allow(dead_code)]

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

mod commands;
mod engine;
mod idle_inhibit;
pub mod mpv;
mod reconnect;
mod renderer;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "android")]
mod android;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use mpv::MpvState;

// The Swift half of the plugin, in `ios/Sources/MpvPlugin.swift`.
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mpv);

/// Set LC_NUMERIC=C once at plugin init (before any threads use locale-dependent code).
/// libmpv requires this for correct number parsing; without it mpv_create() returns null
/// on non-C locales (common on Linux).
#[cfg(target_os = "linux")]
fn ensure_c_locale() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        libc::setlocale(libc::LC_NUMERIC, b"C\0".as_ptr() as *const _);
    });
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mpv")
        .invoke_handler(tauri::generate_handler![
            commands::mpv_load,
            commands::mpv_play,
            commands::mpv_pause,
            commands::mpv_stop,
            commands::mpv_seek,
            commands::mpv_set_volume,
            commands::mpv_set_bounds,
            commands::mpv_set_visible,
            commands::mpv_get_state,
            commands::mpv_sub_add,
            commands::mpv_sub_remove,
            commands::mpv_set_sub_pos,
            commands::mpv_set_sub_delay,
            commands::mpv_set_media_info,
        ])
        .setup(|app, _api| {
            #[cfg(target_os = "linux")]
            ensure_c_locale();
            app.manage(MpvState::new());
            #[cfg(target_os = "ios")]
            {
                _api.register_ios_plugin(init_plugin_mpv)?;
                ios::install(app);
            }
            tracing::info!("MPV plugin initialized");
            Ok(())
        })
        .build()
}
