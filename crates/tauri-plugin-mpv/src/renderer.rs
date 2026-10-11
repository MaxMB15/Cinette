// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The contract each platform's video surface implements.
//!
//! Platform code lives in its own file and `mpv.rs` picks the type with
//! `#[cfg]`, so this file stays free of platform code.

use libmpv2::Mpv;

/// Embeds the libmpv video surface in the app window.
///
/// Implementations:
/// - `macos::MacosGlRenderer` draws through an OpenGL render context into an
///   NSOpenGLView below the web view.
/// - `linux::LinuxGlRenderer` draws through an EGL render context into a
///   Wayland subsurface below the web view.
/// - `ios::IosMetalRenderer` hands mpv a CAMetalLayer and lets mpv run its
///   own draw loop.
pub trait PlatformRenderer: Send + Sync {
    /// Sets up the video surface and connects it to `mpv`.
    ///
    /// Called once per stream load, after `mpv` is created with the platform
    /// options and before `loadfile`. On success video reaches the surface
    /// until `detach` is called.
    fn attach(&mut self, mpv: &mut Mpv) -> Result<(), String>;

    /// Updates the surface size after the window resizes.
    fn resize(&mut self, width: u32, height: u32);

    /// Moves and sizes the video surface to a rect in logical pixels.
    ///
    /// The frontend calls this to line the video up with the player area.
    fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64);

    /// Shows or hides the video surface without stopping playback.
    fn set_visible(&mut self, visible: bool);

    /// Register a one-shot callback fired when the first rendered frame is
    /// presented. Used by the frontend to make the WKWebView/WebKit layer
    /// transparent only after pixels arrive. Default no-op for platforms that
    /// set their callback on the concrete type prior to boxing.
    fn set_first_frame_callback(&mut self, _cb: Box<dyn FnOnce() + Send>) {}

    /// Tears down the surface. Must be safe to call more than once.
    fn detach(&mut self);
}
