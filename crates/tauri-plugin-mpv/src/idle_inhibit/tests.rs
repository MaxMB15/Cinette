// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! On macOS the tests hold a power assertion for a moment. On Linux the
//! inhibit goes over the desktop's session bus, which CI doesn't have, so
//! only the reply parser is tested here. The load tests in `mpv` reach the
//! bus on a desktop, where the inhibit lasts only as long as the test.

use super::*;

#[test]
fn a_new_inhibitor_holds_nothing() {
    let inhibitor = IdleInhibitor::new();
    assert!(!inhibitor.is_active());
    // Releasing what was never taken leaves the platform alone.
    inhibitor.uninhibit();
    assert!(!inhibitor.is_active());
}

#[cfg(target_os = "macos")]
#[test]
fn holds_one_power_assertion_until_released() {
    let inhibitor = IdleInhibitor::new();
    let assertion = || lock_or_recover(&inhibitor.inner).assertion_id;

    inhibitor.inhibit();
    assert!(inhibitor.is_active());
    let id = assertion();
    assert_ne!(id, 0);
    // A second inhibit keeps the assertion it has.
    inhibitor.inhibit();
    assert_eq!(assertion(), id);

    inhibitor.uninhibit();
    assert!(!inhibitor.is_active());
    assert_eq!(assertion(), 0);
}

#[cfg(target_os = "linux")]
#[test]
fn reads_the_cookie_from_gdbus_output() {
    assert_eq!(extract_u32_from_gdbus("(uint32 12345,)\n"), Some(12345));
    assert_eq!(extract_u32_from_gdbus("(uint32  7 ,)"), Some(7));
    assert_eq!(extract_u32_from_gdbus("(42,)"), Some(42));
    assert_eq!(extract_u32_from_gdbus("()"), None);
    assert_eq!(extract_u32_from_gdbus("uint32 12345"), None);
    assert_eq!(extract_u32_from_gdbus("(uint32 cookie,)"), None);
    assert_eq!(extract_u32_from_gdbus("(uint32 4294967296,)"), None);
}
