// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Tests for the download queue. Most run against a mock app and the real
//! bundled ffmpeg, as `downloads::test_support` describes.

use super::*;
use crate::downloads::test_support::{
    add_channel, add_download, download, finished, missing_url, movie, record, video_url,
    DownloadEvent, Events, STALLS, VIDEO_BYTES,
};
use crate::test_support::{poison, TestApp};
use mvp_core::models::channel::Channel;
use serde_json::json;

fn queued(id: &str, dest_path: &str) -> DownloadRecord {
    record(id, DownloadStatus::Queued, dest_path)
}

fn channel(id: &str, name: &str) -> Channel {
    movie(id, name, &format!("http://h/movie/u/p/{id}.mkv"))
}

/// Delete the downloads `ids` the way `delete_downloads` does.
fn delete(cache: &Mutex<CacheStore>, ids: &[&str], missing: MissingFile) -> Deleted {
    delete_selected(cache, &Deleting::default(), missing, |c| select(c, ids)).unwrap()
}

fn select(cache: &CacheStore, ids: &[&str]) -> Result<Vec<DownloadRecord>, String> {
    Ok(ids
        .iter()
        .filter_map(|id| cache.get_download(id).unwrap())
        .collect())
}

fn exists(cache: &Mutex<CacheStore>, id: &str) -> bool {
    cache.lock().unwrap().get_download(id).unwrap().is_some()
}

#[test]
fn a_file_two_records_share_stays_until_the_last_one_goes() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Dune (2021).mkv");
    std::fs::write(&file, b"video").unwrap();
    let cache = Mutex::new(CacheStore::open_in_memory().unwrap());
    {
        let c = cache.lock().unwrap();
        c.upsert_download(&finished("a", &file)).unwrap();
        // Name the file in another case where the file system ignores
        // case, as the default macOS one does. Elsewhere that would be
        // another file, so use the same name.
        let upper = dir.path().join("DUNE (2021).MKV");
        let shared = if upper.exists() { upper } else { file.clone() };
        c.upsert_download(&finished("b", &shared)).unwrap();
    }

    let deleted = delete(&cache, &["a"], MissingFile::Forget);
    assert_eq!(deleted.removed, vec!["a"]);
    assert!(!exists(&cache, "a"));
    assert!(file.exists(), "b still points at the file");

    delete(&cache, &["b"], MissingFile::Forget);
    assert!(!exists(&cache, "b"));
    assert!(!file.exists());
}

#[test]
fn a_file_another_download_is_writing_stays() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Dune (2021).mkv");
    std::fs::write(&file, b"video").unwrap();
    let cache = Mutex::new(CacheStore::open_in_memory().unwrap());
    {
        let c = cache.lock().unwrap();
        c.upsert_download(&finished("a", &file)).unwrap();
        c.upsert_download(&queued("b", &part_path(&file).to_string_lossy()))
            .unwrap();
    }
    delete(&cache, &["a"], MissingFile::Forget);
    assert!(!exists(&cache, "a"));
    assert!(file.exists());
}

#[test]
fn deleting_every_record_of_a_shared_file_deletes_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Dune (2021).mkv");
    std::fs::write(&file, b"video").unwrap();
    let cache = Mutex::new(CacheStore::open_in_memory().unwrap());
    {
        let c = cache.lock().unwrap();
        c.upsert_download(&finished("a", &file)).unwrap();
        c.upsert_download(&finished("b", &file)).unwrap();
    }
    let deleted = delete(&cache, &["a", "b"], MissingFile::KeepWithoutFolder);
    assert_eq!(deleted.removed, vec!["a", "b"]);
    assert!(deleted.errors.is_empty());
    assert!(!file.exists());
}

#[test]
fn a_missing_file_still_removes_the_record() {
    let dir = tempfile::tempdir().unwrap();
    let cache = Mutex::new(CacheStore::open_in_memory().unwrap());
    {
        let c = cache.lock().unwrap();
        c.upsert_download(&finished("a", &dir.path().join("gone.mkv")))
            .unwrap();
        c.upsert_download(&finished("b", &dir.path().join("gone too.mkv")))
            .unwrap();
    }
    delete(&cache, &["a"], MissingFile::Forget);
    assert!(!exists(&cache, "a"));
    // Its folder is there, so the file was deleted rather than unplugged.
    delete(&cache, &["b"], MissingFile::KeepWithoutFolder);
    assert!(!exists(&cache, "b"));
}

