// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! AirPlay on macOS, through AVPlayer and `AVRoutePickerView`, with the
//! objc2 bindings `macos.rs` uses. Everything runs on the main thread.
//!
//! macOS picks a route for one player, not for the whole system, and it
//! never says which receiver that is, or whether there is one, until the
//! player plays an item. So:
//!
//! - The picker is bound to this module's one `AVPlayer`. When it closes,
//!   the route counts as picked, and the app loads the item.
//! - AVPlayer is muted whenever `isExternalPlaybackActive` says the video
//!   isn't on a receiver, so the Mac's own speakers never play it. If the
//!   video hasn't got there [`PICK_LIMIT`](super::pick::PICK_LIMIT) after the item is ready,
//!   nothing was picked: AVPlayer stops, and the player hears it as
//!   [`Callback::NotPicked`]. [`Pick`] holds these rules.
//! - The picker stays in the window only while it's open, hidden the rest
//!   of the time, so it never takes the page's clicks.
//! - mpv's own sound never moves, since the route is AVPlayer's.
//!
//! There's no KVO here. A timer reads AVPlayer's state four times a second
//! while there's something to watch, and the tracker drops the reports
//! that change nothing.

use super::pick::Pick;
use super::reading::{failed_report, finite, http_status, is_numeric};
use super::{
    handle_from, Report, ReportError, Route, EVENT_AVAILABLE, EVENT_PICKER_CLOSED, EVENT_ROUTE,
};
use crate::lock::lock_or_recover;
use dispatch2::{DispatchQueue, DispatchTime, MainThreadBound};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSButton, NSView, NSWindowOrderingMode};
use objc2_av_foundation::{
    AVPlayer, AVPlayerItem, AVPlayerItemStatus, AVPlayerLayer, AVPlayerTimeControlStatus,
    AVRouteDetector,
};
use objc2_av_kit::{AVRoutePickerView, AVRoutePickerViewDelegate};
use objc2_core_media::{kCMTimeZero, CMTime};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::cell::RefCell;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// How often the timer reads AVPlayer's state.
const POLL: Duration = Duration::from_millis(250);
/// How close to the end a paused item counts as ended.
const END_SLACK: f64 = 0.5;

/// What macOS calls the receiver, since it gives no name.
const ROUTE_UID: &str = "mac";
const ROUTE_NAME: &str = "AirPlay";

/// What the main thread hands to the app.
enum Callback {
    Available(bool),
    Route(Option<Route>),
    PickerClosed,
    /// A report about a load's item.
    Report(u64, Report),
    /// No receiver took a load's video.
    NotPicked(u64),
}

type Sink = Box<dyn Fn(Callback) + Send + Sync>;
static SINK: OnceLock<Sink> = OnceLock::new();
/// The main window's view's address, which the picker and the player's
/// layer go in. The window may not exist yet when the plugin starts.
type ViewFinder = Box<dyn Fn() -> Option<usize> + Send + Sync>;
static VIEW: OnceLock<ViewFinder> = OnceLock::new();
/// The route the picker gave, until AirPlay stops.
static ROUTE: Mutex<Option<Route>> = Mutex::new(None);
/// The host, made on the main thread on first use.
static HOST: OnceLock<MainThreadBound<RefCell<Host>>> = OnceLock::new();
/// Whether the timer has anything to watch, and its wake-up.
static WATCHING: Mutex<bool> = Mutex::new(false);
static WAKE: Condvar = Condvar::new();

fn send(callback: Callback) {
    if let Some(sink) = SINK.get() {
        sink(callback);
    }
}

pub fn ensure() -> Result<(), String> {
    Ok(())
}

pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let sink_app = app.clone();
    let sink: Sink = Box::new(move |callback| match callback {
        Callback::Available(available) => {
            let _ = sink_app.emit(EVENT_AVAILABLE, available);
        }
        Callback::Route(route) => {
            *lock_or_recover(&ROUTE) = route.clone();
            let _ = sink_app.emit(EVENT_ROUTE, route);
        }
        Callback::PickerClosed => {
            let _ = sink_app.emit(EVENT_PICKER_CLOSED, ());
        }
        Callback::Report(load, report) => handle_from(&sink_app, load, &report, Instant::now()),
        Callback::NotPicked(load) => {
            if super::not_picked(&sink_app, load) {
                *lock_or_recover(&ROUTE) = None;
            }
        }
    });
    if SINK.set(sink).is_err() {
        return;
    }
    let view_app = app.clone();
    let _ = VIEW.set(Box::new(move || main_view(&view_app)));
    std::thread::Builder::new()
        .name("airplay-watch".into())
        .spawn(watch)
        .ok();
}

