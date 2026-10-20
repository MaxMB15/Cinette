// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! MPEG-TS for tests, written by `test-media/test_media.c` with the
//! system's FFmpeg and libx264.

use std::ffi::{c_char, c_int, CString};
use std::path::Path;

unsafe extern "C" {
    fn cinette_test_write_ts(
        path: *const c_char,
        seconds: f64,
        h264: c_int,
        gop: c_int,
        channels: c_int,
        ts_offset: f64,
    ) -> c_int;
}

/// What to write.
#[derive(Debug, Clone, Copy)]
pub struct Media {
    pub seconds: f64,
    /// 64x64 H.264 at 25 frames a second.
    pub h264: bool,
    /// Frames from one keyframe to the next.
    pub gop: i32,
    /// MP2 audio with this many channels at 48 kHz, or none for 0.
    pub channels: i32,
    /// Seconds added to every timestamp.
    pub ts_offset: f64,
}

impl Default for Media {
    /// Four seconds of H.264 with a keyframe a second, and stereo MP2.
    fn default() -> Self {
        Self {
            seconds: 4.0,
            h264: true,
            gop: 25,
            channels: 2,
            ts_offset: 0.0,
        }
    }
}

/// Writes `media` to `path` as MPEG-TS. Panics when it can't, such as
/// without libx264.
pub fn write_ts(path: &Path, media: &Media) {
    let c_path = CString::new(path.to_string_lossy().as_bytes()).expect("a path without NUL");
    let code = unsafe {
        cinette_test_write_ts(
            c_path.as_ptr(),
            media.seconds,
            c_int::from(media.h264),
            media.gop,
            media.channels,
            media.ts_offset,
        )
    };
    assert_ne!(code, -2, "the system's FFmpeg has no libx264 encoder");
    assert_eq!(code, 0, "couldn't write test media to {}", path.display());
}

/// `media` as MPEG-TS bytes, written through a file in `dir`.
pub fn ts_bytes(dir: &Path, media: &Media) -> Vec<u8> {
    let path = dir.join("media.ts");
    write_ts(&path, media);
    std::fs::read(&path).expect("read the test media back")
}
