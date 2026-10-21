// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! How a Mac's readings of AVPlayer become a [`Report`], apart from
//! AVFoundation, so they can be tested where it can't run.

use super::{Report, ReportError};

#[cfg(test)]
#[path = "reading_tests.rs"]
mod tests;

/// `CMTimeFlags`' bits, as Core Media defines them.
pub const VALID: u32 = 0x01;
pub const POSITIVE_INFINITY: u32 = 0x04;
pub const NEGATIVE_INFINITY: u32 = 0x08;
pub const INDEFINITE: u32 = 0x10;
/// The bits that make a time not a number: the last three.
const NOT_A_NUMBER: u32 = 0x1C;

/// Seconds, or 0 for a time AVPlayer doesn't know, which it gives as NaN.
pub fn finite(seconds: f64) -> f64 {
    if seconds.is_finite() {
        seconds
    } else {
        0.0
    }
}

/// `CMTIME_IS_NUMERIC`, from a time's flags: valid, and neither indefinite
/// nor infinite.
pub fn is_numeric(flags: u32) -> bool {
    flags & VALID != 0 && flags & NOT_A_NUMBER == 0
}

/// The HTTP status in an error log event's `errorStatusCode`, when it's
/// one: a request that failed with a 4xx or a 5xx. AVFoundation puts other
/// codes there too, such as its own negative ones.
pub fn http_status(code: isize) -> Option<u16> {
    u16::try_from(code).ok().filter(|s| (400..=599).contains(s))
}

/// A load whose address couldn't be read, as a load that failed before it
/// started.
pub fn failed_report() -> Report {
    Report {
        status: "failed".into(),
        position: 0.0,
        duration: None,
        external: false,
        error: Some(ReportError {
            domain: "Cinette".into(),
            code: -1,
            http_status: None,
        }),
        subtitles: Vec::new(),
        subtitle: None,
        audio: Vec::new(),
        audio_track: None,
    }
}
