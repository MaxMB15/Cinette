// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The download commands.
//!
//! Downloads run the real bundled ffmpeg against a loopback server, as
//! `downloads::test_support` describes.

use super::*;
use crate::downloads::test_support::{
    add_channel, add_download, download, finished, missing_url, movie, record, stalls, video_url,
    DownloadEvent, Events,
};
use crate::test_support::poison;
use mvp_core::downloads::model::DownloadStatus;
use std::path::{Path, PathBuf};

/// An episode of a show that plays `url`.
fn episode(id: &str, name: &str, url: &str) -> Channel {
    Channel {
        group_title: "Severance".into(),
        content_type: "series".into(),
        ..movie(id, name, url)
    }
}

/// A live news channel. Its stream is never fetched, since the recordings
/// in these tests never start.
fn news() -> Channel {
    Channel {
        group_title: "News".into(),
        content_type: "live".into(),
        ..movie("n1", "City News", "http://news.example.test/live/1.ts")
    }
}

/// Schedules half an hour of the news channel's "Evening News" from
/// `start`.
async fn schedule_news(app: &TestApp, start: i64) -> DownloadRecord {
    add_channel(app, &news());
    let program = GuideProgram {
        title: "Evening News".into(),
        start,
        end: start + 1_800,
    };
    schedule_recording(
        app.handle(),
        app.state(),
        "n1".into(),
        start,
        start + 1_800,
        Some(program),
    )
    .await
    .unwrap()
}

fn status(app: &TestApp, id: &str) -> DownloadStatus {
    download(app, id).unwrap().status
}

