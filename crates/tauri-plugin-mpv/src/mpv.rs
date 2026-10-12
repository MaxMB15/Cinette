// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Thread-safe MPV plugin state.
//! Owns MpvEngine + the platform renderer, coordinates load/fallback.

pub use crate::engine::PlayerState;
use crate::engine::MpvEngine;
use crate::idle_inhibit::IdleInhibitor;
use crate::lock::lock_or_recover;
use crate::renderer::PlatformRenderer;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[cfg(target_os = "macos")]
use crate::macos::{embedded_options, fallback_options, MacosGlRenderer};

#[cfg(target_os = "linux")]
use crate::linux::{
    embedded_options as linux_embedded_options, fallback_options as linux_fallback_options,
    mpv_uses_wayland, LinuxGlRenderer,
};

#[cfg(target_os = "ios")]
use crate::ios::{embedded_options as ios_embedded_options, IosMetalRenderer};

pub struct MpvState {
    inner: Mutex<MpvEngine>,
    renderer: Mutex<Option<Box<dyn PlatformRenderer>>>,
    /// Where the frontend last put the video, in CSS pixels, as x, y, width
    /// and height. Each load makes a new renderer, but the frontend reports
    /// the player area only when the player mounts, when the stream URL
    /// changes and when the player changes size, so a new renderer starts
    /// here. Locked only while `renderer` is held.
    bounds: Mutex<Option<[f64; 4]>>,
    fallback_active: AtomicBool,
    /// Whether the next mpv instance may use hardware decoding. Set from the
    /// Settings toggle on every `load()`; mpv is recreated per load, so a
    /// change applies to the next stream.
    hwdec_enabled: AtomicBool,
    idle_inhibitor: IdleInhibitor,
    /// Kill flag for the in-flight reconnect monitor thread, if any.
    ///
    /// The watcher created by `crate::reconnect::spawn` owns a libmpv client
    /// handle (`mpv_create_client`). Per the libmpv docs, that handle holds
    /// a STRONG reference to the player core — so even after we drop our
    /// `Mpv` instance, the core stays alive until the client is dropped.
    /// On macOS that leaks the hardware decoder + audio device, causing
    /// `Error while decoding frame (hardware decoding)!` on the next load.
    ///
    /// We trip this flag BEFORE destroying the parent `Mpv` so the watcher
    /// exits the next time it wakes from `wait_event`, dropping its client
    /// and releasing the core.
    reconnect_kill: Mutex<Option<Arc<AtomicBool>>>,
    /// Held through each whole `load()` and `stop()`. Both are async
    /// commands, so without it they can run at once, and a stop could stop
    /// the engine that a newer load had just created. Nothing on the main
    /// thread takes it, so they can still wait on the main thread while
    /// holding it.
    transition: Mutex<()>,
}

