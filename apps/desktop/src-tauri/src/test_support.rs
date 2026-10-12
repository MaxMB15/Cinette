// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A mock app for tests, with the state and plugins the commands use.
//!
//! Each app keeps its settings, caches and downloads in a temporary folder of
//! its own, so tests never touch the real ones and can run side by side.

use crate::commands::AppState;
use crate::downloads::manager::DownloadManager;
use mvp_core::cache::store::CacheStore;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::utils::config::AppDirectoriesOverride;
use tauri::{App, AppHandle, Manager, State};
use tauri_plugin_mpv::MpvState;
use tempfile::TempDir;

/// A mock app and the temporary folder that holds everything it writes.
///
/// Dropping it stops any ffmpeg a test started, as quitting the app does.
/// Its managed state can outlive it, since an open store holds a handle to
/// the app, so nothing else should rely on the app being torn down.
pub(crate) struct TestApp {
    // Fields drop in order, so the app goes before its folder.
    app: App<MockRuntime>,
    dir: TempDir,
}

impl Drop for TestApp {
    fn drop(&mut self) {
        crate::downloads::manager::stop_all_for_exit(self.app.handle());
    }
}

impl TestApp {
    /// An app with an empty cache, the default download settings and a
    /// player that has nothing loaded.
    pub(crate) fn new() -> Self {
        let dir = tempfile::tempdir().expect("create a folder for the test app");
        let mut context = mock_context(noop_assets());
        // The mock's identifier is blank, which would put files straight in
        // the user's data folder if the override below were ever dropped.
        context.config_mut().identifier = "com.maxvideoplayer.test".into();
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Root(dir.path().join("app")));
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .plugin(tauri_plugin_shell::init())
            .build(context)
            .expect("build the mock app");
        let cache = CacheStore::open_in_memory().expect("open an in-memory cache");
        app.manage(AppState {
            cache: Mutex::new(cache),
        });
        app.manage(DownloadManager::new(dir.path().join("downloads")));
        app.manage(MpvState::new());
        Self { app, dir }
    }

    /// A handle to pass to commands, which take one by value.
    pub(crate) fn handle(&self) -> AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    /// The cache and the rest of the app's own state.
    pub(crate) fn state(&self) -> State<'_, AppState> {
        self.app.state()
    }

    /// The download queue.
    pub(crate) fn downloads(&self) -> State<'_, DownloadManager> {
        self.app.state()
    }

    /// The folder downloads go to until a test picks another.
    pub(crate) fn downloads_dir(&self) -> PathBuf {
        self.dir.path().join("downloads")
    }

    /// The folder that stands in for the app's data and config folders, with
    /// its cache in `caches` and its logs in `logs`. `settings.json` goes here.
    pub(crate) fn app_dir(&self) -> PathBuf {
        self.dir.path().join("app")
    }
}

/// Poison `mutex` the way a thread that panics while holding it would.
pub(crate) fn poison<T>(mutex: &Mutex<T>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = mutex.lock();
        panic!("poisoning a lock for a test");
    }));
    assert!(mutex.is_poisoned());
}

mod tests {
    use super::TestApp;
    use tauri::Manager;
    use tauri_plugin_store::StoreExt;

    #[test]
    fn the_app_keeps_its_folders_inside_its_own_temporary_folder() {
        let app = TestApp::new();
        let path = app.handle().path().clone();
        assert_eq!(path.app_data_dir().unwrap(), app.app_dir());
        assert_eq!(path.app_config_dir().unwrap(), app.app_dir());
        assert_eq!(path.app_local_data_dir().unwrap(), app.app_dir());
        assert_eq!(path.app_cache_dir().unwrap(), app.app_dir().join("caches"));
        assert_eq!(path.app_log_dir().unwrap(), app.app_dir().join("logs"));
        assert_eq!(app.downloads().root(), app.downloads_dir());
    }

    #[test]
    fn each_app_gets_a_folder_of_its_own() {
        let (a, b) = (TestApp::new(), TestApp::new());
        let data_dir = |app: &TestApp| app.handle().path().app_data_dir().unwrap();
        assert_ne!(data_dir(&a), data_dir(&b));
    }

    #[test]
    fn settings_land_in_the_app_folder_and_go_when_the_app_drops() {
        let app = TestApp::new();
        let store = app.handle().store("settings.json").unwrap();
        store.set("key", "value");
        store.save().unwrap();
        let file = app.app_dir().join("settings.json");
        assert!(file.exists());
        drop(store);
        drop(app);
        assert!(!file.exists());
    }
}
