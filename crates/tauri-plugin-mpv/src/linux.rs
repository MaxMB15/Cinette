// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Linux video embedding with a Wayland subsurface, EGL and an OpenGL render
//! context.
//!
//! The renderer puts a `wl_subsurface` and `wl_egl_window` under the Tauri
//! `wl_surface` and builds an OpenGL Core 3.2 EGL context on that window.
//! libmpv gets an OpenGL render context plus the native `wl_display` through
//! `MPV_RENDER_PARAM_WL_DISPLAY`. It needs the display for dmabuf and color
//! space interop with the compositor, and for presentation timing.
//!
//! Every EGL, GL and `wl_egl_window` call runs on the GLib main thread, which
//! owns the EGL context for the renderer's whole life. It is the Wayland
//! counterpart of the main thread rule on macOS.
//!
//! X11 sessions aren't embedded. They use the separate window fallback in
//! `MpvState`.

use crate::lock::lock_or_recover;
use crate::options::shared_options;
use crate::renderer::PlatformRenderer;
use khronos_egl as egl;
use libmpv2::{
    render::{mpv_render_update, OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType},
    Mpv,
};
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
/// use it. `attach` calls `gl::load_with` once, on the GLib main thread, while
/// the EGL context is current.
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
    wl_display_ptr: *mut c_void,
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
    egl_surface: egl::Surface,
    wl_egl_surface: Option<WlEglSurface>,
    pending_resize: Option<(i32, i32)>,
    current_size: (i32, i32),
    last_frame: (i32, i32, i32, i32),
    csd_offset: (i32, i32),
}

impl Drop for SessionState {
    fn drop(&mut self) {
        if let Ok(egl) = egl() {
            let _ = egl.destroy_surface(self.egl_display, self.egl_surface);
        }
    }
}

// SAFETY: `egl::Display`, `egl::Surface`, and `WlEglSurface` are opaque
// handles only used on the GLib main thread via `render_frame`. The Mutex
// ensures exclusive access.
unsafe impl Send for SessionState {}

/// Everything one attached session owns. The renderer and the libmpv update
/// callback share it.
struct Inner {
    first_frame_cb: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    video_active: AtomicBool,
    valid: AtomicBool,
    // Keep this order, since fields drop top to bottom. The render context
    // frees mpv's GL resources, `state` destroys the EGL surface and
    // WlEglSurface, `egl` destroys the GL context and `wayland` tears down
    // the subsurface tree.
    render_ctx: RenderContext,
    state: Mutex<SessionState>,
    egl: OwnedEgl,
    wayland: WaylandSession,
}

// SAFETY: `RenderContext`, `OwnedEgl`, and `WaylandSession` are only
// dereferenced from the GLib main thread (via `render_frame`). The libmpv
// update callback runs on an arbitrary thread but only schedules an idle
// task; it does not touch any of these fields directly. The mutex and
// atomic fields are thread safe on their own.
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
}

/// The EGL and Wayland resources `new` builds for `attach`.
struct Pending {
    egl: OwnedEgl,
    wayland: WaylandSession,
    csd_offset: (i32, i32),
}

impl LinuxGlRenderer {
    /// Builds the EGL context and Wayland subsurface tree on the GLib main
    /// thread, because construction has to use the same thread as rendering.
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        // Fail fast if libEGL is not installed on the host.
        egl()?;

        let csd_offset = query_csd_offsets(app);

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Window 'main' not found".to_string())?;

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

        Ok(Self {
            pending: Some(Pending {
                egl: egl_res,
                wayland,
                csd_offset,
            }),
            active: None,
            first_frame_cb: Mutex::new(None),
        })
    }
}

