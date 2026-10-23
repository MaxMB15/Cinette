// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A link against the real target task over loopback, with a proxy between
//! them that can drop the connection the way a network does.

use super::*;
use crate::discovery::Registration;
use crate::remote::target::{self, CatalogPage, TargetHandle, TargetHost};
use crate::remote::test_client::WAIT;
use mvp_core::remote::consent::{Answer, RequestId};
use mvp_core::remote::controller::GIVE_UP_AFTER;
use mvp_core::remote::message::{DeviceType, Feature, PlaybackSnapshot, PROTOCOL_VERSION};
use mvp_core::remote::settings::{ControlMode, RemoteSettings};
use mvp_core::remote::target::{ConsentPrompt, SessionInfo};
use mvp_core::remote::transfer::flow::{
    ControllerEvent, Progress, ProviderKind, ProviderName, ProviderSettings, WRITE_TIMEOUT,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// A target host that carries out every command at once, unless told not
/// to answer.
struct Player {
    target: Mutex<Option<TargetHandle>>,
    prompts: mpsc::UnboundedSender<(RequestId, String)>,
    hidden: mpsc::UnboundedSender<RequestId>,
    silent: Arc<std::sync::atomic::AtomicBool>,
    /// Saves of providers it never finishes, while silent.
    held: Mutex<Vec<target::SavedProviders>>,
}

impl TargetHost for Player {
    fn save_providers(&self, _: String, _: Vec<ProviderSettings>, done: target::SavedProviders) {
        if self.silent.load(Ordering::SeqCst) {
            self.held.lock().unwrap().push(done);
        } else {
            done(Vec::new());
        }
    }
    fn show_consent(&self, prompt: &ConsentPrompt) {
        let _ = self.prompts.send((prompt.request, prompt.code.clone()));
    }
    fn hide_consent(&self, request: RequestId) {
        let _ = self.hidden.send(request);
    }
    fn sessions_changed(&self, _: &[SessionInfo]) {}
    fn apply(&self, token: u64, _: &Command) {
        if self.silent.load(Ordering::SeqCst) {
            return;
        }
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
    hidden: mpsc::UnboundedReceiver<RequestId>,
    /// While set, the player never finishes a command.
    silent: Arc<std::sync::atomic::AtomicBool>,
}

async fn target(mode: ControlMode) -> Target {
    target_keyed(mode, DeviceKey::generate()).await
}

/// A target with `key`, as one that restarted has its old key.
async fn target_keyed(mode: ControlMode, key: DeviceKey) -> Target {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, prompts) = mpsc::unbounded_channel();
    let (hide, hidden) = mpsc::unbounded_channel();
    let silent = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let player = Arc::new(Player {
        target: Mutex::new(None),
        prompts: tx,
        hidden: hide,
        silent: silent.clone(),
        held: Mutex::new(Vec::new()),
    });
    let settings = RemoteSettings {
        remote_control: mode,
        ..RemoteSettings::default()
    };
    let handle = target::start_with(
        listener,
        key.clone(),
        DeviceType::FireTv,
        settings,
        player.clone(),
        target::Limits {
            load_gap: Duration::ZERO,
            ..target::Limits::STANDARD
        },
    )
    .unwrap();
    *player.target.lock().unwrap() = Some(handle.clone());
    Target {
        handle,
        key,
        port,
        prompts,
        hidden,
        silent,
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
    /// The connections it took, refused ones too.
    accepted: Arc<AtomicUsize>,
}

impl Proxy {
    async fn new(to: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepting = Arc::new(Mutex::new(true));
        let pipes: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let sent = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(AtomicUsize::new(0));
        let (open, list, count) = (accepting.clone(), pipes.clone(), sent.clone());
        let taken = accepted.clone();
        tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                taken.fetch_add(1, Ordering::SeqCst);
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
            accepted,
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
    /// When each of `phases` came.
    phased_at: Vec<Instant>,
    states: Vec<VersionedState>,
    transfers: Vec<ControllerEvent>,
    names: Vec<String>,
}

struct Recorder {
    seen: Mutex<Seen>,
    tx: mpsc::UnboundedSender<()>,
}

impl LinkHost for Recorder {
    fn phase(&self, _: u64, _: &DeviceId, phase: &Phase) {
        let mut seen = self.seen.lock().unwrap();
        seen.phases.push(phase.clone());
        seen.phased_at.push(Instant::now());
        drop(seen);
        let _ = self.tx.send(());
    }
    fn state(&self, _: u64, _: &DeviceId, state: &VersionedState) {
        self.seen.lock().unwrap().states.push(state.clone());
        let _ = self.tx.send(());
    }
    fn transfer(&self, _: u64, _: &DeviceId, event: &ControllerEvent) {
        self.seen.lock().unwrap().transfers.push(event.clone());
        let _ = self.tx.send(());
    }
    fn renamed(&self, _: u64, _: &DeviceId, name: &str) {
        self.seen.lock().unwrap().names.push(name.to_owned());
        let _ = self.tx.send(());
    }
}

struct Link {
    handle: LinkHandle,
    recorder: Arc<Recorder>,
    changes: mpsc::UnboundedReceiver<()>,
}

impl Link {
    fn transfers(&self) -> Vec<ControllerEvent> {
        self.recorder.seen.lock().unwrap().transfers.clone()
    }

    fn phases(&self) -> Vec<Phase> {
        self.recorder.seen.lock().unwrap().phases.clone()
    }

    fn states(&self) -> Vec<VersionedState> {
        self.recorder.seen.lock().unwrap().states.clone()
    }

    /// When the link first reported `phase`.
    fn phased_at(&self, phase: &Phase) -> Instant {
        let seen = self.recorder.seen.lock().unwrap();
        let at = seen.phases.iter().position(|p| p == phase).unwrap();
        seen.phased_at[at]
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

    /// Waits until the link is connected a second time, after a resume.
    async fn until_connected_again(&mut self) {
        self.until(|l| l.phases().iter().filter(|p| **p == Phase::Connected).count() == 2)
            .await;
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
    link_timed(target, addresses, grace, QUICK)
}

fn link_timed(target: &Target, addresses: Addresses, grace: Duration, limits: Limits) -> Link {
    link_clocked(
        target,
        addresses,
        grace,
        limits,
        Arc::new(crate::remote::clock::now),
    )
}

fn link_clocked(
    target: &Target,
    addresses: Addresses,
    grace: Duration,
    limits: Limits,
    clock: Clock,
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
        features: vec![
            Feature::Control,
            Feature::Catalog,
            Feature::Providers,
            Feature::Rename,
        ],
    };
    let handle = super::start(
        LinkConfig {
            key,
            hello,
            target: target.key.device_id(),
            addresses,
            grace,
            generation: 7,
            limits,
            clock,
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

/// The app's limits, but the link looks at the clock every 50 ms rather than
/// every 2 s, and waits a tenth as long between attempts. A test that waits
/// for a timeout then sees it soon after it runs out.
const QUICK: Limits = Limits {
    nap: Duration::from_millis(50),
    backoff: quick_backoff,
    ..Limits::STANDARD
};

/// The app's waits between attempts, a tenth as long: 100 ms, 200 ms,
/// 400 ms, then 800 ms over and over.
fn quick_backoff(attempt: u32) -> Duration {
    backoff(attempt) / 10
}

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
    let own_name = RemoteSettings::default().name(DeviceType::FireTv);
    assert!(
        matches!(phases[1], Phase::Verifying { ref code, ref name, .. } if code.len() == 6 && *name == own_name),
        "{phases:?}"
    );
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
            Phase::Verifying { code, .. } => Some(code.clone()),
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
    link.until_connected_again().await;
    assert!(t.prompts.try_recv().is_err(), "no second dialog");
    let codes = link
        .phases()
        .iter()
        .filter(|p| matches!(p, Phase::Verifying { .. }))
        .count();
    assert_eq!(codes, 1, "the code shows once, not again on the resume");
    assert!(link.handle.command(Command::Stop).await.is_ok());
    assert_eq!(t.handle.sessions().await.len(), 1);
}

#[tokio::test]
async fn a_resume_a_restarted_target_asks_about_shows_its_code() {
    let mut t = target(ControlMode::Ask).await;
    let proxy = Proxy::new(t.port).await;
    let at = Arc::new(std::sync::atomic::AtomicU16::new(proxy.port));
    let to = at.clone();
    let addresses: Addresses = Arc::new(move || {
        vec![SocketAddr::from((
            [127, 0, 0, 1],
            to.load(Ordering::SeqCst),
        ))]
    });
    let mut link = link_with(&t, addresses, GRACE);
    let (request, _) = timeout(WAIT, t.prompts.recv()).await.unwrap().unwrap();
    t.handle.answer(request, Answer::Allow);
    link.until_phase(Phase::Connected).await;

    // The target restarts with its key but none of its sessions.
    let mut restarted = target_keyed(ControlMode::Ask, t.key.clone()).await;
    at.store(restarted.port, Ordering::SeqCst);
    proxy.cut(true);
    let (_, shown) = timeout(WAIT, restarted.prompts.recv())
        .await
        .unwrap()
        .unwrap();
    link.until(|l| {
        l.phases()
            .iter()
            .filter(|p| matches!(p, Phase::Pending { .. }))
            .count()
            == 2
    })
    .await;
    let phases = link.phases();
    let after = phases.iter().rposition(|p| *p == Phase::Connected).unwrap();
    let codes: Vec<&str> = phases[after..]
        .iter()
        .filter_map(|p| match p {
            Phase::Verifying { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(codes, [shown.as_str()], "{phases:?}");
    let verifying = phases
        .iter()
        .rposition(|p| matches!(p, Phase::Verifying { .. }));
    let pending = phases
        .iter()
        .rposition(|p| matches!(p, Phase::Pending { .. }));
    assert!(
        verifying < pending,
        "the code comes before the wait: {phases:?}"
    );
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
    link.until_connected_again().await;
}

#[tokio::test]
async fn gives_up_when_the_grace_runs_out() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let port = proxy.port;
    let limits = Limits {
        // A short first wait, then one far longer than the grace.
        backoff: |attempt| match attempt {
            0 => Duration::from_millis(100),
            _ => Duration::from_secs(10),
        },
        ..QUICK
    };
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        Duration::from_millis(300),
        limits,
    );
    link.until_phase(Phase::Connected).await;
    proxy.cut(true);
    let cut = Instant::now();
    assert_eq!(link.closed().await, Ended::Lost);
    // The second wait is cut to the fifth of a second of grace left, rather
    // than the ten seconds that would run past it.
    assert!(
        cut.elapsed() < Duration::from_secs(3),
        "{:?}",
        cut.elapsed()
    );
    let reconnects = link
        .phases()
        .iter()
        .filter(|p| matches!(p, Phase::Reconnecting { .. }))
        .count();
    assert!(reconnects >= 1, "{:?}", link.phases());
}

#[tokio::test]
async fn a_drop_before_control_was_granted_is_lost_without_trying_again() {
    let t = target(ControlMode::Ask).await;
    let proxy = Proxy::new(t.port).await;
    // A long grace, so trying again would show.
    let mut link = link_to(&t, proxy.port, Duration::from_secs(3600));
    link.until(|l| {
        l.phases()
            .iter()
            .any(|p| matches!(p, Phase::Pending { .. }))
    })
    .await;
    // Cut, but still taking connections, as a target that closed on it.
    proxy.cut(false);
    assert_eq!(link.closed().await, Ended::Lost);
    // Five times the first wait before trying again.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        proxy.accepted.load(Ordering::SeqCst),
        1,
        "there was no session to resume"
    );
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
                content_type: "live".into(),
                cursor: None,
                limit: 10,
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
async fn an_address_with_the_wrong_key_is_passed_over_for_the_next() {
    let t = target(ControlMode::Always).await;
    let impostor = target(ControlMode::Always).await;
    // Someone else claims the target's id, at an address listed first.
    let (wrong, right) = (impostor.port, t.port);
    let addresses: Addresses = Arc::new(move || {
        vec![
            SocketAddr::from(([127, 0, 0, 1], wrong)),
            SocketAddr::from(([127, 0, 0, 1], right)),
        ]
    });
    let mut link = link_with(&t, addresses, GRACE);
    link.until_phase(Phase::Connected).await;
    assert!(link.handle.command(Command::Stop).await.is_ok());
    assert_eq!(t.handle.sessions().await.len(), 1);
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
    let waits: Vec<u64> = (0..7)
        .map(|a| (Limits::STANDARD.backoff)(a).as_secs())
        .collect();
    assert_eq!(waits, [1, 2, 4, 8, 8, 8, 8]);
}

#[test]
fn the_link_looks_at_the_clock_every_two_seconds() {
    assert_eq!(Limits::STANDARD.nap, Duration::from_secs(2));
}

#[tokio::test]
async fn it_waits_longer_before_each_attempt() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let mut link = link_to(&t, proxy.port, GRACE);
    link.until_phase(Phase::Connected).await;
    proxy.cut(true);
    link.until_phase(Phase::Reconnecting { attempt: 2 }).await;
    // The second wait is 200 ms, twice the first.
    let waited = link.phased_at(&Phase::Reconnecting { attempt: 2 })
        - link.phased_at(&Phase::Reconnecting { attempt: 1 });
    assert!(waited >= Duration::from_millis(180), "{waited:?}");
    link.handle.leave().await;
}

#[tokio::test]
async fn a_device_missing_from_discovery_for_a_while_is_tried_again() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let found = Arc::new(Mutex::new(vec![SocketAddr::from((
        [127, 0, 0, 1],
        proxy.port,
    ))]));
    let list = found.clone();
    let looks = AtomicUsize::new(0);
    let mut link = link_with(
        &t,
        Arc::new(move || {
            // With no address to try, a link that doesn't wait between
            // attempts never yields, so this test can't run again until the
            // grace is gone. This ends it long before then.
            let looked = looks.fetch_add(1, Ordering::SeqCst);
            assert!(looked < 50, "the link tries again without waiting");
            list.lock().unwrap().clone()
        }),
        GRACE,
    );
    link.until_phase(Phase::Connected).await;
    let addresses = std::mem::take(&mut *found.lock().unwrap());
    proxy.cut(false);
    link.until_phase(Phase::Reconnecting { attempt: 1 }).await;
    *found.lock().unwrap() = addresses;
    link.until_connected_again().await;
    assert!(!link
        .phases()
        .iter()
        .any(|p| matches!(p, Phase::Closed { .. })));
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
    let limits = Limits {
        handshake: Duration::from_millis(300),
        ..QUICK
    };
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        limits,
    );
    assert_eq!(link.closed().await, Ended::Unreachable);
    held.abort();
}

/// A listener that takes connections and closes each at once.
async fn closing_decoy() -> (u16, JoinHandle<()>) {
    let decoy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = decoy.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = decoy.accept().await {
            drop(stream);
        }
    });
    (port, task)
}

/// A listener that takes connections and never says a word.
async fn silent_decoy() -> (u16, JoinHandle<()>) {
    let decoy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = decoy.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let mut open = Vec::new();
        while let Ok((stream, _)) = decoy.accept().await {
            open.push(stream);
        }
    });
    (port, task)
}

