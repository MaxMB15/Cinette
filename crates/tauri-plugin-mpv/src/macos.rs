// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! macOS MPV embedding — NSOpenGLView with OpenGL Core 3.2 render context.
//!
//! Root cause fixes vs previous implementation:
//! - NSOpenGLProfileVersion3_2Core (not Legacy): source-built libmpv rejects the legacy profile
//! - NSOpenGLView manages its own context ([glView openGLContext]): no separate NSOpenGLContext alloc
//! - [glView prepareOpenGL] called in attach(): establishes CGL drawable; without it,
//!   mpv_render_context_create returns Unsupported
//!
//! Threading: ALL NSView/OpenGL calls must be on the main thread via dispatch::Queue::main().

#![allow(deprecated)] // cocoa crate uses deprecated NSOpenGL APIs; migration to objc2 deferred

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

/// Wrapper to pass non-Send types through dispatch queue boundaries.
/// Safety: caller guarantees main-thread-only access.
struct UnsafeSend<T>(T);
unsafe impl<T> Send for UnsafeSend<T> {}

/// Raw value for NSOpenGLProfileVersion3_2Core (not always exposed by cocoa 0.26).
const NS_OPENGL_PROFILE_VERSION_3_2_CORE: u32 = 0x3200;

// ---------------------------------------------------------------------------
// CGLGetProcAddress — resolves OpenGL function pointers for libmpv
// ---------------------------------------------------------------------------

/// Resolve an OpenGL function pointer on macOS.
///
/// `CGLGetProcAddress` only resolves CGL *extension* functions — it returns NULL
/// for every core OpenGL function (glClear, glViewport, etc.).
/// The correct approach on macOS is `dlsym` on the OpenGL framework, which
/// resolves both core functions and extensions.
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

// ---------------------------------------------------------------------------
// Render callback inner state (heap-stable, accessed from main thread only)
// ---------------------------------------------------------------------------

struct RenderInner {
    ctx: RenderContext,
    gl_view: *mut c_void,
    gl_context: *mut c_void,
    /// Called once when the first frame is rendered, then cleared.
    first_frame_cb: Option<Box<dyn FnOnce() + Send>>,
    /// Shared with MacosGlRenderer::set_visible; skips GPU calls when false.
    video_active: Arc<AtomicBool>,
}

unsafe impl Send for RenderInner {}

// ---------------------------------------------------------------------------
// MacosGlRenderer
// ---------------------------------------------------------------------------