#[test]
fn a_missing_folder_keeps_the_record_unless_the_user_removes_it() {
    let dir = tempfile::tempdir().unwrap();
    // As if the drive with this folder were unplugged.
    let file = dir.path().join("Unplugged").join("Dune (2021).mkv");
    let cache = Mutex::new(CacheStore::open_in_memory().unwrap());
    cache
        .lock()
        .unwrap()
        .upsert_download(&finished("a", &file))
        .unwrap();

    let deleted = delete(&cache, &["a"], MissingFile::KeepWithoutFolder);
    assert!(deleted.removed.is_empty());
    assert_eq!(deleted.errors.len(), 1);
    assert!(exists(&cache, "a"));

    delete(&cache, &["a"], MissingFile::Forget);
    assert!(!exists(&cache, "a"));
}

#[test]
fn a_file_that_cant_be_deleted_keeps_its_record_and_the_rest_go() {
    let dir = tempfile::tempdir().unwrap();
    // A directory where the file should be makes remove_file fail with
    // something other than NotFound.
    let blocked = dir.path().join("blocked.mkv");
    std::fs::create_dir(&blocked).unwrap();
    let file = dir.path().join("fine.mkv");
    std::fs::write(&file, b"video").unwrap();
    let cache = Mutex::new(CacheStore::open_in_memory().unwrap());
    let mut played = finished("a", &blocked);
    played.last_played_at = Some(42);
    {
        let c = cache.lock().unwrap();
        c.upsert_download(&played).unwrap();
        c.upsert_download(&finished("b", &file)).unwrap();
    }

    let deleted = delete(&cache, &["a", "b"], MissingFile::Forget);
    assert_eq!(deleted.removed, vec!["b"]);
    assert_eq!(deleted.errors.len(), 1);
    assert!(!file.exists());
    let back = cache.lock().unwrap().get_download("a").unwrap().unwrap();
    assert_eq!(back.last_played_at, Some(42));
}

#[test]
fn a_keep_set_while_the_files_are_deleted_comes_back_with_a_file_that_stayed() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("blocked.mkv");
    std::fs::create_dir(&blocked).unwrap();
    let file = dir.path().join("fine.mkv");
    std::fs::write(&file, b"video").unwrap();
    let cache = Mutex::new(CacheStore::open_in_memory().unwrap());
    {
        let c = cache.lock().unwrap();
        c.upsert_download(&finished("a", &blocked)).unwrap();
        c.upsert_download(&finished("b", &file)).unwrap();
    }
    let deleting = Deleting::default();

    // The steps of `delete_selected`, with the user pressing Keep on both
    // downloads while their files are being deleted.
    let taken = take_selected(&cache, &deleting, |c| select(c, &["a", "b"])).unwrap();
    set_keep(&cache, &deleting, "a", true).unwrap();
    set_keep(&cache, &deleting, "b", true).unwrap();
    let (deleted, failed) = delete_files(taken, MissingFile::Forget);
    let put = put_back(&cache, &deleting, &deleted.removed, failed).unwrap();

    assert_eq!(deleted.removed, vec!["b"]);
    assert_eq!(put, vec!["a"]);
    let back = cache.lock().unwrap().get_download("a").unwrap().unwrap();
    assert!(back.keep);
    assert!(!exists(&cache, "b"));
    assert!(deleting.ids().is_empty());
}

#[test]
fn a_keep_for_a_download_that_isnt_there_does_nothing() {
    let cache = Mutex::new(CacheStore::open_in_memory().unwrap());
    let deleting = Deleting::default();
    set_keep(&cache, &deleting, "gone", true).unwrap();
    assert!(!exists(&cache, "gone"));
    assert!(deleting.ids().is_empty());
}

#[test]
fn says_which_downloads_were_not_deleted() {
    let mut deleted = Deleted::default();
    assert_eq!(removal_error(&deleted), None);

    deleted
        .errors
        .push("Could not delete /a.mkv: denied".into());
    assert_eq!(
        removal_error(&deleted).unwrap(),
        "Could not delete /a.mkv: denied"
    );

    deleted.removed.push("b".into());
    deleted
        .errors
        .push("Could not delete /c.mkv: denied".into());
    assert_eq!(
        removal_error(&deleted).unwrap(),
        "Deleted 1 of 3.\nCould not delete /a.mkv: denied\nCould not delete /c.mkv: denied"
    );
}