fn at(ports: Vec<u16>) -> Addresses {
    Arc::new(move || {
        ports
            .iter()
            .map(|&port| SocketAddr::from(([127, 0, 0, 1], port)))
            .collect()
    })
}

#[tokio::test]
async fn an_address_that_closes_or_says_nothing_is_passed_over_for_the_next() {
    let t = target(ControlMode::Always).await;
    let (closes, a) = closing_decoy().await;
    let (silent, b) = silent_decoy().await;
    let limits = Limits {
        handshake: Duration::from_millis(300),
        ..QUICK
    };
    let mut link = link_timed(&t, at(vec![closes, silent, t.port]), GRACE, limits);
    link.until_phase(Phase::Connected).await;
    assert!(link.handle.command(Command::Stop).await.is_ok());
    a.abort();
    b.abort();
}

#[tokio::test]
async fn with_no_address_the_device_it_ends_with_the_most_telling_reason() {
    let t = target(ControlMode::Always).await;
    let impostor = target(ControlMode::Always).await;
    let (closes, a) = closing_decoy().await;
    let (silent, b) = silent_decoy().await;
    let limits = Limits {
        handshake: Duration::from_millis(300),
        ..QUICK
    };
    // Another device's key says more than a closed connection.
    let mut link = link_timed(&t, at(vec![closes, impostor.port, silent]), GRACE, limits);
    assert_eq!(
        link.closed().await,
        Ended::Target(CloseReason::IdentityMismatch)
    );
    // And a closed connection more than no answer.
    let mut link = link_timed(&t, at(vec![silent, closes]), GRACE, limits);
    assert_eq!(link.closed().await, Ended::Lost);
    a.abort();
    b.abort();
}

