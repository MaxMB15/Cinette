// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! macOS video embedding with an NSOpenGLView and an OpenGL Core 3.2 render
//! context.
//!
//! Three details make `mpv_render_context_create` work here. libmpv built
//! from source rejects the legacy profile, so the pixel format asks for Core
//! 3.2. The view creates and owns its context, so there is no separate
//! NSOpenGLContext. `attach` calls `prepareOpenGL` before anything else,
//! because without a CGL drawable `makeCurrentContext` does nothing and mpv
//! returns Unsupported.
//!
//! Every NSView and OpenGL call has to run on the main thread. The AppKit
//! objects and the render state sit in `MainThreadBound`, which only hands
//! them out for a `MainThreadMarker`. `run_on_main` and `on_main_async` run
//! work on the main thread and supply the marker.

// Apple deprecated NSOpenGL in favor of Metal, and objc2-app-kit marks those
// bindings deprecated to match.
#![allow(deprecated)]

use crate::gl_render::GlRenderContext;
use crate::options::shared_options;
use crate::renderer::PlatformRenderer;
use dispatch2::{run_on_main, DispatchQueue, MainThreadBound};
use libmpv2::{render::mpv_render_update, Mpv};
use objc2::rc::Retained;
use objc2::{AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSOpenGLContext, NSOpenGLPFAAccelerated, NSOpenGLPFADoubleBuffer, NSOpenGLPFAOpenGLProfile,
    NSOpenGLPixelFormat, NSOpenGLPixelFormatAttribute, NSOpenGLProfileVersion3_2Core, NSOpenGLView,
    NSView, NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::cell::Cell;
use std::ffi::{c_char, c_void, CString};
use std::ptr::NonNull;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, Weak,
};
use tauri::{AppHandle, Manager, Runtime};

/// Runs `f` on the main thread without waiting for it. `run_on_main` is the
/// version that waits.
fn on_main_async<F: FnOnce(MainThreadMarker) + Send + 'static>(f: F) {
    DispatchQueue::main().exec_async(move || {
        // SAFETY: the main queue only runs its work on the main thread.
        f(unsafe { MainThreadMarker::new_unchecked() });
    });
}

/// Resolves an OpenGL function pointer for libmpv.
///
/// `CGLGetProcAddress` only finds CGL extension functions and returns null
/// for core ones like `glClear`, so this looks names up with `dlsym` in the
/// OpenGL framework, which finds both.
fn gl_get_proc_address(name: *const c_char) -> *mut c_void {
    static HANDLE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let lib = *HANDLE.get_or_init(|| {
        let path = CString::new("/System/Library/Frameworks/OpenGL.framework/OpenGL").unwrap();
        unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_GLOBAL) as usize }
    });
    if lib == 0 {
        return std::ptr::null_mut();
    }
    unsafe { libc::dlsym(lib as *mut c_void, name) }
}

/// The libmpv side of `gl_get_proc_address`.
fn get_proc_address(_ctx: &*mut c_void, name: &str) -> *mut c_void {
    match CString::new(name) {
        Ok(c) => gl_get_proc_address(c.as_ptr()),
        Err(_) => std::ptr::null_mut(),
    }
}

/// The AppKit objects one renderer creates and uses.
struct Views {
    /// The window's content view, which also holds the web view.
    content_view: Retained<NSView>,
    gl_view: Retained<NSOpenGLView>,
    /// The context `gl_view` created and owns.
    gl_context: Retained<NSOpenGLContext>,
}

/// Render state for one attached mpv core. It only lives on the main thread.
struct RenderInner {
    ctx: GlRenderContext,
    gl_view: Retained<NSOpenGLView>,
    gl_context: Retained<NSOpenGLContext>,
    /// Called once when the first frame is rendered, then cleared.
    first_frame_cb: Cell<Option<Box<dyn FnOnce() + Send>>>,
    /// Shared with `MacosGlRenderer::set_visible`. Rendering skips the GPU
    /// calls while it is false.
    video_active: Arc<AtomicBool>,
}