#[test]
fn a_download_is_claimed_once() {
    let cache = CacheStore::open_in_memory().unwrap();
    cache
        .upsert_download(&queued("a", "/dl/a.mkv.part"))
        .unwrap();

    let claimed = claim_queued(&cache, "a").unwrap().unwrap();
    assert_eq!(claimed.status, DownloadStatus::Downloading);
    assert_eq!(
        cache.get_download("a").unwrap().unwrap().status,
        DownloadStatus::Downloading
    );
    assert!(claim_queued(&cache, "a").unwrap().is_none());
    assert!(claim_queued(&cache, "missing").unwrap().is_none());
}

#[test]
fn a_stopped_download_is_not_claimed() {
    let cache = CacheStore::open_in_memory().unwrap();
    let mut rec = queued("a", "/dl/a.mkv.part");
    rec.status = DownloadStatus::Cancelled;
    cache.upsert_download(&rec).unwrap();

    assert!(claim_queued(&cache, "a").unwrap().is_none());
    assert_eq!(
        cache.get_download("a").unwrap().unwrap().status,
        DownloadStatus::Cancelled
    );
}

#[test]
fn picks_a_path_no_download_or_file_uses() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("Dune (2021).mkv");
    let cache = CacheStore::open_in_memory().unwrap();
    assert_eq!(unused_dest_path(&cache, &dest).unwrap(), dest);

    // Another download writing the same file, in another case.
    let upper = dir.path().join("DUNE (2021).MKV");
    cache
        .upsert_download(&queued("a", &part_path(&upper).to_string_lossy()))
        .unwrap();
    let second = dir.path().join("Dune (2021) (2).mkv");
    assert_eq!(unused_dest_path(&cache, &dest).unwrap(), second);

    // A file already in the folder that no download knows about, and a
    // partial file left behind.
    std::fs::write(&second, b"video").unwrap();
    let third = dir.path().join("Dune (2021) (3).mkv");
    std::fs::write(part_path(&third), b"vid").unwrap();
    assert_eq!(
        unused_dest_path(&cache, &dest).unwrap(),
        dir.path().join("Dune (2021) (4).mkv")
    );
}

#[test]
fn starts_only_while_the_channel_keeps_its_title() {
    let cache = CacheStore::open_in_memory().unwrap();
    let rec = queued("a", "/dl/a.mkv.part");
    cache
        .upsert_channel("p1", &channel(&rec.channel_id, "Dune (2021)"))
        .unwrap();
    assert_eq!(
        source_url(&cache, &rec).unwrap(),
        "http://h/movie/u/p/c-a.mkv"
    );

    // A refresh moved another title to this position in the playlist.
    cache
        .upsert_channel("p1", &channel(&rec.channel_id, "Arrival (2016)"))
        .unwrap();
    assert!(source_url(&cache, &rec).is_err());

    let gone = queued("b", "/dl/b.mkv.part");
    assert!(source_url(&cache, &gone).is_err());
}

/// Queue a download of a new channel that plays `url`, as adding one in the
/// app does, and return its id.
fn enqueue(app: &TestApp, channel_id: &str, title: &str, url: &str) -> String {
    add_channel(app, &movie(channel_id, title, url));
    enqueue_record(
        &app.handle(),
        channel_id,
        title,
        url,
        DownloadKind::Movie,
        None,
        None,
    )
    .unwrap()
}

/// Claim the queued download `id`, as `pump` does before it starts one.
fn claim(app: &TestApp, id: &str) -> DownloadRecord {
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    claim_queued(&cache, id).unwrap().unwrap()
}

fn status(app: &TestApp, id: &str) -> DownloadStatus {
    download(app, id).unwrap().status
}

fn is_running(app: &TestApp, id: &str) -> bool {
    app.downloads().running().contains_key(id)
}

/// Save `settings` as the app's settings file, as an earlier session or a
/// hand edit would have left it.
fn write_settings(app: &TestApp, settings: serde_json::Value) {
    std::fs::create_dir_all(app.app_dir()).unwrap();
    std::fs::write(
        app.app_dir().join(SETTINGS_STORE_FILE),
        settings.to_string(),
    )
    .unwrap();
}