#[tokio::test]
async fn a_refusal_after_the_code_isnt_tried_at_the_next_address() {
    let mut t = target(ControlMode::Ask).await;
    let other = target_keyed(ControlMode::Always, t.key.clone()).await;
    let mut link = link_with(&t, at(vec![t.port, other.port]), GRACE);
    let (request, _) = timeout(WAIT, t.prompts.recv()).await.unwrap().unwrap();
    t.handle.answer(request, Answer::Deny);
    assert_eq!(link.closed().await, Ended::Target(CloseReason::Denied));
    assert!(other.handle.sessions().await.is_empty());
}

#[test]
fn the_more_telling_reason_wins() {
    let mismatch = Ended::Target(CloseReason::IdentityMismatch);
    assert_eq!(more_telling(None, Ended::Unreachable), Ended::Unreachable);
    assert_eq!(
        more_telling(Some(Ended::Unreachable), Ended::Lost),
        Ended::Lost
    );
    assert_eq!(
        more_telling(Some(Ended::Lost), Ended::Unreachable),
        Ended::Lost
    );
    assert_eq!(more_telling(Some(Ended::Lost), mismatch), mismatch);
    assert_eq!(more_telling(Some(mismatch), Ended::Lost), mismatch);
    // On a tie, the first stays.
    let protocol = Ended::Target(CloseReason::Protocol);
    assert_eq!(more_telling(Some(mismatch), protocol), mismatch);
}