/// Embeds libmpv video inside the Tauri window using NSOpenGLView + OpenGL Core 3.2.
///
/// Obj-C pointer fields are only accessed via dispatch::Queue::main(), ensuring
/// all AppKit calls happen on the main thread. The `valid` flag prevents callbacks
/// from firing after detach().
pub struct MacosGlRenderer {
    gl_view: *mut c_void,
    gl_context: *mut c_void,
    content_view: *mut c_void,
    valid: Arc<AtomicBool>,
    /// Heap-stable render state. Box address is captured in the update callback.
    render_inner: Option<Box<RenderInner>>,
    /// Called once on first rendered frame; moved into RenderInner during attach().
    first_frame_cb: Option<Box<dyn FnOnce() + Send>>,
    /// Controls whether GPU rendering happens. Toggled by set_visible().
    /// Starts true (video visible when player page is first entered).
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
            RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as *mut c_void,
            _ => return Err("Expected AppKit window handle".to_string()),
        };

        let ns_view_addr = ns_view_ptr as usize;
        Queue::main().exec_sync(move || unsafe { Self::build_on_main(ns_view_addr as *mut c_void) })
    }

    unsafe fn build_on_main(content_view_ptr: *mut c_void) -> Result<Self, String> {
        let _pool = NSAutoreleasePool::new(nil);
        let content_view = content_view_ptr as *mut objc::runtime::Object;
        let bounds: NSRect = NSView::bounds(content_view);

        // Core 3.2 profile. Source-built libmpv (with -Dgl=enabled) requires this.
        // NSOpenGLProfileVersionLegacy (0x1000) was the previous bug — libmpv rejects it.
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

        // Let NSOpenGLView create and manage its own OpenGL context.
        // Do NOT alloc a separate NSOpenGLContext — that was the second bug.
        let gl_view = NSOpenGLView::alloc(nil);
        let gl_view = NSOpenGLView::initWithFrame_pixelFormat_(gl_view, bounds, pixel_format);
        if gl_view == nil {
            return Err("NSOpenGLView initWithFrame:pixelFormat: failed".to_string());
        }

        // Retrieve the view's internally managed context.
        let gl_context: *mut objc::runtime::Object = msg_send![gl_view, openGLContext];
        if gl_context.is_null() {
            return Err("NSOpenGLView returned nil openGLContext".to_string());
        }

        // --- Diagnostic: log the view hierarchy to find where WKWebView lives ---
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

        // WKWebView transparency is handled by "transparent": true in tauri.conf.json.
        // wry calls [webView setValue:@NO forKey:@"drawsBackground"] during initialization
        // when the window is configured as transparent, so no manual call is needed here.

        // Position our view BELOW the WKWebView (NSWindowBelow = -1).
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

        // All OpenGL setup must be on the main thread.
        // RenderContext is not Send, so we wrap it in UnsafeSend to cross the dispatch boundary.
        let gl_view_ptr = gl_view as usize;
        let gl_context_ptr = gl_context as usize;
        // SAFETY: mpv.ctx is valid for the duration of this sync call; we're on main thread.
        let mpv_ctx_addr = mpv.ctx.as_ptr() as usize;

        let result: UnsafeSend<Result<RenderContext, String>> =
            Queue::main().exec_sync(move || -> UnsafeSend<Result<RenderContext, String>> {
                let view = gl_view_ptr as *mut objc::runtime::Object;
                let ctx = gl_context_ptr as *mut objc::runtime::Object;
                // Type inferred from RenderContext::new signature; no need to name libmpv2_sys.
                let mpv_ctx = mpv_ctx_addr as *mut _;

                unsafe {
                    // prepareOpenGL establishes the CGL drawable.
                    // This was the critical missing step: without it, makeCurrentContext
                    // is a no-op and mpv_render_context_create returns Unsupported.
                    let _: () = msg_send![view, prepareOpenGL];

                    // Associate context with view and make it current.
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

        // Heap-allocate the inner state for a stable address captured by the callback.
        let mut inner = Box::new(RenderInner {
            ctx: render_ctx,
            gl_view,
            gl_context,
            first_frame_cb: self.first_frame_cb.take(),
            video_active: self.video_active.clone(),
        });

        // The raw pointer into the Box contents is stable (heap address never changes).
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
        // The frame is owned exclusively by set_frame() (driven by the JS ResizeObserver).
        // We must NOT call setFrame: here — that races with set_frame() and causes the
        // x position to toggle between 0 and sidebar_width on every resize event.
        // Only [ctx update] is needed to inform the GL context the drawable geometry changed.
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
            // CSS / AppKit points share the same logical pixel space.
            // AppKit's Y origin is bottom-left in non-flipped views; flip Y if needed.
            let is_flipped: bool = msg_send![parent, isFlipped];
            let appkit_y = if is_flipped {
                y
            } else {
                // With transparent+decorations, wry sets fullSizeContentView so the
                // WKWebView (ns_view) extends under the titlebar — bounds.size.height
                // equals the full window height. But CSS getBoundingClientRect() measures
                // from the layout viewport which excludes the titlebar area (matching
                // 100vh). Using bounds.size.height produces an offset equal to the
                // titlebar height, shifting the GL view up and leaving a gap at the bottom.
                // contentLayoutRect gives the usable content area height below the titlebar,
                // matching the CSS viewport reference.
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
        // Stop GPU rendering immediately (atomic, no dispatch needed).
        // When false: render_frame early-returns, skipping rc.render() + flushBuffer.
        // Audio continues unaffected (CoreAudio is independent of the render context).
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
        // Signal all queued callbacks to bail before we free the render state.
        self.valid.store(false, Ordering::Release);

        let gl_view_ptr = self.gl_view as usize;
        let gl_context_ptr = self.gl_context as usize;

        // Take ownership of render_inner here. The heap-stable inner_ptr captured by
        // any queued render_frame closures remains valid until this Box is dropped —
        // which we defer until we're on the main thread with the GL context current.
        let render_inner = self.render_inner.take();

        // Run cleanup on the main thread:
        //   1. drain any pending render_frame closures (exec_sync runs after all
        //      previously-queued exec_async items, valid=false so they early-return)
        //   2. make GL context current so mpv_render_context_free() can call
        //      glDeleteFramebuffers / gl_tex_destroy etc. safely
        //   3. drop RenderContext → mpv_render_context_free()
        //   4. remove the NSOpenGLView from the window hierarchy
        Queue::main().exec_sync(move || unsafe {
            if gl_context_ptr != 0 {
                let ctx = gl_context_ptr as *mut objc::runtime::Object;
                cocoa::appkit::NSOpenGLContext::makeCurrentContext(ctx);
            }
            // Drop RenderContext (→ mpv_render_context_free) with GL context current.
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

// ---------------------------------------------------------------------------
// Per-frame rendering — main thread only
// ---------------------------------------------------------------------------

/// Render one frame. Called on the main thread by the update callback.
/// Safety: caller must verify `valid = true`; `inner_ptr` must be live (owned by MacosGlRenderer).
unsafe fn render_frame(inner_ptr: usize) {
    static FRAME_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let inner = &mut *(inner_ptr as *mut RenderInner);

    // Skip GPU work when the player page is not active (set_visible(false) clears this flag).
    // MPV's update callback still fires so internal state stays consistent; we just don't
    // submit OpenGL commands or flip the back buffer.
    if !inner.video_active.load(Ordering::Acquire) {
        return;
    }

    let view = inner.gl_view as *mut objc::runtime::Object;
    let ctx = inner.gl_context as *mut objc::runtime::Object;
    let rc = &inner.ctx as *const RenderContext; // raw ptr so we can also mutably borrow inner below

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
                // fbo=0 = default framebuffer. flip_y=true corrects GL's inverted Y axis.
                if let Err(e) = rc.render::<*mut c_void>(0, w, h, true) {
                    tracing::trace!("[macOS renderer] render error: {}", e);
                    return;
                }
                // Only present and report swap after actually rendering a frame.
                // Unconditional flushBuffer would show undefined back-buffer contents
                // when the update callback fires for non-frame events.
                cocoa::appkit::NSOpenGLContext::flushBuffer(ctx);
                rc.report_swap();
                let n = FRAME_COUNT.fetch_add(1, Ordering::Relaxed);
                if n < 5 || n % 60 == 0 {
                    tracing::debug!("[macOS renderer] frame presented (#{n})");
                }
                // Notify on first frame so the frontend can switch from opaque to transparent.
                if let Some(cb) = inner.first_frame_cb.take() {
                    cb();
                }
            }
        }
        Err(e) => tracing::trace!("[macOS renderer] update error: {}", e),
    }
}

// ---------------------------------------------------------------------------
// MPV option sets for macOS
// ---------------------------------------------------------------------------

/// FFmpeg lavf reconnect options shared by every macOS option set.
///
/// IPTV streams are HTTP/HLS-based and FFmpeg does NOT auto-reconnect by
/// default. Without these, a transient network drop causes the demuxer to
/// hit EOF and playback freezes forever (mpv just sits at the last frame
/// because `keep-open=yes`). With these set, FFmpeg transparently retries
/// the underlying HTTP read with exponential backoff capped at
/// `reconnect_delay_max` seconds.
///
/// - `reconnect=1` — enable auto-reconnect for HTTP-backed protocols
/// - `reconnect_streamed=1` — required for live (non-seekable) streams
/// - `reconnect_on_network_error=1` — reconnect on TCP/socket errors
/// - `reconnect_delay_max=5` — cap retry backoff at 5 s (was 30 s; smaller
///   value makes recovery far snappier once the network returns, at the
///   cost of slightly more retry attempts during a real outage).
///
/// We rely on `paused-for-cache` observation in `reconnect.rs` to surface
/// the stall to the UI while these retries run silently underneath.
const LAVF_RECONNECT_OPTS: &str =
    "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5";

/// Options for embedded playback via OpenGL render context (vo=libmpv).
pub fn embedded_options() -> Vec<(&'static str, &'static str)> {
    vec![
        ("vo", "libmpv"),
        ("hwdec", "videotoolbox"),
        ("ao", "coreaudio"),
        ("video-sync", "display-resample"),
        ("cache", "yes"),
        ("cache-secs", "30"),
        ("demuxer-max-bytes", "150MiB"),
        ("demuxer-max-back-bytes", "75MiB"),
        ("stream-lavf-o", LAVF_RECONNECT_OPTS),
        ("network-timeout", "30"),
        // Keep the last frame visible at EOF instead of going idle.
        // This lets the frontend detect EOF via position proximity and show controls.
        ("keep-open", "yes"),
        ("terminal", "yes"),
        ("msg-level", "all=status"),
    ]
}

/// Options for fallback separate window (vo=gpu, native OSC shown automatically).
pub fn fallback_options() -> Vec<(&'static str, &'static str)> {
    vec![
        ("hwdec", "videotoolbox"),
        ("ao", "coreaudio"),
        ("video-sync", "display-resample"),
        ("cache", "yes"),
        ("cache-secs", "30"),
        ("demuxer-max-bytes", "150MiB"),
        ("demuxer-max-back-bytes", "75MiB"),
        ("stream-lavf-o", LAVF_RECONNECT_OPTS),
        ("network-timeout", "30"),
        ("keep-open", "yes"),
        ("terminal", "yes"),
        ("msg-level", "all=status"),
        // vo=gpu is the default; do NOT add --no-osc so native controls are visible.
    ]
}
