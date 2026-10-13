// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Most tests here ask a fake instead of the system, so they run the same on
//! every platform. On macOS one test also holds a real power assertion for a
//! moment. On Linux the inhibit goes over the desktop's session bus, which
//! CI doesn't have, so only the reply parser is tested against it. The load
//! tests in `mpv` reach the bus on a desktop, where the inhibit lasts only
//! as long as the test.

use super::*;
use std::sync::Arc;

/// Stands in for the system. It grants the inhibit unless it was made with
/// `refusing`, and records each call.
#[derive(Default)]
pub(super) struct FakePlatform {
    refuses: bool,
    calls: Mutex<Vec<&'static str>>,
}

impl FakePlatform {
    fn refusing() -> Self {
        Self {
            refuses: true,
            ..Self::default()
        }
    }

    pub(super) fn take(&self) -> bool {
        self.calls.lock().unwrap().push("take");
        !self.refuses
    }

    pub(super) fn release(&self) {
        self.calls.lock().unwrap().push("release");
    }

    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}

/// An inhibitor that asks `fake` instead of the system.
fn inhibitor(fake: &Arc<FakePlatform>) -> IdleInhibitor {
    let mut inhibitor = IdleInhibitor::new();
    inhibitor.fake = Some(fake.clone());
    inhibitor
}

#[test]
fn a_new_inhibitor_holds_nothing() {
    let fake = Arc::new(FakePlatform::default());
    let inhibitor = inhibitor(&fake);
    assert!(!inhibitor.is_active());
    // Releasing what was never taken leaves the platform alone.
    inhibitor.uninhibit();
    assert!(!inhibitor.is_active());
    assert!(fake.calls().is_empty());
}

#[test]
fn takes_one_inhibit_and_releases_it_once() {
    let fake = Arc::new(FakePlatform::default());
    let inhibitor = inhibitor(&fake);

    inhibitor.inhibit();
    assert!(inhibitor.is_active());
    // A second inhibit keeps the one it has.
    inhibitor.inhibit();
    assert_eq!(fake.calls(), ["take"]);

    inhibitor.uninhibit();
    assert!(!inhibitor.is_active());
    inhibitor.uninhibit();
    assert_eq!(fake.calls(), ["take", "release"]);
}

#[test]
fn asks_again_after_the_system_refuses() {
    let fake = Arc::new(FakePlatform::refusing());
    let inhibitor = inhibitor(&fake);

    inhibitor.inhibit();
    assert!(!inhibitor.is_active());
    inhibitor.inhibit();
    // Nothing was taken, so there is nothing to give back.
    inhibitor.uninhibit();
    assert_eq!(fake.calls(), ["take", "take"]);
}

#[test]
fn dropping_an_inhibitor_releases_what_it_holds() {
    let fake = Arc::new(FakePlatform::default());
    let held = inhibitor(&fake);
    held.inhibit();
    drop(held);
    assert_eq!(fake.calls(), ["take", "release"]);

    let idle = Arc::new(FakePlatform::default());
    drop(inhibitor(&idle));
    assert!(idle.calls().is_empty());
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