#[tokio::test]
async fn a_slow_answer_to_control_is_waited_for_past_the_handshake_time() {
    let mut t = target(ControlMode::Ask).await;
    let limits = Limits {
        handshake: Duration::from_millis(300),
        ..QUICK
    };
    let port = t.port;
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        limits,
    );
    let (request, _) = timeout(WAIT, t.prompts.recv()).await.unwrap().unwrap();
    // Longer than the handshake may take, and many naps.
    tokio::time::sleep(Duration::from_secs(1)).await;
    t.handle.answer(request, Answer::Allow);
    link.until_phase(Phase::Connected).await;
    assert!(!link
        .phases()
        .iter()
        .any(|p| matches!(p, Phase::Closed { .. })));
}

#[tokio::test]
async fn it_pings_only_after_a_quiet_spell() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let limits = Limits {
        ping: Duration::from_millis(1500),
        ..QUICK
    };
    let port = proxy.port;
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        limits,
    );
    link.until_phase(Phase::Connected).await;
    let before = proxy.sent.load(Ordering::SeqCst);
    // Six naps, but a fifth of the ping interval, so a busy machine can wake
    // this a second late and still find no ping.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        proxy.sent.load(Ordering::SeqCst),
        before,
        "nothing to say yet"
    );
    // The ping is due a little over a second from now. This stops waiting as
    // soon as it comes, so it can give a busy machine plenty of time.
    let pinged = timeout(WAIT, async {
        while proxy.sent.load(Ordering::SeqCst) == before {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(pinged.is_ok(), "a ping after a second and a half of quiet");
}

#[tokio::test]
async fn gives_up_on_a_device_that_never_answers_and_withdraws_the_request() {
    let mut t = target(ControlMode::Ask).await;
    // A clock the test can move on.
    let skew = Arc::new(Mutex::new(Duration::ZERO));
    let ahead = skew.clone();
    let clock: Clock = Arc::new(move || crate::remote::clock::now() + *ahead.lock().unwrap());
    let port = t.port;
    let mut link = link_clocked(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        QUICK,
        clock,
    );
    let (request, _) = timeout(WAIT, t.prompts.recv()).await.unwrap().unwrap();
    link.until(|l| {
        l.phases()
            .iter()
            .any(|p| matches!(p, Phase::Pending { .. }))
    })
    .await;
    *skew.lock().unwrap() = GIVE_UP_AFTER;
    assert_eq!(link.closed().await, Ended::Target(CloseReason::Timeout));
    // The target hears the request withdrawn, so its dialog goes.
    let hidden = timeout(WAIT, t.hidden.recv()).await.unwrap().unwrap();
    assert_eq!(hidden, request);
}

#[tokio::test]
async fn a_resume_that_reaches_another_device_tries_again() {
    let t = target(ControlMode::Always).await;
    let impostor = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    // The first try after the drop finds another device at the address.
    let tries = Arc::new(AtomicUsize::new(0));
    let (real, other) = (proxy.port, impostor.port);
    let count = tries.clone();
    let mut link = link_with(
        &t,
        Arc::new(move || {
            let port = if count.fetch_add(1, Ordering::SeqCst) == 1 {
                other
            } else {
                real
            };
            vec![SocketAddr::from(([127, 0, 0, 1], port))]
        }),
        GRACE,
    );
    link.until_phase(Phase::Connected).await;
    proxy.cut(false);
    link.until_connected_again().await;
    assert!(tries.load(Ordering::SeqCst) >= 3);
    assert!(!link
        .phases()
        .iter()
        .any(|p| matches!(p, Phase::Closed { .. })));
}

/// The port of a listener whose queue is full, so a new connection to it
/// waits, and what keeps it full.
async fn full_listener() -> (u16, (TcpListener, Vec<TcpStream>)) {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
    let full = socket.listen(1).unwrap();
    let port = full.local_addr().unwrap().port();
    let mut queued = Vec::new();
    for _ in 0..8 {
        let attempt = TcpStream::connect(("127.0.0.1", port));
        match timeout(Duration::from_millis(200), attempt).await {
            Ok(Ok(stream)) => queued.push(stream),
            Ok(Err(_)) => {}
            // This one waits, so the queue is full.
            Err(_) => break,
        }
    }
    assert!(queued.len() < 8, "the queue never filled");
    (port, (full, queued))
}

#[tokio::test]
async fn leaving_while_a_connection_is_being_opened_stops_at_once() {
    let t = target(ControlMode::Always).await;
    let (port, _full) = full_listener().await;
    let mut link = link_to(&t, port, GRACE);
    link.until_phase(Phase::Connecting).await;
    let asked = Instant::now();
    link.handle.leave().await;
    assert!(
        asked.elapsed() < Duration::from_secs(2),
        "{:?}",
        asked.elapsed()
    );
    assert_eq!(link.closed().await, Ended::Left);
}

#[tokio::test]
async fn a_command_with_no_answer_times_out() {
    let t = target(ControlMode::Always).await;
    t.silent.store(true, Ordering::SeqCst);
    let limits = Limits {
        request: Duration::from_millis(300),
        ..QUICK
    };
    let port = t.port;
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        limits,
    );
    link.until_phase(Phase::Connected).await;
    assert_eq!(
        link.handle.command(Command::Stop).await,
        Err(LinkError::TimedOut)
    );
    // The link itself goes on.
    t.silent.store(false, Ordering::SeqCst);
    assert!(link.handle.command(Command::Stop).await.is_ok());
}

#[tokio::test]
async fn only_so_many_wait_for_answers() {
    let t = target(ControlMode::Always).await;
    t.silent.store(true, Ordering::SeqCst);
    let limits = Limits {
        waiting: 1,
        ..QUICK
    };
    let port = t.port;
    let mut link = link_timed(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        limits,
    );
    link.until_phase(Phase::Connected).await;
    let first = {
        let handle = link.handle.clone();
        tokio::spawn(async move { handle.command(Command::Stop).await })
    };
    // Until the first is on its way, the second could be it.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        link.handle
            .catalog(CatalogQuery::Groups {
                content_type: "live".into(),
                cursor: None,
                limit: 10,
            })
            .await,
        Err(LinkError::Busy)
    );
    assert_eq!(
        link.handle.command(Command::Stop).await,
        Err(LinkError::Busy)
    );
    link.handle.leave().await;
    assert_eq!(first.await.unwrap(), Err(LinkError::NotConnected));
}

