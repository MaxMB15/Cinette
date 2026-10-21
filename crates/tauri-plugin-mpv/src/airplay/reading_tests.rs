// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::airplay::{AirPlay, Status, Tracker};
use std::time::Instant;

#[test]
fn a_time_avplayer_doesnt_know_is_zero() {
    assert_eq!(finite(12.5), 12.5);
    assert_eq!(finite(-3.0), -3.0);
    assert_eq!(finite(f64::NAN), 0.0);
    assert_eq!(finite(f64::INFINITY), 0.0);
    assert_eq!(finite(f64::NEG_INFINITY), 0.0);
}

#[test]
fn only_a_valid_finite_time_is_numeric() {
    assert!(is_numeric(VALID));
    // Rounded is still a number.
    assert!(is_numeric(VALID | 1 << 1));
    assert!(!is_numeric(0));
    for other in [INDEFINITE, POSITIVE_INFINITY, NEGATIVE_INFINITY] {
        assert!(!is_numeric(VALID | other), "{other}");
        assert!(!is_numeric(other), "{other}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn the_flags_are_core_medias() {
    use objc2_core_media::CMTimeFlags;
    assert_eq!(VALID, CMTimeFlags::Valid.0);
    assert_eq!(POSITIVE_INFINITY, CMTimeFlags::PositiveInfinity.0);
    assert_eq!(NEGATIVE_INFINITY, CMTimeFlags::NegativeInfinity.0);
    assert_eq!(INDEFINITE, CMTimeFlags::Indefinite.0);
}

#[test]
fn reads_only_an_http_error_status() {
    assert_eq!(http_status(403), Some(403));
    assert_eq!(http_status(400), Some(400));
    assert_eq!(http_status(599), Some(599));
    assert_eq!(http_status(399), None);
    assert_eq!(http_status(600), None);
    assert_eq!(http_status(200), None);
    assert_eq!(http_status(-12938), None);
    assert_eq!(http_status(70_000), None);
}

#[test]
fn an_unreadable_address_fails_before_it_opens() {
    let report = failed_report();
    assert_eq!(report.status, "failed");
    assert_eq!(report.position, 0.0);
    assert_eq!(report.duration, None);
    assert!(!report.external);
    assert_eq!(
        report.error,
        Some(ReportError {
            domain: "Cinette".into(),
            code: -1,
            http_status: None,
        })
    );
    assert!(report.subtitles.is_empty() && report.audio.is_empty());
    assert_eq!((report.subtitle, report.audio_track), (None, None));
    // The player shows it as a stream that didn't open.
    let airplay = AirPlay::default();
    airplay.begin(Tracker::new(false));
    let state = airplay.report(&report, Instant::now()).unwrap();
    assert_eq!(state.status, Status::Error);
    assert_eq!(state.error.unwrap().code, "openFailed");
}
