// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

mod airplay;
#[cfg(target_os = "android")]
mod android_device;
#[cfg(target_os = "android")]
mod android_tls;
mod commands;
mod downloads;
#[cfg(desktop)]
mod identifier;
mod logging;
mod progress;
mod streams;
#[cfg(test)]
mod android_project_tests;
#[cfg(test)]
mod capabilities_tests;
#[cfg(test)]
mod test_support;

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
    let is_set = |name| std::env::var(name).is_ok();
    let changes = linux_workarounds(
        is_set("APPIMAGE"),
        is_set("WAYLAND_DISPLAY"),
        is_set("WEBKIT_DISABLE_DMABUF_RENDERER"),
    );
    for (name, value) in changes {
        // SAFETY: run() calls this before it builds Tauri, and nothing before
        // it starts a thread, so no other thread can be reading the environment.
        unsafe { std::env::set_var(name, value) };
    }
}

/// The environment variables [`apply_linux_workarounds`] sets, and their
/// values, for a run from an AppImage or not, in a Wayland session or not,
/// and with `WEBKIT_DISABLE_DMABUF_RENDERER` already set or not.
#[cfg(target_os = "linux")]
fn linux_workarounds(
    appimage: bool,
    wayland: bool,
    dmabuf_chosen: bool,
) -> Vec<(&'static str, &'static str)> {
    let mut changes = Vec::new();
    // Disable DMABUF only on X11 — on Wayland the DMABUF renderer is needed
    // for correct compositing with the EGL video subsurface. The original
    // workaround targeted blank-window bugs in some X11/AppImage configs.
    if appimage && !wayland && !dmabuf_chosen {
        changes.push(("WEBKIT_DISABLE_DMABUF_RENDERER", "1"));
    }
    // The linuxdeploy-plugin-gtk AppRun hook forces GDK_BACKEND=x11 before
    // our binary starts. Override it back to wayland when a Wayland session
    // is available so GTK provides native wl_surface handles for embedded
    // video rendering. Scoped to AppImage only — .deb/.rpm use system GTK
    // which auto-detects correctly.
    if appimage && wayland {
        changes.push(("GDK_BACKEND", "wayland"));
    }
    changes
}

/// Decides whether `tauri-plugin-single-instance` can start on Linux, by the
/// rules zbus uses to find the session bus.
///
/// The plugin opens its D-Bus connection with
/// `zbus::blocking::connection::Builder::session().unwrap()`. zbus reads the
/// address from `DBUS_SESSION_BUS_ADDRESS`. When that isn't set, it uses
/// `$XDG_RUNTIME_DIR/bus`, or `/run/user/<euid>/bus` without `XDG_RUNTIME_DIR`.
/// The unwrap panics at launch when the variable is set to something zbus
/// can't parse, such as an empty value or the `/dev/null` some headless setups
/// use. A bus that isn't running doesn't panic, but the plugin then can't stop
/// a second copy and doesn't say so, so that case is reported too.
///
/// `dbus_address` and `runtime_dir` are the two variables as `std::env::var`
/// reads them, so a value that isn't UTF-8 counts as unset, as it does in zbus.
/// `socket_exists` is only asked about the fallback socket. Returns the reason
/// to leave the plugin out, or `None` when it can start.
#[cfg(target_os = "linux")]
fn session_bus_problem(
    dbus_address: Option<&str>,
    runtime_dir: Option<&str>,
    euid: u32,
    socket_exists: impl Fn(&std::path::Path) -> bool,
) -> Option<String> {
    use std::str::FromStr;

    if let Some(address) = dbus_address {
        return zbus::Address::from_str(address)
            .err()
            .map(|e| format!("zbus can't use DBUS_SESSION_BUS_ADDRESS {address:?}. {e}"));
    }
    let socket = match runtime_dir {
        Some(dir) => format!("{dir}/bus"),
        None => format!("/run/user/{euid}/bus"),
    };
    (!socket_exists(std::path::Path::new(&socket))).then(|| {
        format!("DBUS_SESSION_BUS_ADDRESS isn't set and there's no session bus at {socket}.")
    })
}

/// Bring the main window to the front, for when the app is opened again
/// while it's running.
#[cfg(desktop)]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Builds `invoke_handler` and, for tests, `COMMAND_NAMES` from one list, so
/// the tests learn of every command the app registers.
macro_rules! register_commands {
    ($($module:ident::$command:ident),* $(,)?) => {
        /// Every command the frontend can call. Tests build their mock app with it
        /// too, so they reach the commands the same way the app does.
        fn invoke_handler<R: tauri::Runtime>(
        ) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($module::$command),*]
        }

        /// The name of each command `invoke_handler` registers.
        #[cfg(test)]
        const COMMAND_NAMES: &[&str] = &[$(stringify!($command)),*];
    };
}