#[tokio::test]
async fn providers_go_through_a_link_and_a_stalled_transfer_ends_alone() {
    let mut t = target(ControlMode::Always).await;
    let skew = Arc::new(Mutex::new(Duration::ZERO));
    let ahead = skew.clone();
    let clock: Clock = Arc::new(move || crate::remote::clock::now() + *ahead.lock().unwrap());
    let port = t.port;
    let mut link = link_clocked(
        &t,
        Arc::new(move || vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        GRACE,
        QUICK,
        clock,
    );
    link.until_phase(Phase::Connected).await;
    let verifying = link
        .phases()
        .into_iter()
        .find(|p| matches!(p, Phase::Verifying { .. }))
        .unwrap();
    assert!(
        matches!(verifying, Phase::Verifying { ref features, .. } if features.contains(&Feature::Providers))
    );

    let names = vec![ProviderName {
        name: "Home".into(),
        kind: ProviderKind::M3u,
    }];
    link.handle.ask_providers(names.clone()).await.unwrap();
    // Asking twice at once is refused here, before it goes anywhere.
    assert_eq!(
        link.handle.ask_providers(names).await,
        Err(mvp_core::remote::controller::AskError::Busy)
    );
    let (request, _) = timeout(WAIT, t.prompts.recv()).await.unwrap().unwrap();
    t.handle.answer(request, Answer::Allow);
    link.until(|l| {
        l.transfers()
            .iter()
            .any(|e| matches!(e, ControllerEvent::ProvidersGranted { .. }))
    })
    .await;
    let grant = link
        .transfers()
        .into_iter()
        .find_map(|e| match e {
            ControllerEvent::ProvidersGranted { grant } => Some(grant),
            _ => None,
        })
        .unwrap();
    t.silent.store(true, Ordering::SeqCst);
    link.handle.send_providers(
        grant,
        vec![ProviderSettings {
            name: "Home".into(),
            kind: ProviderKind::M3u,
            url: "http://lists.example/a.m3u".into(),
            username: None,
            password: None,
            epg_url: None,
        }],
    );
    link.until(|l| {
        l.transfers().iter().any(|e| {
            matches!(
                e,
                ControllerEvent::Progress {
                    progress: Progress::Saving,
                    ..
                }
            )
        })
    })
    .await;
    // The target never answers. Once the grant's time is up, the transfer
    // ends, and the session isn't closed for it.
    *skew.lock().unwrap() = WRITE_TIMEOUT;
    link.until(|l| {
        l.transfers().iter().any(|e| {
            matches!(
                e,
                ControllerEvent::Progress {
                    progress: Progress::Failed(ErrorCode::Expired),
                    ..
                }
            )
        })
    })
    .await;
    assert!(
        !link.phases().contains(&Phase::Closed {
            reason: Ended::Target(CloseReason::Timeout)
        }),
        "{:?}",
        link.phases()
    );
}

#[tokio::test]
async fn a_cancel_with_nothing_going_on_sends_nothing() {
    let t = target(ControlMode::Always).await;
    let mut link = link_to(&t, t.port, GRACE);
    link.until_phase(Phase::Connected).await;
    link.handle.cancel_transfer();
    // Still in control afterwards.
    assert!(link.handle.command(Command::Stop).await.is_ok());
    assert!(link.transfers().is_empty());
}

/// Waits for the target's one controller to be called `name`.
async fn controller_named(t: &Target, name: &str) {
    let named = timeout(WAIT, async {
        loop {
            if t.handle.sessions().await.first().map(|s| s.name.as_str()) == Some(name) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(named.is_ok(), "{:?}", t.handle.sessions().await);
}

#[tokio::test]
async fn a_new_name_reaches_the_other_side_of_a_session() {
    let t = target(ControlMode::Always).await;
    let mut link = link_to(&t, t.port, GRACE);
    link.until_phase(Phase::Connected).await;
    controller_named(&t, "Mac").await;
    link.handle.rename("Kitchen".into());
    controller_named(&t, "Kitchen").await;

    t.handle.update_settings(RemoteSettings {
        device_name: Some("Den".into()),
        ..RemoteSettings::default()
    });
    link.until(|l| l.recorder.seen.lock().unwrap().names == ["Den"])
        .await;
}

/// Waits a second between attempts, so a test can act while the link waits.
fn slow_backoff(_: u32) -> Duration {
    Duration::from_secs(1)
}

#[tokio::test]
async fn a_name_changed_while_the_link_waits_to_try_again_goes_with_the_resume() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let addresses = Arc::new(Mutex::new(vec![SocketAddr::from(([127, 0, 0, 1], proxy.port))]));
    let found = addresses.clone();
    let mut link = link_timed(
        &t,
        Arc::new(move || found.lock().unwrap().clone()),
        GRACE,
        Limits {
            backoff: slow_backoff,
            ..QUICK
        },
    );
    link.until_phase(Phase::Connected).await;
    // Discovery lost the device, so each attempt finds nowhere to go and
    // the link waits for the next.
    let kept = std::mem::take(&mut *addresses.lock().unwrap());
    proxy.cut(false);
    link.until_phase(Phase::Reconnecting { attempt: 1 }).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    link.handle.rename("Attic".into());
    *addresses.lock().unwrap() = kept;
    link.until_connected_again().await;
    controller_named(&t, "Attic").await;
}

#[tokio::test]
async fn a_name_changed_while_a_connection_is_being_opened_goes_with_it() {
    let t = target(ControlMode::Always).await;
    // A connection to it waits until the link gives up and tries the target.
    let (port, _full) = full_listener().await;
    let mut link = link_with(&t, at(vec![port, t.port]), GRACE);
    link.until_phase(Phase::Connecting).await;
    link.handle.rename("Attic".into());
    // The first address takes the link's whole connect timeout.
    let connected = timeout(CONNECT_TIMEOUT + WAIT, async {
        while !link.phases().contains(&Phase::Connected) {
            link.changes.recv().await.unwrap();
        }
    })
    .await;
    assert!(connected.is_ok(), "{:?}", link.phases());
    controller_named(&t, "Attic").await;
}

#[tokio::test]
async fn a_target_renamed_while_the_link_was_down_shows_its_name_on_the_resume() {
    let t = target(ControlMode::Always).await;
    let proxy = Proxy::new(t.port).await;
    let mut link = link_to(&t, proxy.port, GRACE);
    link.until_phase(Phase::Connected).await;
    proxy.cut(true);
    link.until_phase(Phase::Reconnecting { attempt: 1 }).await;
    t.handle.update_settings(RemoteSettings {
        device_name: Some("Den".into()),
        ..RemoteSettings::default()
    });
    proxy.reopen();
    link.until_connected_again().await;
    assert_eq!(link.recorder.seen.lock().unwrap().names, ["Den"]);
}