/// Embeds libmpv video in the Tauri window with an NSOpenGLView and OpenGL
/// Core 3.2.
pub struct MacosGlRenderer {
    /// The view and its context. `detach` takes them, so `None` means the
    /// renderer is detached.
    views: Option<Arc<MainThreadBound<Views>>>,
    /// Set by `attach`.
    render: Option<Arc<MainThreadBound<RenderInner>>>,
    /// Runs once on the first rendered frame. `attach` moves it into
    /// `RenderInner`.
    first_frame_cb: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Whether to render at all. `set_visible` toggles it. It starts true
    /// because the player page is showing when playback starts.
    video_active: Arc<AtomicBool>,
}

impl MacosGlRenderer {
    /// Create NSOpenGLView on the main thread and add it below the Tauri WKWebView.
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Window 'main' not found".to_string())?;

        let raw = window
            .window_handle()
            .map_err(|e| format!("window handle: {:?}", e))?
            .as_raw();

        // A raw pointer isn't Send, so the view crosses to the main thread
        // as an address.
        let content_view_addr = match raw {
            RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as usize,
            _ => return Err("Expected AppKit window handle".to_string()),
        };

        let views = run_on_main(move |mtm| {
            // SAFETY: the handle points at the content view of the `main`
            // window, which `window` keeps open.
            let content_view = unsafe { Retained::retain(content_view_addr as *mut NSView) }
                .ok_or("AppKit window handle has no view")?;
            build_views(content_view, mtm).map(|views| MainThreadBound::new(views, mtm))
        })?;

        Ok(Self {
            views: Some(Arc::new(views)),
            render: None,
            first_frame_cb: Mutex::new(None),
            video_active: Arc::new(AtomicBool::new(true)),
        })
    }
}

/// Builds the OpenGL view and context and puts the view below the web view.
fn build_views(content_view: Retained<NSView>, mtm: MainThreadMarker) -> Result<Views, String> {
    // libmpv built from source with -Dgl=enabled rejects the legacy profile.
    let attrs: [NSOpenGLPixelFormatAttribute; 5] = [
        NSOpenGLPFAOpenGLProfile,
        NSOpenGLProfileVersion3_2Core,
        NSOpenGLPFADoubleBuffer,
        NSOpenGLPFAAccelerated,
        0,
    ];
    // SAFETY: `attrs` is a zero-terminated attribute list that outlives the
    // call, and AppKit only reads it.
    let pixel_format = unsafe {
        NSOpenGLPixelFormat::initWithAttributes(
            NSOpenGLPixelFormat::alloc(),
            NonNull::from(&attrs).cast(),
        )
    }
    .ok_or("NSOpenGLPixelFormat (Core 3.2) init failed, check OpenGL availability")?;

    // Use the context the view creates and owns rather than allocating a
    // separate NSOpenGLContext.
    let gl_view = NSOpenGLView::initWithFrame_pixelFormat(
        NSOpenGLView::alloc(mtm),
        content_view.bounds(),
        Some(&pixel_format),
    )
    .ok_or("NSOpenGLView initWithFrame:pixelFormat: failed")?;
    let gl_context = gl_view
        .openGLContext()
        .ok_or("NSOpenGLView returned nil openGLContext")?;

    log_view_tree(&content_view);

    // The web view needs no drawsBackground call here. wry turns it off
    // itself because tauri.conf.json makes the window transparent.

    // Below with no relative view puts the GL view under every other
    // subview, the WKWebView included.
    content_view.addSubview_positioned_relativeTo(&gl_view, NSWindowOrderingMode::Below, None);

    tracing::info!("[macOS renderer] NSOpenGLView created (Core 3.2 profile)");
    Ok(Views {
        content_view,
        gl_view,
        gl_context,
    })
}

/// Logs the view tree at debug level, to show where the WKWebView sits.
fn log_view_tree(content_view: &NSView) {
    if !tracing::enabled!(tracing::Level::DEBUG) {
        return;
    }
    let class_name = |view: &NSView| view.class().name().to_string_lossy().into_owned();
    tracing::debug!(
        "[macOS renderer] content_view class = {}",
        class_name(content_view)
    );
    let subviews = content_view.subviews();
    tracing::debug!(
        "[macOS renderer] content_view has {} direct subviews",
        subviews.count()
    );
    for (i, subview) in subviews.iter().enumerate() {
        tracing::debug!(
            "[macOS renderer]   subview[{i}] = {} ({} children)",
            class_name(&subview),
            subview.subviews().count()
        );
    }
}

