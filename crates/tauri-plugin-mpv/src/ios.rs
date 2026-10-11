// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! iOS video output.
//!
//! mpv draws straight into a `CAMetalLayer` through MoltenVK
//! (`vo=gpu-next`, `gpu-context=moltenvk`), with the layer pointer passed as
//! `wid`. mpv owns the draw loop, so there's no render context to drive like
//! on macOS and Linux. The layer is a sublayer of a UIView that the plugin's
//! Swift package (`ios/Sources/MpvPlugin.swift`) keeps under the web view.
//!
//! The Swift side also runs the audio session, Now Playing and the lock
//! screen controls. Rust calls it through the `mvp_ios_*` functions, and it
//! calls back through the C callbacks registered in [`install`].

use crate::mpv::MpvState;
use crate::renderer::PlatformRenderer;
use libmpv2::{
    events::{Event, PropertyData},
    Format, Mpv,
};
use std::ffi::{c_char, c_void, CString};
use std::panic::{self, AssertUnwindSafe};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use tauri::{AppHandle, Manager, Runtime};

extern "C" {
    fn mvp_ios_register_callbacks(
        lifecycle: Option<extern "C" fn(bool)>,
        remote: Option<extern "C" fn(i32, f64)>,
        resized: Option<extern "C" fn()>,
    );
    fn mvp_ios_surface_create() -> usize;
    fn mvp_ios_surface_set_frame(x: f64, y: f64, width: f64, height: f64);
    fn mvp_ios_surface_set_visible(visible: bool);
    fn mvp_ios_surface_detach();
    fn mvp_ios_set_idle_timer_disabled(disabled: bool);
    fn mvp_ios_set_audio_active(active: bool);
    fn mvp_ios_now_playing(title: *const c_char, duration: f64, position: f64, playing: bool);
    fn mvp_ios_now_playing_clear();
    // From libmpv itself. libmpv2 doesn't re-export its sys crate.
    fn mpv_wakeup(ctx: *mut c_void);
}

/// Remote command codes from `MvpRemoteCommand` in `MpvPlugin.swift`.
const REMOTE_PLAY: i32 = 0;
const REMOTE_PAUSE: i32 = 1;
const REMOTE_TOGGLE: i32 = 2;
const REMOTE_SKIP: i32 = 3;
const REMOTE_SEEK_TO: i32 = 4;

/// mpv options for the Metal layer. The caller adds `wid`, which changes
/// with every layer.
pub fn embedded_options() -> Vec<(&'static str, &'static str)> {
    vec![
        ("vo", "gpu-next"),
        ("gpu-api", "vulkan"),
        ("gpu-context", "moltenvk"),
        ("hwdec", "videotoolbox"),
        ("hwdec-codecs", "all"),
        ("video-rotate", "no"),
        ("profile", "fast"),
        ("cache", "yes"),
        ("cache-secs", "10"),
        ("demuxer-max-bytes", "50MiB"),
        ("demuxer-max-back-bytes", "25MiB"),
        ("stream-lavf-o", "reconnect=1,reconnect_streamed=1,reconnect_delay_max=5"),
        ("network-timeout", "30"),
        // Keep the last frame at EOF so the frontend can show its controls,
        // same as desktop.
        ("keep-open", "yes"),
        ("terminal", "no"),
        ("input-default-bindings", "no"),
        // No `ytdl` or `osc`: MPVKit builds mpv for iOS without Lua, and
        // those options only exist with it. Setting one fails init with
        // MPV_ERROR_OPTION_NOT_FOUND.
    ]
}

/// Called once from plugin setup. Hands Swift the callbacks for the app
/// lifecycle and the lock screen controls, which need the app's `MpvState`.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let (tx, rx) = mpsc::channel::<Job>();
    if JOBS.set(tx).is_err() {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mpv-ios-callbacks".into())
        .spawn(move || {
            for job in rx {
                let state = app.state::<MpvState>();
                if panic::catch_unwind(AssertUnwindSafe(|| job(&state))).is_err() {
                    tracing::warn!("[MPV ios] a callback panicked");
                }
            }
        });
    if let Err(e) = spawned {
        tracing::warn!("[MPV ios] failed to spawn the callback thread: {e}");
        return;
    }
    unsafe { mvp_ios_register_callbacks(Some(on_lifecycle), Some(on_remote), Some(on_resized)) };
}

type Job = Box<dyn FnOnce(&MpvState) + Send>;

/// Feeds the thread that runs the callbacks.
static JOBS: OnceLock<mpsc::Sender<Job>> = OnceLock::new();