#[test]
fn a_download_saves_the_whole_video_and_how_big_it_is() {
    let app = TestApp::new();
    let events = Events::watch(&app);
    let id = enqueue(&app, "c1", "Dune (2021)", &video_url("dune"));
    pump(&app.handle()).unwrap();

    let done = events.wait_for(&id, DownloadStatus::Completed);
    let file = app.downloads_dir().join("movies").join("Dune (2021).mkv");
    assert_eq!(done.dest_path, file.to_string_lossy());
    assert!(!part_path(&file).exists());
    let size = std::fs::metadata(&file).unwrap().len() as i64;
    assert_eq!(done.downloaded_bytes, size);
    assert_eq!(done.total_bytes, Some(VIDEO_BYTES));
    assert!(done.avg_rate_bps.is_some_and(|rate| rate > 0));
    assert!(done.finished_at.is_some());
    assert_eq!(done.error, None);
    assert_eq!(download(&app, &id), Some(done));
    assert!(!is_running(&app, &id));
}

#[test]
fn a_download_the_server_refuses_fails_with_ffmpegs_reason() {
    let app = TestApp::new();
    let events = Events::watch(&app);
    let id = enqueue(&app, "c1", "Dune (2021)", &missing_url("dune"));
    pump(&app.handle()).unwrap();

    let failed = events.wait_for(&id, DownloadStatus::Failed);
    let error = failed.error.clone().unwrap();
    assert!(error.contains("404"), "{error}");
    assert_eq!(failed.total_bytes, None);
    assert!(failed.finished_at.is_some());
    assert!(!Path::new(&failed.dest_path).exists());
    assert!(!app.downloads_dir().join("movies/Dune (2021).mkv").exists());
    assert_eq!(download(&app, &id), Some(failed));
    assert!(!is_running(&app, &id));
}

#[test]
fn stopping_a_running_download_deletes_its_partial_file_and_starts_the_next() {
    let app = TestApp::new();
    let handle = app.handle();
    app.downloads().set_concurrency(1);
    let first = enqueue(&app, "c1", "Dune (2021)", STALLS);
    let second = enqueue(&app, "c2", "Arrival (2016)", STALLS);
    pump(&handle).unwrap();
    assert_eq!(status(&app, &first), DownloadStatus::Downloading);
    assert_eq!(status(&app, &second), DownloadStatus::Queued);
    // ffmpeg writes nothing while it waits for input, so stand in for the
    // part it would have written.
    let part = download(&app, &first).unwrap().dest_path;
    std::fs::write(&part, b"partial").unwrap();

    let events = Events::watch(&app);
    stop_one(&handle, &first).unwrap();
    let stopped = download(&app, &first).unwrap();
    assert_eq!(stopped.status, DownloadStatus::Cancelled);
    assert!(stopped.finished_at.is_some());
    assert!(!Path::new(&part).exists());
    assert!(!is_running(&app, &first));

    // The next one starts once the first ffmpeg has ended.
    events.wait_until("the next download starts", || {
        status(&app, &second) == DownloadStatus::Downloading && is_running(&app, &second)
    });
    assert_eq!(download(&app, &first), Some(stopped));

    stop_one(&handle, &second).unwrap();
}

/// A stop that lands between claiming a download and tracking its ffmpeg
/// finds nothing to kill, so the start has to.
#[test]
fn a_download_stopped_while_it_starts_is_killed_at_once() {
    let app = TestApp::new();
    let handle = app.handle();
    let id = enqueue(&app, "c1", "Dune (2021)", STALLS);
    let claimed = claim(&app, &id);
    let events = Events::watch(&app);
    stop_one(&handle, &id).unwrap();

    start_process(&handle, claimed).unwrap();
    assert!(!is_running(&app, &id));
    // The stop and the start each send the record, and so does the end of
    // ffmpeg, which never comes unless it was killed.
    events.wait_until("ffmpeg ends", || events.progress(&id).len() == 3);
    let sent = events.progress(&id);
    assert!(sent.iter().all(|r| r.status == DownloadStatus::Cancelled));
    assert_eq!(sent[2].error, None);
}