impl PlatformRenderer for MacosGlRenderer {
    fn attach(&mut self, mpv: &mut Mpv) -> Result<(), String> {
        let views = self.views.clone().ok_or("attach called after detach")?;
        let first_frame_cb = self
            .first_frame_cb
            .get_mut()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let video_active = self.video_active.clone();
        let mpv: &Mpv = mpv;

        // OpenGL setup has to run on the main thread with the context
        // current.
        let render = run_on_main(move |mtm| -> Result<_, String> {
            let Views {
                gl_view,
                gl_context,
                ..
            } = views.get(mtm);

            // Without the CGL drawable that prepareOpenGL sets up,
            // makeCurrentContext does nothing and mpv_render_context_create
            // returns Unsupported.
            gl_view.prepareOpenGL();
            let view: &NSView = gl_view;
            gl_context.setView(Some(view), mtm);
            gl_context.makeCurrentContext();

            // SAFETY: `detach` drops the render state on the main thread
            // before it returns, and `MpvState` detaches the renderer
            // before it stops the engine, so the context goes before mpv.
            let ctx = unsafe { GlRenderContext::new(mpv, get_proc_address) }?;

            let inner = RenderInner {
                ctx,
                gl_view: gl_view.clone(),
                gl_context: gl_context.clone(),
                first_frame_cb: Cell::new(first_frame_cb),
                video_active,
            };
            Ok(inner.into_shared(mtm))
        })?;

        self.render = Some(render);
        tracing::info!("[macOS renderer] render context attached");
        Ok(())
    }

    fn resize(&mut self, _width: u32, _height: u32) {
        // set_frame owns the view's frame, driven by the frontend's
        // ResizeObserver. Calling setFrame: here too races with it and makes x
        // jump between 0 and the sidebar width on each resize. The GL context
        // only needs `update` to pick up the new drawable size.
        let Some(views) = self.views.clone() else {
            return;
        };
        on_main_async(move |mtm| views.get(mtm).gl_context.update(mtm));
    }

    fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let Some(views) = self.views.clone() else {
            return;
        };
        on_main_async(move |mtm| {
            let Views {
                content_view: parent,
                gl_view,
                gl_context,
            } = views.get(mtm);
            // CSS pixels and AppKit points are the same unit. AppKit puts the
            // origin at the bottom left unless the view is flipped.
            let appkit_y = if parent.isFlipped() {
                y
            } else {
                // A transparent window with decorations gets fullSizeContentView
                // from wry, so the web view runs under the titlebar and its
                // bounds cover the whole window. getBoundingClientRect measures
                // from below the titlebar. contentLayoutRect is that same area,
                // so measuring from its height keeps the GL view from sitting
                // one titlebar height too high.
                let ref_height = match parent.window() {
                    Some(window) => window.contentLayoutRect().size.height,
                    None => parent.bounds().size.height,
                };
                ref_height - y - h
            };
            gl_view.setFrame(NSRect::new(NSPoint::new(x, appkit_y), NSSize::new(w, h)));
            gl_context.update(mtm);
        });
    }

    fn set_visible(&mut self, visible: bool) {
        // This takes effect without a hop to the main thread. While it is
        // false render_frame returns before rendering or flushing. Audio keeps
        // playing because CoreAudio doesn't depend on the render context.
        self.video_active.store(visible, Ordering::Release);

        let Some(views) = self.views.clone() else {
            return;
        };
        on_main_async(move |mtm| views.get(mtm).gl_view.setHidden(!visible));
    }

    fn set_first_frame_callback(&mut self, cb: Box<dyn FnOnce() + Send>) {
        *self
            .first_frame_cb
            .get_mut()
            .unwrap_or_else(|p| p.into_inner()) = Some(cb);
    }

    fn detach(&mut self) {
        let render = self.render.take();
        let Some(views) = self.views.take() else {
            return;
        };

        // mpv_render_context_free calls GL functions like
        // glDeleteFramebuffers, so the context has to be current when the
        // render state drops. Frames still queued on the main thread find the
        // render state gone and return.
        run_on_main(move |mtm| {
            let Views {
                gl_view,
                gl_context,
                ..
            } = views.get(mtm);
            gl_context.makeCurrentContext();
            drop(render);
            // The view and its context are freed once the last queued call
            // that holds them has run, so the main thread mustn't keep
            // pointing at the context.
            NSOpenGLContext::clearCurrentContext();
            gl_view.removeFromSuperview();
        });

        tracing::info!("[macOS renderer] detached");
    }
}

