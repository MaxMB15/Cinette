// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Keeps the display from dimming or sleeping while video plays.
//!
//! - macOS takes an IOKit power assertion with `IOPMAssertionCreateWithName`.
//! - Linux asks `org.freedesktop.ScreenSaver` over D-Bus, then GNOME's
//!   session manager.
//! - iOS sets `UIApplication.isIdleTimerDisabled`.

use crate::lock::lock_or_recover;
use std::sync::Mutex;

/// Holds at most one idle inhibit at a time. `inhibit` and `uninhibit` can
/// be called from any thread.
pub struct IdleInhibitor {
    inner: Mutex<InhibitState>,
    /// Answers in place of the system when a test sets it, so the test can
    /// check the bookkeeping here without taking a real power assertion or
    /// calling D-Bus. Only test builds have the field, so the app always
    /// asks the system.
    #[cfg(test)]
    fake: Option<std::sync::Arc<tests::FakePlatform>>,
}

struct InhibitState {
    /// The active IOKit assertion.
    #[cfg(target_os = "macos")]
    assertion_id: u32,
    /// The cookie from whichever D-Bus interface took the inhibit.
    #[cfg(target_os = "linux")]
    cookie: Option<u32>,
    active: bool,
}

impl IdleInhibitor {
    /// Creates an inhibitor that isn't holding anything yet.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(InhibitState {
                #[cfg(target_os = "macos")]
                assertion_id: 0,
                #[cfg(target_os = "linux")]
                cookie: None,
                active: false,
            }),
            #[cfg(test)]
            fake: None,
        }
    }

    /// Prevent the display from sleeping. No-op if already inhibited.
    pub fn inhibit(&self) {
        let mut state = lock_or_recover(&self.inner);
        if state.active {
            return;
        }
        if self.take(&mut state) {
            state.active = true;
            tracing::debug!("[idle-inhibit] display sleep inhibited");
        }
    }

    /// Allow the display to sleep again. No-op if not inhibited.
    pub fn uninhibit(&self) {
        let mut state = lock_or_recover(&self.inner);
        if !state.active {
            return;
        }
        self.release(&mut state);
        state.active = false;
        tracing::debug!("[idle-inhibit] display sleep uninhibited");
    }

    /// Asks the system for the inhibit, or the test's fake when it has one.
    fn take(&self, state: &mut InhibitState) -> bool {
        #[cfg(test)]
        if let Some(fake) = &self.fake {
            return fake.take();
        }
        self.platform_inhibit(state)
    }

    /// Gives the inhibit back to the system, or to the test's fake when it
    /// has one.
    fn release(&self, state: &mut InhibitState) {
        #[cfg(test)]
        if let Some(fake) = &self.fake {
            fake.release();
            return;
        }
        self.platform_uninhibit(state);
    }

    /// Whether an inhibit is held, so tests can check who takes and releases
    /// it.
    #[cfg(test)]
    pub(crate) fn is_active(&self) -> bool {
        lock_or_recover(&self.inner).active
    }

    #[cfg(target_os = "macos")]
    fn platform_inhibit(&self, state: &mut InhibitState) -> bool {
        use std::ffi::c_void;

        // IOPMAssertionCreateWithName signature from IOKit/pwr_mgt/IOPMLib.h
        #[link(name = "IOKit", kind = "framework")]
        unsafe extern "C" {
            fn IOPMAssertionCreateWithName(
                assertion_type: *const c_void, // CFStringRef
                level: u32,                    // IOPMAssertionLevel
                reason: *const c_void,         // CFStringRef
                assertion_id: *mut u32,        // IOPMAssertionID*
            ) -> i32; // IOReturn
        }

        // kIOPMAssertionTypePreventUserIdleDisplaySleep
        let assertion_type = cfstring("PreventUserIdleDisplaySleep");
        let reason = cfstring("Cinette: video playback active");
        if assertion_type.is_null() || reason.is_null() {
            if !assertion_type.is_null() {
                unsafe { CFRelease(assertion_type) };
            }
            if !reason.is_null() {
                unsafe { CFRelease(reason) };
            }
            tracing::warn!("[idle-inhibit] CFStringCreateWithBytes returned null");
            return false;
        }
        let mut assertion_id: u32 = 0;

        // kIOPMAssertionLevelOn = 255
        let ret =
            unsafe { IOPMAssertionCreateWithName(assertion_type, 255, reason, &mut assertion_id) };

        unsafe {
            CFRelease(reason);
            CFRelease(assertion_type);
        }

        if ret == 0 {
            // kIOReturnSuccess
            state.assertion_id = assertion_id;
            true
        } else {
            tracing::warn!("[idle-inhibit] IOPMAssertionCreateWithName failed: {}", ret);
            false
        }
    }

    #[cfg(target_os = "macos")]
    fn platform_uninhibit(&self, state: &mut InhibitState) {
        #[link(name = "IOKit", kind = "framework")]
        unsafe extern "C" {
            fn IOPMAssertionRelease(assertion_id: u32) -> i32;
        }
        let ret = unsafe { IOPMAssertionRelease(state.assertion_id) };
        if ret != 0 {
            tracing::warn!("[idle-inhibit] IOPMAssertionRelease failed: {}", ret);
        }
        state.assertion_id = 0;
    }

    #[cfg(target_os = "linux")]
    fn platform_inhibit(&self, state: &mut InhibitState) -> bool {
        // KDE, XFCE and MATE answer on org.freedesktop.ScreenSaver. GNOME,
        // Pop!_OS and older COSMIC releases use org.gnome.SessionManager.
        if let Some(cookie) = dbus_screensaver_inhibit() {
            state.cookie = Some(cookie);
            return true;
        }
        tracing::info!(
            "[idle-inhibit] D-Bus ScreenSaver.Inhibit unavailable, trying GNOME SessionManager"
        );
        if let Some(cookie) = dbus_gnome_inhibit() {
            state.cookie = Some(cookie);
            return true;
        }
        tracing::warn!("[idle-inhibit] no D-Bus idle-inhibit interface available");
        false
    }

    #[cfg(target_os = "linux")]
    fn platform_uninhibit(&self, state: &mut InhibitState) {
        if let Some(cookie) = state.cookie.take() {
            // Only one interface issued the cookie. Calling the other fails
            // without side effects.
            let _ = dbus_screensaver_uninhibit(cookie);
            let _ = dbus_gnome_uninhibit(cookie);
        }
    }

    /// `UIApplication.isIdleTimerDisabled`, set by the plugin's Swift side.
    #[cfg(target_os = "ios")]
    fn platform_inhibit(&self, _state: &mut InhibitState) -> bool {
        crate::ios::set_idle_timer_disabled(true);
        true
    }

    #[cfg(target_os = "ios")]
    fn platform_uninhibit(&self, _state: &mut InhibitState) {
        crate::ios::set_idle_timer_disabled(false);
    }

    /// `FLAG_KEEP_SCREEN_ON` on the activity's window, set by the plugin's
    /// Kotlin side. It also keeps a TV's screensaver away.
    #[cfg(target_os = "android")]
    fn platform_inhibit(&self, _state: &mut InhibitState) -> bool {
        crate::android::set_keep_screen_on(true);
        true
    }

    #[cfg(target_os = "android")]
    fn platform_uninhibit(&self, _state: &mut InhibitState) {
        crate::android::set_keep_screen_on(false);
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "ios",
        target_os = "android"
    )))]
    fn platform_inhibit(&self, _state: &mut InhibitState) -> bool {
        false
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "ios",
        target_os = "android"
    )))]
    fn platform_uninhibit(&self, _state: &mut InhibitState) {}
}

