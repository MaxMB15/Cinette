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
//! Every NSView and OpenGL call has to run on the main thread, through
//! `dispatch::Queue::main()`.

// The cocoa crate's NSOpenGL bindings are deprecated in favor of objc2.
#![allow(deprecated)]

use crate::options::shared_options;
use crate::renderer::PlatformRenderer;
use cocoa::appkit::{NSOpenGLPixelFormat, NSOpenGLView, NSView};
use cocoa::base::nil;
use cocoa::foundation::{NSAutoreleasePool, NSRect};
use dispatch::Queue;
use libmpv2::{
    render::{mpv_render_update, OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType},
    Mpv,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::ffi::{c_char, c_void, CString};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager, Runtime};

/// Carries a value that isn't `Send` across a dispatch queue boundary.
///
/// Only use it for values that the main thread alone touches.
struct UnsafeSend<T>(T);
unsafe impl<T> Send for UnsafeSend<T> {}

/// Raw value of `NSOpenGLProfileVersion3_2Core`, which cocoa 0.26 doesn't always export.
const NS_OPENGL_PROFILE_VERSION_3_2_CORE: u32 = 0x3200;

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

/// Render state that the update callback reaches through a raw pointer.
///
/// It lives in a `Box` so its address doesn't move, and only the main thread
/// touches it.
struct RenderInner {
    ctx: RenderContext,
    gl_view: *mut c_void,
    gl_context: *mut c_void,
    /// Called once when the first frame is rendered, then cleared.
    first_frame_cb: Option<Box<dyn FnOnce() + Send>>,
    /// Shared with `MacosGlRenderer::set_visible`. Rendering skips the GPU
    /// calls while it is false.
    video_active: Arc<AtomicBool>,
}

unsafe impl Send for RenderInner {}

/// Embeds libmpv video in the Tauri window with an NSOpenGLView and OpenGL
/// Core 3.2.
///
/// The Obj-C pointer fields are only used inside `dispatch::Queue::main()`
/// closures, so AppKit only sees them on the main thread. `valid` stops
/// queued callbacks from running after `detach`.
pub struct MacosGlRenderer {
    gl_view: *mut c_void,
    gl_context: *mut c_void,
    content_view: *mut c_void,
    valid: Arc<AtomicBool>,
    /// Boxed so the address the update callback holds stays valid.
    render_inner: Option<Box<RenderInner>>,
    /// Runs once on the first rendered frame. `attach` moves it into
    /// `RenderInner`.
    first_frame_cb: Option<Box<dyn FnOnce() + Send>>,
    /// Whether to render at all. `set_visible` toggles it. It starts true
    /// because the player page is showing when playback starts.
    video_active: Arc<AtomicBool>,
}

