// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What a surface callback on Android means for mpv. Only Android uses it,
//! but it builds for tests on every target. `android.rs` talks to the JVM and
//! to mpv.

/// Whether a `surfaceChanged` call only resized the surface mpv already has.
///
/// A new `wid` makes mpv rebuild its video output, so the picture goes black
/// and a live stream buffers again. A resize only needs a new
/// `android-surface-size`.
///
/// Each call brings a new JNI reference, even for the same `Surface`, so the
/// references can't be compared. `same_object` asks the JVM, and only runs
/// when there's a surface on both sides.
pub fn only_resized<C, R>(
    current: Option<&C>,
    reported: Option<&R>,
    same_object: impl FnOnce(&C, &R) -> bool,
) -> bool {
    match (current, reported) {
        (Some(current), Some(reported)) => same_object(current, reported),
        _ => false,
    }
}

/// mpv's `android-surface-size` for a surface of `width` by `height` pixels.
pub fn surface_size(width: i32, height: i32) -> String {
    format!("{width}x{height}")
}

#[cfg(test)]
mod tests;
