// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

mod commands;
mod downloads;

use commands::AppState;
use mvp_core::cache::store::CacheStore;
use std::sync::Mutex;
use tauri::Manager;

/// Work around WebKit2GTK's DMABUF renderer causing a blank window inside the
/// AppImage runtime on some Linux configurations. Only applied when running
/// from an AppImage (detected via `APPIMAGE`, a variable the AppImage runtime
/// sets itself — we only read it). The workaround is harmful outside the
/// AppImage, which is why it is scoped to that runtime.
#[cfg(target_os = "linux")]
fn apply_linux_workarounds() {
    let is_appimage = std::env::var("APPIMAGE").is_ok();
    let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
    // Disable DMABUF only on X11 — on Wayland the DMABUF renderer is needed
    // for correct compositing with the EGL video subsurface. The original
    // workaround targeted blank-window bugs in some X11/AppImage configs.
    if is_appimage && !is_wayland && std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // The linuxdeploy-plugin-gtk AppRun hook forces GDK_BACKEND=x11 before
    // our binary starts. Override it back to wayland when a Wayland session
    // is available so GTK provides native wl_surface handles for embedded
    // video rendering. Scoped to AppImage only — .deb/.rpm use system GTK
    // which auto-detects correctly.
    if std::env::var("APPIMAGE").is_ok() && std::env::var("WAYLAND_DISPLAY").is_ok() {
        std::env::set_var("GDK_BACKEND", "wayland");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("max_video_player=debug".parse().unwrap())
                .add_directive("tauri_plugin_mpv=debug".parse().unwrap())
                .add_directive("mvp_core=debug".parse().unwrap()),
        )
        .init();

    #[cfg(target_os = "linux")]
    apply_linux_workarounds();

    let builder = tauri::Builder::default();
    // On iOS the App Store handles updates, and there's nothing to relaunch.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_mpv::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::load_m3u_playlist,
            commands::load_m3u_file,
            commands::load_xtream_provider,
            commands::get_providers,
            commands::remove_provider,
            commands::get_all_channels,
            commands::toggle_favorite,
            commands::refresh_provider,
            commands::update_provider,
            commands::get_xtream_series_episodes,
            commands::refresh_epg,
            commands::get_epg_programmes,
            commands::get_epg_for_live_channels,
            commands::search_epg_programmes,
            commands::set_epg_url,
            commands::detect_epg_url,
            commands::get_omdb_api_key,
            commands::set_omdb_api_key,
            commands::fetch_omdb_data,
            commands::get_mdblist_api_key,
            commands::set_mdblist_api_key,
            commands::test_mdblist_api_key,
            commands::fetch_mdblist_data,
            commands::fetch_whatson_data,
            commands::get_opensubtitles_api_key,
            commands::set_opensubtitles_api_key,
            commands::test_opensubtitles_api_key,
            commands::search_subtitles,
            commands::download_subtitle,
            commands::read_subtitle_file,
            commands::record_play_start,
            commands::record_play_end,
            commands::get_watch_history,
            commands::delete_history_entry,
            commands::clear_watch_history,
            commands::save_playback_position,
            commands::get_playback_position,
            commands::delete_playback_position,
            commands::get_group_hierarchy,
            commands::update_group_hierarchy_entry,
            commands::delete_group_hierarchy,
            commands::pin_group,
            commands::unpin_group,
            commands::get_pinned_groups,
            commands::get_gemini_api_key,
            commands::set_gemini_api_key,
            commands::test_gemini_api_key,
            commands::categorize_provider,
            commands::clear_all_caches,
            commands::reorder_group_hierarchy_entry,
            commands::fix_uncategorized_groups,
            commands::rename_super_category,
            commands::delete_super_category,
            commands::get_install_info,
            commands::package_update,
            commands::enqueue_movie_download,
            commands::enqueue_episode_download,
            commands::enqueue_episodes_batch,
            commands::list_downloads,
            commands::cache_series_episodes,
            commands::get_cached_series_episodes,
            commands::stop_download,
            commands::stop_downloads,
            commands::remove_download,
            commands::remove_downloads,
            commands::set_download_concurrency,
            commands::get_download_concurrency,
            commands::set_download_folder,
            commands::get_download_folder,
            commands::resolve_local_download,
        ])
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let db_path = app_dir.join("maxvideoplayer.db");
            tracing::info!("Database path: {}", db_path.display());

            let cache = CacheStore::open(&db_path)
                .expect("failed to open database");

            // Collapse any leftover duplicate download rows (e.g. a failed
            // attempt sitting next to a later successful one) to one record
            // per channel so the UI doesn't show a stale error after reboot.
            match cache.prune_redundant_downloads() {
                Ok(ids) if !ids.is_empty() => {
                    tracing::info!("Pruned {} redundant download record(s)", ids.len());
                }
                Err(e) => tracing::warn!("Failed to prune download records: {e}"),
                _ => {}
            }

            app.manage(AppState {
                cache: Mutex::new(cache),
            });

            let downloads_root = app_dir.join("downloads");
            app.manage(crate::downloads::manager::DownloadManager::new(downloads_root));
            crate::downloads::manager::restore_settings(app.handle());

            #[cfg(desktop)]
            {
                use tauri_plugin_shell::ShellExt;
                match app.shell().sidecar("ffmpeg") {
                    Ok(_) => tracing::info!("ffmpeg sidecar resolved"),
                    Err(e) => tracing::error!("ffmpeg sidecar missing: {e}"),
                }
            }

            // Set the WebView's native background to fully transparent so the
            // video surface (positioned below the WebView) is visible through it.
            // CSS `background: transparent` alone is not sufficient on all Linux
            // compositors (e.g. Pop!_OS/COSMIC with WebKit2GTK DMABUF renderer).
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            if let Some(ref window) = app.get_webview_window("main") {
                use tauri::webview::Color;
                if let Err(e) = window.set_background_color(Some(Color(0, 0, 0, 0))) {
                    tracing::warn!("Failed to set WebView background transparent: {}", e);
                }
            }

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let handle = app.handle().clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::Resized(size) = event {
                            if let Some(state) = handle.try_state::<tauri_plugin_mpv::MpvState>() {
                                state.resize(size.width, size.height);
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
