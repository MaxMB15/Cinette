// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Linux video embedding with a Wayland subsurface, EGL and an OpenGL render
//! context.
//!
//! The renderer puts a `wl_subsurface` and `wl_egl_window` under the Tauri
//! `wl_surface` and builds an OpenGL Core 3.2 EGL context on that window.
//! libmpv gets an OpenGL render context and nothing else. We don't pass the
//! `wl_display` through `MPV_RENDER_PARAM_WL_DISPLAY`, because mpv only uses
//! it to open a VA-API display for zero-copy decoding, and that call has
//! crashed inside libva on some Wayland compositors (#36). Decoding uses
//! copy mode instead, see [`LINUX_HWDEC`].
//!
//! Every EGL, GL and `wl_egl_window` call runs on the GLib main thread, which
//! owns the EGL context for the renderer's whole life. It is the Wayland
//! counterpart of the main thread rule on macOS.
//!
//! X11 sessions aren't embedded. They use the separate window fallback in
//! `MpvState`.

use crate::gl_render::GlRenderContext;
use crate::lock::lock_or_recover;
use crate::options::shared_options;
use crate::renderer::PlatformRenderer;
use khronos_egl as egl;
use libmpv2::{render::mpv_render_update, Mpv};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::{AppHandle, Manager, Runtime};

use wayland_client::{
    backend::{Backend, ObjectId},
    globals::{registry_queue_init, GlobalListContents},
    protocol::{
        wl_compositor::WlCompositor, wl_registry::WlRegistry, wl_subcompositor::WlSubcompositor,
        wl_subsurface::WlSubsurface, wl_surface::WlSurface,
    },
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
};
use wayland_egl::WlEglSurface;