/// Runs `f` with the app's `MpvState` on the callback thread. The callbacks
/// arrive on the main thread, and an mpv call can wait on a lock held by a
/// load, so they can't run there. One thread runs them in the order they
/// arrived. With a thread each, a quick trip to the background and back
/// could turn video on and then off again.
fn run_in_order(f: impl FnOnce(&MpvState) + Send + 'static) {
    if let Some(jobs) = JOBS.get() {
        if jobs.send(Box::new(f)).is_err() {
            tracing::warn!("[MPV ios] the callback thread has stopped");
        }
    }
}

/// iOS stops apps that use the GPU in the background, so video output is
/// off while the app is in the background. Audio keeps playing.
extern "C" fn on_lifecycle(background: bool) {
    run_in_order(move |state| state.set_video_enabled(!background));
}

extern "C" fn on_remote(command: i32, value: f64) {
    run_in_order(move |state| {
        let result = match command {
            REMOTE_PLAY => state.play(),
            REMOTE_PAUSE => state.pause(),
            REMOTE_TOGGLE if state.get_state().is_paused => state.play(),
            REMOTE_TOGGLE => state.pause(),
            REMOTE_SKIP => state.seek_relative(value),
            REMOTE_SEEK_TO => state.seek(value),
            _ => Ok(()),
        };
        if let Err(e) = result {
            tracing::warn!("[MPV ios] remote command {command} failed: {e}");
        }
    });
}

/// Bumped whenever the Metal layer's drawable changes size.
static RESIZE_GEN: AtomicU64 = AtomicU64::new(0);

/// The running watcher's mpv client as an address, so a resize can wake it.
/// Zero while there's no watcher.
static WATCHER_CLIENT: Mutex<usize> = Mutex::new(0);

/// The video view's drawable changed size, after a rotation or a layout
/// change. The watcher gets mpv to pick up the new size.
extern "C" fn on_resized() {
    RESIZE_GEN.fetch_add(1, Ordering::AcqRel);
    let client = WATCHER_CLIENT.lock().unwrap_or_else(|p| p.into_inner());
    if *client != 0 {
        unsafe { mpv_wakeup(*client as *mut c_void) };
    }
}

pub fn set_idle_timer_disabled(disabled: bool) {
    unsafe { mvp_ios_set_idle_timer_disabled(disabled) };
}

/// Turns the audio session on for playback, or off along with the lock
/// screen's Now Playing info when playback stops.
pub fn set_audio_active(active: bool) {
    unsafe { mvp_ios_set_audio_active(active) };
    if !active {
        unsafe { mvp_ios_now_playing_clear() };
    }
}

/// What the frontend knows about the stream that mpv can't tell: the
/// channel name, and whether it's live. mpv's `media-title` for a stream is
/// usually the last part of the URL, and a live stream's `duration` keeps
/// growing as it buffers.
struct MediaInfo {
    title: Option<CString>,
    live: bool,
}

static MEDIA_INFO: Mutex<MediaInfo> = Mutex::new(MediaInfo {
    title: None,
    live: false,
});

/// Bumped on every `set_media_info` so the watcher knows to resend.
static MEDIA_INFO_GEN: AtomicU64 = AtomicU64::new(0);

/// Sets the title and live flag shown on the lock screen. They stay until
/// the next call, so they cover the next load too.
pub fn set_media_info(title: Option<String>, live: bool) {
    let title = title.filter(|t| !t.is_empty()).and_then(|t| CString::new(t).ok());
    let mut info = MEDIA_INFO.lock().unwrap_or_else(|p| p.into_inner());
    info.title = title;
    info.live = live;
    MEDIA_INFO_GEN.fetch_add(1, Ordering::AcqRel);
}

/// The Metal view under the web view. The view outlives this value: Swift
/// reuses it for the next stream and only hides it on detach.
pub struct IosMetalRenderer {
    layer: usize,
    /// In a mutex only so the renderer is `Sync`.
    first_frame_cb: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Stops the watcher thread, whose client handle keeps the mpv core
    /// alive. Tripped in `detach`, before the engine stops.
    watcher_kill: Option<Arc<AtomicBool>>,
    detached: bool,
}

impl IosMetalRenderer {
    pub fn new() -> Result<Self, String> {
        let layer = unsafe { mvp_ios_surface_create() };
        if layer == 0 {
            return Err("the web view isn't ready for video yet".into());
        }
        Ok(Self {
            layer,
            first_frame_cb: Mutex::new(None),
            watcher_kill: None,
            detached: false,
        })
    }