impl MpvState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MpvEngine::new()),
            renderer: Mutex::new(None),
            bounds: Mutex::new(None),
            fallback_active: AtomicBool::new(false),
            hwdec_enabled: AtomicBool::new(true),
            idle_inhibitor: IdleInhibitor::new(),
            reconnect_kill: Mutex::new(None),
            transition: Mutex::new(()),
        }
    }

    /// Trip the current reconnect monitor's kill flag (if one exists) so it
    /// exits on the next event-loop iteration. Must be called BEFORE the
    /// parent `Mpv` is dropped — see the field docstring.
    ///
    /// We recover from a poisoned mutex by taking the inner guard. This entire
    /// teardown path exists specifically to prevent the libmpv-core /
    /// hardware-decoder leak on macOS; silently bailing on a poisoned lock
    /// would re-introduce exactly the bug it's here to prevent.
    fn cancel_reconnect_monitor(&self) {
        if let Some(flag) = lock_or_recover(&self.reconnect_kill).take() {
            flag.store(true, Ordering::Release);
        }
    }

    pub fn load<R: tauri::Runtime>(
        &self,
        url: &str,
        start_pos: Option<f64>,
        hwdec: bool,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let _transition = lock_or_recover(&self.transition);
        // Trip the old reconnect monitor BEFORE we destroy the parent mpv,
        // so its client handle is dropped on the next loop iteration and the
        // old libmpv core is actually released (see field docstring).
        self.cancel_reconnect_monitor();
        // Take the old renderer OUT of the mutex before dropping it.
        // detach() calls Queue::main().exec_sync(), which blocks the background thread
        // until the main thread processes the closure. The main thread's on_window_event
        // resize handler also needs the renderer mutex — holding the mutex while calling
        // exec_sync causes a deadlock. Dropping outside the lock avoids this.
        let old_renderer = lock_or_recover(&self.renderer).take();
        drop(old_renderer); // calls detach() with renderer mutex RELEASED
        lock_or_recover(&self.inner).stop();
        self.idle_inhibitor.uninhibit();
        self.fallback_active.store(false, Ordering::Release);
        self.hwdec_enabled.store(hwdec, Ordering::Release);

        let result = self.load_impl(url, start_pos, app);
        if result.is_ok() {
            self.idle_inhibitor.inhibit();
        } else {
            // A load can fail after the renderer is attached, such as when
            // mpv rejects the file. Tear down what it set up, in the same
            // order as stop(), so no empty video surface or core is left.
            let renderer = lock_or_recover(&self.renderer).take();
            drop(renderer);
            lock_or_recover(&self.inner).stop();
        }
        // The old stream stopped above, so a failed load leaves nothing
        // playing. Turning the session off also clears its Now Playing info.
        #[cfg(target_os = "ios")]
        crate::ios::set_audio_active(result.is_ok());
        result
    }

    /// The platform's mpv options, with hardware decoding turned off if the
    /// user disabled it.
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios"))]
    fn options(
        &self,
        base: Vec<(&'static str, &'static str)>,
    ) -> Vec<(&'static str, &'static str)> {
        with_hwdec(base, self.hwdec_enabled.load(Ordering::Acquire))
    }

    /// Makes `renderer` the active one and moves its surface to where the
    /// frontend last put the video. Without this, reloading the same stream
    /// leaves the new surface at its starting frame. That's the whole window
    /// on macOS, and a single pixel on Linux, where the video doesn't show.
    ///
    /// The bounds are read with the renderer locked, so a `set_bounds` that
    /// runs after the old renderer is taken out and before this one is
    /// installed still reaches it.
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios"))]
    fn install_renderer(&self, mut renderer: Box<dyn PlatformRenderer>) {
        let replaced = {
            let mut active = lock_or_recover(&self.renderer);
            let bounds = *lock_or_recover(&self.bounds);
            if let Some([x, y, w, h]) = bounds {
                renderer.set_frame(x, y, w, h);
            }
            active.replace(renderer)
        };
        // `load()` takes the old renderer out first, so this is only a
        // safeguard. Its detach waits on the main thread, which can be
        // waiting on the renderer lock in `resize()`, so it's dropped after
        // the lock is released.
        drop(replaced);
    }

    /// Helper: spawn the auto-reconnect monitor for the currently loaded URL.
    /// `client` may be `None` if the engine failed to create one — we just log
    /// and continue without auto-recovery in that case rather than failing the
    /// load.
    ///
    /// Allocates a fresh `Arc<AtomicBool>` kill flag, stores it on the state,
    /// and passes a clone to the watcher. Any pre-existing flag should already
    /// have been tripped by `cancel_reconnect_monitor()` before this point;
    /// we overwrite the slot here so the new monitor "owns" cancellation.
    fn spawn_reconnect_monitor<R: tauri::Runtime>(
        &self,
        client: Option<libmpv2::Mpv>,
        url: &str,
        app: &tauri::AppHandle<R>,
    ) {
        let Some(c) = client else {
            tracing::warn!(
                "[MPV] auto-reconnect disabled for this stream — failed to create event client"
            );
            return;
        };
        let kill = Arc::new(AtomicBool::new(false));
        // Recover from a poisoned mutex by taking the inner guard. If we
        // failed to store the flag here, the next `cancel_reconnect_monitor`
        // would have nothing to trip and the watcher would keep its client
        // handle alive — leaking the libmpv core on the next load.
        *lock_or_recover(&self.reconnect_kill) = Some(kill.clone());
        crate::reconnect::spawn(c, url.to_string(), app.clone(), kill);
    }

    #[cfg(target_os = "macos")]
    fn load_impl<R: tauri::Runtime>(
        &self,
        url: &str,
        start_pos: Option<f64>,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        // Create the NSOpenGLView renderer (main-thread work happens inside new()).
        let mut gl_renderer = match MacosGlRenderer::new(app) {
            Ok(r) => r,
            Err(e) => return self.launch_fallback(url, start_pos, app, &e),
        };

        // Emit mpv://first-frame when the first video frame is rendered so the
        // frontend knows to make the WKWebView transparent.
        {
            use tauri::Emitter;
            let app_clone = app.clone();
            gl_renderer.set_first_frame_callback(Box::new(move || {
                let _ = app_clone.emit("mpv://first-frame", ());
            }));
        }

        // Create mpv with embedded options and attach the renderer.
        let attach_result = {
            let mut engine = lock_or_recover(&self.inner);
            match engine.create(&self.options(embedded_options())) {
                Ok(mpv) => gl_renderer.attach(mpv),
                Err(e) => Err(e),
            }
        };

        if let Err(e) = attach_result {
            lock_or_recover(&self.inner).stop();
            return self.launch_fallback(url, start_pos, app, &e);
        }

        self.install_renderer(Box::new(gl_renderer));

        let event_client = {
            let mut engine = lock_or_recover(&self.inner);
            engine.loadfile(url, start_pos)?;
            engine.set_current_url(url);
            engine.create_event_client().ok()
        };
        self.spawn_reconnect_monitor(event_client, url, app);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn load_impl<R: tauri::Runtime>(
        &self,
        url: &str,
        start_pos: Option<f64>,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let mut gl_renderer = match LinuxGlRenderer::new(app) {
            Ok(r) => r,
            Err(e) => return self.launch_fallback(url, start_pos, app, &e),
        };

        {
            use tauri::Emitter;
            let app_clone = app.clone();
            gl_renderer.set_first_frame_callback(Box::new(move || {
                let _ = app_clone.emit("mpv://first-frame", ());
            }));
        }

        let attach_result = {
            let mut engine = lock_or_recover(&self.inner);
            let options = linux_embedded_options(gl_renderer.software_gl());
            match engine.create(&self.options(options)) {
                Ok(mpv) => gl_renderer.attach(mpv),
                Err(e) => Err(e),
            }
        };

        if let Err(e) = attach_result {
            lock_or_recover(&self.inner).stop();
            return self.launch_fallback(url, start_pos, app, &e);
        }

        self.install_renderer(Box::new(gl_renderer));

        let event_client = {
            let mut engine = lock_or_recover(&self.inner);
            engine.configure_audio()?;
            engine.loadfile(url, start_pos)?;
            engine.set_current_url(url);
            engine.create_event_client().ok()
        };
        self.spawn_reconnect_monitor(event_client, url, app);
        Ok(())
    }

    /// iOS has one window, so there's no fallback. If the Metal view can't
    /// be set up, the load fails and the frontend shows the error.
    #[cfg(target_os = "ios")]
    fn load_impl<R: tauri::Runtime>(
        &self,
        url: &str,
        start_pos: Option<f64>,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        // Creating the view runs on the main thread, so it happens before
        // any lock is taken.
        let mut metal_renderer = IosMetalRenderer::new()?;

        {
            use tauri::Emitter;
            let app_clone = app.clone();
            metal_renderer.set_first_frame_callback(Box::new(move || {
                let _ = app_clone.emit("mpv://first-frame", ());
            }));
        }

        let wid = metal_renderer.wid();
        let mut options = vec![("wid", wid.as_str())];
        options.extend(self.options(ios_embedded_options()));

        let attach_result = {
            let mut engine = lock_or_recover(&self.inner);
            // Start without video if the app is in the background. This is
            // read with the engine locked, so the lifecycle job that turns
            // video back on can only run after mpv exists.
            if crate::ios::in_background() {
                options.push(("vid", "no"));
            }
            match engine.create(&options) {
                Ok(mpv) => metal_renderer.attach(mpv),
                Err(e) => Err(e),
            }
        };
        if let Err(e) = attach_result {
            drop(metal_renderer);
            lock_or_recover(&self.inner).stop();
            return Err(e);
        }

        self.install_renderer(Box::new(metal_renderer));

        let event_client = {
            let mut engine = lock_or_recover(&self.inner);
            engine.loadfile(url, start_pos)?;
            engine.set_current_url(url);
            engine.create_event_client().ok()
        };
        self.spawn_reconnect_monitor(event_client, url, app);
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios")))]
    fn load_impl<R: tauri::Runtime>(
        &self,
        url: &str,
        start_pos: Option<f64>,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let event_client = {
            let mut engine = lock_or_recover(&self.inner);
            engine.create(&[])?;
            engine.loadfile(url, start_pos)?;
            engine.set_current_url(url);
            engine.create_event_client().ok()
        };
        self.spawn_reconnect_monitor(event_client, url, app);
        Ok(())
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn launch_fallback<R: tauri::Runtime>(
        &self,
        url: &str,
        start_pos: Option<f64>,
        app: &tauri::AppHandle<R>,
        reason: &str,
    ) -> Result<(), String> {
        use tauri::Emitter;
        tracing::warn!(
            "[MPV] embedded renderer failed ({}), launching fallback window",
            reason
        );
        let client = self.launch_fallback_impl(url, start_pos)?;
        // Only tell the frontend once the window is up. If it fails, load()
        // tears everything down and the player shows the error instead.
        self.fallback_active.store(true, Ordering::Release);
        let _ = app.emit("mpv://render-fallback", serde_json::json!({ "reason": reason }));
        self.spawn_reconnect_monitor(client, url, app);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn launch_fallback_impl(
        &self,
        url: &str,
        start_pos: Option<f64>,
    ) -> Result<Option<libmpv2::Mpv>, String> {
        let mut engine = lock_or_recover(&self.inner);
        engine.create(&self.options(fallback_options()))?;
        engine.loadfile(url, start_pos)?;
        engine.set_current_url(url);
        Ok(engine.create_event_client().ok())
    }

    #[cfg(target_os = "linux")]
    fn launch_fallback_impl(
        &self,
        url: &str,
        start_pos: Option<f64>,
    ) -> Result<Option<libmpv2::Mpv>, String> {
        let mut engine = lock_or_recover(&self.inner);
        engine.create(&self.options(linux_fallback_options(mpv_uses_wayland())))?;
        engine.configure_audio()?;
        engine.loadfile(url, start_pos)?;
        engine.set_current_url(url);
        Ok(engine.create_event_client().ok())
    }

    /// Shows or hides the video surface without stopping playback.
    pub fn set_visible(&self, visible: bool) {
        if let Some(r) = lock_or_recover(&self.renderer).as_mut() {
            r.set_visible(visible);
        }
    }

    /// Moves the video surface to a rect in CSS pixels reported by the
    /// frontend, and keeps it for the renderer the next load makes.
    pub fn set_bounds(&self, x: f64, y: f64, w: f64, h: f64) {
        // Stored and applied under one renderer lock, so two reports can't
        // leave the stored bounds different from where the renderer is.
        let mut active = lock_or_recover(&self.renderer);
        *lock_or_recover(&self.bounds) = Some([x, y, w, h]);
        if let Some(r) = active.as_mut() {
            r.set_frame(x, y, w, h);
        }
    }

    /// Forward a window resize to the active renderer (e.g. from Tauri WindowEvent::Resized).
    pub fn resize(&self, width: u32, height: u32) {
        if let Some(r) = lock_or_recover(&self.renderer).as_mut() {
            r.resize(width, height);
        }
    }

    pub fn play(&self) -> Result<(), String> {
        let result = lock_or_recover(&self.inner).play();
        if result.is_ok() {
            self.idle_inhibitor.inhibit();
        }
        result
    }

    pub fn pause(&self) -> Result<(), String> {
        let result = lock_or_recover(&self.inner).pause();
        if result.is_ok() {
            self.idle_inhibitor.uninhibit();
        }
        result
    }

    pub fn stop(&self) {
        let _transition = lock_or_recover(&self.transition);
        // Same ordering rule as `load()`: cancel the monitor BEFORE the
        // engine drops the parent `Mpv`, otherwise the watcher's client
        // keeps the libmpv core alive (hardware decoder + audio device).
        // `cancel_reconnect_monitor` itself is poison-tolerant.
        self.cancel_reconnect_monitor();
        let old_renderer = lock_or_recover(&self.renderer).take();
        drop(old_renderer); // detach() runs synchronously on GLib main thread
        lock_or_recover(&self.inner).stop();
        self.idle_inhibitor.uninhibit();
        #[cfg(target_os = "ios")]
        crate::ios::set_audio_active(false);
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        lock_or_recover(&self.inner).seek(position)
    }

    /// Seek forward (positive) or back (negative) by `offset` seconds.
    pub fn seek_relative(&self, offset: f64) -> Result<(), String> {
        lock_or_recover(&self.inner).seek_relative(offset)
    }

    /// Turn video output off or back on while audio keeps playing. iOS
    /// uses this when the app goes to the background.
    pub fn set_video_enabled(&self, enabled: bool) {
        if let Err(e) = lock_or_recover(&self.inner).set_video_enabled(enabled) {
            tracing::debug!("[MPV] set_video_enabled({enabled}): {e}");
        }
    }

    /// The channel name and live flag for the lock screen. Only iOS shows
    /// them.
    pub fn set_media_info(&self, title: Option<String>, live: bool) {
        #[cfg(target_os = "ios")]
        crate::ios::set_media_info(title, live);
        #[cfg(not(target_os = "ios"))]
        let _ = (title, live);
    }

    /// How many seconds the lock screen's skip buttons jump back and
    /// forward. Only iOS has them.
    pub fn set_skip_intervals(&self, back: f64, forward: f64) {
        #[cfg(target_os = "ios")]
        crate::ios::set_skip_intervals(back, forward);
        #[cfg(not(target_os = "ios"))]
        let _ = (back, forward);
    }

    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        lock_or_recover(&self.inner).set_volume(volume)
    }

    pub fn sub_add(&self, path: &str) -> Result<(), String> {
        lock_or_recover(&self.inner).sub_add(path)
    }

    pub fn sub_remove(&self, id: i64) -> Result<(), String> {
        lock_or_recover(&self.inner).sub_remove(id)
    }

    pub fn set_sub_pos(&self, pos: f64) -> Result<(), String> {
        lock_or_recover(&self.inner).set_sub_pos(pos)
    }

    pub fn set_sub_delay(&self, delay: f64) -> Result<(), String> {
        lock_or_recover(&self.inner).set_sub_delay(delay)
    }

    pub fn get_state(&self) -> PlayerState {
        lock_or_recover(&self.inner).get_state()
    }
}

/// Replace the `hwdec` option with `no` when hardware decoding is disabled.
/// Other options pass through unchanged.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux", target_os = "ios")),
    allow(dead_code)
)]
fn with_hwdec(
    mut options: Vec<(&'static str, &'static str)>,
    enabled: bool,
) -> Vec<(&'static str, &'static str)> {
    if !enabled {
        for (key, value) in options.iter_mut() {
            if *key == "hwdec" {
                *value = "no";
            }
        }
    }
    options
}