#[test]
fn quitting_kills_ffmpeg_and_leaves_its_download_for_the_next_launch() {
    let app = TestApp::new();
    let handle = app.handle();
    app.downloads().set_concurrency(1);
    let running = enqueue(&app, "c1", "Dune (2021)", STALLS);
    let waiting = enqueue(&app, "c2", "Arrival (2016)", STALLS);
    pump(&handle).unwrap();
    assert!(is_running(&app, &running));

    stop_all_for_exit(&handle);
    let manager = app.downloads();
    assert!(manager.exiting.load(Ordering::SeqCst));
    assert!(manager.running().is_empty());
    assert_eq!(status(&app, &running), DownloadStatus::Downloading);

    // Nothing new starts while the app quits, even with a slot free.
    manager.set_concurrency(2);
    pump(&handle).unwrap();
    assert_eq!(status(&app, &waiting), DownloadStatus::Queued);

    // One that was already starting is killed rather than tracked.
    start_process(&handle, claim(&app, &waiting)).unwrap();
    assert!(manager.running().is_empty());
    assert_eq!(status(&app, &waiting), DownloadStatus::Downloading);
}

#[test]
fn quitting_before_the_downloads_are_set_up_does_nothing() {
    let app = tauri::test::mock_app();
    stop_all_for_exit(app.handle());
    assert!(app.try_state::<DownloadManager>().is_none());
}

#[test]
fn a_download_whose_channel_changed_fails_and_the_next_one_starts() {
    let app = TestApp::new();
    app.downloads().set_concurrency(1);
    let changed = enqueue(&app, "c1", "Dune (2021)", STALLS);
    // A refresh put another title at this position in the playlist.
    add_channel(&app, &movie("c1", "Arrival (2016)", STALLS));
    let part = download(&app, &changed).unwrap().dest_path;
    std::fs::create_dir_all(Path::new(&part).parent().unwrap()).unwrap();
    std::fs::write(&part, b"partial").unwrap();
    let next = enqueue(&app, "c2", "Blade Runner (1982)", STALLS);

    let err = pump(&app.handle()).unwrap_err();
    assert!(err.contains("The playlist changed"), "{err}");
    let failed = download(&app, &changed).unwrap();
    assert_eq!(failed.status, DownloadStatus::Failed);
    assert_eq!(failed.error, Some(err));
    assert!(failed.finished_at.is_some());
    assert!(!Path::new(&part).exists());
    assert_eq!(status(&app, &next), DownloadStatus::Downloading);

    stop_one(&app.handle(), &next).unwrap();
}

#[test]
fn a_download_folder_that_cant_be_made_fails_the_download() {
    let app = TestApp::new();
    let blocker = app.downloads_dir();
    std::fs::write(&blocker, b"a file where the folder should be").unwrap();
    let id = enqueue(&app, "c1", "Dune (2021)", STALLS);

    let err = pump(&app.handle()).unwrap_err();
    let failed = download(&app, &id).unwrap();
    assert_eq!(failed.status, DownloadStatus::Failed);
    assert_eq!(failed.error, Some(err));
    assert!(blocker.is_file());
}

#[test]
fn a_download_stopped_before_it_failed_to_start_stays_cancelled() {
    let app = TestApp::new();
    let part = app.downloads_dir().join("Dune (2021).mkv.part");
    let rec = record("a", DownloadStatus::Cancelled, &part.to_string_lossy());
    add_download(&app, &rec);

    fail_to_start(&app.handle(), &rec, "no ffmpeg");
    assert_eq!(download(&app, "a"), Some(rec));
}

#[test]
fn stopping_a_queued_download_cancels_it_and_a_finished_one_keeps_its_file() {
    let app = TestApp::new();
    let handle = app.handle();
    let dir = app.downloads_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("Arrival (2016).mkv");
    std::fs::write(&file, b"video").unwrap();
    add_download(
        &app,
        &queued("a", &dir.join("Dune (2021).mkv.part").to_string_lossy()),
    );
    add_download(&app, &finished("b", &file));
    let events = Events::watch(&app);

    stop_one(&handle, "a").unwrap();
    stop_one(&handle, "b").unwrap();
    stop_one(&handle, "gone").unwrap();

    let a = download(&app, "a").unwrap();
    assert_eq!(a.status, DownloadStatus::Cancelled);
    assert!(a.finished_at.is_some());
    assert_eq!(download(&app, "b"), Some(finished("b", &file)));
    assert!(file.exists());
    assert_eq!(
        events.sent(),
        vec![
            DownloadEvent::Progress(a),
            DownloadEvent::Progress(finished("b", &file)),
        ]
    );
}

