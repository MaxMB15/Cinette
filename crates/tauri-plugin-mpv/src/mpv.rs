// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Thread-safe MPV plugin state.
//! Owns MpvEngine + the platform renderer, coordinates load/fallback.

pub use crate::engine::PlayerState;
use crate::engine::MpvEngine;
use crate::idle_inhibit::IdleInhibitor;
use crate::renderer::PlatformRenderer;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[cfg(target_os = "macos")]
use crate::macos::{embedded_options, fallback_options, MacosGlRenderer};

#[cfg(target_os = "linux")]
use crate::linux::{embedded_options as linux_embedded_options, fallback_options as linux_fallback_options, LinuxGlRenderer};

#[cfg(target_os = "ios")]
use crate::ios::{embedded_options as ios_embedded_options, IosMetalRenderer};

pub struct MpvState {
    inner: Mutex<MpvEngine>,
    renderer: Mutex<Option<Box<dyn PlatformRenderer>>>,
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
}

impl MpvState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MpvEngine::new()),
            renderer: Mutex::new(None),
            fallback_active: AtomicBool::new(false),
            hwdec_enabled: AtomicBool::new(true),
            idle_inhibitor: IdleInhibitor::new(),
            reconnect_kill: Mutex::new(None),
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
        let mut guard = self
            .reconnect_kill
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(flag) = guard.take() {
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
        // Trip the old reconnect monitor BEFORE we destroy the parent mpv,
        // so its client handle is dropped on the next loop iteration and the
        // old libmpv core is actually released (see field docstring).
        self.cancel_reconnect_monitor();
        // Take the old renderer OUT of the mutex before dropping it.
        // detach() calls Queue::main().exec_sync(), which blocks the background thread
        // until the main thread processes the closure. The main thread's on_window_event
        // resize handler also needs the renderer mutex — holding the mutex while calling
        // exec_sync causes a deadlock. Dropping outside the lock avoids this.
        let old_renderer = self.renderer.lock().map_err(|e| e.to_string())?.take();
        drop(old_renderer); // calls detach() with renderer mutex RELEASED
        self.inner.lock().map_err(|e| e.to_string())?.stop();
        self.idle_inhibitor.uninhibit();
        self.fallback_active.store(false, Ordering::Release);
        self.hwdec_enabled.store(hwdec, Ordering::Release);

        let result = self.load_impl(url, start_pos, app);
        if result.is_ok() {
            self.idle_inhibitor.inhibit();
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
        let mut slot = self
            .reconnect_kill
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *slot = Some(kill.clone());
        drop(slot);
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
            let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
            match engine.create(&self.options(embedded_options())) {
                Ok(mpv) => gl_renderer.attach(mpv),
                Err(e) => Err(e),
            }
        };

        if let Err(e) = attach_result {
            self.inner.lock().map_err(|e| e.to_string())?.stop();
            return self.launch_fallback(url, start_pos, app, &e);
        }

        {
            let mut renderer = self.renderer.lock().map_err(|e| e.to_string())?;
            *renderer = Some(Box::new(gl_renderer));
        }

        let event_client = {
            let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
            engine.loadfile(url, start_pos)?;
            engine.set_current_url(url);
            engine.create_event_client("reconnect-watcher").ok()
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
            let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
            match engine.create(&self.options(linux_embedded_options())) {
                Ok(mpv) => gl_renderer.attach(mpv),
                Err(e) => Err(e),
            }
        };

        if let Err(e) = attach_result {
            self.inner.lock().map_err(|e| e.to_string())?.stop();
            return self.launch_fallback(url, start_pos, app, &e);
        }

        {
            let mut renderer = self.renderer.lock().map_err(|e| e.to_string())?;
            *renderer = Some(Box::new(gl_renderer));
        }

        let event_client = {
            let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
            engine.configure_audio()?;
            engine.loadfile(url, start_pos)?;
            engine.set_current_url(url);
            engine.create_event_client("reconnect-watcher").ok()
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
            let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
            match engine.create(&options) {
                Ok(mpv) => metal_renderer.attach(mpv),
                Err(e) => Err(e),
            }
        };
        if let Err(e) = attach_result {
            drop(metal_renderer);
            self.inner.lock().map_err(|e| e.to_string())?.stop();
            return Err(e);
        }

        {
            let mut renderer = self.renderer.lock().map_err(|e| e.to_string())?;
            *renderer = Some(Box::new(metal_renderer));
        }

        let event_client = {
            let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
            engine.loadfile(url, start_pos)?;
            engine.set_current_url(url);
            engine.create_event_client("reconnect-watcher").ok()
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
            let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
            engine.create(&[])?;
            engine.loadfile(url, start_pos)?;
            engine.set_current_url(url);
            engine.create_event_client("reconnect-watcher").ok()
        };
        self.spawn_reconnect_monitor(event_client, url, app);
        Ok(())
    }

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
        self.fallback_active.store(true, Ordering::Release);
        let _ = app.emit("mpv://render-fallback", serde_json::json!({ "reason": reason }));

        let client = self.launch_fallback_impl(url, start_pos, reason)?;
        self.spawn_reconnect_monitor(client, url, app);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn launch_fallback_impl(
        &self,
        url: &str,
        start_pos: Option<f64>,
        _reason: &str,
    ) -> Result<Option<libmpv2::Mpv>, String> {
        let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
        engine.create(&self.options(fallback_options()))?;
        engine.loadfile(url, start_pos)?;
        engine.set_current_url(url);
        Ok(engine.create_event_client("reconnect-watcher").ok())
    }

    #[cfg(target_os = "linux")]
    fn launch_fallback_impl(
        &self,
        url: &str,
        start_pos: Option<f64>,
        _reason: &str,
    ) -> Result<Option<libmpv2::Mpv>, String> {
        let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
        engine.create(&self.options(linux_fallback_options()))?;
        engine.configure_audio()?;
        engine.loadfile(url, start_pos)?;
        engine.set_current_url(url);
        Ok(engine.create_event_client("reconnect-watcher").ok())
    }

    #[cfg(target_os = "ios")]
    fn launch_fallback_impl(
        &self,
        _url: &str,
        _start_pos: Option<f64>,
        reason: &str,
    ) -> Result<Option<libmpv2::Mpv>, String> {
        Err(format!("video output failed: {reason}"))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios")))]
    fn launch_fallback_impl(
        &self,
        url: &str,
        start_pos: Option<f64>,
        _reason: &str,
    ) -> Result<Option<libmpv2::Mpv>, String> {
        let mut engine = self.inner.lock().map_err(|e| e.to_string())?;
        engine.create(&[])?;
        engine.loadfile(url, start_pos)?;
        engine.set_current_url(url);
        Ok(engine.create_event_client("reconnect-watcher").ok())
    }

    /// Reposition the video surface to a CSS-pixel rect reported by the frontend.
    pub fn set_visible(&self, visible: bool) {
        if let Ok(mut renderer) = self.renderer.lock() {
            if let Some(ref mut r) = *renderer {
                r.set_visible(visible);
            }
        }
    }

    pub fn set_bounds(&self, x: f64, y: f64, w: f64, h: f64) {
        if let Ok(mut renderer) = self.renderer.lock() {
            if let Some(ref mut r) = *renderer {
                r.set_frame(x, y, w, h);
            }
        }
    }

    /// Forward a window resize to the active renderer (e.g. from Tauri WindowEvent::Resized).
    pub fn resize(&self, width: u32, height: u32) {
        if let Ok(mut renderer) = self.renderer.lock() {
            if let Some(ref mut r) = *renderer {
                r.resize(width, height);
            }
        }
    }

    pub fn play(&self) -> Result<(), String> {
        let result = self.inner.lock().map_err(|e| e.to_string())?.play();
        if result.is_ok() {
            self.idle_inhibitor.inhibit();
        }
        result
    }

    pub fn pause(&self) -> Result<(), String> {
        let result = self.inner.lock().map_err(|e| e.to_string())?.pause();
        if result.is_ok() {
            self.idle_inhibitor.uninhibit();
        }
        result
    }

    pub fn stop(&self) {
        // Same ordering rule as `load()`: cancel the monitor BEFORE the
        // engine drops the parent `Mpv`, otherwise the watcher's client
        // keeps the libmpv core alive (hardware decoder + audio device).
        // `cancel_reconnect_monitor` itself is poison-tolerant.
        self.cancel_reconnect_monitor();
        let old_renderer = match self.renderer.lock() {
            Ok(mut r) => r.take(),
            Err(p) => p.into_inner().take(),
        };
        drop(old_renderer); // detach() runs synchronously on GLib main thread
        match self.inner.lock() {
            Ok(mut e) => e.stop(),
            Err(p) => p.into_inner().stop(),
        }
        self.idle_inhibitor.uninhibit();
        #[cfg(target_os = "ios")]
        crate::ios::set_audio_active(false);
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        self.inner.lock().map_err(|e| e.to_string())?.seek(position)
    }

    /// Seek forward (positive) or back (negative) by `offset` seconds.
    pub fn seek_relative(&self, offset: f64) -> Result<(), String> {
        self.inner.lock().map_err(|e| e.to_string())?.seek_relative(offset)
    }

    /// Turn video output off or back on while audio keeps playing. iOS
    /// uses this when the app goes to the background.
    pub fn set_video_enabled(&self, enabled: bool) {
        let result = match self.inner.lock() {
            Ok(engine) => engine.set_video_enabled(enabled),
            Err(e) => Err(e.to_string()),
        };
        if let Err(e) = result {
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

    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        self.inner.lock().map_err(|e| e.to_string())?.set_volume(volume)
    }

    pub fn sub_add(&self, path: &str) -> Result<(), String> {
        self.inner.lock().map_err(|e| e.to_string())?.sub_add(path)
    }

    pub fn sub_remove(&self, id: i64) -> Result<(), String> {
        self.inner.lock().map_err(|e| e.to_string())?.sub_remove(id)
    }

    pub fn set_sub_pos(&self, pos: f64) -> Result<(), String> {
        self.inner.lock().map_err(|e| e.to_string())?.set_sub_pos(pos)
    }

    pub fn set_sub_delay(&self, delay: f64) -> Result<(), String> {
        self.inner.lock().map_err(|e| e.to_string())?.set_sub_delay(delay)
    }

    pub fn get_state(&self) -> PlayerState {
        self.inner.lock().unwrap().get_state()
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
}
