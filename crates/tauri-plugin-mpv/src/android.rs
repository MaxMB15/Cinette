// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Android video: mpv draws into the `Surface` of a `SurfaceView` that sits
//! below the transparent web view.
//!
//! The Kotlin half of the plugin (`android/src/main/java/MpvPlugin.kt`) adds
//! the view and reports its surface through `MpvNative.surfaceChanged`. mpv
//! gets the surface as `wid`, a JNI global reference, and runs its own draw
//! loop with `gpu-context=android`, so there's no render context to drive.
//!
//! Android destroys the surface whenever the view hides or the app goes to
//! the background. The callback then sets `vo=null` and `wid=0` before it
//! returns, as mpv-android does, because mpv must stop drawing before the
//! surface goes. When a surface comes back, mpv gets it and `vo=gpu` again.
//! The callback only takes [`SURFACE`]'s lock and talks to mpv through a
//! client handle of its own, never `MpvState`'s locks, since a load can hold
//! those while it waits for the UI thread.

use crate::lock::lock_or_recover;
use crate::renderer::PlatformRenderer;
use jni::objects::{Global, JObject};
use libmpv2::events::{Event, PropertyData};
use libmpv2::{Format, Mpv};
use std::ffi::{c_int, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

unsafe extern "C" {
    /// From libavcodec. MediaCodec and AudioTrack call into the JVM through
    /// the VM this sets.
    fn av_jni_set_java_vm(vm: *mut c_void, log_ctx: *mut c_void) -> c_int;
}

/// The folder and family of the font mpv draws subtitles and messages with.
/// Set once in [`install`].
static FONT: OnceLock<(String, &'static str)> = OnceLock::new();

/// System fonts to copy for mpv, with their family names, best first. Every
/// Android version the app runs on has at least one of them.
const SYSTEM_FONTS: [(&str, &str); 3] = [
    ("/system/fonts/Roboto-Regular.ttf", "Roboto"),
    ("/system/fonts/NotoSans-Regular.ttf", "Noto Sans"),
    ("/system/fonts/DroidSans.ttf", "Droid Sans"),
];

/// libass on Android has no system font provider, so mpv would draw
/// subtitles without any font. It reads every file in `sub-fonts-dir` when
/// it starts, and `/system/fonts` holds hundreds of megabytes, so one font
/// is copied into a folder of its own instead.
fn prepare_font(dir: &std::path::Path) -> Result<(String, &'static str), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    for (path, family) in SYSTEM_FONTS {
        let source = std::path::Path::new(path);
        let Some(name) = source.file_name() else {
            continue;
        };
        let target = dir.join(name);
        if target.exists() || std::fs::copy(source, &target).is_ok() {
            return Ok((dir.to_string_lossy().into_owned(), family));
        }
    }
    Err("no system font to copy".into())
}

/// mpv options for the surface. The caller adds `wid`, which changes with
/// every surface.
pub fn embedded_options() -> Vec<(&'static str, &'static str)> {
    let mut options = vec![
        ("vo", "gpu"),
        ("gpu-context", "android"),
        ("opengl-es", "yes"),
        ("hwdec", "mediacodec"),
        ("hwdec-codecs", "all"),
        ("ao", "audiotrack,opensles"),
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
        // No `ytdl` or `osc`: libmpv is built for Android without Lua.
    ];
    if let Some((dir, family)) = FONT.get() {
        options.extend([
            ("sub-fonts-dir", dir.as_str()),
            ("osd-fonts-dir", dir.as_str()),
            ("sub-font", *family),
            ("osd-font", *family),
        ]);
    }
    options
}

/// Runs a command of the Kotlin plugin. Set once in [`install`].
type RunCommand = Box<dyn Fn(&'static str, serde_json::Value) + Send + Sync>;
static RUN_COMMAND: OnceLock<RunCommand> = OnceLock::new();

/// Hands libavcodec the JVM, copies a font for subtitles into `font_dir`
/// and keeps the plugin's handle for the view commands. Called once from
/// plugin setup, before any mpv instance.
pub fn install(run_command: RunCommand, font_dir: Option<std::path::PathBuf>) {
    match font_dir.as_deref().map(prepare_font) {
        Some(Ok(font)) => {
            let _ = FONT.set(font);
        }
        Some(Err(e)) => tracing::warn!("[MPV android] subtitles have no font: {e}"),
        None => tracing::warn!("[MPV android] subtitles have no font: no cache folder"),
    }
    let vm = ndk_context::android_context().vm();
    // SAFETY: tao sets the pointer from the running JVM, which lives as long
    // as the process. libavcodec only stores it.
    let result = unsafe { av_jni_set_java_vm(vm, std::ptr::null_mut()) };
    if result < 0 {
        tracing::warn!("[MPV android] av_jni_set_java_vm failed: {result}");
    }
    let _ = RUN_COMMAND.set(run_command);
}

fn run_command(command: &'static str, payload: serde_json::Value) {
    match RUN_COMMAND.get() {
        Some(run) => run(command, payload),
        None => tracing::warn!("[MPV android] {command} before the plugin was set up"),
    }
}

/// Keeps the screen on, and a TV's screensaver off, while a stream plays.
pub fn set_keep_screen_on(on: bool) {
    run_command("setKeepScreenOn", serde_json::json!({ "on": on }));
}

/// A JNI global reference to an `android.view.Surface`. mpv reads `wid` as
/// this reference, so it must outlive every mpv instance that has it.
struct SurfaceRef {
    surface: Global<JObject<'static>>,
}

impl SurfaceRef {
    /// The value for mpv's `wid`: the global reference as an integer.
    fn wid(&self) -> i64 {
        self.surface.as_obj().as_raw() as i64
    }
}

/// The current surface and the client handle the surface callback uses.
struct SurfaceState {
    surface: Option<Arc<SurfaceRef>>,
    /// "WIDTHxHEIGHT" in pixels, for mpv's `android-surface-size`.
    size: Option<String>,
    /// A client of the playing mpv core. `None` while nothing plays.
    client: Option<Mpv>,
}

static SURFACE: Mutex<SurfaceState> = Mutex::new(SurfaceState {
    surface: None,
    size: None,
    client: None,
});

/// Signalled whenever [`SURFACE`] gets a new surface.
static SURFACE_READY: Condvar = Condvar::new();

/// How long a load waits for a hidden view to get its surface back.
const SURFACE_WAIT: Duration = Duration::from_secs(2);

/// Points `client`'s mpv at the current surface, or turns video output off
/// when there's none. Each failure only costs the picture, so it's logged.
fn apply_surface(client: &Mpv, state: &SurfaceState) {
    let result = match &state.surface {
        Some(surface) => {
            if let Some(size) = &state.size {
                let _ = client.set_property("android-surface-size", size.as_str());
            }
            client
                .set_property("wid", surface.wid())
                .and_then(|()| client.set_property("vo", "gpu"))
        }
        None => client
            .set_property("vo", "null")
            .and_then(|()| client.set_property("wid", 0i64)),
    };
    if let Err(e) = result {
        tracing::warn!("[MPV android] switching the video surface failed: {e}");
    }
}

/// Called on the UI thread from `surfaceCreated`, `surfaceChanged` and,
/// with no surface, `surfaceDestroyed`. mpv lets go of an old surface
/// before this returns.
fn surface_changed(surface: Option<Global<JObject<'static>>>, width: i32, height: i32) {
    let mut state = lock_or_recover(&SURFACE);
    let same = match (&state.surface, &surface) {
        (Some(old), Some(new)) => old.wid() == new.as_obj().as_raw() as i64,
        _ => false,
    };
    state.size = surface.as_ref().map(|_| format!("{width}x{height}"));
    if same {
        // Only the size changed.
        if let (Some(client), Some(size)) = (&state.client, &state.size) {
            let _ = client.set_property("android-surface-size", size.as_str());
        }
        return;
    }
    let old = state.surface.take();
    state.surface = surface.map(|surface| Arc::new(SurfaceRef { surface }));
    if let Some(client) = &state.client {
        apply_surface(client, &state);
    }
    if state.surface.is_some() {
        SURFACE_READY.notify_all();
    }
    // mpv has the new surface, or none, so the old reference can go.
    drop(old);
}

/// `MpvNative.surfaceChanged(Surface?, int, int)` in the Kotlin plugin.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_cinette_mpv_MpvNative_surfaceChanged<'local>(
    mut env: jni::EnvUnowned<'local>,
    _class: jni::objects::JClass<'local>,
    surface: JObject<'local>,
    width: jni::sys::jint,
    height: jni::sys::jint,
) {
    let global = env
        .with_env(|env| -> jni::errors::Result<_> {
            if surface.is_null() {
                Ok(None)
            } else {
                Ok(Some(env.new_global_ref(&surface)?))
            }
        })
        .resolve::<jni::errors::LogErrorAndDefault>();
    // A surface that couldn't be referenced counts as none, so mpv never
    // draws into one it can't keep.
    surface_changed(global, width, height);
}

/// The surface below the web view. The view outlives this value: Kotlin
/// keeps it for the next stream and only hides it on detach.
pub struct AndroidSurfaceRenderer {
    /// Keeps the reference in `wid` alive while this mpv instance has it.
    surface: Arc<SurfaceRef>,
    /// In a mutex only so the renderer is `Sync`.
    first_frame_cb: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Stops the watcher thread, whose client handle keeps the mpv core
    /// alive. Tripped in `detach`, before the engine stops.
    watcher_kill: Option<Arc<AtomicBool>>,
    detached: bool,
}

impl AndroidSurfaceRenderer {
    /// Shows the view and takes its surface. A hidden view has none, and
    /// gets one on the UI thread after it shows, so this waits for it. It
    /// runs before a load takes any lock, so the UI thread is free to.
    pub fn new() -> Result<Self, String> {
        run_command("setVisible", serde_json::json!({ "visible": true }));
        let state = lock_or_recover(&SURFACE);
        let (state, _) = SURFACE_READY
            .wait_timeout_while(state, SURFACE_WAIT, |state| state.surface.is_none())
            .unwrap_or_else(|p| p.into_inner());
        let surface = state
            .surface
            .clone()
            .ok_or("the video surface isn't ready yet")?;
        drop(state);
        Ok(Self {
            surface,
            first_frame_cb: Mutex::new(None),
            watcher_kill: None,
            detached: false,
        })
    }

    /// The value for mpv's `wid` option.
    pub fn wid(&self) -> String {
        self.surface.wid().to_string()
    }
}

impl PlatformRenderer for AndroidSurfaceRenderer {
    /// mpv already has the surface through `wid`. This hands the surface
    /// callback a client, in case the surface changed since, and starts the
    /// thread that reports the first frame.
    fn attach(&mut self, mpv: &mut Mpv) -> Result<(), String> {
        // No name, for the reason `MpvEngine::create_event_client` gives.
        let surface_client = mpv
            .create_client(None)
            .map_err(|e| format!("mpv_create_client: {e}"))?;
        let watcher = mpv
            .create_client(None)
            .map_err(|e| format!("mpv_create_client: {e}"))?;
        {
            let mut state = lock_or_recover(&SURFACE);
            let current = state.surface.as_ref().map(|s| s.wid());
            if current != Some(self.surface.wid()) {
                apply_surface(&surface_client, &state);
            } else if let Some(size) = &state.size {
                let _ = surface_client.set_property("android-surface-size", size.as_str());
            }
            state.client = Some(surface_client);
        }
        let kill = Arc::new(AtomicBool::new(false));
        self.watcher_kill = Some(kill.clone());
        let first_frame = self
            .first_frame_cb
            .get_mut()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        std::thread::Builder::new()
            .name("mpv-android-watcher".into())
            .spawn(move || run_watcher(watcher, kill, first_frame))
            .map_err(|e| format!("spawn watcher: {e}"))?;
        Ok(())
    }

    /// The view follows `set_frame`, and the surface callback passes size
    /// changes to mpv, so a window resize needs nothing here.
    fn resize(&mut self, _width: u32, _height: u32) {}

    fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64) {
        run_command("setFrame", serde_json::json!({ "x": x, "y": y, "width": w, "height": h }));
    }

    fn set_visible(&mut self, visible: bool) {
        run_command("setVisible", serde_json::json!({ "visible": visible }));
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
        // Hiding the view destroys its surface, and the engine stops this
        // core only after the renderer goes, so mpv lets go of the surface
        // first. The client keeps the core alive, so it goes too.
        if let Some(client) = lock_or_recover(&SURFACE).client.take()
            && let Err(e) = client
                .set_property("vo", "null")
                .and_then(|()| client.set_property("wid", 0i64))
        {
            tracing::warn!("[MPV android] releasing the video surface failed: {e}");
        }
        run_command("setVisible", serde_json::json!({ "visible": false }));
    }
}

impl Drop for AndroidSurfaceRenderer {
    fn drop(&mut self) {
        self.detach();
    }
}

/// Waits for the first video frame and reports it.
fn run_watcher(client: Mpv, kill: Arc<AtomicBool>, mut first_frame: Option<Box<dyn FnOnce() + Send>>) {
    let _ = client.disable_deprecated_events();
    if let Err(e) = client.observe_property("vo-configured", Format::Flag, 1) {
        tracing::warn!("[MPV android] observe vo-configured failed: {e}");
        return;
    }
    while first_frame.is_some() && !kill.load(Ordering::Acquire) {
        match client.wait_event(0.5) {
            Some(Ok(Event::Shutdown)) => break,
            Some(Ok(Event::PropertyChange {
                name: "vo-configured",
                change: PropertyData::Flag(true),
                ..
            })) => {
                if let Some(cb) = first_frame.take() {
                    cb();
                }
            }
            _ => {}
        }
    }
}