#[test]
fn deleting_downloads_tells_the_frontend_which_went_and_which_stayed() {
    let app = TestApp::new();
    let dir = app.downloads_dir();
    // A directory where the file should be can't be deleted as a file.
    let blocked = dir.join("blocked.mkv");
    std::fs::create_dir_all(&blocked).unwrap();
    let file = dir.join("fine.mkv");
    std::fs::write(&file, b"video").unwrap();
    add_download(&app, &finished("a", &blocked));
    add_download(&app, &finished("b", &file));
    let events = Events::watch(&app);

    let deleted = delete_downloads(&app.handle(), MissingFile::Forget, |c| {
        select(c, &["a", "b"])
    })
    .unwrap();
    assert_eq!(deleted.removed, vec!["b"]);
    assert_eq!(deleted.put_back, vec!["a"]);
    assert_eq!(
        events.sent(),
        vec![
            DownloadEvent::Removed("b".into()),
            DownloadEvent::Progress(finished("a", &blocked)),
        ]
    );
}

#[test]
fn saved_download_settings_come_back_on_the_next_launch() {
    let first = TestApp::new();
    let handle = first.handle();
    let folder = first.app_dir().join("Videos");
    save_folder(&handle, &folder.to_string_lossy()).unwrap();
    save_concurrency(&handle, 5).unwrap();
    save_retention(&handle, Some(14)).unwrap();

    let next = TestApp::new();
    std::fs::create_dir_all(next.app_dir()).unwrap();
    std::fs::copy(
        first.app_dir().join(SETTINGS_STORE_FILE),
        next.app_dir().join(SETTINGS_STORE_FILE),
    )
    .unwrap();
    restore_settings(&next.handle());
    let manager = next.downloads();
    assert_eq!(manager.root(), folder);
    assert_eq!(manager.concurrency(), 5);
    assert_eq!(manager.retention_days(), Some(14));
}

#[test]
fn without_saved_settings_the_defaults_stay() {
    let app = TestApp::new();
    restore_settings(&app.handle());
    let manager = app.downloads();
    assert_eq!(manager.root(), app.downloads_dir());
    assert_eq!(manager.concurrency(), 3);
    assert_eq!(manager.retention_days(), None);
}

#[test]
fn hand_edited_settings_stay_in_the_range_the_app_allows() {
    let app = TestApp::new();
    app.downloads().set_retention_days(Some(30));
    write_settings(
        &app,
        json!({
            "download_folder": "",
            "download_concurrency": 50,
            "download_retention_days": 0,
        }),
    );
    restore_settings(&app.handle());
    let manager = app.downloads();
    assert_eq!(manager.root(), app.downloads_dir());
    assert_eq!(manager.concurrency(), MAX_CONCURRENCY);
    // 0 means never in the app, not every download at once.
    assert_eq!(manager.retention_days(), None);

    let app = TestApp::new();
    app.downloads().set_retention_days(Some(30));
    write_settings(
        &app,
        json!({
            "download_concurrency": "five",
            "download_retention_days": 1u64 << 40,
        }),
    );
    restore_settings(&app.handle());
    let manager = app.downloads();
    assert_eq!(manager.concurrency(), 3);
    assert_eq!(manager.retention_days(), None);
}

#[test]
fn a_setting_that_cant_be_written_says_why() {
    let app = TestApp::new();
    std::fs::write(app.app_dir(), b"a file where the app folder should be").unwrap();
    let handle = app.handle();
    assert!(save_folder(&handle, "/Videos").is_err());
    assert!(save_concurrency(&handle, 2).is_err());
    assert!(save_retention(&handle, None).is_err());
    assert!(app.app_dir().is_file());
}

#[test]
fn a_poisoned_cache_fails_without_a_panic() {
    let app = TestApp::new();
    let handle = app.handle();
    let id = enqueue(&app, "c1", "Dune (2021)", STALLS);
    let events = Events::watch(&app);
    let state = app.state();
    poison(&state.cache);

    let added = enqueue_record(
        &handle,
        "c2",
        "Arrival (2016)",
        STALLS,
        DownloadKind::Movie,
        None,
        None,
    );
    assert!(added.is_err());
    assert!(pump(&handle).is_err());
    assert_eq!(stop_one(&handle, &id), Ok(()));
    assert_eq!(current_status(&handle, &id), None);
    assert!(events.sent().is_empty());

    state.cache.clear_poison();
    assert_eq!(status(&app, &id), DownloadStatus::Queued);
}
