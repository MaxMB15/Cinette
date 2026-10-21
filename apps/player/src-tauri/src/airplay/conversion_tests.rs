// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The order of loads and stops, with fake conversions whose threads end
//! when a test says.

use super::*;
use std::sync::atomic::AtomicBool;
use tokio::sync::oneshot;

/// A fake conversion. Dropping it asks it to stop, and it ends when its
/// test sends on `end`, or at once if `closes` is set.
struct Fake {
    ended: watch::Receiver<Option<Ended>>,
    end: Arc<watch::Sender<Option<Ended>>>,
    closes: bool,
    playing: Arc<Mutex<Vec<bool>>>,
    dropped: Arc<AtomicBool>,
}

impl Running for Fake {
    fn ended(&self) -> watch::Receiver<Option<Ended>> {
        self.ended.clone()
    }

    fn set_playing(&self, playing: bool) {
        lock(&self.playing).push(playing);
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
        if self.closes {
            let _ = self.end.send(Some(Err(HlsError::Failed)));
        }
    }
}

/// What a test sees of one fake.
struct Handle {
    end: Arc<watch::Sender<Option<Ended>>>,
    playing: Arc<Mutex<Vec<bool>>>,
    dropped: Arc<AtomicBool>,
}

impl Handle {
    fn dropped(&self) -> bool {
        self.dropped.load(Ordering::SeqCst)
    }
}

fn fake(closes: bool) -> (Fake, Handle) {
    let (end, ended) = watch::channel(None);
    let end = Arc::new(end);
    let playing = Arc::new(Mutex::new(Vec::new()));
    let dropped = Arc::new(AtomicBool::new(false));
    let handle = Handle {
        end: end.clone(),
        playing: playing.clone(),
        dropped: dropped.clone(),
    };
    let fake = Fake {
        ended,
        end,
        closes,
        playing,
        dropped,
    };
    (fake, handle)
}

/// Conversions whose failures go into the returned list.
fn conversions() -> (Arc<Conversions<Fake>>, Arc<Mutex<Vec<&'static str>>>) {
    let failed = Arc::new(Mutex::new(Vec::new()));
    let seen = failed.clone();
    (Conversions::new(move |code| lock(&seen).push(code)), failed)
}