/// The address of the main window's view, as `macos.rs` finds it.
fn main_view<R: Runtime>(app: &AppHandle<R>) -> Option<usize> {
    let window = app.get_webview_window("main")?;
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(h) => Some(h.ns_view.as_ptr() as usize),
        _ => None,
    }
}

/// Runs `f` with the host on the main thread, without waiting. The host
/// finds the main window's view the first time it can.
fn on_host<F: FnOnce(&mut Host, MainThreadMarker) + Send + 'static>(f: F) {
    let view = VIEW.get().and_then(|find| find());
    on_main_host(view, f);
}

fn on_main_host<F: FnOnce(&mut Host, MainThreadMarker) + Send + 'static>(
    view: Option<usize>,
    f: F,
) {
    DispatchQueue::main().exec_async(move || run_on_host(view, f, true));
}

/// How long work waits for the host while it's in use.
const BUSY_RETRY: Duration = Duration::from_millis(50);

/// Runs `f` with the host, on the main thread. A click on the picker can
/// run the main queue again before it returns, while the host is still in
/// use, so work that comes then waits a moment and tries again, or is
/// dropped unless it must `retry`: a reading can wait for the next.
fn run_on_host<F: FnOnce(&mut Host, MainThreadMarker) + Send + 'static>(
    view: Option<usize>,
    f: F,
    retry: bool,
) {
    // SAFETY: the main queue only runs its work on the main thread.
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let host = HOST.get_or_init(|| MainThreadBound::new(RefCell::new(Host::new()), mtm));
    let Ok(mut host) = host.get(mtm).try_borrow_mut() else {
        if retry {
            let when = DispatchTime::try_from(BUSY_RETRY).unwrap_or(DispatchTime::NOW);
            let _ = DispatchQueue::main().after(when, move || run_on_host(view, f, true));
        }
        return;
    };
    if host.view.is_none() {
        // SAFETY: the address is the main window's view, which stays
        // as long as the app runs, since closing that window quits it.
        host.view = view.and_then(|v| unsafe { Retained::retain(v as *mut NSView) });
    }
    f(&mut host, mtm);
}

/// Starts or stops the timer.
fn set_watching(watching: bool) {
    *lock_or_recover(&WATCHING) = watching;
    WAKE.notify_all();
}

/// The timer's thread. It reads the state on the main thread while there's
/// something to watch, and sleeps otherwise.
fn watch() {
    loop {
        let mut watching = lock_or_recover(&WATCHING);
        while !*watching {
            watching = WAKE.wait(watching).unwrap_or_else(|p| p.into_inner());
        }
        drop(watching);
        std::thread::sleep(POLL);
        // Only the calls that show something need the window's view.
        DispatchQueue::main().exec_async(|| {
            run_on_host(
                None,
                |host, mtm| {
                    let more = host.poll(mtm);
                    if !more {
                        *lock_or_recover(&WATCHING) = false;
                    }
                },
                false,
            )
        });
    }
}

define_class!(
    /// Hears the picker close.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "CinetteAirPlayPickerDelegate"]
    struct PickerDelegate;

    unsafe impl NSObjectProtocol for PickerDelegate {}

    unsafe impl AVRoutePickerViewDelegate for PickerDelegate {
        #[unsafe(method(routePickerViewDidEndPresentingRoutes:))]
        fn did_end(&self, view: &AVRoutePickerView) {
            // Out of the page's way until it opens again.
            view.setHidden(true);
            // macOS doesn't say what was picked, so the app loads, and the
            // load finds out.
            send(Callback::Route(Some(Route::new(ROUTE_UID, ROUTE_NAME))));
            send(Callback::PickerClosed);
        }
    }
);

impl PickerDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// The item AVPlayer plays.
struct Item {
    /// The load it came from, which its reports carry.
    load: u64,
    live: bool,
    start_at: f64,
    /// It got ready and started playing.
    started: bool,
    pick: Pick,
}

struct Host {
    view: Option<Retained<NSView>>,
    detector: Retained<AVRouteDetector>,
    detecting: bool,
    available: Option<bool>,
    picker: Option<Retained<AVRoutePickerView>>,
    delegate: Option<Retained<PickerDelegate>>,
    player: Option<Retained<AVPlayer>>,
    /// Holds an AVPlayerLayer for the player, too small to see, as on iOS.
    layer_view: Option<Retained<NSView>>,
    item: Option<Item>,
}