unsafe impl Send for MacosGlRenderer {}
unsafe impl Sync for MacosGlRenderer {}

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

        let ns_view_ptr = match raw {
            RawWindowHandle::AppKit(h) => h.ns_view.as_ptr(),
            _ => return Err("Expected AppKit window handle".to_string()),
        };

        let ns_view_addr = ns_view_ptr as usize;
        Queue::main().exec_sync(move || unsafe { Self::build_on_main(ns_view_addr as *mut c_void) })
    }

    unsafe fn build_on_main(content_view_ptr: *mut c_void) -> Result<Self, String> {
        let _pool = NSAutoreleasePool::new(nil);
        let content_view = content_view_ptr as *mut objc::runtime::Object;
        let bounds: NSRect = NSView::bounds(content_view);

        // libmpv built from source with -Dgl=enabled rejects the legacy profile.
        let attrs: [u32; 5] = [
            cocoa::appkit::NSOpenGLPFAOpenGLProfile as u32,
            NS_OPENGL_PROFILE_VERSION_3_2_CORE,
            cocoa::appkit::NSOpenGLPFADoubleBuffer as u32,
            cocoa::appkit::NSOpenGLPFAAccelerated as u32,
            0,
        ];
        let pixel_format = NSOpenGLPixelFormat::alloc(nil);
        let pixel_format = NSOpenGLPixelFormat::initWithAttributes_(pixel_format, &attrs);
        if pixel_format == nil {
            return Err(
                "NSOpenGLPixelFormat (Core 3.2) init failed — check OpenGL availability"
                    .to_string(),
            );
        }

        // Use the context the view creates and owns rather than allocating a
        // separate NSOpenGLContext.
        let gl_view = NSOpenGLView::alloc(nil);
        let gl_view = NSOpenGLView::initWithFrame_pixelFormat_(gl_view, bounds, pixel_format);
        if gl_view == nil {
            return Err("NSOpenGLView initWithFrame:pixelFormat: failed".to_string());
        }

        let gl_context: *mut objc::runtime::Object = msg_send![gl_view, openGLContext];
        if gl_context.is_null() {
            return Err("NSOpenGLView returned nil openGLContext".to_string());
        }

        // Logs the view tree at debug level, to show where the WKWebView sits.
        {
            let class_ns: *mut objc::runtime::Object = msg_send![content_view, className];
            let class_ptr: *const c_char = msg_send![class_ns, UTF8String];
            let cv_name = if class_ptr.is_null() {
                "?"
            } else {
                std::ffi::CStr::from_ptr(class_ptr).to_str().unwrap_or("?")
            };
            tracing::debug!("[macOS renderer] content_view class = {cv_name}");

            let subs: *mut objc::runtime::Object = msg_send![content_view, subviews];
            let n: usize = msg_send![subs, count];
            tracing::debug!("[macOS renderer] content_view has {n} direct subviews");
            for i in 0..n {
                let sv: *mut objc::runtime::Object = msg_send![subs, objectAtIndex: i];
                let sv_class_ns: *mut objc::runtime::Object = msg_send![sv, className];
                let sv_ptr: *const c_char = msg_send![sv_class_ns, UTF8String];
                let sv_name = if sv_ptr.is_null() {
                    "?"
                } else {
                    std::ffi::CStr::from_ptr(sv_ptr).to_str().unwrap_or("?")
                };
                let sub_subs: *mut objc::runtime::Object = msg_send![sv, subviews];
                let sub_count: usize = msg_send![sub_subs, count];
                tracing::debug!(
                    "[macOS renderer]   subview[{i}] = {sv_name} ({sub_count} children)"
                );
            }
        }

        // The web view needs no drawsBackground call here. wry turns it off
        // itself because tauri.conf.json makes the window transparent.

        // -1 is NSWindowBelow, which puts the GL view under the WKWebView.
        let _: () = msg_send![
            content_view,
            addSubview: gl_view
            positioned: -1i64
            relativeTo: nil
        ];

        tracing::info!("[macOS renderer] NSOpenGLView created (Core 3.2 profile)");
        Ok(Self {
            gl_view: gl_view as *mut c_void,
            gl_context: gl_context as *mut c_void,
            content_view: content_view as *mut c_void,
            valid: Arc::new(AtomicBool::new(true)),
            render_inner: None,
            first_frame_cb: None,
            video_active: Arc::new(AtomicBool::new(true)),
        })
    }
}