#[cfg(test)]
mod tests {
    use super::with_hwdec;

    const OPTIONS: [(&str, &str); 3] =
        [("vo", "libmpv"), ("hwdec", "videotoolbox"), ("cache", "yes")];

    #[test]
    fn keeps_platform_hwdec_when_enabled() {
        assert_eq!(with_hwdec(OPTIONS.to_vec(), true), OPTIONS.to_vec());
    }

    #[test]
    fn turns_hwdec_off_when_disabled() {
        assert_eq!(
            with_hwdec(OPTIONS.to_vec(), false),
            vec![("vo", "libmpv"), ("hwdec", "no"), ("cache", "yes")]
        );
    }

    #[test]
    fn leaves_options_without_hwdec_alone() {
        let opts = vec![("vo", "gpu")];
        assert_eq!(with_hwdec(opts.clone(), false), opts);
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios"))]
    mod bounds {
        use crate::mpv::MpvState;
        use crate::renderer::PlatformRenderer;
        use libmpv2::Mpv;
        use std::sync::{Arc, Mutex};

        type Frames = Arc<Mutex<Vec<[f64; 4]>>>;

        /// A renderer that only records where it was put.
        struct FakeRenderer(Frames);

        impl PlatformRenderer for FakeRenderer {
            fn attach(&mut self, _mpv: &mut Mpv) -> Result<(), String> {
                Ok(())
            }
            fn resize(&mut self, _width: u32, _height: u32) {}
            fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64) {
                self.0.lock().unwrap().push([x, y, w, h]);
            }
            fn set_visible(&mut self, _visible: bool) {}
            fn set_first_frame_callback(&mut self, _cb: Box<dyn FnOnce() + Send>) {}
            fn detach(&mut self) {}
        }

        /// Installs a fake renderer and returns the frames it gets.
        fn install(state: &MpvState) -> Frames {
            let frames = Frames::default();
            state.install_renderer(Box::new(FakeRenderer(frames.clone())));
            frames
        }

        #[test]
        fn starts_a_new_renderer_at_the_last_bounds() {
            let state = MpvState::new();
            state.set_bounds(0.0, 0.0, 800.0, 600.0);
            state.set_bounds(240.0, 52.0, 960.0, 540.0);
            let frames = install(&state);
            assert_eq!(*frames.lock().unwrap(), [[240.0, 52.0, 960.0, 540.0]]);
        }

        #[test]
        fn keeps_the_bounds_for_the_renderer_after_this_one() {
            let state = MpvState::new();
            let first = install(&state);
            state.set_bounds(240.0, 52.0, 960.0, 540.0);
            assert_eq!(*first.lock().unwrap(), [[240.0, 52.0, 960.0, 540.0]]);

            // Retry stops the stream and loads it again, with no new report.
            state.stop();
            let second = install(&state);
            assert_eq!(*second.lock().unwrap(), [[240.0, 52.0, 960.0, 540.0]]);
        }

        #[test]
        fn keeps_bounds_reported_while_no_renderer_is_active() {
            let state = MpvState::new();
            install(&state);
            state.stop();
            state.set_bounds(0.0, 0.0, 1280.0, 720.0);
            let frames = install(&state);
            assert_eq!(*frames.lock().unwrap(), [[0.0, 0.0, 1280.0, 720.0]]);
        }

        #[test]
        fn leaves_a_new_renderer_alone_before_any_bounds() {
            let state = MpvState::new();
            let frames = install(&state);
            assert!(frames.lock().unwrap().is_empty());
        }
    }
}