    /// The value for mpv's `wid` option, the `CAMetalLayer` pointer.
    pub fn wid(&self) -> String {
        self.layer.to_string()
    }
}

impl PlatformRenderer for IosMetalRenderer {
    /// mpv already has the layer through `wid`. This only starts the thread
    /// that reports the first frame and keeps Now Playing up to date.
    fn attach(&mut self, mpv: &mut Mpv) -> Result<(), String> {
        let client = mpv
            .create_client(Some("ios-watcher"))
            .map_err(|e| format!("mpv_create_client: {e}"))?;
        let kill = Arc::new(AtomicBool::new(false));
        self.watcher_kill = Some(kill.clone());
        let first_frame = self
            .first_frame_cb
            .get_mut()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        std::thread::Builder::new()
            .name("mpv-ios-watcher".into())
            .spawn(move || run_watcher(client, kill, first_frame))
            .map_err(|e| format!("spawn watcher: {e}"))?;
        Ok(())
    }

    /// The view follows `set_frame` and its own layout, so a window resize
    /// needs nothing here.
    fn resize(&mut self, _width: u32, _height: u32) {}

    fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64) {
        unsafe { mvp_ios_surface_set_frame(x, y, w, h) };
    }

    fn set_visible(&mut self, visible: bool) {
        unsafe { mvp_ios_surface_set_visible(visible) };
    }

    fn set_first_frame_callback(&mut self, cb: Box<dyn FnOnce() + Send>) {
        *self.first_frame_cb.get_mut().unwrap_or_else(|p| p.into_inner()) = Some(cb);
    }

    fn detach(&mut self) {
        if self.detached {
            return;
        }
        self.detached = true;
        if let Some(kill) = self.watcher_kill.take() {
            kill.store(true, Ordering::Release);
        }
        unsafe { mvp_ios_surface_detach() };
    }
}

impl Drop for IosMetalRenderer {
    fn drop(&mut self) {
        self.detach();
    }
}

const OBSERVE_VO_CONFIGURED: u64 = 1;
const OBSERVE_PAUSE: u64 = 2;
const OBSERVE_DURATION: u64 = 3;
const OBSERVE_TITLE: u64 = 4;

/// Waits for the first video frame, then keeps the lock screen's Now Playing
/// info in step with pause, seeks, duration and title. It also gets mpv to
/// resize its output when the view changes size, see [`OutputResize`].
fn run_watcher(
    mut client: Mpv,
    kill: Arc<AtomicBool>,
    mut first_frame: Option<Box<dyn FnOnce() + Send>>,
) {
    let _ = client.disable_deprecated_events();
    let observed = [
        ("vo-configured", Format::Flag, OBSERVE_VO_CONFIGURED),
        ("pause", Format::Flag, OBSERVE_PAUSE),
        ("duration", Format::Double, OBSERVE_DURATION),
        ("media-title", Format::String, OBSERVE_TITLE),
    ];
    for (name, format, id) in observed {
        if let Err(e) = client.observe_property(name, format, id) {
            tracing::warn!("[MPV ios] observe {name} failed: {e}");
        }
    }

    let client_addr = client.ctx.as_ptr() as usize;
    *WATCHER_CLIENT.lock().unwrap_or_else(|p| p.into_inner()) = client_addr;

    let mut paused = false;
    let mut duration = 0.0;
    let mut mpv_title: Option<CString> = None;
    let mut seen_gen = MEDIA_INFO_GEN.load(Ordering::Acquire);
    let mut vo_configured = false;
    let mut seen_resize = RESIZE_GEN.load(Ordering::Acquire);
    let mut resize = OutputResize::default();

    while !kill.load(Ordering::Acquire) {
        let mut reconfigured = false;
        let event_changed = match client.wait_event(0.5) {
            Some(Ok(Event::Shutdown)) => break,
            Some(Ok(Event::VideoReconfig)) => {
                reconfigured = true;
                false
            }
            Some(Ok(Event::PropertyChange { name, change, .. })) => match (name, change) {
                ("vo-configured", PropertyData::Flag(configured)) => {
                    vo_configured = configured;
                    if configured {
                        if let Some(cb) = first_frame.take() {
                            cb();
                        }
                    }
                    false
                }
                ("pause", PropertyData::Flag(p)) => {
                    paused = p;
                    true
                }
                ("duration", PropertyData::Double(d)) => {
                    duration = d;
                    // A live stream's duration grows with the buffer. Each
                    // update would restart the lock screen's progress, so
                    // only a file with a real length counts.
                    !MEDIA_INFO.lock().unwrap_or_else(|p| p.into_inner()).live
                }
                ("media-title", PropertyData::Str(t)) => {
                    mpv_title = CString::new(t).ok();
                    true
                }
                _ => false,
            },
            Some(Ok(Event::PlaybackRestart)) => true,
            _ => false,
        };
        if reconfigured {
            resize.on_reconfig(&client);
        }
        let resize_gen = RESIZE_GEN.load(Ordering::Acquire);
        if resize_gen != seen_resize {
            seen_resize = resize_gen;
            // Before the first frame, mpv reads the size when it sets up
            // the output anyway.
            if vo_configured {
                resize.start(&client);
            }
        }
        let gen = MEDIA_INFO_GEN.load(Ordering::Acquire);
        let info_changed = gen != seen_gen;
        seen_gen = gen;
        if event_changed || info_changed {
            let position = client.get_property::<f64>("time-pos").unwrap_or(0.0);
            let info = MEDIA_INFO.lock().unwrap_or_else(|p| p.into_inner());
            let title = info.title.as_ref().or(mpv_title.as_ref());
            let title_ptr = title.map_or(std::ptr::null(), |t| t.as_ptr());
            // Zero duration tells Swift the stream is live.
            let length = if info.live { 0.0 } else { duration };
            unsafe { mvp_ios_now_playing(title_ptr, length, position, !paused) };
        }
    }

    // Clear the address before the client goes, so no resize wakes a freed
    // handle. A newer watcher may already have replaced it.
    let mut slot = WATCHER_CLIENT.lock().unwrap_or_else(|p| p.into_inner());
    if *slot == client_addr {
        *slot = 0;
    }
}