impl PlatformRenderer for MacosGlRenderer {
    fn attach(&mut self, mpv: &mut Mpv) -> Result<(), String> {
        let gl_view = self.gl_view;
        let gl_context = self.gl_context;

        // OpenGL setup has to run on the main thread. RenderContext isn't Send,
        // so it comes back wrapped in UnsafeSend.
        let gl_view_ptr = gl_view as usize;
        let gl_context_ptr = gl_context as usize;
        // SAFETY: exec_sync blocks until the closure finishes and `mpv` stays
        // borrowed for the whole call, so the pointer is valid inside it.
        let mpv_ctx_addr = mpv.ctx.as_ptr() as usize;

        let result: UnsafeSend<Result<RenderContext, String>> =
            Queue::main().exec_sync(move || -> UnsafeSend<Result<RenderContext, String>> {
                let view = gl_view_ptr as *mut objc::runtime::Object;
                let ctx = gl_context_ptr as *mut objc::runtime::Object;
                // RenderContext::new fixes the pointer type, which saves naming
                // libmpv2_sys.
                let mpv_ctx = mpv_ctx_addr as *mut _;

                unsafe {
                    // Without the CGL drawable that prepareOpenGL sets up,
                    // makeCurrentContext does nothing and
                    // mpv_render_context_create returns Unsupported.
                    let _: () = msg_send![view, prepareOpenGL];

                    cocoa::appkit::NSOpenGLContext::setView_(ctx, view);
                    cocoa::appkit::NSOpenGLContext::makeCurrentContext(ctx);
                }

                fn get_proc_address(_ctx: &*mut c_void, name: &str) -> *mut c_void {
                    match CString::new(name) {
                        Ok(c) => gl_get_proc_address(c.as_ptr()),
                        Err(_) => std::ptr::null_mut(),
                    }
                }

                UnsafeSend(
                    RenderContext::new(
                        unsafe { &mut *mpv_ctx },
                        vec![
                            RenderParam::ApiType(RenderParamApiType::OpenGl),
                            RenderParam::InitParams(OpenGLInitParams {
                                get_proc_address,
                                ctx: std::ptr::null_mut(),
                            }),
                        ],
                    )
                    .map_err(|e| format!("mpv_render_context_create: {}", e)),
                )
            });
        let render_ctx: RenderContext = result.0?;

        // Boxed so the address the update callback holds doesn't move.
        let mut inner = Box::new(RenderInner {
            ctx: render_ctx,
            gl_view,
            gl_context,
            first_frame_cb: self.first_frame_cb.take(),
            video_active: self.video_active.clone(),
        });

        let inner_ptr = &*inner as *const RenderInner as usize;
        let valid = self.valid.clone();

        inner.ctx.set_update_callback(move || {
            let v = valid.clone();
            Queue::main().exec_async(move || {
                if !v.load(Ordering::Acquire) {
                    return;
                }
                unsafe { render_frame(inner_ptr) };
            });
        });

        self.render_inner = Some(inner);
        tracing::info!("[macOS renderer] render context attached");
        Ok(())
    }

    fn resize(&mut self, _width: u32, _height: u32) {
        // set_frame owns the view's frame, driven by the frontend's
        // ResizeObserver. Calling setFrame: here too races with it and makes x
        // jump between 0 and the sidebar width on each resize. The GL context
        // only needs `update` to pick up the new drawable size.
        let gl_context_ptr = self.gl_context as usize;
        Queue::main().exec_async(move || unsafe {
            let ctx = gl_context_ptr as *mut objc::runtime::Object;
            let _: () = msg_send![ctx, update];
        });
    }

    fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let gl_view_ptr = self.gl_view as usize;
        let gl_context_ptr = self.gl_context as usize;
        let content_view_ptr = self.content_view as usize;
        Queue::main().exec_async(move || unsafe {
            let view = gl_view_ptr as *mut objc::runtime::Object;
            let ctx = gl_context_ptr as *mut objc::runtime::Object;
            let parent = content_view_ptr as *mut objc::runtime::Object;
            // CSS pixels and AppKit points are the same unit. AppKit puts the
            // origin at the bottom left unless the view is flipped.
            let is_flipped: bool = msg_send![parent, isFlipped];
            let appkit_y = if is_flipped {
                y
            } else {
                // A transparent window with decorations gets fullSizeContentView
                // from wry, so the web view runs under the titlebar and its
                // bounds cover the whole window. getBoundingClientRect measures
                // from below the titlebar. contentLayoutRect is that same area,
                // so measuring from its height keeps the GL view from sitting
                // one titlebar height too high.
                let window: *mut objc::runtime::Object = msg_send![parent, window];
                let ref_height: f64 = if !window.is_null() {
                    let layout_rect: NSRect = msg_send![window, contentLayoutRect];
                    layout_rect.size.height
                } else {
                    let bounds: NSRect = NSView::bounds(parent);
                    bounds.size.height
                };
                ref_height - y - h
            };
            use cocoa::foundation::NSPoint;
            let frame = NSRect::new(
                NSPoint::new(x, appkit_y),
                cocoa::foundation::NSSize::new(w, h),
            );
            let _: () = msg_send![view, setFrame: frame];
            let _: () = msg_send![ctx, update];
        });
    }

    fn set_visible(&mut self, visible: bool) {
        // This takes effect without a hop to the main thread. While it is
        // false render_frame returns before rendering or flushing. Audio keeps
        // playing because CoreAudio doesn't depend on the render context.
        self.video_active.store(visible, Ordering::Release);

        let gl_view_ptr = self.gl_view as usize;
        if gl_view_ptr == 0 {
            return;
        }
        Queue::main().exec_async(move || unsafe {
            let view = gl_view_ptr as *mut objc::runtime::Object;
            let hidden: bool = !visible;
            let _: () = msg_send![view, setHidden: hidden];
        });
    }

    fn set_first_frame_callback(&mut self, cb: Box<dyn FnOnce() + Send>) {
        self.first_frame_cb = Some(cb);
    }

    fn detach(&mut self) {
        // Queued callbacks check this and return before the render state is
        // freed.
        self.valid.store(false, Ordering::Release);

        let gl_view_ptr = self.gl_view as usize;
        let gl_context_ptr = self.gl_context as usize;

        // Queued render_frame closures hold a pointer into this Box, so it is
        // only dropped on the main thread below.
        let render_inner = self.render_inner.take();

        // exec_sync runs after every render_frame closure already queued, and
        // those return early now that `valid` is false. mpv_render_context_free
        // calls GL functions like glDeleteFramebuffers, so the context has to
        // be current when the render state drops.
        Queue::main().exec_sync(move || unsafe {
            if gl_context_ptr != 0 {
                let ctx = gl_context_ptr as *mut objc::runtime::Object;
                cocoa::appkit::NSOpenGLContext::makeCurrentContext(ctx);
            }
            drop(render_inner);
            if gl_view_ptr != 0 {
                let view = gl_view_ptr as *mut objc::runtime::Object;
                let _: () = msg_send![view, removeFromSuperview];
            }
        });

        self.gl_view = std::ptr::null_mut();
        tracing::info!("[macOS renderer] detached");
    }
}

