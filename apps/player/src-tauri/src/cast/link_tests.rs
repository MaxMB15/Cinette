// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The session loop against the fake receiver, over an in-memory stream.

use std::time::Instant;

use mvp_core::cast::message::{LoadRequest, StreamType};
use mvp_core::cast::session::Session;
use tokio::sync::mpsc;

use super::fake_receiver::{answer, next_of, Got};
use super::link::{drive, CastUpdate, Command, MediaView};

fn request() -> LoadRequest {
    LoadRequest {
        url: "http://192.0.2.1/1.mp4".into(),
        content_type: "video/mp4".into(),
        stream_type: StreamType::Buffered,
        hls_ts_segments: false,
        title: "Test".into(),
        image: None,
        start_at: None,
        text_tracks: vec![],
        active_track_ids: vec![],
    }
}

/// A cast to a fake receiver. Returns the commands, the updates and what
/// the receiver got.
fn cast() -> (
    mpsc::UnboundedSender<Command>,
    mpsc::UnboundedReceiver<CastUpdate>,
    mpsc::UnboundedReceiver<Got>,
) {
    let (sender_end, receiver_end) = tokio::io::duplex(64 * 1024);
    let (got_tx, got) = mpsc::unbounded_channel();
    tokio::spawn(answer(receiver_end, got_tx, 0));
    let (commands, command_rx) = mpsc::unbounded_channel();
    let (updates_tx, updates) = mpsc::unbounded_channel();
    let (session, first) = Session::start("sender-1".into(), Instant::now());
    tokio::spawn(drive(sender_end, session, first, command_rx, move |u| {
        let _ = updates_tx.send(u);
    }));
    (commands, updates, got)
}

async fn next_update(
    updates: &mut mpsc::UnboundedReceiver<CastUpdate>,
    wanted: impl Fn(&CastUpdate) -> bool,
) -> CastUpdate {
    let wait = async {
        while let Some(update) = updates.recv().await {
            if wanted(&update) {
                return update;
            }
        }
        panic!("the updates ended");
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), wait)
        .await
        .expect("an update within 10 s")
}

fn playing(update: &CastUpdate, player: &str) -> bool {
    matches!(update, CastUpdate::Media { media: Some(m) } if m.player == player)
}

#[tokio::test]
async fn launches_loads_and_controls_the_receiver() {
    let (commands, mut updates, mut got) = cast();
    commands.send(Command::Load(Box::new(request()))).unwrap();
    assert_eq!(
        next_update(&mut updates, |u| *u == CastUpdate::Ready).await,
        CastUpdate::Ready
    );
    let load = next_of(&mut got, "LOAD").await;
    assert_eq!(load.body["media"]["contentId"], "http://192.0.2.1/1.mp4");
    let update = next_update(&mut updates, |u| playing(u, "playing")).await;
    assert_eq!(
        update,
        CastUpdate::Media {
            media: Some(MediaView {
                media_session_id: 1,
                player: "playing",
                idle_reason: None,
                position: 42.5,
                duration: Some(600.0),
                live: false,
                can_pause: true,
                can_seek: true,
            })
        }
    );

    commands.send(Command::Pause).unwrap();
    next_of(&mut got, "PAUSE").await;
    next_update(&mut updates, |u| playing(u, "paused")).await;
    commands.send(Command::Play).unwrap();
    next_of(&mut got, "PLAY").await;
    commands.send(Command::Seek(90.0)).unwrap();
    assert_eq!(next_of(&mut got, "SEEK").await.body["currentTime"], 90.0);
    commands.send(Command::Volume(0.25)).unwrap();
    assert_eq!(
        next_of(&mut got, "SET_VOLUME").await.body["volume"]["level"],
        0.25
    );
    let volume = next_update(&mut updates, |u| matches!(u, CastUpdate::Volume { .. })).await;
    assert_eq!(
        volume,
        CastUpdate::Volume {
            level: 0.5,
            muted: false,
            fixed: false
        }
    );

    commands.send(Command::Stop).unwrap();
    next_of(&mut got, "STOP").await;
    assert_eq!(
        next_update(&mut updates, |u| matches!(u, CastUpdate::Closed { .. })).await,
        CastUpdate::Closed { reason: "stopped" }
    );
    // Nothing comes after the close.
    assert!(updates.recv().await.is_none());
}