/// How far each nudge moves the pixel aspect. A 4K frame would need about
/// 250 times this to change by one pixel.
const NUDGE: f64 = 1e-6;

/// Gets mpv to resize its output after the view changes size.
///
/// MPVKit's MoltenVK context reads the layer's drawable size only when mpv
/// reconfigures its video output, and never reports a resize. mpv
/// reconfigures when the frame parameters change, so this moves
/// `video-aspect-override` by a few parts per million. The next frame then
/// reconfigures the output at the new size, and the override goes back to
/// `no`, which reconfigures once more with the stream's own aspect.
#[derive(Default)]
struct OutputResize {
    /// Counts nudges, so two in a row never set the same value. mpv ignores
    /// an option set to the value it already has.
    step: u32,
    /// The pixel aspect of the stream without the override.
    base_par: f64,
    /// The pixel aspect the output will have once the nudge reaches it.
    /// `None` while no nudge is in flight.
    pending_par: Option<f64>,
}

impl OutputResize {
    fn start(&mut self, client: &Mpv) {
        let (Ok(w), Ok(h)) = (
            client.get_property::<i64>("video-params/w"),
            client.get_property::<i64>("video-params/h"),
        ) else {
            return;
        };
        if w <= 0 || h <= 0 {
            return;
        }
        // While a nudge is in flight, the params may show the nudged value
        // or the stream's own. Keep the base from before it.
        if self.pending_par.is_none() {
            match client.get_property::<f64>("video-params/par") {
                Ok(par) if par > 0.0 => self.base_par = par,
                _ => return,
            }
        }
        self.step = self.step % 50 + 1;
        let par = self.base_par * (1.0 + NUDGE * f64::from(self.step));
        // The override is a display aspect. mpv works the pixel aspect back
        // out from the frame size.
        let aspect = par * w as f64 / h as f64;
        match client.set_property("video-aspect-override", aspect) {
            Ok(()) => self.pending_par = Some(par),
            Err(e) => tracing::warn!("[MPV ios] resize nudge failed: {e}"),
        }
    }

    /// Drops the override once the nudged frame is on screen. A reconfigure
    /// for anything else leaves it, since the nudged frame is still coming.
    fn on_reconfig(&mut self, client: &Mpv) {
        let Some(pending) = self.pending_par else {
            return;
        };
        let Ok(par) = client.get_property::<f64>("video-out-params/par") else {
            return;
        };
        if (par / pending - 1.0).abs() > NUDGE / 2.0 {
            return;
        }
        self.pending_par = None;
        if let Err(e) = client.set_property("video-aspect-override", "no") {
            tracing::warn!("[MPV ios] clearing the resize nudge failed: {e}");
        }
    }
}
