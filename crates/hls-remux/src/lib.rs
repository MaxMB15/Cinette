// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Converts a stream into MPEG-TS segments in memory, for HLS, through the
//! C in `native/remux.c`. It copies the video, and copies or converts one
//! audio track to stereo AAC.
//!
//! iOS links the C from the app target, built against MPVKit's FFmpeg.
//! Linux builds it against the system's FFmpeg for the tests. Nothing else
//! uses this crate, so it's empty on other platforms.
//!
//! The source URL carries the provider's login. It goes to the C as it is,
//! and nothing here logs it or puts it in an error.

#![cfg(any(target_os = "linux", target_os = "ios"))]

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::panic::{self, AssertUnwindSafe};
use std::ptr::NonNull;
use std::sync::Arc;

#[cfg(test)]
mod tests;

mod ffi {
    use std::ffi::{c_char, c_int, c_void};

    #[repr(C)]
    pub struct CinetteRemux {
        _private: [u8; 0],
    }

    #[repr(C)]
    pub struct CinetteAudioTrack {
        pub codec: *const c_char,
        pub language: *const c_char,
        pub is_default: c_int,
    }

    pub type WriteFn = extern "C" fn(*mut c_void, *const u8, c_int);
    pub type CutFn = extern "C" fn(*mut c_void, f64) -> c_int;

    unsafe extern "C" {
        pub fn cinette_remux_open(
            url: *const c_char,
            start: f64,
            user_agent: *const c_char,
            out: *mut *mut CinetteRemux,
        ) -> c_int;
        pub fn cinette_remux_audio_count(r: *const CinetteRemux) -> c_int;
        pub fn cinette_remux_audio_track(r: *const CinetteRemux, index: c_int)
            -> CinetteAudioTrack;
        pub fn cinette_remux_video(
            r: *const CinetteRemux,
            extradata: *mut *const u8,
            size: *mut c_int,
        ) -> c_int;
        pub fn cinette_remux_duration(r: *const CinetteRemux) -> f64;
        pub fn cinette_remux_start(
            r: *mut CinetteRemux,
            audio: c_int,
            audio_mode: c_int,
            downmix: c_int,
            segment: f64,
            write: WriteFn,
            cut: CutFn,
            ctx: *mut c_void,
        ) -> c_int;
        pub fn cinette_remux_run(r: *mut CinetteRemux) -> c_int;
        pub fn cinette_remux_cancel(r: *mut CinetteRemux);
        pub fn cinette_remux_close(r: *mut CinetteRemux);
    }
}

const UNREACHABLE: c_int = -1;
const REFUSED: c_int = -2;
const CANCELLED: c_int = -4;
const AUDIO_COPY: c_int = 0;
const AUDIO_AAC: c_int = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemuxError {
    /// The source couldn't be opened or read.
    Unreachable,
    /// The provider answered 401 or 403.
    Refused,
    /// Something on this device failed, such as an encoder.
    Failed,
    /// It was cancelled, or the sink asked it to stop.
    Cancelled,
}

impl std::fmt::Display for RemuxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            RemuxError::Unreachable => "couldn't reach the stream",
            RemuxError::Refused => "the provider refused the stream",
            RemuxError::Failed => "the converter failed",
            RemuxError::Cancelled => "the conversion was stopped",
        })
    }
}

impl std::error::Error for RemuxError {}

fn check(code: c_int) -> Result<(), RemuxError> {
    match code {
        0 => Ok(()),
        UNREACHABLE => Err(RemuxError::Unreachable),
        REFUSED => Err(RemuxError::Refused),
        CANCELLED => Err(RemuxError::Cancelled),
        _ => Err(RemuxError::Failed),
    }
}

/// One of the source's audio streams.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioTrack {
    /// FFmpeg's codec name, such as `aac` or `ac3`.
    pub codec: String,
    pub language: Option<String>,
    pub default: bool,
}

/// What the source's video is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Video {
    None,
    H264,
    Hevc,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Audio {
    /// No audio.
    None,
    /// Copy audio stream `n`, counting the audio streams from 0.
    Copy(usize),
    /// Convert audio stream `n` to stereo AAC. `downmix` asks the decoder
    /// for stereo itself, which AC-3, E-AC-3 and DTS decoders do with the
    /// stream's own levels.
    Aac { track: usize, downmix: bool },
}

/// Where the segments go.
pub trait Sink {
    /// The next bytes of MPEG-TS.
    fn write(&mut self, bytes: &[u8]);
    /// The segment written since the last cut is `duration` seconds long.
    /// This may block while the receiver catches up. Returns false to stop.
    fn cut(&mut self, duration: f64) -> bool;
}

/// The C handle. Only [`Source::run`] uses it on one thread at a time;
/// cancelling is an atomic store, which any thread may do.
struct Handle(NonNull<ffi::CinetteRemux>);

// SAFETY: the C object has no thread affinity. `Source` gives out `&mut`
// access only through `run`, which takes `&mut self`, and the one call
// other threads make, `cinette_remux_cancel`, only stores an atomic.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { ffi::cinette_remux_close(self.0.as_ptr()) };
    }
}