#[tokio::test]
async fn a_control_before_anything_plays_is_rejected() {
    let (commands, mut updates, _got) = cast();
    next_update(&mut updates, |u| *u == CastUpdate::Ready).await;
    commands.send(Command::Pause).unwrap();
    assert_eq!(
        next_update(&mut updates, |u| matches!(u, CastUpdate::Rejected { .. })).await,
        CastUpdate::Rejected {
            reason: Some("nothing is loaded on the receiver".into())
        }
    );
}

#[tokio::test]
async fn dropping_the_commands_stops_the_cast() {
    let (commands, mut updates, mut got) = cast();
    next_update(&mut updates, |u| *u == CastUpdate::Ready).await;
    drop(commands);
    next_of(&mut got, "CLOSE").await;
    assert_eq!(
        next_update(&mut updates, |u| matches!(u, CastUpdate::Closed { .. })).await,
        CastUpdate::Closed { reason: "stopped" }
    );
}

#[tokio::test]
async fn a_receiver_that_hangs_up_ends_the_cast() {
    let (sender_end, receiver_end) = tokio::io::duplex(1024);
    let (_commands, command_rx) = mpsc::unbounded_channel();
    let (updates_tx, mut updates) = mpsc::unbounded_channel();
    let (session, first) = Session::start("sender-1".into(), Instant::now());
    drop(receiver_end);
    drive(sender_end, session, first, command_rx, move |u| {
        let _ = updates_tx.send(u);
    })
    .await;
    assert_eq!(
        updates.recv().await,
        Some(CastUpdate::Closed {
            reason: "connectionLost"
        })
    );
    assert!(updates.recv().await.is_none());
}

#[test]
fn every_update_reads_as_the_frontend_expects() {
    use mvp_core::cast::session::{CloseReason, Event, IdleReason, MediaState, PlayerState};
    let media = |player| MediaState {
        media_session_id: 1,
        player,
        current_time: 3.0,
        duration: None,
        live: true,
        can_pause: false,
        can_seek: false,
        tracks: vec![],
        active_track_ids: vec![],
    };
    let player = |state| match CastUpdate::from(Event::Media(Some(media(state)))) {
        CastUpdate::Media { media: Some(m) } => (m.player, m.idle_reason),
        other => panic!("{other:?}"),
    };
    assert_eq!(player(PlayerState::Buffering), ("buffering", None));
    assert_eq!(player(PlayerState::Paused), ("paused", None));
    for (reason, text) in [
        (IdleReason::Finished, Some("finished")),
        (IdleReason::Cancelled, Some("cancelled")),
        (IdleReason::Interrupted, Some("interrupted")),
        (IdleReason::Error, Some("error")),
        (IdleReason::None, None),
    ] {
        assert_eq!(player(PlayerState::Idle(reason)), ("idle", text));
    }
    assert_eq!(
        CastUpdate::from(Event::Media(None)),
        CastUpdate::Media { media: None }
    );
    assert_eq!(
        CastUpdate::from(Event::LoadFailed {
            detailed_error_code: Some(104)
        }),
        CastUpdate::LoadFailed { code: Some(104) }
    );
    assert_eq!(
        CastUpdate::from(Event::PlaybackError {
            detailed_error_code: None
        }),
        CastUpdate::PlaybackError { code: None }
    );
    for (reason, text) in [
        (CloseReason::Stopped, "stopped"),
        (CloseReason::AppStopped, "appStopped"),
        (CloseReason::LaunchFailed(None), "launchFailed"),
        (CloseReason::Timeout, "timeout"),
        (
            CloseReason::Protocol(mvp_core::cast::frame::FrameError::TooLong),
            "protocol",
        ),
    ] {
        assert_eq!(
            CastUpdate::from(Event::Closed(reason)),
            CastUpdate::Closed { reason: text }
        );
    }
    let json = serde_json::to_value(CastUpdate::Media {
        media: Some(MediaView::from(&media(PlayerState::Playing))),
    })
    .unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "kind": "media", "media": {
            "mediaSessionId": 1, "player": "playing", "idleReason": null, "position": 3.0, "duration": null,
            "live": true, "canPause": false, "canSeek": false } })
    );
    assert_eq!(
        serde_json::to_value(CastUpdate::ConversionFailed { refused: true }).unwrap(),
        serde_json::json!({ "kind": "conversionFailed", "refused": true })
    );
}