register_commands![
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
    commands::test_omdb_api_key,
    commands::fetch_omdb_data,
    commands::get_mdblist_api_key,
    commands::set_mdblist_api_key,
    commands::test_mdblist_api_key,
    commands::fetch_mdblist_data,
    commands::fetch_whatson_data,
    commands::get_skip_segments,
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
    commands::delete_history_series,
    commands::clear_watch_history,
    commands::clear_watch_history_of_type,
    commands::save_playback_position,
    commands::get_playback_position,
    commands::delete_playback_position,
    progress::hand_off_progress,
    streams::get_stream_formats,
    airplay::airplay_load,
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
    commands::set_download_keep,
    commands::get_download_retention,
    commands::set_download_retention,
    commands::count_downloads_due,
    commands::schedule_recording,
    commands::stop_recording,
];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();

    #[cfg(target_os = "linux")]
    apply_linux_workarounds();

    let context = tauri::generate_context!();
    // Moves the folders saved under the old identifier before the app is
    // built, since building it opens the window, and WebKit's storage with it.
    #[cfg(desktop)]
    identifier::move_folders(
        &identifier::parent_folders(),
        identifier::OLD_IDENTIFIER,
        &context.config().identifier,
    );

    let builder = tauri::Builder::default();
    // A second copy of the app would share the database and start the same
    // downloads again, so opening the app again shows the open window. This
    // plugin comes first so the second copy quits before anything else runs.
    // On Linux it needs a D-Bus session bus, which `session_bus_problem` checks.
    #[cfg(target_os = "linux")]
    let single_instance = match session_bus_problem(
        std::env::var("DBUS_SESSION_BUS_ADDRESS").ok().as_deref(),
        std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
        // SAFETY: geteuid takes no arguments, can't fail and touches no memory.
        unsafe { libc::geteuid() },
        |socket| socket.exists(),
    ) {
        Some(reason) => {
            tracing::warn!("{reason} More than one copy of the app can run.");
            false
        }
        None => true,
    };
    #[cfg(all(desktop, not(target_os = "linux")))]
    let single_instance = true;
    #[cfg(desktop)]
    let builder = if single_instance {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app)
        }))
    } else {
        builder
    };
    // On iOS the App Store handles updates, and there's nothing to relaunch.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Metadata and subtitle lookups name the app's version in their user agent.
    mvp_core::http::set_app_version(env!("CARGO_PKG_VERSION"));

    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_device::plugin());

    builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_mpv::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(invoke_handler())
        .setup(|app| {
            // Before anything makes an HTTPS request. If it fails, every HTTPS
            // request would hang, so the app stops here instead.
            #[cfg(target_os = "android")]
            android_tls::init().expect("HTTPS certificate checks could not start");

            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let db_path = app_dir.join("maxvideoplayer.db");
            tracing::info!("Database path: {}", db_path.display());

            let cache = CacheStore::open(&db_path)
                .expect("failed to open database");

            // A download's file moved with the data folder, so its saved path
            // has to follow before anything reads it.
            #[cfg(desktop)]
            identifier::update_moved_paths(app.handle(), &cache, &app_dir);

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

            // Downloads that were running when the app quit have no ffmpeg
            // anymore. Left as they are, each would hold a download slot for good.
            match cache.requeue_interrupted_downloads() {
                Ok(n) if n > 0 => tracing::info!("Requeued {n} interrupted download(s)"),
                Err(e) => tracing::warn!("Failed to requeue interrupted downloads: {e}"),
                _ => {}
            }

            // Recordings that were running then keep their files. A program
            // that's still on gets a new recording for the rest.
            match crate::downloads::recordings::recover(&cache) {
                Ok(n) if n > 0 => tracing::info!("Settled {n} interrupted recording(s)"),
                Err(e) => tracing::warn!("Failed to settle interrupted recordings: {e}"),
                _ => {}
            }

            app.manage(AppState {
                cache: Mutex::new(cache),
            });

            let downloads_root = app_dir.join("downloads");
            app.manage(crate::downloads::manager::DownloadManager::new(downloads_root));
            app.manage(crate::downloads::recordings::Recorder::default());
            app.manage(crate::streams::StreamsState::default());
            crate::downloads::manager::restore_settings(app.handle());

            #[cfg(desktop)]
            {
                use tauri_plugin_shell::ShellExt;
                crate::downloads::retention::start(app.handle());
                match app.shell().sidecar(crate::downloads::FFMPEG_SIDECAR) {
                    Ok(_) => {
                        tracing::info!("ffmpeg sidecar resolved");
                        // Start or miss the recordings that came due while the
                        // app was closed, before downloads take the connections.
                        let next_check = crate::downloads::recordings::run_check(app.handle());
                        crate::downloads::recordings::start(app.handle(), next_check);
                        // Start whatever is still queued from the last run.
                        if let Err(e) = crate::downloads::manager::pump(app.handle()) {
                            tracing::warn!("Failed to start queued downloads: {e}");
                        }
                    }
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
                        if let tauri::WindowEvent::Resized(size) = event
                            && let Some(state) = handle.try_state::<tauri_plugin_mpv::MpvState>()
                        {
                            state.resize(size.width, size.height);
                        }
                    });
                }
            }

            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                crate::downloads::manager::stop_all_for_exit(app);
                crate::downloads::recordings::stop_all_for_exit(app);
            }
        });
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{linux_workarounds, session_bus_problem};
    use std::path::Path;

    /// For cases that must not look for the fallback socket.
    fn never_asked(path: &Path) -> bool {
        panic!("looked for {}", path.display())
    }

    /// Finds only the session bus of user 1000.
    fn user_1000_bus(path: &Path) -> bool {
        path == Path::new("/run/user/1000/bus")
    }

    #[test]
    fn a_session_bus_address_zbus_can_parse_registers_the_plugin() {
        for address in [
            "unix:path=/run/user/1000/bus",
            "unix:abstract=/tmp/dbus-abc,guid=0123456789abcdef0123456789abcdef",
        ] {
            let problem = session_bus_problem(Some(address), None, 1000, never_asked);
            assert_eq!(problem, None, "{address:?} should be accepted");
        }
    }

    #[test]
    fn a_session_bus_address_zbus_cant_parse_leaves_the_plugin_out() {
        for address in ["", "/dev/null", "disabled:", "unix:foo=bar"] {
            let problem = session_bus_problem(Some(address), None, 1000, never_asked);
            assert!(problem.is_some(), "{address:?} should be refused");
        }
    }

    #[test]
    fn without_an_address_the_socket_in_the_runtime_dir_decides() {
        let problem = session_bus_problem(None, Some("/run/user/1000"), 0, user_1000_bus);
        assert_eq!(problem, None);
        let problem = session_bus_problem(None, Some("/tmp/elsewhere"), 1000, user_1000_bus);
        assert!(problem.unwrap().contains("/tmp/elsewhere/bus"));
    }

    #[test]
    fn without_a_runtime_dir_the_socket_under_run_user_decides() {
        assert_eq!(session_bus_problem(None, None, 1000, user_1000_bus), None);
        let problem = session_bus_problem(None, None, 1001, user_1000_bus);
        assert!(problem.unwrap().contains("/run/user/1001/bus"));
    }

    /// A .deb or .rpm install uses the system's GTK and WebKit, which choose
    /// for themselves.
    #[test]
    fn outside_an_appimage_nothing_is_changed() {
        let cases = [(false, false), (false, true), (true, false), (true, true)];
        for (wayland, dmabuf_chosen) in cases {
            let changes = linux_workarounds(false, wayland, dmabuf_chosen);
            assert!(changes.is_empty(), "{changes:?}");
        }
    }

    /// WebKit's DMABUF renderer can leave an AppImage's window blank on X11,
    /// so it's turned off there unless the user already chose a setting.
    #[test]
    fn an_appimage_on_x11_turns_off_dmabuf_unless_the_user_chose() {
        let changes = linux_workarounds(true, false, false);
        assert_eq!(changes, [("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]);
        let changes = linux_workarounds(true, false, true);
        assert!(changes.is_empty(), "{changes:?}");
    }

    /// The AppImage's GTK hook turns Wayland off. It's turned back on in a
    /// Wayland session so the video can draw below the page, and DMABUF
    /// stays on there.
    #[test]
    fn an_appimage_on_wayland_goes_back_to_wayland() {
        for dmabuf_chosen in [false, true] {
            let changes = linux_workarounds(true, true, dmabuf_chosen);
            assert_eq!(changes, [("GDK_BACKEND", "wayland")]);
        }
    }
}
