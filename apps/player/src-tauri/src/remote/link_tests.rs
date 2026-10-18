// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A link against the real target task over loopback, with a proxy between
//! them that can drop the connection the way a network does.

use super::*;
use crate::discovery::Registration;
use crate::remote::target::{self, CatalogPage, TargetHandle, TargetHost};
use crate::remote::test_client::WAIT;
use mvp_core::remote::consent::{Answer, RequestId};
use mvp_core::remote::message::{DeviceType, Feature, PlaybackSnapshot, PROTOCOL_VERSION};
use mvp_core::remote::settings::{ControlMode, RemoteSettings};
use mvp_core::remote::target::{ConsentPrompt, SessionInfo};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// A target host that carries out every command at once.
struct Player {
    target: Mutex<Option<TargetHandle>>,
    prompts: mpsc::UnboundedSender<(RequestId, String)>,
}

impl TargetHost for Player {
    fn show_consent(&self, prompt: &ConsentPrompt) {
        let _ = self.prompts.send((prompt.request, prompt.code.clone()));
    }
    fn hide_consent(&self, _: RequestId) {}
    fn sessions_changed(&self, _: &[SessionInfo]) {}
    fn apply(&self, token: u64, _: &Command) {
        if let Some(target) = self.target.lock().unwrap().as_ref() {
            target.finish_command(token, Ok(()));
        }
    }
    fn catalog(&self, _: CatalogQuery) -> CatalogPage {
        Ok((
            vec![CatalogItem {
                id: "live-1".into(),
                name: "News".into(),
                ..CatalogItem::default()
            }],
            None,
        ))
    }
    fn advertise(&self, _: Option<Registration>) {}
}

struct Target {
    handle: TargetHandle,
    key: DeviceKey,
    port: u16,
    prompts: mpsc::UnboundedReceiver<(RequestId, String)>,
}

async fn target(mode: ControlMode) -> Target {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let key = DeviceKey::generate();
    let (tx, prompts) = mpsc::unbounded_channel();
    let player = Arc::new(Player {
        target: Mutex::new(None),
        prompts: tx,
    });
    let settings = RemoteSettings {
        remote_control: mode,
        ..RemoteSettings::default()
    };
    let handle = target::start(
        listener,
        key.clone(),
        DeviceType::FireTv,
        settings,
        player.clone(),
    )
    .unwrap();
    *player.target.lock().unwrap() = Some(handle.clone());
    Target {
        handle,
        key,
        port,
        prompts,
    }
}

/// Forwards connections to the target, and can cut them or stop taking new
/// ones.
struct Proxy {
    port: u16,
    accepting: Arc<Mutex<bool>>,
    pipes: Arc<Mutex<Vec<JoinHandle<()>>>>,
    /// The bytes the link sent through so far.
    sent: Arc<AtomicUsize>,
}

impl Proxy {
    async fn new(to: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepting = Arc::new(Mutex::new(true));
        let pipes: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let sent = Arc::new(AtomicUsize::new(0));
        let (open, list, count) = (accepting.clone(), pipes.clone(), sent.clone());
        tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                if !*open.lock().unwrap() {
                    // Refused, as an unreachable device would be.
                    drop(inbound);
                    continue;
                }
                let count = count.clone();
                let pipe = tokio::spawn(async move {
                    let outbound = TcpStream::connect(("127.0.0.1", to)).await.unwrap();
                    let (mut from_link, mut to_link) = inbound.split();
                    let (mut from_target, mut to_target) = tokio::io::split(outbound);
                    let up = async {
                        let mut buf = [0u8; 4096];
                        loop {
                            match from_link.read(&mut buf).await {
                                Ok(0) | Err(_) => break,
                                Ok(n) => {
                                    count.fetch_add(n, Ordering::SeqCst);
                                    if to_target.write_all(&buf[..n]).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    };
                    let down = tokio::io::copy(&mut from_target, &mut to_link);
                    tokio::select! {
                        _ = up => {}
                        _ = down => {}
                    }
                });
                list.lock().unwrap().push(pipe);
            }
        });
        Self {
            port,
            accepting,
            pipes,
            sent,
        }
    }