/// Stops a running conversion from another thread.
#[derive(Clone)]
pub struct Canceller(Arc<Handle>);

impl Canceller {
    pub fn cancel(&self) {
        unsafe { ffi::cinette_remux_cancel(self.0 .0.as_ptr()) };
    }
}

/// An opened source, before or while it converts.
pub struct Source {
    handle: Arc<Handle>,
}

impl Source {
    /// Opens `url`, starting `start` seconds in when it's above 0. Blocks
    /// while it connects and reads the stream's layout.
    pub fn open(url: &str, start: f64, user_agent: Option<&str>) -> Result<Self, RemuxError> {
        let url = CString::new(url).map_err(|_| RemuxError::Unreachable)?;
        let agent = user_agent.and_then(|a| CString::new(a).ok());
        let mut raw = std::ptr::null_mut();
        let code = unsafe {
            ffi::cinette_remux_open(
                url.as_ptr(),
                start,
                agent.as_ref().map_or(std::ptr::null(), |a| a.as_ptr()),
                &mut raw,
            )
        };
        check(code)?;
        let raw = NonNull::new(raw).ok_or(RemuxError::Failed)?;
        Ok(Self {
            handle: Arc::new(Handle(raw)),
        })
    }

    fn raw(&self) -> *mut ffi::CinetteRemux {
        self.handle.0.as_ptr()
    }

    pub fn audio_tracks(&self) -> Vec<AudioTrack> {
        let count = unsafe { ffi::cinette_remux_audio_count(self.raw()) };
        (0..count)
            .map(|i| {
                let t = unsafe { ffi::cinette_remux_audio_track(self.raw(), i) };
                AudioTrack {
                    codec: text(t.codec).unwrap_or_default(),
                    language: text(t.language),
                    default: t.is_default != 0,
                }
            })
            .collect()
    }

    /// The video's codec and its extradata, for the playlist's `CODECS`.
    pub fn video(&self) -> (Video, Vec<u8>) {
        let mut data = std::ptr::null();
        let mut size: c_int = 0;
        let kind = unsafe { ffi::cinette_remux_video(self.raw(), &mut data, &mut size) };
        let extradata = match usize::try_from(size) {
            Ok(len) if !data.is_null() && len > 0 => unsafe {
                std::slice::from_raw_parts(data, len).to_vec()
            },
            _ => Vec::new(),
        };
        let video = match kind {
            -1 => Video::None,
            1 => Video::H264,
            2 => Video::Hevc,
            _ => Video::Other,
        };
        (video, extradata)
    }

    /// The source's length in seconds, or `None` for a live stream.
    pub fn duration(&self) -> Option<f64> {
        let d = unsafe { ffi::cinette_remux_duration(self.raw()) };
        (d > 0.0).then_some(d)
    }

    pub fn canceller(&self) -> Canceller {
        Canceller(self.handle.clone())
    }

    /// Converts until the source ends, cutting segments of at least
    /// `segment` seconds into `sink`. Blocks the thread.
    pub fn run(
        &mut self,
        audio: Audio,
        segment: f64,
        sink: &mut dyn Sink,
    ) -> Result<(), RemuxError> {
        let (track, mode, downmix) = match audio {
            Audio::None => (-1, AUDIO_COPY, 0),
            Audio::Copy(track) => (track_index(track)?, AUDIO_COPY, 0),
            Audio::Aac { track, downmix } => (track_index(track)?, AUDIO_AAC, c_int::from(downmix)),
        };
        let mut sink: &mut dyn Sink = sink;
        let ctx = (&mut sink as *mut &mut dyn Sink).cast::<c_void>();
        let raw = self.raw();
        check(unsafe {
            ffi::cinette_remux_start(raw, track, mode, downmix, segment, on_write, on_cut, ctx)
        })?;
        check(unsafe { ffi::cinette_remux_run(raw) })
    }
}

fn track_index(track: usize) -> Result<c_int, RemuxError> {
    c_int::try_from(track).map_err(|_| RemuxError::Failed)
}

fn text(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned(),
    )
}

/// The sink `run` passed, from the C's context pointer.
///
/// SAFETY: `ctx` is the `&mut &mut dyn Sink` that `run` keeps alive for the
/// whole of `cinette_remux_run`, and the C calls back only during it, on the
/// same thread.
unsafe fn sink<'a>(ctx: *mut c_void) -> &'a mut &'a mut dyn Sink {
    unsafe { &mut *ctx.cast::<&mut dyn Sink>() }
}

extern "C" fn on_write(ctx: *mut c_void, data: *const u8, size: c_int) {
    let Ok(len) = usize::try_from(size) else {
        return;
    };
    if data.is_null() || len == 0 {
        return;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    // A panic must not unwind into C.
    let _ = panic::catch_unwind(AssertUnwindSafe(|| unsafe { sink(ctx) }.write(bytes)));
}

extern "C" fn on_cut(ctx: *mut c_void, duration: f64) -> c_int {
    match panic::catch_unwind(AssertUnwindSafe(|| unsafe { sink(ctx) }.cut(duration))) {
        Ok(true) => 0,
        _ => 1,
    }
}
