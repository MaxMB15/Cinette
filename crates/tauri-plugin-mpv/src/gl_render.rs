// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The OpenGL render context that the macOS and Linux renderers share.

use libmpv2::{
    render::{OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType},
    Mpv,
};
use std::ffi::c_void;
use std::ops::Deref;

/// Looks up an OpenGL function by name for libmpv. The first argument is the
/// `ctx` of `OpenGLInitParams`, which is always null here.
pub(crate) type GetProcAddress = fn(&*mut c_void, &str) -> *mut c_void;

/// An mpv OpenGL render context that a renderer keeps for a whole session.
///
/// libmpv2 ties a `RenderContext` to a borrow of the `Mpv` it was made from.
/// `MpvEngine` owns that `Mpv` and the renderer lives in its own mutex in
/// `MpvState`, so the borrow can't be written down and this type holds the
/// context as `'static`. `new` documents the rule that makes that sound.
///
/// It derefs to the context for rendering but never hands out `&mut`, so the
/// context can't be moved out and dropped without the callback swap below.
pub(crate) struct GlRenderContext(RenderContext<'static>);

impl GlRenderContext {
    /// Creates the render context on the calling thread, which has to be the
    /// thread with the OpenGL context current.
    ///
    /// # Safety
    ///
    /// The returned value must be dropped before `mpv` is destroyed, because
    /// libmpv requires `mpv_render_context_free` to run before the core goes.
    /// `MpvState` keeps this rule by dropping the renderer, which drops this
    /// value before returning, before it stops the engine.
    pub(crate) unsafe fn new(mpv: &Mpv, get_proc_address: GetProcAddress) -> Result<Self, String> {
        let ctx = mpv
            .create_render_context([
                RenderParam::ApiType(RenderParamApiType::OpenGl),
                RenderParam::InitParams(OpenGLInitParams {
                    get_proc_address,
                    ctx: std::ptr::null_mut::<c_void>(),
                }),
            ])
            .map_err(|e| format!("mpv_render_context_create: {e}"))?;
        // SAFETY: the caller drops the context before `mpv` is destroyed, so
        // it never outlives the borrow the lifetime stood for.
        Ok(Self(unsafe {
            std::mem::transmute::<RenderContext<'_>, RenderContext<'static>>(ctx)
        }))
    }

    /// Sets the function libmpv calls when there is a new frame to render.
    /// It runs on one of mpv's threads, so it should only schedule the work.
    pub(crate) fn set_update_callback<F: Fn() + Send + 'static>(&mut self, callback: F) {
        self.0.set_update_callback(callback);
    }
}

impl Deref for GlRenderContext {
    type Target = RenderContext<'static>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for GlRenderContext {
    /// Swaps in an update callback that captures nothing before the context
    /// is freed.
    ///
    /// libmpv2 frees the callback before it calls `mpv_render_context_free`,
    /// and mpv's video output can still call the callback in between. A
    /// closure that captures nothing is zero sized, so freeing it frees no
    /// memory and a late call stays harmless. Replacing the callback is safe
    /// on its own, because libmpv2 6 sets the new one before it frees the old.
    fn drop(&mut self) {
        self.0.set_update_callback(|| {});
    }
}