    /// Cuts every connection without a word to either side, as a dropped
    /// network does, and stops forwarding new ones when `refuse` is set.
    fn cut(&self, refuse: bool) {
        *self.accepting.lock().unwrap() = !refuse;
        for pipe in self.pipes.lock().unwrap().drain(..) {
            pipe.abort();
        }
    }

    fn reopen(&self) {
        *self.accepting.lock().unwrap() = true;
    }
}

#[derive(Default)]
struct Seen {
    phases: Vec<Phase>,
    states: Vec<VersionedState>,
}

struct Recorder {
    seen: Mutex<Seen>,
    tx: mpsc::UnboundedSender<()>,
}

impl LinkHost for Recorder {
    fn phase(&self, _: u64, _: &DeviceId, phase: &Phase) {
        self.seen.lock().unwrap().phases.push(phase.clone());
        let _ = self.tx.send(());
    }
    fn state(&self, _: u64, _: &DeviceId, state: &VersionedState) {
        self.seen.lock().unwrap().states.push(state.clone());
        let _ = self.tx.send(());
    }
}

struct Link {
    handle: LinkHandle,
    recorder: Arc<Recorder>,
    changes: mpsc::UnboundedReceiver<()>,
}

impl Link {
    fn phases(&self) -> Vec<Phase> {
        self.recorder.seen.lock().unwrap().phases.clone()
    }

    fn states(&self) -> Vec<VersionedState> {
        self.recorder.seen.lock().unwrap().states.clone()
    }

    /// Waits until `done` holds.
    async fn until(&mut self, mut done: impl FnMut(&Self) -> bool) {
        let result = timeout(WAIT, async {
            while !done(self) {
                self.changes.recv().await.unwrap();
            }
        })
        .await;
        assert!(result.is_ok(), "timed out; phases {:?}", self.phases());
    }

    async fn until_phase(&mut self, phase: Phase) {
        self.until(|l| l.phases().contains(&phase)).await;
    }

    async fn closed(&mut self) -> Ended {
        self.until(|l| matches!(l.phases().last(), Some(Phase::Closed { .. })))
            .await;
        match self.phases().last() {
            Some(Phase::Closed { reason }) => *reason,
            _ => unreachable!(),
        }
    }
}

fn link_to(target: &Target, port: u16, grace: Duration) -> Link {
    link_with(
        target,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        grace,
    )
}

fn link_with(target: &Target, addresses: Addresses, grace: Duration) -> Link {
    link_timed(target, addresses, grace, Timeouts::STANDARD)
}

fn link_timed(
    target: &Target,
    addresses: Addresses,
    grace: Duration,
    timeouts: Timeouts,
) -> Link {
    let (tx, changes) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder {
        seen: Mutex::default(),
        tx,
    });
    let key = DeviceKey::generate();
    let hello = Hello {
        id: key.device_id(),
        name: "Mac".into(),
        device_type: DeviceType::Mac,
        versions: vec![PROTOCOL_VERSION],
        features: vec![Feature::Control, Feature::Catalog],
    };
    let handle = super::start(
        LinkConfig {
            key,
            hello,
            target: target.key.device_id(),
            addresses,
            grace,
            generation: 7,
            timeouts,
        },
        recorder.clone(),
    );
    Link {
        handle,
        recorder,
        changes,
    }
}

const GRACE: Duration = Duration::from_secs(30);

#[tokio::test]
async fn connects_and_attaches_to_what_plays() {
    let t = target(ControlMode::Always).await;
    t.handle.set_state(PlaybackSnapshot {
        position: 12.0,
        ..PlaybackSnapshot::default()
    });
    let mut link = link_to(&t, t.port, GRACE);
    link.until_phase(Phase::Connected).await;
    let phases = link.phases();
    assert_eq!(phases[0], Phase::Connecting);
    assert!(matches!(phases[1], Phase::Verifying { ref code } if code.len() == 6));
    assert_eq!(phases[2], Phase::Connected);
    link.until(|l| !l.states().is_empty()).await;
    assert_eq!(link.states()[0].state.position, 12.0);
    assert_eq!(link.handle.generation(), 7);
}

