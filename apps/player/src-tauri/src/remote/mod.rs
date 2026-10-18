// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Remote control between Cinette devices on the same network: the
//! platform layer around `mvp_core::remote`, on macOS and Linux.
//!
//! [`target`] runs this device as a target: it listens on TCP, advertises
//! `_cinette._tcp`, and drives the core's `Target`. Commands for the player
//! go to the webview as `remote://command` events, so a remote play goes
//! through the same code as a local one and is recorded in this device's
//! history. The `remote_*` commands in [`commands`] are how the webview
//! answers and changes settings.
//!
//! iOS and Android will drive the same core with their own sockets and
//! discovery. Until then the commands say remote control isn't available.

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod catalog;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod clock;
pub mod commands;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod conn;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod identity;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod service;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod target;

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use service::{start, stop_for_exit, RemoteService};

/// Where remote-control settings are kept, beside the app's other settings.
pub const SETTINGS_STORE_FILE: &str = "settings.json";
/// Their key in the store.
pub const SETTINGS_KEY: &str = "remote";