/// The settings the app saved, read from its settings file.
fn saved_settings(app: &TestApp) -> serde_json::Value {
    let text = std::fs::read_to_string(app.app_dir().join("settings.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// A finished download of a file that's on disk.
fn finished_file(app: &TestApp, id: &str, name: &str) -> PathBuf {
    let dir = app.downloads_dir().join("movies");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    std::fs::write(&file, b"video").unwrap();
    add_download(app, &finished(id, &file));
    file
}

#[tokio::test]
async fn a_movie_download_starts_in_the_movies_folder() {
    let app = TestApp::new();
    add_channel(&app, &movie("c1", "Dune (2021)", stalls()));

    let id = enqueue_movie_download(app.handle(), app.state(), "c1".into())
        .await
        .unwrap();
    let rec = download(&app, &id).unwrap();
    assert_eq!(rec.kind, DownloadKind::Movie);
    assert_eq!(
        (rec.channel_id.as_str(), rec.title.as_str()),
        ("c1", "Dune (2021)")
    );
    assert_eq!(rec.status, DownloadStatus::Downloading);
    assert_eq!(
        Path::new(&rec.dest_path),
        app.downloads_dir().join("movies/Dune (2021).mkv.part")
    );

    stop_download(app.handle(), id.clone()).await.unwrap();
    assert_eq!(status(&app, &id), DownloadStatus::Cancelled);
}

#[tokio::test]
async fn a_movie_that_isnt_in_the_playlist_isnt_downloaded() {
    let app = TestApp::new();
    let err = enqueue_movie_download(app.handle(), app.state(), "gone".into())
        .await
        .unwrap_err();
    assert_eq!(err, "channel not found");
    assert!(list_downloads(app.state()).await.unwrap().is_empty());
}

#[tokio::test]
async fn retrying_a_failed_download_replaces_it() {
    let app = TestApp::new();
    let events = Events::watch(&app);
    add_channel(&app, &movie("c1", "Dune (2021)", &missing_url("dune")));
    let failed = enqueue_movie_download(app.handle(), app.state(), "c1".into())
        .await
        .unwrap();
    events.wait_for(&failed, DownloadStatus::Failed);

    add_channel(&app, &movie("c1", "Dune (2021)", stalls()));
    let retry = enqueue_movie_download(app.handle(), app.state(), "c1".into())
        .await
        .unwrap();
    let ids: Vec<String> = list_downloads(app.state())
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, vec![retry.clone()]);
}

#[tokio::test]
async fn an_episode_downloads_into_its_shows_folder() {
    let app = TestApp::new();
    let events = Events::watch(&app);
    let ep = episode("e1", "Good News About Hell", &video_url("severance-1"));

    let id = enqueue_episode_download(
        app.handle(),
        app.state(),
        ep.clone(),
        "s1".into(),
        "Severance".into(),
    )
    .await
    .unwrap();
    let done = events.wait_for(&id, DownloadStatus::Completed);
    let file = app
        .downloads_dir()
        .join("series/Severance/Good News About Hell.mkv");
    assert_eq!(Path::new(&done.dest_path), file);
    assert!(file.is_file());
    assert_eq!(done.kind, DownloadKind::Episode);
    assert_eq!(done.series_channel_id.as_deref(), Some("s1"));
    // The episode isn't in any playlist's channels, so it's saved where a
    // retry or a restart can find its URL.
    let state = app.state();
    let cache = state.cache.lock().unwrap();
    assert_eq!(cache.get_channels("__downloads__").unwrap(), vec![ep]);
}

#[tokio::test]
async fn a_batch_of_episodes_queues_in_order_and_stops_together() {
    let app = TestApp::new();
    app.downloads().set_concurrency(1);
    let eps = vec![
        episode("e1", "Good News About Hell", stalls()),
        episode("e2", "Half Loop", stalls()),
    ];

    let ids = enqueue_episodes_batch(
        app.handle(),
        app.state(),
        eps.clone(),
        "s1".into(),
        "Severance".into(),
    )
    .await
    .unwrap();
    let recs: Vec<DownloadRecord> = ids.iter().map(|id| download(&app, id).unwrap()).collect();
    let got: Vec<(&str, DownloadStatus)> =
        recs.iter().map(|r| (r.title.as_str(), r.status)).collect();
    assert_eq!(
        got,
        vec![
            ("Good News About Hell", DownloadStatus::Downloading),
            ("Half Loop", DownloadStatus::Queued),
        ]
    );
    assert!(recs
        .iter()
        .all(|r| r.series_channel_id.as_deref() == Some("s1")));
    {
        let state = app.state();
        let cache = state.cache.lock().unwrap();
        assert_eq!(cache.get_channels("__downloads__").unwrap(), eps);
    }

    stop_downloads(app.handle(), ids.clone()).await.unwrap();
    for id in &ids {
        assert_eq!(status(&app, id), DownloadStatus::Cancelled);
    }
}

#[tokio::test]
async fn an_empty_batch_queues_nothing() {
    let app = TestApp::new();
    let ids = enqueue_episodes_batch(
        app.handle(),
        app.state(),
        Vec::new(),
        "s1".into(),
        "Severance".into(),
    )
    .await
    .unwrap();
    assert!(ids.is_empty());
    assert!(list_downloads(app.state()).await.unwrap().is_empty());
}

#[tokio::test]
async fn the_list_holds_every_download_newest_first() {
    let app = TestApp::new();
    assert!(list_downloads(app.state()).await.unwrap().is_empty());
    let old = record("old", DownloadStatus::Completed, "/old.mkv");
    let new = DownloadRecord {
        created_at: 10,
        ..record("new", DownloadStatus::Queued, "/new.mkv.part")
    };
    add_download(&app, &old);
    add_download(&app, &new);

    assert_eq!(list_downloads(app.state()).await.unwrap(), vec![new, old]);
}

#[tokio::test]
async fn a_shows_episode_list_is_kept_for_offline_use() {
    let app = TestApp::new();
    let eps = vec![
        episode("e1", "Good News About Hell", "http://example.test/e1.mkv"),
        episode("e2", "Half Loop", "http://example.test/e2.mkv"),
    ];
    assert!(get_cached_series_episodes(app.state(), "s1".into())
        .await
        .unwrap()
        .is_empty());

    cache_series_episodes(app.state(), "s1".into(), eps.clone())
        .await
        .unwrap();
    assert_eq!(
        get_cached_series_episodes(app.state(), "s1".into()).await,
        Ok(eps)
    );
    assert!(get_cached_series_episodes(app.state(), "s2".into())
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn removing_downloads_deletes_their_files_and_tells_the_frontend() {
    let app = TestApp::new();
    let a = finished_file(&app, "a", "Dune (2021).mkv");
    let b = finished_file(&app, "b", "Arrival (2016).mkv");
    let missing = app.downloads_dir().join("movies/Gone.mkv");
    add_download(&app, &finished("c", &missing));
    let events = Events::watch(&app);

    remove_download(app.handle(), "a".into()).await.unwrap();
    // Repeats and unknown ids are skipped, and a file that's already gone
    // still lets its download go.
    let ids = ["b", "b", "c", "unknown"].map(String::from).to_vec();
    remove_downloads(app.handle(), ids).await.unwrap();

    assert!(!a.exists() && !b.exists());
    assert!(list_downloads(app.state()).await.unwrap().is_empty());
    assert_eq!(
        events.sent(),
        ["a", "b", "c"].map(|id| DownloadEvent::Removed(id.into()))
    );
}

#[tokio::test]
async fn a_download_whose_file_cant_be_deleted_stays_with_the_reason() {
    let app = TestApp::new();
    // A folder where the file should be can't be deleted as a file.
    let blocked = app.downloads_dir().join("movies/Blocked.mkv");
    std::fs::create_dir_all(&blocked).unwrap();
    add_download(&app, &finished("blocked", &blocked));
    let fine = finished_file(&app, "fine", "Fine.mkv");

    let err = remove_download(app.handle(), "blocked".into())
        .await
        .unwrap_err();
    assert!(err.starts_with("Could not delete"), "{err}");
    assert!(download(&app, "blocked").is_some());

    let ids = vec!["blocked".to_string(), "fine".to_string()];
    let err = remove_downloads(app.handle(), ids).await.unwrap_err();
    assert!(
        err.starts_with("Deleted 1 of 2.\nCould not delete"),
        "{err}"
    );
    assert!(download(&app, "blocked").is_some());
    assert!(download(&app, "fine").is_none() && !fine.exists());
}

#[tokio::test]
async fn a_kept_download_is_saved_and_sent_to_the_frontend() {
    let app = TestApp::new();
    let file = finished_file(&app, "a", "Dune (2021).mkv");
    let events = Events::watch(&app);

    set_download_keep(app.handle(), app.state(), app.downloads(), "a".into(), true)
        .await
        .unwrap();
    let kept = download(&app, "a").unwrap();
    assert!(kept.keep);
    set_download_keep(
        app.handle(),
        app.state(),
        app.downloads(),
        "gone".into(),
        true,
    )
    .await
    .unwrap();
    assert_eq!(events.sent(), vec![DownloadEvent::Progress(kept)]);

    set_download_keep(
        app.handle(),
        app.state(),
        app.downloads(),
        "a".into(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(download(&app, "a"), Some(finished("a", &file)));
}

#[tokio::test]
async fn more_downloads_at_once_starts_the_queued_ones() {
    let app = TestApp::new();
    set_download_concurrency(app.downloads(), app.handle(), 1)
        .await
        .unwrap();
    add_channel(&app, &movie("c1", "Dune (2021)", stalls()));
    add_channel(&app, &movie("c2", "Arrival (2016)", stalls()));
    let mut ids = Vec::new();
    for channel in ["c1", "c2"] {
        let id = enqueue_movie_download(app.handle(), app.state(), channel.into())
            .await
            .unwrap();
        ids.push(id);
    }
    assert_eq!(status(&app, &ids[1]), DownloadStatus::Queued);

    set_download_concurrency(app.downloads(), app.handle(), 2)
        .await
        .unwrap();
    assert_eq!(status(&app, &ids[1]), DownloadStatus::Downloading);
    assert_eq!(get_download_concurrency(app.downloads()).await, Ok(2));
    assert_eq!(saved_settings(&app)["download_concurrency"], 2);
}

#[tokio::test]
async fn zero_downloads_at_once_means_one() {
    let app = TestApp::new();
    set_download_concurrency(app.downloads(), app.handle(), 0)
        .await
        .unwrap();
    assert_eq!(get_download_concurrency(app.downloads()).await, Ok(1));
    assert_eq!(saved_settings(&app)["download_concurrency"], 1);
}

#[tokio::test]
async fn a_new_download_folder_is_saved_and_used() {
    let app = TestApp::new();
    let default = app.downloads_dir().to_string_lossy().into_owned();
    assert_eq!(get_download_folder(app.downloads()).await, Ok(default));
    let folder = app.app_dir().join("Videos");
    let path = folder.to_string_lossy().into_owned();

    set_download_folder(app.downloads(), app.handle(), path.clone())
        .await
        .unwrap();
    assert_eq!(get_download_folder(app.downloads()).await, Ok(path.clone()));
    assert_eq!(saved_settings(&app)["download_folder"], path);

    add_channel(&app, &movie("c1", "Dune (2021)", stalls()));
    let id = enqueue_movie_download(app.handle(), app.state(), "c1".into())
        .await
        .unwrap();
    let rec = download(&app, &id).unwrap();
    assert!(Path::new(&rec.dest_path).starts_with(&folder));
}

#[tokio::test]
async fn a_setting_that_cant_be_saved_isnt_used() {
    let app = TestApp::new();
    std::fs::write(app.app_dir(), b"a file where the app folder should be").unwrap();
    let due = finished_file(&app, "a", "Dune (2021).mkv");

    assert!(set_download_concurrency(app.downloads(), app.handle(), 5)
        .await
        .is_err());
    assert!(
        set_download_folder(app.downloads(), app.handle(), "/Videos".into())
            .await
            .is_err()
    );
    assert!(
        set_download_retention(app.downloads(), app.handle(), Some(1))
            .await
            .is_err()
    );

    assert_eq!(get_download_concurrency(app.downloads()).await, Ok(3));
    let default = app.downloads_dir().to_string_lossy().into_owned();
    assert_eq!(get_download_folder(app.downloads()).await, Ok(default));
    assert_eq!(get_download_retention(app.downloads()).await, Ok(None));
    assert!(due.exists() && download(&app, "a").is_some());
}

#[tokio::test]
async fn a_retention_setting_counts_then_deletes_what_is_due() {
    let app = TestApp::new();
    let due = finished_file(&app, "due", "Dune (2021).mkv");
    let kept = finished_file(&app, "kept", "Arrival (2016).mkv");
    set_download_keep(
        app.handle(),
        app.state(),
        app.downloads(),
        "kept".into(),
        true,
    )
    .await
    .unwrap();
    let recent = DownloadRecord {
        finished_at: Some(manager::now_secs()),
        ..record("recent", DownloadStatus::Completed, "/recent.mkv")
    };
    add_download(&app, &recent);
    add_download(
        &app,
        &record("queued", DownloadStatus::Queued, "/queued.mkv.part"),
    );

    assert_eq!(count_downloads_due(app.handle(), Some(30)).await, Ok(1));
    // 0 and no setting both mean downloads are never deleted.
    assert_eq!(count_downloads_due(app.handle(), Some(0)).await, Ok(0));
    assert_eq!(count_downloads_due(app.handle(), None).await, Ok(0));
    assert_eq!(get_download_retention(app.downloads()).await, Ok(None));

    assert_eq!(
        set_download_retention(app.downloads(), app.handle(), Some(30)).await,
        Ok(1)
    );
    assert!(!due.exists() && download(&app, "due").is_none());
    assert!(kept.exists() && download(&app, "kept").is_some());
    assert!(download(&app, "recent").is_some() && download(&app, "queued").is_some());
    assert_eq!(get_download_retention(app.downloads()).await, Ok(Some(30)));
    assert_eq!(saved_settings(&app)["download_retention_days"], 30);

    assert_eq!(
        set_download_retention(app.downloads(), app.handle(), Some(0)).await,
        Ok(0)
    );
    assert_eq!(get_download_retention(app.downloads()).await, Ok(None));
    assert_eq!(saved_settings(&app)["download_retention_days"], json!(null));
}

#[tokio::test]
async fn a_download_on_a_drive_that_isnt_connected_survives_retention() {
    let app = TestApp::new();
    let unplugged = app.downloads_dir().join("Unplugged/Dune (2021).mkv");
    add_download(&app, &finished("a", &unplugged));

    assert_eq!(
        set_download_retention(app.downloads(), app.handle(), Some(30)).await,
        Ok(0)
    );
    assert_eq!(download(&app, "a"), Some(finished("a", &unplugged)));
}

#[tokio::test]
async fn a_retention_setting_is_saved_even_when_the_check_fails() {
    let app = TestApp::new();
    let due = finished_file(&app, "a", "Dune (2021).mkv");
    let state = app.state();
    poison(&state.cache);

    assert!(count_downloads_due(app.handle(), Some(30)).await.is_err());
    assert_eq!(
        set_download_retention(app.downloads(), app.handle(), Some(30)).await,
        Ok(0)
    );
    assert_eq!(get_download_retention(app.downloads()).await, Ok(Some(30)));
    assert_eq!(saved_settings(&app)["download_retention_days"], 30);

    state.cache.clear_poison();
    assert!(due.exists() && download(&app, "a").is_some());
}

#[tokio::test]
async fn a_finished_download_plays_from_its_file_and_counts_as_played() {
    let app = TestApp::new();
    let file = finished_file(&app, "a", "Dune (2021).mkv");
    let events = Events::watch(&app);

    let path = resolve_local_download(app.handle(), app.state(), "c-a".into())
        .await
        .unwrap();
    assert_eq!(path.as_deref().map(Path::new), Some(file.as_path()));
    let played = download(&app, "a").unwrap();
    assert!(played.last_played_at.is_some_and(|at| at > 0));
    assert_eq!(events.sent(), vec![DownloadEvent::Progress(played)]);
}

#[tokio::test]
async fn a_channel_without_a_finished_file_plays_from_the_playlist() {
    let app = TestApp::new();
    let gone = app.downloads_dir().join("movies/Gone.mkv");
    add_download(&app, &finished("gone", &gone));
    let part = app.downloads_dir().join("movies/Dune (2021).mkv.part");
    add_download(
        &app,
        &record(
            "running",
            DownloadStatus::Downloading,
            &part.to_string_lossy(),
        ),
    );
    std::fs::create_dir_all(part.parent().unwrap()).unwrap();
    std::fs::write(&part, b"partial").unwrap();
    let events = Events::watch(&app);

    for channel in ["c-gone", "c-running", "c-unknown"] {
        let path = resolve_local_download(app.handle(), app.state(), channel.into()).await;
        assert_eq!(path, Ok(None), "{channel}");
    }
    assert_eq!(download(&app, "gone").unwrap().last_played_at, None);
    assert!(events.sent().is_empty());
}

#[tokio::test]
async fn a_scheduled_recording_is_saved_and_sent_to_the_frontend() {
    let app = TestApp::new();
    let events = Events::watch(&app);
    // An hour ahead, so it only waits.
    let start = manager::now_secs() + 3_600;

    let rec = schedule_news(&app, start).await;

    assert_eq!(
        (rec.kind, rec.status),
        (DownloadKind::Recording, DownloadStatus::Scheduled)
    );
    assert_eq!(rec.source_channel_id.as_deref(), Some("n1"));
    assert_eq!(
        (rec.start_at, rec.end_at),
        (Some(start), Some(start + 1_800))
    );
    assert_eq!(rec.program_title.as_deref(), Some("Evening News"));
    assert_eq!(download(&app, &rec.id), Some(rec.clone()));
    assert_eq!(events.sent(), vec![DownloadEvent::Progress(rec)]);
}

#[tokio::test]
async fn a_movie_cant_be_recorded() {
    let app = TestApp::new();
    add_channel(&app, &movie("c1", "Dune (2021)", stalls()));
    let events = Events::watch(&app);
    let start = manager::now_secs() + 3_600;

    let err = schedule_recording(
        app.handle(),
        app.state(),
        "c1".into(),
        start,
        start + 60,
        None,
    )
    .await
    .unwrap_err();

    assert_eq!(err, "Only live channels can be recorded.");
    assert!(list_downloads(app.state()).await.unwrap().is_empty());
    assert!(events.sent().is_empty());
}

#[tokio::test]
async fn stopping_a_recording_that_hasnt_started_cancels_it() {
    let app = TestApp::new();
    let rec = schedule_news(&app, manager::now_secs() + 3_600).await;
    let events = Events::watch(&app);

    stop_recording(app.handle(), rec.id.clone()).await.unwrap();

    assert_eq!(download(&app, &rec.id), None);
    assert_eq!(events.sent(), vec![DownloadEvent::Removed(rec.id)]);
}

#[tokio::test]
async fn stopping_a_running_recording_from_the_downloads_list_ends_it_now() {
    let app = TestApp::new();
    let start = manager::now_secs() - 600;
    let scheduled = schedule_news(&app, start).await;
    // It records as if it had started, though no ffmpeg runs. Its file is
    // kept, so the plain download stop must not handle it.
    let dir = app.downloads_dir().join("recordings");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("City News.ts");
    std::fs::write(&file, b"news").unwrap();
    add_download(
        &app,
        &DownloadRecord {
            status: DownloadStatus::Recording,
            dest_path: file.to_string_lossy().into(),
            ..scheduled.clone()
        },
    );
    let events = Events::watch(&app);
    let before = manager::now_secs();

    stop_download(app.handle(), scheduled.id.clone())
        .await
        .unwrap();

    let ending = download(&app, &scheduled.id).unwrap();
    // The recording itself marks the record done once ffmpeg has closed
    // the file.
    assert_eq!(ending.status, DownloadStatus::Recording);
    let end = ending.end_at.unwrap();
    assert!((before..=manager::now_secs()).contains(&end));
    assert!(file.exists());
    assert_eq!(events.progress(&scheduled.id), vec![ending]);
}

#[tokio::test]
async fn a_poisoned_cache_fails_the_commands_that_need_it() {
    let app = TestApp::new();
    add_channel(&app, &movie("c1", "Dune (2021)", stalls()));
    add_channel(&app, &news());
    let state = app.state();
    poison(&state.cache);
    let ep = || episode("e1", "Good News About Hell", stalls());
    let start = manager::now_secs() + 3_600;

    assert!(
        enqueue_movie_download(app.handle(), app.state(), "c1".into())
            .await
            .is_err()
    );
    assert!(
        enqueue_episode_download(app.handle(), app.state(), ep(), "s1".into(), "S".into())
            .await
            .is_err()
    );
    assert!(enqueue_episodes_batch(
        app.handle(),
        app.state(),
        vec![ep()],
        "s1".into(),
        "S".into()
    )
    .await
    .is_err());
    assert!(list_downloads(app.state()).await.is_err());
    assert!(cache_series_episodes(app.state(), "s1".into(), vec![ep()])
        .await
        .is_err());
    assert!(get_cached_series_episodes(app.state(), "s1".into())
        .await
        .is_err());
    assert!(
        resolve_local_download(app.handle(), app.state(), "c1".into())
            .await
            .is_err()
    );
    assert!(schedule_recording(
        app.handle(),
        app.state(),
        "n1".into(),
        start,
        start + 60,
        None
    )
    .await
    .is_err());
    assert!(stop_recording(app.handle(), "r1".into()).await.is_err());

    state.cache.clear_poison();
    assert!(list_downloads(app.state()).await.unwrap().is_empty());
}