/// The dynamically loaded `libEGL.so.1`, opened once per process.
///
/// It returns `Err` rather than panicking so `LinuxGlRenderer::new` can fall
/// back to the separate window.
fn egl() -> Result<&'static egl::DynamicInstance<egl::EGL1_4>, String> {
    static INSTANCE: OnceLock<Result<egl::DynamicInstance<egl::EGL1_4>, String>> = OnceLock::new();
    INSTANCE
        .get_or_init(|| {
            // SAFETY: `load_required` wraps `dlopen("libEGL.so.1")`. We rely on
            // one-time initialization via `OnceLock` and on the loaded library
            // remaining valid for the lifetime of the process.
            unsafe { egl::DynamicInstance::<egl::EGL1_4>::load_required() }
                .map_err(|e| format!("Failed to load libEGL: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Resolves a GL function pointer through the EGL loader.
///
/// Both the `gl` crate's `load_with` and libmpv's `get_proc_address` callback
/// use it. `gl_renderer_name` and `attach` call `gl::load_with` on the GLib
/// main thread, each while the EGL context is current.
fn gl_proc_address(name: &str) -> *mut c_void {
    match egl() {
        Ok(egl) => egl
            .get_proc_address(name)
            .map_or(std::ptr::null_mut(), |f| f as *mut c_void),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Event handler for the renderer's Wayland queue. The renderer only binds
/// globals through it and ignores every event.
struct WlGlobals;

impl Dispatch<WlRegistry, GlobalListContents> for WlGlobals {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: wayland_client::protocol::wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

wayland_client::delegate_noop!(WlGlobals: ignore WlCompositor);
wayland_client::delegate_noop!(WlGlobals: ignore WlSubcompositor);
wayland_client::delegate_noop!(WlGlobals: ignore WlSurface);
wayland_client::delegate_noop!(WlGlobals: ignore WlSubsurface);

/// Owns the EGL context.
///
/// `attach` takes the first surface and moves it into `SessionState`, which
/// replaces it on resize. Drop leaves the display alone because GTK and
/// WebKit share it on Wayland.
struct OwnedEgl {
    display: egl::Display,
    surface: Option<egl::Surface>,
    context: egl::Context,
    config: egl::Config,
    /// Whether the context draws on the CPU. See [`is_software_gl`].
    software_gl: bool,
}

impl Drop for OwnedEgl {
    fn drop(&mut self) {
        if let Ok(egl) = egl() {
            let _ = egl.make_current(self.display, None, None, None);
            if let Some(s) = self.surface {
                let _ = egl.destroy_surface(self.display, s);
            }
            let _ = egl.destroy_context(self.display, self.context);
        }
    }
}

// SAFETY: Opaque pointers into libEGL's process-wide state. All EGL calls
// are restricted to the GLib main thread.
unsafe impl Send for OwnedEgl {}
unsafe impl Sync for OwnedEgl {}

/// Owns the Wayland subsurface tree. `attach` takes the first
/// `WlEglSurface` and moves it into `SessionState`.
struct WaylandSession {
    wl_egl_surface: Option<WlEglSurface>,
    subsurface: WlSubsurface,
    child_surface: WlSurface,
    queue: Mutex<EventQueue<WlGlobals>>,
    conn: Connection,
}

impl Drop for WaylandSession {
    fn drop(&mut self) {
        drop(self.wl_egl_surface.take());
        self.subsurface.destroy();
        self.child_surface.commit();
        let _ = self.conn.flush();
    }
}

// SAFETY: Subsurface and surface protocol requests go through
// wayland-client's internally-locked Backend and are safe from any thread.
unsafe impl Send for WaylandSession {}
unsafe impl Sync for WaylandSession {}

/// Surface state that `set_frame`, `set_visible` and `render_frame` share
/// through `Inner::state`.
struct SessionState {
    egl_display: egl::Display,
    /// `None` after a resize failed to make a new surface. The next resize
    /// tries again.
    egl_surface: Option<egl::Surface>,
    wl_egl_surface: Option<WlEglSurface>,
    pending_resize: Option<(i32, i32)>,
    current_size: (i32, i32),
    /// Where the frontend last put the video, as x, y, width and height in
    /// the page. The width is 0 until it does.
    frame: (i32, i32, i32, i32),
    /// How far the page sits from the window surface's corner, for GTK's
    /// shadow and title bar.
    csd_offset: (i32, i32),
}

impl SessionState {
    /// Where the subsurface goes, relative to the window surface.
    fn position(&self) -> (i32, i32) {
        (
            self.frame.0 + self.csd_offset.0,
            self.frame.1 + self.csd_offset.1,
        )
    }
}

impl Drop for SessionState {
    fn drop(&mut self) {
        if let (Some(surface), Ok(egl)) = (self.egl_surface, egl()) {
            let _ = egl.destroy_surface(self.egl_display, surface);
        }
    }
}

// SAFETY: `egl::Display`, `egl::Surface`, and `WlEglSurface` are opaque
// handles only used on the GLib main thread via `render_frame`. The Mutex
// ensures exclusive access.
unsafe impl Send for SessionState {}

/// Looks up the main window's GTK window and the box that holds the page, or
/// None when the window is gone. Only call it on the GLib main thread.
type FindWindow = Box<dyn FnOnce() -> Option<(gtk::ApplicationWindow, gtk::Box)> + Send + Sync>;

/// The main window's `size-allocate` handler, which moves the video when
/// GTK's decorations change size.
struct DecorationWatch {
    window: gtk::glib::SendWeakRef<gtk::ApplicationWindow>,
    handler: gtk::glib::SignalHandlerId,
}

impl DecorationWatch {
    /// Starts following `window`'s decorations for `inner`. Only call it on
    /// the GLib main thread.
    fn start(window: &gtk::ApplicationWindow, vbox: &gtk::Box, inner: Weak<Inner>) -> Self {
        use gtk::prelude::*;

        let vbox = vbox.downgrade();
        let handler = window.connect_size_allocate(move |window, _| {
            let (Some(inner), Some(vbox)) = (inner.upgrade(), vbox.upgrade()) else {
                return;
            };
            if !inner.valid.load(Ordering::Acquire) {
                return;
            }
            if let Some(offset) = csd_offset(window, &vbox) {
                follow_decorations(&inner, offset);
            }
        });
        Self {
            window: window.downgrade().into(),
            handler,
        }
    }

    /// Disconnects the handler. Only call it on the GLib main thread.
    fn stop(self) {
        use gtk::prelude::*;

        if let Some(window) = self.window.upgrade() {
            window.disconnect(self.handler);
        }
    }
}

/// Everything one attached session owns. The renderer and the libmpv update
/// callback share it.
struct Inner {
    /// Taken and stopped by `detach`. None when the window couldn't be found.
    decorations: Mutex<Option<DecorationWatch>>,
    first_frame_cb: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    video_active: AtomicBool,
    valid: AtomicBool,
    /// Set once mpv has drawn a decoded frame. Only `render_frame` uses it.
    drew_frame: AtomicBool,
    // Keep this order, since fields drop top to bottom. The render context
    // frees mpv's GL resources, `state` destroys the EGL surface and
    // WlEglSurface, `egl` destroys the GL context and `wayland` tears down
    // the subsurface tree.
    render_ctx: GlRenderContext,
    state: Mutex<SessionState>,
    egl: OwnedEgl,
    wayland: WaylandSession,
}

// SAFETY: the render context and `OwnedEgl` are only used on the GLib main
// thread, by `render_frame` and by `detach`, which drops the session there.
// `DecorationWatch` holds GTK objects and is only started and stopped on that
// thread too. `WaylandSession` is Send and Sync on its own, so `set_frame`,
// `set_visible` and `detach` move the subsurface from any thread. The libmpv
// update callback runs on an arbitrary thread but only schedules an idle
// task. The mutex and atomic fields are thread safe on their own.
unsafe impl Send for Inner {}
unsafe impl Sync for Inner {}

/// Embeds libmpv video in the Tauri window through a Wayland subsurface and
/// EGL.
pub struct LinuxGlRenderer {
    /// What `new` built, held until `attach` takes it.
    pending: Option<Pending>,
    /// The attached session. `Some` between `attach` and `detach`.
    active: Option<Arc<Inner>>,
    /// The callback set before `attach`, which moves it into `Inner`. The
    /// mutex is only there for `Sync`. Nothing contends it, because the
    /// command thread sets and takes it before the renderer is shared.
    first_frame_cb: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Whether OpenGL runs on the CPU, such as Mesa's llvmpipe.
    software_gl: bool,
}

/// The EGL and Wayland resources `new` builds for `attach`.
struct Pending {
    egl: OwnedEgl,
    wayland: WaylandSession,
    find_window: FindWindow,
}

impl LinuxGlRenderer {
    /// Builds the EGL context and Wayland subsurface tree on the GLib main
    /// thread, because construction has to use the same thread as rendering.
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        // Fail fast if libEGL is not installed on the host.
        egl()?;

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Window 'main' not found".to_string())?;
        let find_window: FindWindow = {
            let window = window.clone();
            Box::new(move || Some((window.gtk_window().ok()?, window.default_vbox().ok()?)))
        };

        let raw_window = window
            .window_handle()
            .map_err(|e| format!("window handle: {e:?}"))?
            .as_raw();
        let raw_display = window
            .display_handle()
            .map_err(|e| format!("display handle: {e:?}"))?
            .as_raw();

        let (wl_surface_ptr, wl_display_ptr) = match (raw_window, raw_display) {
            (RawWindowHandle::Wayland(wh), RawDisplayHandle::Wayland(dh)) => {
                (wh.surface.as_ptr(), dh.display.as_ptr())
            }
            _ => {
                tracing::warn!(
                    "[MPV] non-Wayland handles: window={:?}, display={:?}. \
                     Set GDK_BACKEND=wayland if running on Wayland.",
                    raw_window,
                    raw_display,
                );
                return Err("Embedded Linux renderer requires a Wayland session".into());
            }
        };

        let (egl_res, wayland) = build_wayland_on_main_thread(wl_surface_ptr, wl_display_ptr)?;
        let software_gl = egl_res.software_gl;

        Ok(Self {
            pending: Some(Pending {
                egl: egl_res,
                wayland,
                find_window,
            }),
            active: None,
            first_frame_cb: Mutex::new(None),
            software_gl,
        })
    }

    /// Whether OpenGL runs on the CPU. Pass it to [`embedded_options`].
    pub fn software_gl(&self) -> bool {
        self.software_gl
    }
}

impl PlatformRenderer for LinuxGlRenderer {
    fn attach(&mut self, mpv: &mut Mpv) -> Result<(), String> {
        let Pending {
            egl: egl_res,
            wayland,
            find_window,
        } = self
            .pending
            .take()
            .ok_or_else(|| "Renderer has already been attached".to_string())?;

        let first_frame_cb = lock_or_recover(&self.first_frame_cb).take();

        // The closure has to be 'static, so `mpv` crosses to the GLib main
        // thread as an address.
        let mpv_addr = &*mpv as *const Mpv as usize;

        // The render context and its update callback have to be set up on
        // the GLib main thread as well. `Inner` is Send, so the Arc comes back
        // over the channel without a wrapper.
        let inner = run_on_glib_main(move || -> Result<Arc<Inner>, String> {
            // SAFETY: the caller holds the `MpvEngine` lock for the whole
            // call and `run_on_glib_main` waits for this closure, so `mpv` is
            // alive while it runs. If the main thread stalls past the 5
            // second timeout, `run_on_glib_main` panics and leaves this
            // closure queued, which is outside this guarantee. Issue #208
            // tracks it.
            let mpv = unsafe { &*(mpv_addr as *const Mpv) };
            let egl = egl()?;
            let mut egl_res = egl_res;
            let mut wayland = wayland;
            let display = egl_res.display;
            let context = egl_res.context;
            let surface = egl_res.surface.take().expect("surface already taken");
            let wl_egl = wayland.wl_egl_surface.take().expect("wl_egl already taken");

            egl.make_current(display, Some(surface), Some(surface), Some(context))
                .map_err(|e| format!("eglMakeCurrent (init): {e:?}"))?;

            gl::load_with(|name| gl_proc_address(name) as *const _);

            fn get_proc_address(_ctx: &*mut c_void, name: &str) -> *mut c_void {
                gl_proc_address(name)
            }

            // SAFETY: `detach` drops the session on this thread and waits
            // for it, and `MpvState` detaches the renderer before it stops
            // the engine, so the context goes before mpv. Idle tasks hold
            // only a `Weak`, so none of them keeps the session alive longer.
            // The one gap is the main thread stalling past the timeout in
            // `run_on_glib_main`, which issue #208 tracks.
            let mut render_ctx = unsafe { GlRenderContext::new(mpv, get_proc_address) }?;

            unsafe {
                gl::ClearColor(0.0, 0.0, 0.0, 1.0);
                gl::Clear(gl::COLOR_BUFFER_BIT);
            }
            let _ = egl.swap_buffers(display, surface);
            let _ = egl.make_current(display, None, None, None);

            // Subsurface coordinates count from the window surface's corner.
            // GTK's shadow and title bar sit between that corner and the page.
            let window = find_window();
            let csd_offset = window
                .as_ref()
                .and_then(|(window, vbox)| csd_offset(window, vbox))
                .unwrap_or((0, 0));

            let inner = Arc::new_cyclic(move |weak: &Weak<Inner>| {
                let decorations = window
                    .map(|(window, vbox)| DecorationWatch::start(&window, &vbox, weak.clone()));
                let weak = weak.clone();
                render_ctx.set_update_callback(move || request_render(weak.clone()));
                Inner {
                    decorations: Mutex::new(decorations),
                    first_frame_cb: Mutex::new(first_frame_cb),
                    video_active: AtomicBool::new(true),
                    valid: AtomicBool::new(true),
                    drew_frame: AtomicBool::new(false),
                    render_ctx,
                    state: Mutex::new(SessionState {
                        egl_display: display,
                        egl_surface: Some(surface),
                        wl_egl_surface: Some(wl_egl),
                        pending_resize: None,
                        current_size: (1, 1),
                        frame: (0, 0, 0, 0),
                        csd_offset,
                    }),
                    egl: egl_res,
                    wayland,
                }
            });
            Ok(inner)
        })?;

        self.active = Some(inner);
        Ok(())
    }

    fn resize(&mut self, _width: u32, _height: u32) {
        // `set_frame` places the video, and the window's `size-allocate`
        // handler follows GTK's decorations.
    }

    fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let Some(inner) = self.active.as_ref() else {
            return;
        };
        let wi = (w as i32).max(1);
        let hi = (h as i32).max(1);

        {
            let mut state = lock_or_recover(&inner.state);
            state.frame = (x as i32, y as i32, wi, hi);
            let (ax, ay) = state.position();
            // Only a new size needs a new EGL surface. The frontend also
            // calls this when the video moves without resizing, and
            // recreating the surface then would flash a black frame.
            let target = state.pending_resize.unwrap_or(state.current_size);
            if target != (wi, hi) {
                state.pending_resize = Some((wi, hi));
            }

            // A hidden video stays off screen. `set_visible(true)` puts it
            // back at the latest frame.
            if inner.video_active.load(Ordering::Acquire) {
                inner.wayland.subsurface.set_position(ax, ay);
                inner.wayland.child_surface.commit();
                let _ = inner.wayland.conn.flush();
            }
        }

        drain_wayland_queue(inner);
        request_render(Arc::downgrade(inner));
    }

    fn set_visible(&mut self, visible: bool) {
        let Some(inner) = self.active.as_ref() else {
            return;
        };
        // The lock keeps `set_frame` and `follow_decorations` from moving the
        // video back on screen while it's being hidden.
        let mut state = lock_or_recover(&inner.state);
        inner.video_active.store(visible, Ordering::Release);

        if visible {
            let (x, y) = state.position();
            inner.wayland.subsurface.set_position(x, y);
            let (_, _, w, h) = state.frame;
            if w > 0 && h > 0 {
                state.pending_resize = Some((w, h));
            }
        } else {
            // Move the subsurface off screen instead of attaching a null
            // buffer. Some compositors raise a protocol error for a null
            // buffer on a surface that EGL manages.
            inner.wayland.subsurface.set_position(-32000, -32000);
        }
        inner.wayland.child_surface.commit();
        let _ = inner.wayland.conn.flush();
        drop(state);
        drain_wayland_queue(inner);
        // The render makes the surface the size of the latest frame, which
        // may have changed while the video was hidden. A paused video gets no
        // other render.
        if visible {
            request_render(Arc::downgrade(inner));
        }
    }

    fn set_first_frame_callback(&mut self, cb: Box<dyn FnOnce() + Send>) {
        let slot = match self.active.as_ref() {
            Some(inner) => &inner.first_frame_cb,
            None => &self.first_frame_cb,
        };
        *lock_or_recover(slot) = Some(cb);
    }

    fn detach(&mut self) {
        let Some(inner) = self.active.take() else {
            return;
        };
        {
            // The lock keeps `follow_decorations` from moving the video back
            // on screen after it's hidden, as in `set_visible`.
            let _state = lock_or_recover(&inner.state);
            inner.valid.store(false, Ordering::Release);
            inner.video_active.store(false, Ordering::Release);

            // Hide subsurface before destroying to prevent a visible flash
            // of the transparent WebView background.
            inner.wayland.subsurface.set_position(-32000, -32000);
            inner.wayland.child_surface.commit();
            let _ = inner.wayland.conn.flush();
        }

        run_on_glib_main(move || {
            if let Some(watch) = lock_or_recover(&inner.decorations).take() {
                watch.stop();
            }
            drop(inner);
        });
    }
}

impl Drop for LinuxGlRenderer {
    fn drop(&mut self) {
        self.detach();
        // If attach never ran, `pending` drops here on the calling thread
        // rather than the GLib main thread. That is usually fine for the EGL
        // destroy calls, because nothing has rendered with these handles.
    }
}

/// Renders a frame soon on the GLib main thread, unless the session has
/// ended by then.
///
/// The task holds a `Weak`, so a task still queued when `detach` runs can't
/// keep the render context alive after mpv is destroyed.
fn request_render(weak: Weak<Inner>) {
    gtk::glib::idle_add_once(move || {
        if let Some(alive) = weak.upgrade() {
            if alive.valid.load(Ordering::Acquire) {
                render_frame(&alive);
            }
        }
    });
}

/// Moves the video to `offset`, where GTK's decorations now put the page.
/// GTK drops the window shadow when the window is maximized or tiled, and the
/// shadow and title bar in full screen, which moves the page inside the window
/// surface.
///
/// The window's `size-allocate` handler calls it on the GLib main thread. The
/// compositor applies the move when GTK next commits the window surface,
/// which GTK does as it paints the new layout, so the video and the page move
/// in the same frame. While GTK holds back painting, such as when the
/// compositor stops sending frame callbacks to a hidden window, the move
/// waits with the page and nothing shows out of place.
fn follow_decorations(inner: &Inner, offset: (i32, i32)) {
    // The lock stays held while the video moves, so a `set_frame` or a
    // `set_visible(false)` on another thread can't land in between.
    let mut state = lock_or_recover(&inner.state);
    if state.csd_offset == offset {
        return;
    }
    tracing::debug!("[MPV] window decorations moved the page to {offset:?}");
    state.csd_offset = offset;
    // A hidden video takes the new offset when `set_visible(true)` shows it.
    if state.frame.2 < 1 || !inner.video_active.load(Ordering::Acquire) {
        return;
    }
    let (x, y) = state.position();
    inner.wayland.subsurface.set_position(x, y);
    inner.wayland.child_surface.commit();
    let _ = inner.wayland.conn.flush();
}

/// Renders one frame. Only call it on the GLib main thread.
fn render_frame(inner: &Inner) {
    if !inner.video_active.load(Ordering::Acquire) {
        return;
    }
    let Ok(egl) = egl() else { return };
    let display = inner.egl.display;
    let context = inner.egl.context;

    let mut state = lock_or_recover(&inner.state);

    // Recreate the EGL surface at the new size instead of calling
    // wl_egl_window_resize, which corrupts mpv's internal textures
    // on VM GL drivers (virgl/llvmpipe).
    let resized = if let Some((nw, nh)) = state.pending_resize.take() {
        let _ = egl.make_current(display, None, None, None);
        if let Some(old) = state.egl_surface.take() {
            let _ = egl.destroy_surface(display, old);
        }
        let old_wl = state.wl_egl_surface.take();
        drop(old_wl);

        let child_id = inner.wayland.child_surface.id();
        match recreate_egl_surface(egl, display, inner.egl.config, child_id, nw, nh) {
            Some((new_wl, new_egl)) => {
                state.wl_egl_surface = Some(new_wl);
                state.egl_surface = Some(new_egl);
                state.current_size = (nw, nh);
                true
            }
            None => {
                tracing::warn!("[MPV] EGL surface recreation failed on resize");
                // The old surface is gone. A zero size makes the next
                // `set_frame` queue another attempt.
                state.current_size = (0, 0);
                return;
            }
        }
    } else {
        false
    };

    let Some(surface) = state.egl_surface else {
        return;
    };
    let (w, h) = state.current_size;
    drop(state);

    if w < 1 || h < 1 {
        return;
    }

    if egl
        .make_current(display, Some(surface), Some(surface), Some(context))
        .is_err()
    {
        return;
    }

    if resized {
        unsafe {
            gl::Viewport(0, 0, w, h);
            gl::ClearColor(0.0, 0.0, 0.0, 1.0);
            gl::Clear(gl::COLOR_BUFFER_BIT);
        }
        let _ = egl.swap_buffers(display, surface);
        inner.wayland.child_surface.damage_buffer(0, 0, w, h);
        inner.wayland.child_surface.commit();
        let _ = inner.wayland.conn.flush();
    }

    let has_frame = match inner.render_ctx.update() {
        Ok(flags) => flags & mpv_render_update::Frame != 0,
        Err(_) => false,
    };

    // A resize redraws the last frame, so a paused video doesn't go black.
    // Before the first frame there is nothing to redraw, and a render would
    // fire the first frame callback too early. The macOS renderer likewise
    // only renders when mpv reports a new frame. If mpv drops the first frame
    // because this callback ran late, the picture stays black until the next
    // one arrives.
    if !has_frame && !(resized && inner.drew_frame.load(Ordering::Relaxed)) {
        return;
    }

    if inner
        .render_ctx
        .render::<*mut c_void>(0, w, h, true)
        .is_err()
    {
        return;
    }
    if egl.swap_buffers(display, surface).is_err() {
        return;
    }
    inner.wayland.child_surface.damage_buffer(0, 0, w, h);
    inner.wayland.child_surface.commit();
    let _ = inner.wayland.conn.flush();

    inner.render_ctx.report_swap();
    inner.drew_frame.store(true, Ordering::Relaxed);

    // A resize redraws the surface without a new frame, which doesn't count
    // as the first one. Take the callback out first, so it doesn't run with
    // the lock held.
    if has_frame {
        let first_frame_cb = lock_or_recover(&inner.first_frame_cb).take();
        if let Some(cb) = first_frame_cb {
            cb();
        }
    }
}

fn recreate_egl_surface(
    egl: &egl::DynamicInstance<egl::EGL1_4>,
    display: egl::Display,
    config: egl::Config,
    child_id: wayland_client::backend::ObjectId,
    w: i32,
    h: i32,
) -> Option<(WlEglSurface, egl::Surface)> {
    let new_wl = WlEglSurface::new(child_id, w, h).ok()?;
    let new_egl = unsafe {
        egl.create_window_surface(display, config, new_wl.ptr() as egl::NativeWindowType, None)
    }
    .ok()?;
    Some((new_wl, new_egl))
}

/// Builds the EGL and Wayland subsurface resources on the GLib main thread.
fn build_wayland_on_main_thread(
    wl_surface_ptr: *mut c_void,
    wl_display_ptr: *mut c_void,
) -> Result<(OwnedEgl, WaylandSession), String> {
    // Raw pointers aren't Send, but `usize` is. Transport the two GTK-owned
    // Wayland handles across the main-thread dispatch boundary as integers
    // and cast back inside the closure. This avoids an `unsafe impl Send`
    // wrapper and sidesteps RFC 2229 disjoint-capture, which would otherwise
    // split any struct wrapper into its non-Send field captures.
    let ws_usize = wl_surface_ptr as usize;
    let wd_usize = wl_display_ptr as usize;
    run_on_glib_main(move || build_wayland(ws_usize as *mut c_void, wd_usize as *mut c_void))
}

fn build_wayland(
    wl_surface_ptr: *mut c_void,
    wl_display_ptr: *mut c_void,
) -> Result<(OwnedEgl, WaylandSession), String> {
    let egl = egl()?;

    // Secondary reference to the GTK Wayland connection. Shares the same fd
    // and object namespace, so ObjectId::from_ptr recognizes GTK's objects.
    //
    // SAFETY: `wl_display_ptr` is a valid `wl_display *` owned by GTK for
    // the lifetime of the window. `from_foreign_display` only reads the fd
    // and bumps a refcount; it never frees the display.
    let backend = unsafe { Backend::from_foreign_display(wl_display_ptr as *mut _) };
    let conn = Connection::from_backend(backend);

    let (globals, mut queue) = registry_queue_init::<WlGlobals>(&conn)
        .map_err(|e| format!("Wayland registry_queue_init: {e}"))?;
    let qh = queue.handle();

    let compositor: WlCompositor = globals
        .bind(&qh, 4..=5, ())
        .map_err(|e| format!("bind wl_compositor: {e}"))?;
    let subcompositor: WlSubcompositor = globals
        .bind(&qh, 1..=1, ())
        .map_err(|e| format!("bind wl_subcompositor: {e}"))?;

    let mut dummy = WlGlobals;
    queue
        .roundtrip(&mut dummy)
        .map_err(|e| format!("wayland roundtrip: {e}"))?;

    // Wrap the parent surface pointer as a wayland-client proxy so we can
    // pass it to `get_subsurface`. We never receive events on it, and its
    // Drop doesn't send `wl_surface.destroy`, which matters because GTK owns
    // the surface.
    //
    // SAFETY: `wl_surface_ptr` is a valid `wl_surface *` on the same
    // connection we are using (shared fd via `from_foreign_display`).
    let parent_id = unsafe { ObjectId::from_ptr(WlSurface::interface(), wl_surface_ptr as *mut _) }
        .map_err(|_| "invalid parent wl_surface pointer")?;
    let parent_surface = WlSurface::from_id(&conn, parent_id)
        .map_err(|_| "cannot build proxy for parent wl_surface")?;

    let child_surface = compositor.create_surface(&qh, ());
    let subsurface = subcompositor.get_subsurface(&child_surface, &parent_surface, &qh, ());
    subsurface.place_below(&parent_surface);
    subsurface.set_desync();
    child_surface.commit();
    conn.flush().map_err(|e| format!("wayland flush: {e}"))?;

    // Prefer `eglGetPlatformDisplayEXT(EGL_PLATFORM_WAYLAND_EXT)`, which tells
    // EGL the native display is a Wayland one instead of letting it guess.
    // `eglGetDisplay` covers older drivers.
    const EGL_PLATFORM_WAYLAND_EXT: u32 = 0x31D8;
    let egl_display = wayland_egl_display(egl, wl_display_ptr, EGL_PLATFORM_WAYLAND_EXT)?;

    // `eglInitialize` is idempotent per spec, but some Mesa releases
    // mishandle double-init on a display already initialized by GTK. Only
    // call it if `EGL_VERSION` is not yet queryable.
    if egl.query_string(Some(egl_display), egl::VERSION).is_err() {
        egl.initialize(egl_display)
            .map_err(|e| format!("eglInitialize: {e:?}"))?;
    }

    let config_attribs = [
        egl::RED_SIZE,
        8,
        egl::GREEN_SIZE,
        8,
        egl::BLUE_SIZE,
        8,
        egl::ALPHA_SIZE,
        8,
        egl::DEPTH_SIZE,
        0,
        egl::STENCIL_SIZE,
        0,
        egl::RENDERABLE_TYPE,
        egl::OPENGL_BIT,
        egl::SURFACE_TYPE,
        egl::WINDOW_BIT,
        egl::NONE,
    ];
    let config = egl
        .choose_first_config(egl_display, &config_attribs)
        .map_err(|e| format!("eglChooseConfig: {e:?}"))?
        .ok_or("no suitable EGL config")?;
    egl.bind_api(egl::OPENGL_API)
        .map_err(|e| format!("eglBindAPI(OPENGL): {e:?}"))?;

    let wl_egl_surface = WlEglSurface::new(child_surface.id(), 1, 1)
        .map_err(|e| format!("wl_egl_window_create: {e:?}"))?;

    // SAFETY: `wl_egl_surface.ptr()` is a valid `wl_egl_window *` and stays
    // alive as long as `WaylandSession` owns `wl_egl_surface`.
    let egl_surface = unsafe {
        egl.create_window_surface(
            egl_display,
            config,
            wl_egl_surface.ptr() as egl::NativeWindowType,
            None,
        )
    }
    .map_err(|e| format!("eglCreateWindowSurface: {e:?}"))?;

    let context_attribs = [
        egl::CONTEXT_MAJOR_VERSION,
        3,
        egl::CONTEXT_MINOR_VERSION,
        2,
        egl::CONTEXT_OPENGL_PROFILE_MASK,
        egl::CONTEXT_OPENGL_CORE_PROFILE_BIT,
        egl::NONE,
    ];
    let egl_context = egl
        .create_context(egl_display, config, None, &context_attribs)
        .map_err(|e| format!("eglCreateContext: {e:?}"))?;

    let renderer = gl_renderer_name(egl, egl_display, egl_surface, egl_context);
    tracing::info!(
        "[MPV] OpenGL renderer: {}",
        renderer.as_deref().unwrap_or("unknown")
    );

    let egl_res = OwnedEgl {
        display: egl_display,
        surface: Some(egl_surface),
        context: egl_context,
        config,
        software_gl: renderer.as_deref().is_some_and(is_software_gl),
    };
    let wayland = WaylandSession {
        wl_egl_surface: Some(wl_egl_surface),
        subsurface,
        child_surface,
        queue: Mutex::new(queue),
        conn,
    };
    Ok((egl_res, wayland))
}

/// Reads `GL_RENDERER` with the new context, then releases the context.
fn gl_renderer_name(
    egl: &egl::DynamicInstance<egl::EGL1_4>,
    display: egl::Display,
    surface: egl::Surface,
    context: egl::Context,
) -> Option<String> {
    egl.make_current(display, Some(surface), Some(surface), Some(context))
        .ok()?;
    gl::load_with(|name| gl_proc_address(name) as *const _);
    // SAFETY: The context is current, and a non-null `glGetString` result
    // is a NUL-terminated string that the driver keeps alive.
    let name = unsafe {
        let ptr = gl::GetString(gl::RENDERER);
        (!ptr.is_null()).then(|| {
            std::ffi::CStr::from_ptr(ptr.cast())
                .to_string_lossy()
                .into_owned()
        })
    };
    let _ = egl.make_current(display, None, None, None);
    name
}

/// Whether a `GL_RENDERER` string names a renderer that draws on the CPU.
/// The names are the ones mpv itself checks for.
fn is_software_gl(renderer: &str) -> bool {
    renderer.contains("llvmpipe")
        || renderer.contains("softpipe")
        || renderer == "Software Rasterizer"
        || renderer == "Mesa X11"
}

fn wayland_egl_display(
    egl: &egl::DynamicInstance<egl::EGL1_4>,
    wl_display_ptr: *mut c_void,
    platform_enum: u32,
) -> Result<egl::Display, String> {
    type GetPlatformDisplayExt = unsafe extern "C" fn(u32, *mut c_void, *const i32) -> *mut c_void;

    if let Some(get_fn) = egl.get_proc_address("eglGetPlatformDisplayEXT") {
        // SAFETY: `eglGetPlatformDisplayEXT` has the documented signature
        // `EGLDisplay(EGLenum, void*, const EGLint*)`; transmuting the proc
        // address to that fn pointer matches the loader's contract.
        let get_platform_display: GetPlatformDisplayExt = unsafe { std::mem::transmute(get_fn) };
        // SAFETY: calls into libEGL with a valid wl_display pointer.
        let d_ptr =
            unsafe { get_platform_display(platform_enum, wl_display_ptr, std::ptr::null()) };
        if !d_ptr.is_null() {
            // SAFETY: `egl::Display` is `repr(transparent)` over `*mut c_void`.
            return Ok(unsafe { std::mem::transmute::<*mut c_void, egl::Display>(d_ptr) });
        }
    }

    // SAFETY: Fallback path; `eglGetDisplay` accepts any native display
    // pointer and returns EGL_NO_DISPLAY on failure (mapped to None).
    unsafe { egl.get_display(wl_display_ptr) }
        .ok_or_else(|| "eglGetDisplay returned EGL_NO_DISPLAY".to_string())
}

/// How far the page in `vbox` sits from the corner of `window`'s surface,
/// for GTK's client side shadow and title bar. Subsurface coordinates count
/// from that corner, so adding the offset lines them up with the page.
///
/// GTK lays the window's child out inside the shadow, so the position of
/// `vbox` in the window already counts it. Adding the gap between the GDK
/// window and the allocation as well counted the shadow twice while the two
/// sizes differed during a layout.
///
/// It's None until `vbox` and the window are realized. Only call it on the
/// GLib main thread.
fn csd_offset(window: &gtk::ApplicationWindow, vbox: &gtk::Box) -> Option<(i32, i32)> {
    use gtk::prelude::*;

    vbox.translate_coordinates(window, 0, 0)
}

/// Runs `f` on the GLib main thread and blocks until it returns.
///
/// On the main thread it runs `f` inline, since waiting for its own callback
/// would deadlock. Elsewhere it uses `MainContext::invoke`, which runs ahead
/// of idle callbacks. It panics if the main thread doesn't answer within 5
/// seconds.
fn run_on_glib_main<F, T>(f: F) -> T
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let main_ctx = gtk::glib::MainContext::default();
    if main_ctx.is_owner() {
        return f();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    main_ctx.invoke(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(value) => value,
        Err(e) => {
            tracing::error!("[MPV] GLib main-thread dispatch timed out or disconnected: {e}");
            panic!("GLib main-thread dispatch failed: {e}");
        }
    }
}

/// Dispatches the events waiting on the renderer's Wayland queue. Every
/// handler ignores them, so this only empties the queue.
fn drain_wayland_queue(inner: &Inner) {
    let mut queue = lock_or_recover(&inner.wayland.queue);
    let mut dummy = WlGlobals;
    let _ = queue.dispatch_pending(&mut dummy);
}

/// The hardware decoding mode for embedded playback, and for the fallback
/// window when mpv opens it on Wayland.
///
/// Copy mode decodes on the GPU and copies each frame back for upload, so
/// mpv never maps decoder surfaces into the renderer. Zero-copy `auto` opens
/// a VA-API display through the Wayland compositor, which segfaults inside
/// libva on some setups, and the mapped surfaces have shown wrong colors on
/// drivers that can't convert NV12.
///
/// Plain `auto-copy` also tries Vulkan. With libmpv 0.37, a failed Vulkan
/// attempt on a machine without Vulkan video decoding, such as Mesa's
/// software driver, left the embedded picture black even after mpv fell
/// back to software decoding. The `-safe` list in 0.37 leaves Vulkan out.
/// Newer releases, including the 0.40 the AppImage bundles, put Vulkan on
/// that list, and there a failed attempt falls back cleanly.
const LINUX_HWDEC: &str = "auto-copy-safe";

/// Cheaper scaling, no dithering and no HDR peak detection, the settings of
/// mpv's `fast` profile apart from `allow-delayed-peak-detect`, which is
/// newer than some distributions' libmpv. The profile itself is new in mpv
/// 0.37, and an option libmpv doesn't know fails the whole load, so these are
/// spelled out.
///
/// mpv 0.37 made its slower, sharper scalers the default. On a software
/// renderer they cost a lot of CPU, and in testing with Mesa's llvmpipe and
/// libmpv 0.37 the embedded picture stayed black in about half the runs.
/// With these options it showed every time.
const SOFTWARE_GL_OPTIONS: [(&str, &str); 7] = [
    ("scale", "bilinear"),
    ("dscale", "bilinear"),
    ("dither", "no"),
    ("correct-downscaling", "no"),
    ("linear-downscaling", "no"),
    ("sigmoid-upscaling", "no"),
    ("hdr-compute-peak", "no"),
];

/// Options for embedded playback through the OpenGL render context.
/// `software_gl` comes from [`LinuxGlRenderer::software_gl`].
pub fn embedded_options(software_gl: bool) -> Vec<(&'static str, &'static str)> {
    let mut options = vec![
        ("vo", "libmpv"),
        ("hwdec", LINUX_HWDEC),
        // Copy mode doesn't use GPU interop, so don't load any. The render
        // API otherwise loads every interop (VA-API, VDPAU, CUDA, DRM PRIME)
        // when the context is created, which costs startup time and runs
        // the libva code that crashes.
        ("gpu-hwdec-interop", "no"),
        ("ao", "pulse,pipewire,alsa,"),
        // Ignore config files, so neither /etc/mpv/mpv.conf nor a user
        // config can turn audio off with audio=no or aid=no.
        ("config", "no"),
        ("video-sync", "audio"),
    ];
    if software_gl {
        options.extend(SOFTWARE_GL_OPTIONS);
    }
    options.extend(shared_options());
    options.push(("msg-level", "all=info"));
    options
}

/// Options for the separate fallback window, where mpv picks `vo=gpu` and
/// shows its own controls. `wayland` says whether mpv will open that window
/// on Wayland, see [`mpv_uses_wayland`].
pub fn fallback_options(wayland: bool) -> Vec<(&'static str, &'static str)> {
    // X11 never reaches libva's Wayland code, so keep zero-copy decoding
    // there. X11 sessions always use this window.
    let hwdec = if wayland { LINUX_HWDEC } else { "auto" };
    let mut options = vec![
        ("hwdec", hwdec),
        ("ao", "pulse,pipewire,alsa,"),
        ("config", "no"),
        ("video-sync", "display-resample"),
    ];
    options.extend(shared_options());
    options.push(("msg-level", "all=info"));
    options
}

/// Whether mpv's own window will connect to a Wayland compositor. mpv tries
/// Wayland before X11, even when the app itself runs through XWayland with
/// `GDK_BACKEND=x11`. mpv 0.38 and later only try it when `WAYLAND_DISPLAY`
/// is set, and 0.40 also takes `WAYLAND_SOCKET`. Up to 0.37, mpv always tries,
/// and libwayland then falls back to `$XDG_RUNTIME_DIR/wayland-0`. Any sign of
/// a Wayland session counts, because guessing Wayland on X11 only costs
/// zero-copy decoding.
pub fn mpv_uses_wayland() -> bool {
    wayland_in_env(|key| std::env::var_os(key), |path| path.exists())
}

fn wayland_in_env(
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
    exists: impl Fn(&std::path::Path) -> bool,
) -> bool {
    let display = var("WAYLAND_DISPLAY");
    display.as_ref().is_some_and(|v| !v.is_empty())
        || var("WAYLAND_SOCKET").is_some()
        || var("XDG_SESSION_TYPE").is_some_and(|v| v == "wayland")
        || (display.is_none()
            && var("XDG_RUNTIME_DIR")
                .filter(|dir| !dir.is_empty())
                .is_some_and(|dir| exists(&std::path::Path::new(&dir).join("wayland-0"))))
}

#[cfg(test)]
mod tests {
    use super::{is_software_gl, wayland_in_env};
    use std::ffi::OsString;
    use std::path::Path;

    fn env<'a>(vars: &'a [(&str, &str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |key| {
            vars.iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| OsString::from(v))
        }
    }

    /// A file system with no sockets in it.
    fn no_files(_: &Path) -> bool {
        false
    }

    /// A file system where only `/run/user/1000/wayland-0` exists.
    fn default_socket(path: &Path) -> bool {
        path == Path::new("/run/user/1000/wayland-0")
    }

    #[test]
    fn wayland_display_means_wayland() {
        assert!(wayland_in_env(
            env(&[("WAYLAND_DISPLAY", "wayland-0")]),
            no_files
        ));
        // GDK_BACKEND=x11 doesn't stop mpv from using Wayland.
        assert!(wayland_in_env(
            env(&[
                ("WAYLAND_DISPLAY", "wayland-1"),
                ("GDK_BACKEND", "x11"),
                ("DISPLAY", ":0"),
            ]),
            no_files
        ));
    }

    #[test]
    fn socket_or_session_type_means_wayland() {
        assert!(wayland_in_env(env(&[("WAYLAND_SOCKET", "5")]), no_files));
        assert!(wayland_in_env(
            env(&[("XDG_SESSION_TYPE", "wayland")]),
            no_files
        ));
    }

    #[test]
    fn default_socket_means_wayland_when_display_is_unset() {
        // libwayland connects to wayland-0 when WAYLAND_DISPLAY is unset.
        assert!(wayland_in_env(
            env(&[("XDG_RUNTIME_DIR", "/run/user/1000"), ("DISPLAY", ":0")]),
            default_socket
        ));
        // An empty WAYLAND_DISPLAY names no socket, so libwayland fails.
        assert!(!wayland_in_env(
            env(&[
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("WAYLAND_DISPLAY", ""),
            ]),
            default_socket
        ));
        assert!(!wayland_in_env(
            env(&[("XDG_RUNTIME_DIR", "/run/user/1000")]),
            no_files
        ));
        assert!(!wayland_in_env(
            env(&[("XDG_RUNTIME_DIR", "")]),
            |_: &Path| true
        ));
    }

    #[test]
    fn x11_session_is_not_wayland() {
        assert!(!wayland_in_env(
            env(&[("DISPLAY", ":0"), ("XDG_SESSION_TYPE", "x11")]),
            no_files
        ));
        assert!(!wayland_in_env(env(&[("WAYLAND_DISPLAY", "")]), no_files));
        assert!(!wayland_in_env(env(&[]), no_files));
    }

    #[test]
    fn software_renderers_are_recognized() {
        assert!(is_software_gl("llvmpipe (LLVM 19.1.1, 256 bits)"));
        assert!(is_software_gl("softpipe"));
        assert!(is_software_gl("Software Rasterizer"));
        assert!(is_software_gl("Mesa X11"));
        assert!(!is_software_gl("Mesa Intel(R) UHD Graphics 620 (KBL GT2)"));
        assert!(!is_software_gl(
            "AMD Radeon RX 6600 (radeonsi, navi23, LLVM 19.1.1, DRM 3.57)"
        ));
        assert!(!is_software_gl("NVIDIA GeForce RTX 3060/PCIe/SSE2"));
        // virgl draws on the host GPU.
        assert!(!is_software_gl("virgl (NVIDIA GeForce RTX 3060)"));
    }
}