impl PlatformRenderer for LinuxGlRenderer {
    fn attach(&mut self, mpv: &mut Mpv) -> Result<(), String> {
        let Pending {
            egl: egl_res,
            wayland,
            csd_offset,
        } = self
            .pending
            .take()
            .ok_or_else(|| "Renderer has already been attached".to_string())?;

        let first_frame_cb = lock_or_recover(&self.first_frame_cb).take();

        // Raw pointers aren't Send, so the handle crosses to the GLib main
        // thread as a `usize`, which saves a wrapper with its own
        // `unsafe impl Send`. The caller holds the `MpvEngine` lock for the
        // whole call, so the handle stays valid, and only the main thread
        // dereferences it.
        let mpv_ptr_usize = mpv.ctx.as_ptr() as usize;

        // The render context and its update callback have to be set up on
        // the GLib main thread as well. `Inner` is Send, so the Arc comes back
        // over the channel without a wrapper.
        let inner = run_on_glib_main(move || -> Result<Arc<Inner>, String> {
            let mpv_ptr = mpv_ptr_usize as *mut c_void;
            let egl = egl()?;
            let mut egl_res = egl_res;
            let mut wayland = wayland;
            let display = egl_res.display;
            let context = egl_res.context;
            let surface = egl_res.surface.take().expect("surface already taken");
            let wl_egl = wayland.wl_egl_surface.take().expect("wl_egl already taken");
            let wl_display_ptr = wayland.wl_display_ptr;

            egl.make_current(display, Some(surface), Some(surface), Some(context))
                .map_err(|e| format!("eglMakeCurrent (init): {e:?}"))?;

            gl::load_with(|name| gl_proc_address(name) as *const _);

            fn get_proc_address(_ctx: &*mut c_void, name: &str) -> *mut c_void {
                gl_proc_address(name)
            }

            let mut render_ctx = RenderContext::new(
                unsafe { &mut *mpv_ptr.cast() },
                vec![
                    RenderParam::ApiType(RenderParamApiType::OpenGl),
                    RenderParam::InitParams(OpenGLInitParams {
                        get_proc_address,
                        ctx: std::ptr::null_mut::<c_void>(),
                    }),
                    RenderParam::WaylandDisplay(wl_display_ptr as *const c_void),
                ],
            )
            .map_err(|e| format!("mpv_render_context_create: {e}"))?;

            unsafe {
                gl::ClearColor(0.0, 0.0, 0.0, 1.0);
                gl::Clear(gl::COLOR_BUFFER_BIT);
            }
            let _ = egl.swap_buffers(display, surface);
            let _ = egl.make_current(display, None, None, None);

            let inner = Arc::new_cyclic(move |weak: &Weak<Inner>| {
                let weak = weak.clone();
                render_ctx.set_update_callback(move || {
                    if let Some(alive) = weak.upgrade() {
                        glib::idle_add_once(move || {
                            if alive.valid.load(Ordering::Acquire) {
                                render_frame(&alive);
                            }
                        });
                    }
                });
                Inner {
                    first_frame_cb: Mutex::new(first_frame_cb),
                    video_active: AtomicBool::new(true),
                    valid: AtomicBool::new(true),
                    render_ctx,
                    state: Mutex::new(SessionState {
                        egl_display: display,
                        egl_surface: surface,
                        wl_egl_surface: Some(wl_egl),
                        pending_resize: None,
                        current_size: (1, 1),
                        last_frame: (0, 0, 0, 0),
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
        // Positioning is driven by `set_frame` from the frontend layout.
    }

    fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let Some(inner) = self.active.as_ref() else {
            return;
        };
        let wi = (w as i32).max(1);
        let hi = (h as i32).max(1);

        {
            let mut state = lock_or_recover(&inner.state);
            let ax = x as i32 + state.csd_offset.0;
            let ay = y as i32 + state.csd_offset.1;
            state.last_frame = (ax, ay, wi, hi);
            state.pending_resize = Some((wi, hi));

            inner.wayland.subsurface.set_position(ax, ay);
            inner.wayland.child_surface.commit();
            let _ = inner.wayland.conn.flush();
        }

        drain_wayland_queue(inner);

        let weak = Arc::downgrade(inner);
        glib::idle_add_once(move || {
            if let Some(alive) = weak.upgrade() {
                if alive.valid.load(Ordering::Acquire) {
                    render_frame(&alive);
                }
            }
        });
    }

    fn set_visible(&mut self, visible: bool) {
        let Some(inner) = self.active.as_ref() else {
            return;
        };
        inner.video_active.store(visible, Ordering::Release);

        if visible {
            let (lx, ly, lw, lh) = lock_or_recover(&inner.state).last_frame;
            inner.wayland.subsurface.set_position(lx, ly);
            if lw > 0 && lh > 0 {
                lock_or_recover(&inner.state).pending_resize = Some((lw, lh));
            }
        } else {
            // Move the subsurface off screen instead of attaching a null
            // buffer. Some compositors raise a protocol error for a null
            // buffer on a surface that EGL manages.
            inner.wayland.subsurface.set_position(-32000, -32000);
        }
        inner.wayland.child_surface.commit();
        let _ = inner.wayland.conn.flush();
        drain_wayland_queue(inner);
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
        inner.valid.store(false, Ordering::Release);
        inner.video_active.store(false, Ordering::Release);

        // Hide subsurface before destroying to prevent a visible flash
        // of the transparent WebView background.
        inner.wayland.subsurface.set_position(-32000, -32000);
        inner.wayland.child_surface.commit();
        let _ = inner.wayland.conn.flush();

        run_on_glib_main(move || {
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
        let _ = egl.destroy_surface(display, state.egl_surface);
        let old_wl = state.wl_egl_surface.take();
        drop(old_wl);

        let child_id = inner.wayland.child_surface.id();
        match recreate_egl_surface(egl, display, inner.egl.config, child_id, nw, nh) {
            Some((new_wl, new_egl)) => {
                state.wl_egl_surface = Some(new_wl);
                state.egl_surface = new_egl;
                state.current_size = (nw, nh);
                true
            }
            None => {
                tracing::warn!("[MPV] EGL surface recreation failed on resize");
                drop(state);
                return;
            }
        }
    } else {
        false
    };

    let surface = state.egl_surface;
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

    if !has_frame && !resized {
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

    // Take the callback out first, so it doesn't run with the lock held.
    let first_frame_cb = lock_or_recover(&inner.first_frame_cb).take();
    if let Some(cb) = first_frame_cb {
        cb();
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
    // and object namespace, so ObjectId::from_ptr recognises GTK's objects.
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

    // Prefer `eglGetPlatformDisplayEXT(EGL_PLATFORM_WAYLAND_EXT)` so libmpv's
    // Wayland integration recognises the display as a Wayland one.
    // `eglGetDisplay` covers older drivers.
    const EGL_PLATFORM_WAYLAND_EXT: u32 = 0x31D8;
    let egl_display = wayland_egl_display(egl, wl_display_ptr, EGL_PLATFORM_WAYLAND_EXT)?;

    // `eglInitialize` is idempotent per spec, but some Mesa releases
    // mishandle double-init on a display already initialised by GTK. Only
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

    let egl_res = OwnedEgl {
        display: egl_display,
        surface: Some(egl_surface),
        context: egl_context,
        config,
    };
    let wayland = WaylandSession {
        wl_egl_surface: Some(wl_egl_surface),
        subsurface,
        child_surface,
        queue: Mutex::new(queue),
        conn,
        wl_display_ptr,
    };
    Ok((egl_res, wayland))
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

/// Asks GTK for the client side decoration offset.
///
/// Subsurface coordinates are relative to the parent `wl_surface`, shadow and
/// titlebar included. Adding this offset lines them up with the frontend's
/// content area.
fn query_csd_offsets<R: Runtime>(app: &AppHandle<R>) -> (i32, i32) {
    use gtk::prelude::*;

    if app.get_webview_window("main").is_none() {
        return (0, 0);
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let app_handle = app.clone();

    glib::idle_add_once(move || {
        let Some(window) = app_handle.get_webview_window("main") else {
            let _ = tx.send((0, 0));
            return;
        };
        let offsets = (|| -> Option<(i32, i32)> {
            let gtk_win = window.gtk_window().ok()?;
            let vbox = window.default_vbox().ok()?;
            let (vbox_x, vbox_y) = vbox.translate_coordinates(&gtk_win, 0, 0)?;
            let gdk_win = gtk_win.window()?;
            let alloc = gtk_win.allocation();
            let shadow_x = (gdk_win.width() - alloc.width()).max(0) / 2;
            let shadow_y = (gdk_win.height() - alloc.height()).max(0) / 2;
            Some((shadow_x + vbox_x, shadow_y + vbox_y))
        })();
        let _ = tx.send(offsets.unwrap_or((0, 0)));
    });
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .unwrap_or((0, 0))
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
    let main_ctx = glib::MainContext::default();
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

/// Options for embedded playback through the OpenGL render context.
pub fn embedded_options() -> Vec<(&'static str, &'static str)> {
    let mut options = vec![
        ("vo", "libmpv"),
        // `auto-copy` decodes on the GPU but copies frames to CPU for GL
        // upload. Plain `auto` can map VAAPI surfaces directly as GL
        // textures, which produces colour corruption on drivers that
        // cannot handle the NV12 to RGB interop.
        ("hwdec", "auto-copy"),
        ("ao", "pulse,pipewire,alsa,"),
        // Ignore config files, so neither /etc/mpv/mpv.conf nor a user
        // config can turn audio off with audio=no or aid=no.
        ("config", "no"),
        ("video-sync", "audio"),
    ];
    options.extend(shared_options());
    options.push(("msg-level", "all=info"));
    options
}

/// Options for the separate fallback window, where mpv picks `vo=gpu` and
/// shows its own controls.
pub fn fallback_options() -> Vec<(&'static str, &'static str)> {
    let mut options = vec![
        ("hwdec", "auto"),
        ("ao", "pulse,pipewire,alsa,"),
        ("config", "no"),
        ("video-sync", "display-resample"),
    ];
    options.extend(shared_options());
    options.push(("msg-level", "all=info"));
    options
}