#[tokio::test]
async fn waits_for_consent_with_the_same_code_and_hears_a_denial() {
    let mut t = target(ControlMode::Ask).await;
    let mut link = link_to(&t, t.port, GRACE);
    link.until(|l| {
        l.phases()
            .iter()
            .any(|p| matches!(p, Phase::Pending { .. }))
    })
    .await;
    let (request, shown) = timeout(WAIT, t.prompts.recv()).await.unwrap().unwrap();
    let code = link
        .phases()
        .iter()
        .find_map(|p| match p {
            Phase::Verifying { code } => Some(code.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(shown, code);
    assert!(
        link.phases().contains(&Phase::Pending {
            expires_in_ms: 30_000
        }),
        "{:?}",
        link.phases()
    );
    t.handle.answer(request, Answer::Deny);
    assert_eq!(link.closed().await, Ended::Target(CloseReason::Denied));
}

#[tokio::test]
async fn commands_and_catalog_queries_get_their_answers() {
    let t = target(ControlMode::Always).await;
    let mut link = link_to(&t, t.port, GRACE);
    link.until_phase(Phase::Connected).await;
    assert!(link.handle.command(Command::Stop).await.is_ok());
    let refused = link
        .handle
        .command(Command::Pause {
            item_id: "nothing".into(),
        })
        .await;
    assert_eq!(refused, Err(LinkError::Refused(ErrorCode::StaleItem)));
    let page = link
        .handle
        .catalog(CatalogQuery::Search {
            query: "news".into(),
            content_type: None,
            limit: 10,
        })
        .await
        .unwrap();
    assert_eq!(page.0[0].id, "live-1");
}

#[tokio::test]
async fn a_device_that_does_not_answer_is_unreachable() {
    let t = target(ControlMode::Always).await;
    let mut nowhere = link_with(&t, Arc::new(Vec::new), GRACE);
    assert_eq!(nowhere.closed().await, Ended::Unreachable);

    let closed_port = {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    let mut refused = link_to(&t, closed_port, GRACE);
    assert_eq!(refused.closed().await, Ended::Unreachable);
    assert_eq!(
        refused.handle.command(Command::Stop).await,
        Err(LinkError::NotConnected)
    );
}

#[tokio::test]
async fn tries_each_address_in_turn() {
    let t = target(ControlMode::Always).await;
    let closed_port = {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    let port = t.port;
    let mut link = link_with(
        &t,
        Arc::new(move || {
            vec![
                SocketAddr::from(([127, 0, 0, 1], closed_port)),
                SocketAddr::from(([127, 0, 0, 1], port)),
            ]
        }),
        GRACE,
    );
    link.until_phase(Phase::Connected).await;
}

#[tokio::test]
async fn a_dropped_connection_resumes_without_asking_again() {
    let mut t = target(ControlMode::Ask).await;
    let proxy = Proxy::new(t.port).await;
    let mut link = link_to(&t, proxy.port, GRACE);
    let (request, _) = timeout(WAIT, t.prompts.recv()).await.unwrap().unwrap();
    t.handle.answer(request, Answer::Allow);
    link.until_phase(Phase::Connected).await;

    proxy.cut(false);
    link.until_phase(Phase::Reconnecting { attempt: 1 }).await;
    link.until(|l| {
        l.phases()
            .iter()
            .filter(|p| **p == Phase::Connected)
            .count()
            == 2
    })
    .await;
    assert!(t.prompts.try_recv().is_err(), "no second dialog");
    assert!(link.handle.command(Command::Stop).await.is_ok());
    assert_eq!(t.handle.sessions().await.len(), 1);
}

#[tokio::test]
async fn commands_while_reconnecting_are_not_sent() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let mut link = link_to(&t, proxy.port, GRACE);
    link.until_phase(Phase::Connected).await;
    proxy.cut(true);
    link.until_phase(Phase::Reconnecting { attempt: 1 }).await;
    assert_eq!(
        link.handle.command(Command::Stop).await,
        Err(LinkError::NotConnected)
    );
    proxy.reopen();
    link.until(|l| {
        l.phases()
            .iter()
            .filter(|p| **p == Phase::Connected)
            .count()
            == 2
    })
    .await;
}

#[tokio::test]
async fn gives_up_when_the_grace_runs_out() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let mut link = link_to(&t, proxy.port, Duration::from_millis(1500));
    link.until_phase(Phase::Connected).await;
    proxy.cut(true);
    assert_eq!(link.closed().await, Ended::Lost);
    let reconnects = link
        .phases()
        .iter()
        .filter(|p| matches!(p, Phase::Reconnecting { .. }))
        .count();
    assert!(reconnects >= 1, "{:?}", link.phases());
}

#[tokio::test]
async fn a_drop_before_control_was_granted_is_lost() {
    let t = target(ControlMode::Ask).await;
    let proxy = Proxy::new(t.port).await;
    let mut link = link_to(&t, proxy.port, GRACE);
    link.until(|l| {
        l.phases()
            .iter()
            .any(|p| matches!(p, Phase::Pending { .. }))
    })
    .await;
    proxy.cut(true);
    assert_eq!(link.closed().await, Ended::Lost);
}

#[tokio::test]
async fn leaving_ends_the_session_and_the_target_plays_on() {
    let t = target(ControlMode::Always).await;
    let mut link = link_to(&t, t.port, GRACE);
    link.until_phase(Phase::Connected).await;
    link.handle.leave().await;
    assert_eq!(link.closed().await, Ended::Left);
    let deadline = tokio::time::Instant::now() + WAIT;
    while !t.handle.sessions().await.is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the target kept the session"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // A link that's gone takes nothing more.
    link.handle.leave().await;
    assert_eq!(
        link.handle
            .catalog(CatalogQuery::Groups {
                content_type: "live".into()
            })
            .await,
        Err(LinkError::NotConnected)
    );
}

#[tokio::test]
async fn leaving_while_reconnecting_stops_trying() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let mut link = link_to(&t, proxy.port, GRACE);
    link.until_phase(Phase::Connected).await;
    proxy.cut(true);
    link.until_phase(Phase::Reconnecting { attempt: 1 }).await;
    link.handle.leave().await;
    assert_eq!(link.closed().await, Ended::Left);
}

#[tokio::test]
async fn the_target_closing_ends_it_without_retrying() {
    let t = target(ControlMode::Always).await;
    let mut link = link_to(&t, t.port, GRACE);
    link.until_phase(Phase::Connected).await;
    t.handle.shutdown().await;
    assert_eq!(link.closed().await, Ended::Target(CloseReason::Shutdown));
    assert!(
        !link
            .phases()
            .iter()
            .any(|p| matches!(p, Phase::Reconnecting { .. })),
        "{:?}",
        link.phases()
    );
}

#[tokio::test]
async fn the_wrong_key_at_the_address_is_refused() {
    let t = target(ControlMode::Always).await;
    let other = target(ControlMode::Always).await;
    // Discovery said `t`, but `other` answers.
    let mut link = link_to(&t, other.port, GRACE);
    assert_eq!(
        link.closed().await,
        Ended::Target(CloseReason::IdentityMismatch)
    );
}

#[tokio::test]
async fn phases_read_as_the_webview_expects() {
    let json = |p: Phase| serde_json::to_value(p).unwrap();
    assert_eq!(
        json(Phase::Connecting),
        serde_json::json!({ "phase": "connecting" })
    );
    assert_eq!(
        json(Phase::Pending {
            expires_in_ms: 30_000
        }),
        serde_json::json!({ "phase": "pending", "expiresInMs": 30_000 })
    );
    assert_eq!(
        json(Phase::Closed {
            reason: Ended::Target(CloseReason::Revoked)
        }),
        serde_json::json!({ "phase": "closed", "reason": { "target": "revoked" } })
    );
    assert_eq!(
        json(Phase::Closed {
            reason: Ended::Lost
        }),
        serde_json::json!({ "phase": "closed", "reason": "lost" })
    );
}

#[test]
fn the_waits_between_attempts_grow_and_then_repeat() {
    let waits: Vec<u64> = (0..7).map(|a| backoff(a).as_secs()).collect();
    assert_eq!(waits, [1, 2, 4, 8, 8, 8, 8]);
}

#[tokio::test]
async fn it_waits_longer_before_each_attempt() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let mut link = link_to(&t, proxy.port, GRACE);
    link.until_phase(Phase::Connected).await;
    proxy.cut(true);
    link.until_phase(Phase::Reconnecting { attempt: 1 }).await;
    let first = Instant::now();
    link.until_phase(Phase::Reconnecting { attempt: 2 }).await;
    // The second wait is two seconds.
    assert!(first.elapsed() >= Duration::from_millis(1500), "{:?}", first.elapsed());
    link.handle.leave().await;
}

#[tokio::test]
async fn a_device_missing_from_discovery_for_a_while_is_tried_again() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let found = Arc::new(Mutex::new(vec![SocketAddr::from(([127, 0, 0, 1], proxy.port))]));
    let list = found.clone();
    let mut link = link_with(&t, Arc::new(move || list.lock().unwrap().clone()), GRACE);
    link.until_phase(Phase::Connected).await;
    let addresses = std::mem::take(&mut *found.lock().unwrap());
    proxy.cut(false);
    link.until_phase(Phase::Reconnecting { attempt: 1 }).await;
    *found.lock().unwrap() = addresses;
    link.until(|l| {
        l.phases()
            .iter()
            .filter(|p| **p == Phase::Connected)
            .count()
            == 2
    })
    .await;
    assert!(!link.phases().iter().any(|p| matches!(p, Phase::Closed { .. })));
}

