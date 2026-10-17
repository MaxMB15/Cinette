// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::downloads::test_support::record;
use crate::test_support::TestApp;
use mvp_core::downloads::model::DownloadStatus;
use std::fs;

const NEW: &str = "app.cinette";

/// A folder named `name` in `parent` that holds a file, so a test can tell
/// which folder ended up where.
fn folder_with_file(parent: &Path, name: &str, contents: &str) {
    fs::create_dir_all(parent.join(name)).unwrap();
    fs::write(parent.join(name).join("settings.json"), contents).unwrap();
}

fn read(parent: &Path, name: &str) -> String {
    fs::read_to_string(parent.join(name).join("settings.json")).unwrap()
}

#[test]
fn the_old_folders_move_to_the_new_name_with_what_they_hold() {
    let (data, cache) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    folder_with_file(data.path(), OLD_IDENTIFIER, "data");
    folder_with_file(cache.path(), OLD_IDENTIFIER, "cache");

    move_folders(
        &[data.path().into(), cache.path().into()],
        OLD_IDENTIFIER,
        NEW,
    );

    assert!(!data.path().join(OLD_IDENTIFIER).exists());
    assert!(!cache.path().join(OLD_IDENTIFIER).exists());
    assert_eq!(read(data.path(), NEW), "data");
    assert_eq!(read(cache.path(), NEW), "cache");
}

#[test]
fn a_folder_already_at_the_new_name_is_never_overwritten() {
    let parent = tempfile::tempdir().unwrap();
    folder_with_file(parent.path(), OLD_IDENTIFIER, "old");
    folder_with_file(parent.path(), NEW, "new");

    move_folders(&[parent.path().into()], OLD_IDENTIFIER, NEW);

    assert_eq!(read(parent.path(), OLD_IDENTIFIER), "old");
    assert_eq!(read(parent.path(), NEW), "new");
}

#[test]
fn a_file_at_the_new_name_is_never_overwritten() {
    let parent = tempfile::tempdir().unwrap();
    folder_with_file(parent.path(), OLD_IDENTIFIER, "old");
    fs::write(parent.path().join(NEW), "a file").unwrap();

    move_folders(&[parent.path().into()], OLD_IDENTIFIER, NEW);

    assert_eq!(read(parent.path(), OLD_IDENTIFIER), "old");
    assert_eq!(
        fs::read_to_string(parent.path().join(NEW)).unwrap(),
        "a file"
    );
}

#[test]
fn nothing_is_made_without_an_old_folder() {
    let parent = tempfile::tempdir().unwrap();
    // A file with the old name isn't the app's folder.
    fs::write(parent.path().join(OLD_IDENTIFIER), "a file").unwrap();

    move_folders(&[parent.path().into()], OLD_IDENTIFIER, NEW);

    assert!(parent.path().join(OLD_IDENTIFIER).is_file());
    assert!(!parent.path().join(NEW).exists());
}

#[test]
fn a_folder_that_cant_move_stays_and_the_rest_still_move() {
    let (stuck, free) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    folder_with_file(stuck.path(), OLD_IDENTIFIER, "stuck");
    folder_with_file(free.path(), "missing", "");
    folder_with_file(free.path(), OLD_IDENTIFIER, "free");

    // The rename fails in `stuck`, which has no folder named "missing".
    let new = format!("missing/{NEW}");
    move_folders(
        &[stuck.path().into(), free.path().into()],
        OLD_IDENTIFIER,
        &new,
    );

    assert_eq!(read(stuck.path(), OLD_IDENTIFIER), "stuck");
    assert_eq!(read(free.path(), &new), "free");
}

#[test]
fn a_folder_listed_twice_moves_once() {
    let parent = tempfile::tempdir().unwrap();
    folder_with_file(parent.path(), OLD_IDENTIFIER, "data");

    let parents = [parent.path().into(), parent.path().into()];
    move_folders(&parents, OLD_IDENTIFIER, NEW);

    assert!(!parent.path().join(OLD_IDENTIFIER).exists());
    assert_eq!(read(parent.path(), NEW), "data");
}

#[test]
fn the_folders_tauri_names_after_the_identifier_are_all_listed() {
    let parents = parent_folders();
    for dir in [
        dirs::data_dir(),
        dirs::data_local_dir(),
        dirs::config_dir(),
        dirs::cache_dir(),
    ] {
        assert!(parents.contains(&dir.unwrap()));
    }
    let webkit = dirs::home_dir().unwrap().join("Library").join("WebKit");
    assert_eq!(parents.contains(&webkit), cfg!(target_os = "macos"));
}

/// A test app, its cache and the data folder it had before the move.
fn moved_app() -> (TestApp, CacheStore, PathBuf) {
    let app = TestApp::new();
    let old_dir = app.app_dir().with_file_name(OLD_IDENTIFIER);
    let cache = CacheStore::open_in_memory().unwrap();
    let inside = old_dir.join("downloads").join("Dune.mkv");
    cache
        .upsert_download(&record(
            "inside",
            DownloadStatus::Completed,
            inside.to_str().unwrap(),
        ))
        .unwrap();
    cache
        .upsert_download(&record(
            "elsewhere",
            DownloadStatus::Completed,
            "/Movies/Heat.mkv",
        ))
        .unwrap();
    crate::downloads::manager::save_folder(&app.handle(), old_dir.join("Videos").to_str().unwrap())
        .unwrap();
    (app, cache, old_dir)
}

fn dest_path(cache: &CacheStore, id: &str) -> PathBuf {
    cache.get_download(id).unwrap().unwrap().dest_path.into()
}

#[test]
fn once_the_data_folder_moved_the_paths_into_it_follow() {
    let (app, cache, _) = moved_app();

    update_moved_paths(&app.handle(), &cache, &app.app_dir());

    assert_eq!(
        dest_path(&cache, "inside"),
        app.app_dir().join("downloads").join("Dune.mkv")
    );
    assert_eq!(
        dest_path(&cache, "elsewhere"),
        Path::new("/Movies/Heat.mkv")
    );
    crate::downloads::manager::restore_settings(&app.handle());
    assert_eq!(app.downloads().root(), app.app_dir().join("Videos"));
}

#[test]
fn while_the_old_data_folder_is_there_the_paths_stay() {
    let (app, cache, old_dir) = moved_app();
    fs::create_dir_all(&old_dir).unwrap();

    update_moved_paths(&app.handle(), &cache, &app.app_dir());

    assert_eq!(
        dest_path(&cache, "inside"),
        old_dir.join("downloads").join("Dune.mkv")
    );
    crate::downloads::manager::restore_settings(&app.handle());
    assert_eq!(app.downloads().root(), old_dir.join("Videos"));
}
