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
//! - AVPlayer starts muted, and unmutes once `isExternalPlaybackActive`
//!   says the video is on a receiver. If that hasn't happened
//!   [`PICK_LIMIT`] after the item is ready, nothing was picked: AVPlayer
//!   stops, and the player hears it as [`Callback::NotPicked`].
//! - mpv's own sound never moves, since the route is AVPlayer's.
//!
//! There's no KVO here. A timer reads AVPlayer's state four times a second
//! while there's something to watch, and the tracker drops the reports
//! that change nothing.

use super::{
    handle, Report, ReportError, Route, EVENT_AVAILABLE, EVENT_PICKER_CLOSED, EVENT_ROUTE,
};
use crate::lock::lock_or_recover;
use dispatch2::{DispatchQueue, MainThreadBound};
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

/// How long after the item is ready AVPlayer may take to reach a receiver
/// before the pick counts as none.
const PICK_LIMIT: Duration = Duration::from_secs(5);
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
    Report(Report),
    NotPicked,
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
        Callback::Report(report) => handle(&sink_app, &report, Instant::now()),
        Callback::NotPicked => super::not_picked(&sink_app),
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
    DispatchQueue::main().exec_async(move || {
        // SAFETY: the main queue only runs its work on the main thread.
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let host = HOST.get_or_init(|| MainThreadBound::new(RefCell::new(Host::new()), mtm));
        let mut host = host.get(mtm).borrow_mut();
        if host.view.is_none() {
            // SAFETY: the address is the main window's view, which stays
            // as long as the app runs, since closing that window quits it.
            host.view = view.and_then(|v| unsafe { Retained::retain(v as *mut NSView) });
        }
        f(&mut host, mtm);
    });
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
        on_main_host(None, |host, mtm| {
            let more = host.poll(mtm);
            if !more {
                *lock_or_recover(&WATCHING) = false;
            }
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
        fn did_end(&self, _view: &AVRoutePickerView) {
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
    live: bool,
    start_at: f64,
    /// It got ready and started playing.
    started: bool,
    ready_at: Option<Instant>,
    /// The video reached a receiver.
    external: bool,
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
            player.setAllowsExternalPlayback(true);
            player.setUsesExternalPlaybackWhileExternalScreenIsActive(true);
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
                unsafe {
                    picker.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
                    picker.setPrioritizesVideoDevices(true);
                }
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
            Some(button) => unsafe { button.performClick(None) },
            None => {
                tracing::warn!("[AirPlay] the route picker has no button");
                send(Callback::PickerClosed);
            }
        }
    }

    fn load(&mut self, url: &str, start_at: f64, live: bool, mtm: MainThreadMarker) {
        self.stop_item();
        let player = self.player(mtm);
        let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else {
            tracing::warn!("[AirPlay] load without a valid stream address");
            send(Callback::Report(failed_report()));
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
            live,
            start_at,
            started: false,
            ready_at: None,
            external: false,
        });
        set_watching(true);
    }

    fn stop_item(&mut self) {
        self.item = None;
        if let Some(player) = &self.player {
            unsafe {
                player.pause();
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
            item.ready_at = Some(Instant::now());
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
        if external && !item.external {
            item.external = true;
            unsafe { player.setMuted(false) };
        } else if !external && item.external {
            // The video left the receiver. AVPlayer would carry on here,
            // so it stops, and the tracker says the receiver was lost.
            unsafe { player.pause() };
        }
        if !item.external && item.ready_at.is_some_and(|at| at.elapsed() >= PICK_LIMIT) {
            self.stop_item();
            send(Callback::NotPicked);
            return false;
        }
        let position = finite(unsafe { player.currentTime().seconds() });
        let duration = unsafe { current.duration() };
        let duration = (!item.live && is_numeric(duration))
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
            http_status: http_status(&current),
        });
        send(Callback::Report(Report {
            status: status.to_string(),
            position,
            duration,
            external,
            error,
            subtitles: Vec::new(),
            subtitle: None,
            audio: Vec::new(),
            audio_track: None,
        }));
        true
    }
}

fn finite(seconds: f64) -> f64 {
    if seconds.is_finite() {
        seconds
    } else {
        0.0
    }
}

/// `CMTIME_IS_NUMERIC`: valid, and neither indefinite nor infinite.
fn is_numeric(time: CMTime) -> bool {
    use objc2_core_media::CMTimeFlags;
    let flags = time.flags;
    flags.contains(CMTimeFlags::Valid)
        && !flags.intersects(
            CMTimeFlags::Indefinite | CMTimeFlags::PositiveInfinity | CMTimeFlags::NegativeInfinity,
        )
}

/// The HTTP status of the last failed request, from the error log. Only the
/// number is read: the log's comment can hold the URL.
fn http_status(item: &AVPlayerItem) -> Option<u16> {
    let log = unsafe { item.errorLog() }?;
    let event = unsafe { log.events() }.lastObject()?;
    let status = unsafe { event.errorStatusCode() };
    u16::try_from(status)
        .ok()
        .filter(|s| (400..=599).contains(s))
}

/// A load whose address couldn't be read, as a load that failed before it
/// started.
fn failed_report() -> Report {
    Report {
        status: "failed".into(),
        position: 0.0,
        duration: None,
        external: false,
        error: Some(ReportError {
            domain: "Cinette".into(),
            code: -1,
            http_status: None,
        }),
        subtitles: Vec::new(),
        subtitle: None,
        audio: Vec::new(),
        audio_track: None,
    }
}

pub fn load(
    url: &str,
    _title: &str,
    start: f64,
    live: bool,
    _converted: bool,
) -> Result<(), String> {
    let url = url.to_string();
    on_host(move |host, mtm| host.load(&url, start, live, mtm));
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