#[tokio::test]
async fn a_device_that_takes_the_connection_but_never_answers_is_unreachable() {
    let t = target(ControlMode::Always).await;
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = silent.local_addr().unwrap().port();
    let held = tokio::spawn(async move {
        let mut open = Vec::new();
        while let Ok((stream, _)) = silent.accept().await {
            open.push(stream);
        }
    });
    let timeouts = Timeouts {
        handshake: Duration::from_millis(300),
        ..Timeouts::STANDARD
    };
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        timeouts,
    );
    assert_eq!(link.closed().await, Ended::Unreachable);
    held.abort();
}

#[tokio::test]
async fn a_slow_answer_to_control_is_waited_for_past_the_handshake_time() {
    let mut t = target(ControlMode::Ask).await;
    let timeouts = Timeouts {
        handshake: Duration::from_millis(300),
        ..Timeouts::STANDARD
    };
    let port = t.port;
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        timeouts,
    );
    let (request, _) = timeout(WAIT, t.prompts.recv()).await.unwrap().unwrap();
    // Longer than the handshake may take, and longer than a nap.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    t.handle.answer(request, Answer::Allow);
    link.until_phase(Phase::Connected).await;
    assert!(!link.phases().iter().any(|p| matches!(p, Phase::Closed { .. })));
}

#[tokio::test]
async fn it_pings_only_after_a_quiet_spell() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let timeouts = Timeouts {
        ping: Duration::from_secs(4),
        ..Timeouts::STANDARD
    };
    let port = proxy.port;
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        timeouts,
    );
    link.until_phase(Phase::Connected).await;
    let before = proxy.sent.load(Ordering::SeqCst);
    // More than a nap, less than the ping interval.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(proxy.sent.load(Ordering::SeqCst), before, "nothing to say yet");
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(proxy.sent.load(Ordering::SeqCst) > before, "a ping after four seconds");
}