/// Lets spawned tasks run.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn keeps_a_conversion_the_receiver_plays() {
    let (conversions, failed) = conversions();
    let (running, handle) = fake(true);
    let played = Arc::new(AtomicBool::new(false));
    let saw = played.clone();
    let result = conversions
        .load(false, async { Ok(running) }, move |_| {
            saw.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
    assert_eq!(result, Ok(()));
    assert!(played.load(Ordering::SeqCst));
    assert!(conversions.has_current());
    assert!(!handle.dropped());
    conversions.set_status("playing");
    conversions.set_status("paused");
    conversions.set_status("buffering");
    assert_eq!(*lock(&handle.playing), vec![true, false, false]);
    assert!(lock(&failed).is_empty());
}

#[tokio::test]
async fn a_stop_drops_the_conversion_and_says_nothing() {
    let (conversions, failed) = conversions();
    let (running, handle) = fake(true);
    conversions
        .load(true, async { Ok(running) }, |_| Ok(()))
        .await
        .unwrap();
    conversions.stop().await;
    assert!(handle.dropped());
    assert!(!conversions.has_current());
    settle().await;
    // It ended with an error as it stopped, which nobody needs to hear.
    assert!(lock(&failed).is_empty());
    // Nothing to pass the state on to.
    conversions.set_status("playing");
    assert!(lock(&handle.playing).is_empty());
}

#[tokio::test]
async fn a_stop_while_it_starts_drops_what_it_started() {
    let (conversions, failed) = conversions();
    let (running, handle) = fake(true);
    let (go, wait) = oneshot::channel::<()>();
    let loading = {
        let conversions = conversions.clone();
        tokio::spawn(async move {
            conversions
                .load(
                    false,
                    async move {
                        let _ = wait.await;
                        Ok(running)
                    },
                    |_| panic!("the receiver was told to play a stopped conversion"),
                )
                .await
        })
    };
    settle().await;
    // The stop waits for the load, which gives up once it has started.
    let stopping = {
        let conversions = conversions.clone();
        tokio::spawn(async move { conversions.stop().await })
    };
    settle().await;
    assert!(!stopping.is_finished(), "the stop didn't wait for the load");
    go.send(()).unwrap();
    assert_eq!(loading.await.unwrap(), Err(SUPERSEDED.to_string()));
    stopping.await.unwrap();
    assert!(handle.dropped());
    assert!(!conversions.has_current());
    settle().await;
    assert!(lock(&failed).is_empty());
}

#[tokio::test]
async fn a_failed_play_drops_the_conversion() {
    let (conversions, _) = conversions();
    let (running, handle) = fake(true);
    let result = conversions
        .load(false, async { Ok(running) }, |_| {
            Err("no AirPlay".to_string())
        })
        .await;
    assert_eq!(result, Err("no AirPlay".to_string()));
    assert!(handle.dropped());
    assert!(!conversions.has_current());
}

#[tokio::test]
async fn a_failed_start_says_why() {
    let (conversions, _) = conversions();
    let result = conversions
        .load(false, async { Err::<Fake, _>(HlsError::Refused) }, |_| {
            Ok(())
        })
        .await;
    assert_eq!(result, Err(HlsError::Refused.for_player()));
    assert!(!conversions.has_current());
}

#[tokio::test]
async fn a_failed_start_that_a_stop_overtook_is_superseded() {
    let (conversions, _) = conversions();
    let (go, wait) = oneshot::channel::<()>();
    let loading = {
        let conversions = conversions.clone();
        tokio::spawn(async move {
            conversions
                .load(
                    false,
                    async move {
                        let _ = wait.await;
                        Err::<Fake, _>(HlsError::Unreachable)
                    },
                    |_| Ok(()),
                )
                .await
        })
    };
    settle().await;
    let stopping = {
        let conversions = conversions.clone();
        tokio::spawn(async move { conversions.stop().await })
    };
    go.send(()).unwrap();
    assert_eq!(loading.await.unwrap(), Err(SUPERSEDED.to_string()));
    stopping.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_stop_waits_for_the_source_to_close() {
    let (conversions, _) = conversions();
    // This one takes a while to close after it's dropped.
    let (running, handle) = fake(false);
    conversions
        .load(false, async { Ok(running) }, |_| Ok(()))
        .await
        .unwrap();
    let stopping = {
        let conversions = conversions.clone();
        tokio::spawn(async move { conversions.stop().await })
    };
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(handle.dropped());
    assert!(
        !stopping.is_finished(),
        "it stopped before the source closed"
    );
    handle.end.send(Some(Err(HlsError::Failed))).unwrap();
    stopping.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_source_that_never_closes_holds_a_stop_only_so_long() {
    let (conversions, _) = conversions();
    let (running, _handle) = fake(false);
    conversions
        .load(false, async { Ok(running) }, |_| Ok(()))
        .await
        .unwrap();
    let started = tokio::time::Instant::now();
    conversions.stop().await;
    assert!(started.elapsed() >= CLOSE_LIMIT);
    assert!(started.elapsed() < CLOSE_LIMIT + Duration::from_secs(1));
}

#[tokio::test]
async fn quick_loads_collapse_into_the_last() {
    let (conversions, _) = conversions();
    let (go, wait) = oneshot::channel::<()>();
    let (first, first_handle) = fake(true);
    let started = Arc::new(Mutex::new(Vec::new()));
    let order = started.clone();
    let running_first = {
        let conversions = conversions.clone();
        tokio::spawn(async move {
            conversions
                .load(
                    false,
                    async move {
                        lock(&order).push(1);
                        let _ = wait.await;
                        Ok(first)
                    },
                    |_| Ok(()),
                )
                .await
        })
    };
    settle().await;
    // Three more while the first still starts. Only the last runs.
    let mut later = Vec::new();
    let mut handles = Vec::new();
    for n in 2..=4 {
        let (running, handle) = fake(true);
        handles.push(handle);
        let conversions = conversions.clone();
        let order = started.clone();
        later.push(tokio::spawn(async move {
            conversions
                .load(
                    false,
                    async move {
                        lock(&order).push(n);
                        Ok(running)
                    },
                    |_| Ok(()),
                )
                .await
        }));
        settle().await;
    }
    go.send(()).unwrap();
    assert_eq!(running_first.await.unwrap(), Err(SUPERSEDED.to_string()));
    assert!(first_handle.dropped());
    let mut results = Vec::new();
    for task in later {
        results.push(task.await.unwrap());
    }
    assert_eq!(
        results,
        vec![
            Err(SUPERSEDED.to_string()),
            Err(SUPERSEDED.to_string()),
            Ok(())
        ]
    );
    assert_eq!(*lock(&started), vec![1, 4]);
    assert!(!handles[2].dropped());
}

#[tokio::test(start_paused = true)]
async fn the_next_load_waits_for_the_old_source_to_close() {
    let (conversions, _) = conversions();
    // This one takes a while to close after it's dropped.
    let (old, old_handle) = fake(false);
    conversions
        .load(false, async { Ok(old) }, |_| Ok(()))
        .await
        .unwrap();
    let opened = Arc::new(AtomicBool::new(false));
    let saw = opened.clone();
    let (new, _) = fake(true);
    let loading = {
        let conversions = conversions.clone();
        tokio::spawn(async move {
            conversions
                .load(
                    false,
                    async move {
                        saw.store(true, Ordering::SeqCst);
                        Ok(new)
                    },
                    |_| Ok(()),
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(old_handle.dropped());
    assert!(
        !opened.load(Ordering::SeqCst),
        "it opened before the old one closed"
    );
    old_handle.end.send(Some(Err(HlsError::Failed))).unwrap();
    assert_eq!(loading.await.unwrap(), Ok(()));
    assert!(opened.load(Ordering::SeqCst));
}

#[tokio::test(start_paused = true)]
async fn an_old_source_that_never_closes_holds_the_next_load_only_so_long() {
    let (conversions, _) = conversions();
    let (old, _old_handle) = fake(false);
    conversions
        .load(false, async { Ok(old) }, |_| Ok(()))
        .await
        .unwrap();
    let (new, _) = fake(true);
    let started = tokio::time::Instant::now();
    conversions
        .load(false, async { Ok(new) }, |_| Ok(()))
        .await
        .unwrap();
    assert!(started.elapsed() >= CLOSE_LIMIT);
    assert!(started.elapsed() < CLOSE_LIMIT + Duration::from_secs(1));
}

#[tokio::test]
async fn reports_a_conversion_that_fails_on_its_own() {
    let (conversions, failed) = conversions();
    let (running, handle) = fake(true);
    conversions
        .load(false, async { Ok(running) }, |_| Ok(()))
        .await
        .unwrap();
    handle.end.send(Some(Err(HlsError::Refused))).unwrap();
    settle().await;
    assert_eq!(*lock(&failed), vec!["refused"]);
}

#[tokio::test]
async fn a_movie_that_reaches_its_end_is_fine_and_a_live_channel_isnt() {
    let (conversions, failed) = conversions();
    let (movie, handle) = fake(true);
    conversions
        .load(false, async { Ok(movie) }, |_| Ok(()))
        .await
        .unwrap();
    handle.end.send(Some(Ok(()))).unwrap();
    settle().await;
    assert!(lock(&failed).is_empty());

    let (live, handle) = fake(true);
    conversions
        .load(true, async { Ok(live) }, |_| Ok(()))
        .await
        .unwrap();
    handle.end.send(Some(Ok(()))).unwrap();
    settle().await;
    assert_eq!(*lock(&failed), vec!["failed"]);
}

#[tokio::test]
async fn an_old_conversion_ending_says_nothing() {
    let (conversions, failed) = conversions();
    let (old, old_handle) = fake(false);
    conversions
        .load(false, async { Ok(old) }, |_| Ok(()))
        .await
        .unwrap();
    let (new, _) = fake(true);
    // The old one closes while the new one waits for it.
    let end = old_handle.end.clone();
    let closing = tokio::spawn(async move {
        settle().await;
        let _ = end.send(Some(Err(HlsError::Unreachable)));
    });
    conversions
        .load(false, async { Ok(new) }, |_| Ok(()))
        .await
        .unwrap();
    closing.await.unwrap();
    settle().await;
    assert!(lock(&failed).is_empty());
}

#[test]
fn names_the_errors_the_player_words() {
    assert_eq!(error_code(HlsError::Refused), "refused");
    for other in [
        HlsError::Unreachable,
        HlsError::VideoCodec,
        HlsError::NoNetwork,
        HlsError::Failed,
    ] {
        assert_eq!(error_code(other), "failed");
    }
    assert_eq!(SUPERSEDED, "superseded");
}