impl Host {
    fn new() -> Self {
        Self {
            view: None,
            detector: unsafe { AVRouteDetector::new() },
            detecting: false,
            available: None,
            picker: None,
            delegate: None,
            player: None,
            layer_view: None,
            item: None,
        }
    }

    fn player(&mut self, mtm: MainThreadMarker) -> Retained<AVPlayer> {
        if let Some(player) = &self.player {
            return player.clone();
        }
        let player = unsafe { AVPlayer::new(mtm) };
        unsafe {
            // usesExternalPlaybackWhileExternalScreenIsActive is iOS only.
            player.setAllowsExternalPlayback(true);
            player.setAutomaticallyWaitsToMinimizeStalling(true);
        }
        if let Some(view) = &self.view {
            let holder = NSView::initWithFrame(
                NSView::alloc(mtm),
                NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0)),
            );
            holder.setWantsLayer(true);
            holder.setAlphaValue(0.01);
            let layer = unsafe { AVPlayerLayer::playerLayerWithPlayer(Some(&player)) };
            if let Some(host) = holder.layer() {
                layer.setFrame(host.bounds());
                host.addSublayer(&layer);
            }
            view.addSubview_positioned_relativeTo(&holder, NSWindowOrderingMode::Below, None);
            self.layer_view = Some(holder);
        }
        self.player = Some(player.clone());
        player
    }

    fn set_detection(&mut self, enabled: bool) {
        self.detecting = enabled;
        unsafe { self.detector.setRouteDetectionEnabled(enabled) };
        self.available = None;
        if enabled {
            set_watching(true);
        }
    }

    /// Opens the picker over `rect`, in the page's CSS pixels.
    /// AVRoutePickerView has no method that opens it, so this clicks its
    /// button, as on iOS.
    fn choose(&mut self, rect: NSRect, mtm: MainThreadMarker) {
        let Some(view) = self.view.clone() else {
            send(Callback::PickerClosed);
            return;
        };
        let player = self.player(mtm);
        let picker = match &self.picker {
            Some(picker) => picker.clone(),
            None => {
                let picker = unsafe {
                    AVRoutePickerView::initWithFrame(AVRoutePickerView::alloc(mtm), rect)
                };
                let delegate = PickerDelegate::new(mtm);
                // prioritizesVideoDevices is iOS only. The picker is bound
                // to a player, so it lists the receivers for video anyway.
                unsafe { picker.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
                // Invisible but there, so the menu has somewhere to open.
                picker.setAlphaValue(0.02);
                view.addSubview(&picker);
                self.delegate = Some(delegate);
                self.picker = Some(picker.clone());
                picker
            }
        };
        unsafe { picker.setPlayer(Some(&player)) };
        // The web view's CSS pixels count from the top, AppKit's from the
        // bottom.
        let height = view.bounds().size.height;
        picker.setFrame(NSRect::new(
            NSPoint::new(rect.origin.x, height - rect.origin.y - rect.size.height),
            rect.size,
        ));
        let button = picker
            .subviews()
            .iter()
            .find_map(|v| v.downcast::<NSButton>().ok());
        match button {
            Some(button) => {
                picker.setHidden(false);
                unsafe { button.performClick(None) };
            }
            None => {
                tracing::warn!("[AirPlay] the route picker has no button");
                picker.setHidden(true);
                send(Callback::PickerClosed);
            }
        }
    }

    fn load(&mut self, url: &str, start_at: f64, live: bool, load: u64, mtm: MainThreadMarker) {
        self.stop_item();
        let player = self.player(mtm);
        let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else {
            tracing::warn!("[AirPlay] load without a valid stream address");
            send(Callback::Report(load, failed_report()));
            return;
        };
        let item = unsafe { AVPlayerItem::playerItemWithURL(&url, mtm) };
        unsafe {
            // Quiet until the video is on a receiver, so a pick of this
            // Mac, or none, doesn't play here.
            player.setMuted(true);
            player.replaceCurrentItemWithPlayerItem(Some(&item));
        }
        self.item = Some(Item {
            load,
            live,
            start_at,
            started: false,
            pick: Pick::default(),
        });
        set_watching(true);
    }

    fn stop_item(&mut self) {
        self.item = None;
        if let Some(player) = &self.player {
            unsafe {
                player.pause();
                player.setMuted(true);
                player.replaceCurrentItemWithPlayerItem(None);
            }
        }
    }

    fn stop(&mut self) {
        self.stop_item();
        send(Callback::Route(None));
    }

    /// Reads the state and sends what changed. Returns whether there's
    /// still something to watch.
    fn poll(&mut self, _mtm: MainThreadMarker) -> bool {
        if self.detecting {
            let available = unsafe { self.detector.multipleRoutesDetected() };
            if self.available != Some(available) {
                self.available = Some(available);
                send(Callback::Available(available));
            }
        }
        let watching_item = self.poll_item();
        self.detecting || watching_item
    }

    fn poll_item(&mut self) -> bool {
        let (Some(player), Some(item)) = (self.player.clone(), self.item.as_mut()) else {
            return false;
        };
        let Some(current) = (unsafe { player.currentItem() }) else {
            return false;
        };
        let status = unsafe { current.status() };
        let ready = status == AVPlayerItemStatus::ReadyToPlay;
        if ready && !item.started {
            item.started = true;
            unsafe {
                if item.start_at > 0.0 {
                    // AVPlayerItem can't take a start time before it's
                    // ready.
                    player.seekToTime_toleranceBefore_toleranceAfter(
                        CMTime::with_seconds(item.start_at, 600),
                        kCMTimeZero,
                        kCMTimeZero,
                    );
                }
                player.play();
            }
        }
        let external = unsafe { player.isExternalPlaybackActive() };
        let step = item.pick.step(ready, external, Instant::now());
        unsafe {
            if player.isMuted() != step.muted {
                player.setMuted(step.muted);
            }
            if step.pause {
                // The video left the receiver. The tracker says the
                // receiver was lost.
                player.pause();
            }
        }
        if step.not_picked {
            let load = item.load;
            self.stop_item();
            send(Callback::NotPicked(load));
            return false;
        }
        let load = item.load;
        let position = finite(unsafe { player.currentTime().seconds() });
        let duration = unsafe { current.duration() };
        let duration = (!item.live && is_numeric(duration.flags.0))
            .then(|| unsafe { duration.seconds() })
            .filter(|d| d.is_finite());
        let control = unsafe { player.timeControlStatus() };
        let error = unsafe { current.error() };
        let status = if status == AVPlayerItemStatus::Failed || error.is_some() {
            "failed"
        } else if !item.started {
            "opening"
        } else if control == AVPlayerTimeControlStatus::Paused
            && duration.is_some_and(|d| position >= d - END_SLACK)
        {
            "ended"
        } else if control == AVPlayerTimeControlStatus::Playing {
            "playing"
        } else if control == AVPlayerTimeControlStatus::Paused {
            "paused"
        } else {
            "waiting"
        };
        let error = error.map(|e| ReportError {
            domain: e.domain().to_string(),
            code: e.code() as i64,
            http_status: error_status(&current),
        });
        send(Callback::Report(
            load,
            Report {
                status: status.to_string(),
                position,
                duration,
                external,
                error,
                subtitles: Vec::new(),
                subtitle: None,
                audio: Vec::new(),
                audio_track: None,
            },
        ));
        true
    }
}

