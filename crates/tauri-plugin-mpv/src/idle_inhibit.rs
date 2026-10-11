// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Platform-native idle/sleep inhibition.
//!
//! Prevents the display from dimming or the system from sleeping while
//! video is playing — standard behavior for media players.
//!
//! - macOS: IOPMAssertionCreateWithName / IOPMAssertionRelease
//! - Linux: D-Bus org.freedesktop.ScreenSaver.Inhibit / UnInhibit
//! - iOS: UIApplication.isIdleTimerDisabled

use std::sync::Mutex;

/// Manages a single idle-inhibit assertion. Thread-safe — callers can
/// `inhibit()` and `uninhibit()` from any thread.
pub struct IdleInhibitor {
    inner: Mutex<InhibitState>,
}

struct InhibitState {
    /// Platform-specific handle to the active assertion.
    #[cfg(target_os = "macos")]
    assertion_id: u32,
    #[cfg(target_os = "linux")]
    cookie: Option<u32>,
    active: bool,
}

impl IdleInhibitor {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(InhibitState {
                #[cfg(target_os = "macos")]
                assertion_id: 0,
                #[cfg(target_os = "linux")]
                cookie: None,
                active: false,
            }),
        }
    }

    /// Prevent the display from sleeping. No-op if already inhibited.
    pub fn inhibit(&self) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if state.active {
            return;
        }
        if self.platform_inhibit(&mut state) {
            state.active = true;
            tracing::debug!("[idle-inhibit] display sleep inhibited");
        }
    }

    /// Allow the display to sleep again. No-op if not inhibited.
    pub fn uninhibit(&self) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !state.active {
            return;
        }
        self.platform_uninhibit(&mut state);
        state.active = false;
        tracing::debug!("[idle-inhibit] display sleep uninhibited");
    }

    // ── macOS ────────────────────────────────────────────────────────────

    #[cfg(target_os = "macos")]
    fn platform_inhibit(&self, state: &mut InhibitState) -> bool {
        use std::ffi::c_void;

        // IOPMAssertionCreateWithName signature from IOKit/pwr_mgt/IOPMLib.h
        #[link(name = "IOKit", kind = "framework")]
        extern "C" {
            fn IOPMAssertionCreateWithName(
                assertion_type: *const c_void,   // CFStringRef
                level: u32,                       // IOPMAssertionLevel
                reason: *const c_void,            // CFStringRef
                assertion_id: *mut u32,           // IOPMAssertionID*
            ) -> i32; // IOReturn
        }

        // kIOPMAssertionTypePreventUserIdleDisplaySleep
        let assertion_type = cfstring("PreventUserIdleDisplaySleep");
        let reason = cfstring("Max Video Player: video playback active");
        if assertion_type.is_null() || reason.is_null() {
            if !assertion_type.is_null() { unsafe { CFRelease(assertion_type) }; }
            if !reason.is_null() { unsafe { CFRelease(reason) }; }
            tracing::warn!("[idle-inhibit] CFStringCreateWithBytes returned null");
            return false;
        }
        let mut assertion_id: u32 = 0;

        // kIOPMAssertionLevelOn = 255
        let ret = unsafe {
            IOPMAssertionCreateWithName(
                assertion_type,
                255,
                reason,
                &mut assertion_id,
            )
        };

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
        extern "C" {
            fn IOPMAssertionRelease(assertion_id: u32) -> i32;
        }
        let ret = unsafe { IOPMAssertionRelease(state.assertion_id) };
        if ret != 0 {
            tracing::warn!("[idle-inhibit] IOPMAssertionRelease failed: {}", ret);
        }
        state.assertion_id = 0;
    }

    // ── Linux ────────────────────────────────────────────────────────────

    #[cfg(target_os = "linux")]
    fn platform_inhibit(&self, state: &mut InhibitState) -> bool {
        // Try org.freedesktop.ScreenSaver first (works on KDE, XFCE, MATE),
        // then org.gnome.SessionManager (GNOME, Pop!_OS, COSMIC-legacy).
        if let Some(cookie) = dbus_screensaver_inhibit() {
            state.cookie = Some(cookie);
            return true;
        }
        tracing::info!("[idle-inhibit] D-Bus ScreenSaver.Inhibit unavailable, trying GNOME SessionManager");
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
            // Try both interfaces — only one will have issued the cookie,
            // but the other will harmlessly fail.
            let _ = dbus_screensaver_uninhibit(cookie);
            let _ = dbus_gnome_uninhibit(cookie);
        }
    }

    // ── iOS ──────────────────────────────────────────────────────────────

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

    // ── Fallback (other platforms) ───────────────────────────────────────

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios")))]
    fn platform_inhibit(&self, _state: &mut InhibitState) -> bool {
        false
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios")))]
    fn platform_uninhibit(&self, _state: &mut InhibitState) {}
}

impl Drop for IdleInhibitor {
    fn drop(&mut self) {
        self.uninhibit();
    }
}

// ── macOS helpers ────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[cfg(target_os = "macos")]
fn cfstring(s: &str) -> *const std::ffi::c_void {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
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

// ── Linux D-Bus helpers ──────────────────────────────────────────────────

/// Call a D-Bus method and return the result. Uses `dbus-send` / `gdbus`
/// command-line tools to avoid adding a heavy D-Bus crate dependency.
/// These tools are present on virtually all Linux desktop systems.
#[cfg(target_os = "linux")]
fn dbus_call_u32(bus: &str, path: &str, method: &str, args: &[&str]) -> Option<u32> {
    let mut cmd = std::process::Command::new("gdbus");
    cmd.arg("call")
        .arg("--session")
        .arg("--timeout").arg("3") // seconds; avoid blocking playback on a hung bus
        .arg("--dest").arg(bus)
        .arg("--object-path").arg(path)
        .arg("--method").arg(method);
    for arg in args {
        cmd.arg(arg);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    // gdbus output format: "(uint32 12345,)\n"
    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_u32_from_gdbus(&stdout)
}

#[cfg(target_os = "linux")]
fn dbus_call_void(bus: &str, path: &str, method: &str, args: &[&str]) -> bool {
    let mut cmd = std::process::Command::new("gdbus");
    cmd.arg("call")
        .arg("--session")
        .arg("--timeout").arg("3")
        .arg("--dest").arg(bus)
        .arg("--object-path").arg(path)
        .arg("--method").arg(method);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn extract_u32_from_gdbus(s: &str) -> Option<u32> {
    // Formats: "(uint32 12345,)" or "(12345,)"
    let s = s.trim();
    let inner = s.strip_prefix('(')?.strip_suffix(')')?;
    let val_str = inner.trim_end_matches(',').trim();
    // Try "uint32 NNN" format first
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
        &["Max Video Player", "Video playback active"],
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
    // org.gnome.SessionManager.Inhibit(app_id, toplevel_xid, reason, flags)
    // flags: 8 = Inhibit idle (GSM_INHIBITOR_FLAG_IDLE)
    dbus_call_u32(
        "org.gnome.SessionManager",
        "/org/gnome/SessionManager",
        "org.gnome.SessionManager.Inhibit",
        &["Max Video Player", "uint32 0", "Video playback active", "uint32 8"],
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