impl Drop for MacosGlRenderer {
    fn drop(&mut self) {
        self.detach();
    }
}

impl RenderInner {
    /// Moves the render state behind an `Arc` and points mpv's update
    /// callback at it.
    ///
    /// The callback holds a weak reference, so a frame queued after `detach`
    /// finds the state gone and the state can't keep itself alive.
    fn into_shared(mut self, mtm: MainThreadMarker) -> Arc<MainThreadBound<Self>> {
        Arc::new_cyclic(|weak: &Weak<MainThreadBound<Self>>| {
            let weak = weak.clone();
            // mpv calls this on its own threads, so it only queues the frame
            // for the main thread.
            self.ctx.set_update_callback(move || {
                let weak = weak.clone();
                on_main_async(move |mtm| {
                    if let Some(render) = weak.upgrade() {
                        render.get(mtm).render_frame(mtm);
                    }
                });
            });
            MainThreadBound::new(self, mtm)
        })
    }

    /// Renders one frame. The update callback queues it on the main thread.
    fn render_frame(&self, mtm: MainThreadMarker) {
        static FRAME_COUNT: AtomicU64 = AtomicU64::new(0);

        // set_visible(false) clears this while the player page is hidden. mpv
        // still calls back so its state stays current, but nothing is drawn.
        if !self.video_active.load(Ordering::Acquire) {
            return;
        }

        let view: &NSView = &self.gl_view;
        self.gl_context.setView(Some(view), mtm);
        self.gl_context.makeCurrentContext();

        let bounds = view.bounds();
        let scale = view
            .window()
            .map_or(1.0, |window| window.backingScaleFactor());
        let w = (bounds.size.width * scale) as i32;
        let h = (bounds.size.height * scale) as i32;
        if w < 1 || h < 1 {
            return;
        }

        match self.ctx.update() {
            Ok(flags) => {
                if flags & mpv_render_update::Frame != 0 {
                    // FBO 0 is the default framebuffer. GL's Y axis points up, so
                    // flip it.
                    if let Err(e) = self.ctx.render::<*mut c_void>(0, w, h, true) {
                        tracing::trace!("[macOS renderer] render error: {}", e);
                        return;
                    }
                    // mpv also calls back for updates that aren't frames. Flushing
                    // then would show whatever is left in the back buffer.
                    self.gl_context.flushBuffer();
                    self.ctx.report_swap();
                    let n = FRAME_COUNT.fetch_add(1, Ordering::Relaxed);
                    if n < 5 || n.is_multiple_of(60) {
                        tracing::debug!("[macOS renderer] frame presented (#{n})");
                    }
                    // Lets the frontend switch the web view from opaque to
                    // transparent.
                    if let Some(cb) = self.first_frame_cb.take() {
                        cb();
                    }
                }
            }
            Err(e) => tracing::trace!("[macOS renderer] update error: {}", e),
        }
    }
}

/// Options for embedded playback through the OpenGL render context.
pub fn embedded_options() -> Vec<(&'static str, &'static str)> {
    let mut options = vec![
        ("vo", "libmpv"),
        ("hwdec", "videotoolbox"),
        ("ao", "coreaudio"),
        ("video-sync", "display-resample"),
    ];
    options.extend(shared_options());
    options.push(("msg-level", "all=status"));
    options
}

/// Options for the separate fallback window.
///
/// mpv picks `vo=gpu` on its own. Leave its on-screen controller on, since
/// this window has no other controls.
pub fn fallback_options() -> Vec<(&'static str, &'static str)> {
    let mut options = vec![
        ("hwdec", "videotoolbox"),
        ("ao", "coreaudio"),
        ("video-sync", "display-resample"),
    ];
    options.extend(shared_options());
    options.push(("msg-level", "all=status"));
    options
}
