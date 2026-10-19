// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

pub mod airplay;
#[cfg(any(target_os = "ios", test))]
mod artwork;
mod commands;
mod engine;
mod idle_inhibit;
mod loadfile;
mod lock;
mod log_url;
pub mod mpv;
mod reconnect;
mod renderer;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod gl_render;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod options;

#[cfg(test)]
mod test_support;

#[cfg(target_os = "android")]
mod android;
#[cfg(any(target_os = "android", test))]
mod android_surface;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use engine::MediaInfo;
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
        libc::setlocale(libc::LC_NUMERIC, c"C".as_ptr());
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
            commands::mpv_get_media_info,
            commands::mpv_sub_add,
            commands::mpv_sub_remove,
            commands::mpv_set_sub_delay,
            commands::mpv_set_media_info,
            commands::mpv_set_skip_intervals,
            airplay::airplay_set_detection,
            airplay::airplay_choose,
            airplay::airplay_get_route,
            airplay::airplay_play,
            airplay::airplay_pause,
            airplay::airplay_seek,
            airplay::airplay_select_subtitle,
            airplay::airplay_select_audio,
            airplay::airplay_stop,
            airplay::airplay_get_state,
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
            airplay::install(app);
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("app.cinette.mpv", "MpvPlugin")?;
                let font_dir = app.path().app_cache_dir().ok().map(|dir| dir.join("mpv-fonts"));
                android::install(
                    Box::new(move |command, payload| {
                        if let Err(e) = handle.run_mobile_plugin::<serde_json::Value>(command, payload) {
                            tracing::warn!("[MPV android] {command} failed: {e}");
                        }
                    }),
                    font_dir,
                );
            }
            tracing::info!("MPV plugin initialized");
            Ok(())
        })
        .build()
}