/// The HTTP status of the last failed request, from the error log. Only the
/// number is read: the log's comment can hold the URL.
fn error_status(item: &AVPlayerItem) -> Option<u16> {
    let log = unsafe { item.errorLog() }?;
    let event = unsafe { log.events() }.lastObject()?;
    http_status(unsafe { event.errorStatusCode() })
}

pub fn load(
    url: &str,
    _title: &str,
    start: f64,
    live: bool,
    _converted: bool,
    load: u64,
) -> Result<(), String> {
    let url = url.to_string();
    on_host(move |host, mtm| host.load(&url, start, live, load, mtm));
    Ok(())
}

pub fn set_detection(enabled: bool) {
    on_host(move |host, _| host.set_detection(enabled));
}

pub fn choose(x: f64, y: f64, width: f64, height: f64) {
    let rect = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
    on_host(move |host, mtm| host.choose(rect, mtm));
}

pub fn current_route() -> Option<Route> {
    lock_or_recover(&ROUTE).clone()
}

pub fn play() {
    on_host(|host, _| {
        if let Some(player) = &host.player {
            unsafe { player.play() };
        }
    });
}

pub fn pause() {
    on_host(|host, _| {
        if let Some(player) = &host.player {
            unsafe { player.pause() };
        }
    });
}

pub fn seek(position: f64) {
    on_host(move |host, _| {
        if let Some(player) = &host.player {
            unsafe {
                player.seekToTime_toleranceBefore_toleranceAfter(
                    CMTime::with_seconds(position.max(0.0), 600),
                    kCMTimeZero,
                    kCMTimeZero,
                );
            }
        }
    });
}

/// macOS has no track choice yet: the reports list none.
pub fn select_subtitle(_index: Option<usize>) {}

pub fn select_audio(_index: usize) {}

pub fn stop() {
    on_host(|host, _| host.stop());
}