impl Drop for MacosGlRenderer {
    fn drop(&mut self) {
        self.detach();
    }
}

/// Renders one frame. The update callback calls it on the main thread.
///
/// # Safety
///
/// The caller checks `valid` first, and `inner_ptr` must point at the
/// `RenderInner` that `MacosGlRenderer` still owns.
unsafe fn render_frame(inner_ptr: usize) {
    static FRAME_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let inner = &mut *(inner_ptr as *mut RenderInner);

    // set_visible(false) clears this while the player page is hidden. mpv
    // still calls back so its state stays current, but nothing is drawn.
    if !inner.video_active.load(Ordering::Acquire) {
        return;
    }

    let view = inner.gl_view as *mut objc::runtime::Object;
    let ctx = inner.gl_context as *mut objc::runtime::Object;
    // A raw pointer, so `inner` can still be borrowed mutably for first_frame_cb.
    let rc = &inner.ctx as *const RenderContext;

    cocoa::appkit::NSOpenGLContext::setView_(ctx, view);
    cocoa::appkit::NSOpenGLContext::makeCurrentContext(ctx);

    let bounds: NSRect = NSView::bounds(view);
    let window: *mut objc::runtime::Object = msg_send![view, window];
    let scale: f64 = if window.is_null() {
        1.0
    } else {
        msg_send![window, backingScaleFactor]
    };
    let w = (bounds.size.width * scale) as i32;
    let h = (bounds.size.height * scale) as i32;
    if w < 1 || h < 1 {
        return;
    }

    let rc: &RenderContext = &*rc;
    match rc.update() {
        Ok(flags) => {
            if flags & mpv_render_update::Frame != 0 {
                // FBO 0 is the default framebuffer. GL's Y axis points up, so
                // flip it.
                if let Err(e) = rc.render::<*mut c_void>(0, w, h, true) {
                    tracing::trace!("[macOS renderer] render error: {}", e);
                    return;
                }
                // mpv also calls back for updates that aren't frames. Flushing
                // then would show whatever is left in the back buffer.
                cocoa::appkit::NSOpenGLContext::flushBuffer(ctx);
                rc.report_swap();
                let n = FRAME_COUNT.fetch_add(1, Ordering::Relaxed);
                if n < 5 || n.is_multiple_of(60) {
                    tracing::debug!("[macOS renderer] frame presented (#{n})");
                }
                // Lets the frontend switch the web view from opaque to
                // transparent.
                if let Some(cb) = inner.first_frame_cb.take() {
                    cb();
                }
            }
        }
        Err(e) => tracing::trace!("[macOS renderer] update error: {}", e),
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