impl Drop for IdleInhibitor {
    fn drop(&mut self) {
        self.uninhibit();
    }
}

#[cfg(test)]
mod tests;

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[cfg(target_os = "macos")]
fn cfstring(s: &str) -> *const std::ffi::c_void {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external: bool,
        ) -> *const c_void;
    }
    // kCFStringEncodingUTF8 = 0x08000100
    unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            s.as_ptr(),
            s.len() as isize,
            0x0800_0100,
            false,
        )
    }
}

/// Calls a D-Bus method that returns a `u32`.
///
/// It runs the `gdbus` command line tool, which nearly every Linux desktop
/// ships, rather than pulling in a D-Bus crate.
#[cfg(target_os = "linux")]
fn dbus_call_u32(bus: &str, path: &str, method: &str, args: &[&str]) -> Option<u32> {
    let mut cmd = std::process::Command::new("gdbus");
    cmd.arg("call")
        .arg("--session")
        .arg("--timeout")
        .arg("3") // Seconds, so a hung bus can't stall playback.
        .arg("--dest")
        .arg(bus)
        .arg("--object-path")
        .arg(path)
        .arg("--method")
        .arg(method);
    for arg in args {
        cmd.arg(arg);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_u32_from_gdbus(&stdout)
}

#[cfg(target_os = "linux")]
fn dbus_call_void(bus: &str, path: &str, method: &str, args: &[&str]) -> bool {
    let mut cmd = std::process::Command::new("gdbus");
    cmd.arg("call")
        .arg("--session")
        .arg("--timeout")
        .arg("3")
        .arg("--dest")
        .arg(bus)
        .arg("--object-path")
        .arg(path)
        .arg("--method")
        .arg(method);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// Reads the number out of gdbus output such as `(uint32 12345,)` or
/// `(12345,)`.
#[cfg(target_os = "linux")]
fn extract_u32_from_gdbus(s: &str) -> Option<u32> {
    let s = s.trim();
    let inner = s.strip_prefix('(')?.strip_suffix(')')?;
    let val_str = inner.trim_end_matches(',').trim();
    if let Some(num_str) = val_str.strip_prefix("uint32 ") {
        return num_str.trim().parse().ok();
    }
    val_str.parse().ok()
}

#[cfg(target_os = "linux")]
fn dbus_screensaver_inhibit() -> Option<u32> {
    dbus_call_u32(
        "org.freedesktop.ScreenSaver",
        "/org/freedesktop/ScreenSaver",
        "org.freedesktop.ScreenSaver.Inhibit",
        &["Cinette", "Video playback active"],
    )
}

#[cfg(target_os = "linux")]
fn dbus_screensaver_uninhibit(cookie: u32) -> bool {
    dbus_call_void(
        "org.freedesktop.ScreenSaver",
        "/org/freedesktop/ScreenSaver",
        "org.freedesktop.ScreenSaver.UnInhibit",
        &[&format!("uint32 {}", cookie)],
    )
}

#[cfg(target_os = "linux")]
fn dbus_gnome_inhibit() -> Option<u32> {
    // The arguments are app_id, toplevel_xid, reason and flags. Flag 8 is
    // GSM_INHIBITOR_FLAG_IDLE.
    dbus_call_u32(
        "org.gnome.SessionManager",
        "/org/gnome/SessionManager",
        "org.gnome.SessionManager.Inhibit",
        &[
            "Cinette",
            "uint32 0",
            "Video playback active",
            "uint32 8",
        ],
    )
}

#[cfg(target_os = "linux")]
fn dbus_gnome_uninhibit(cookie: u32) -> bool {
    dbus_call_void(
        "org.gnome.SessionManager",
        "/org/gnome/SessionManager",
        "org.gnome.SessionManager.Uninhibit",
        &[&format!("uint32 {}", cookie)],
    )
}
