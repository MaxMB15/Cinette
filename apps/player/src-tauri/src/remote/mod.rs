// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Remote control between Cinette devices on the same network: the
//! platform layer around `mvp_core::remote`, on macOS, Linux, iOS and Android.
//!
//! [`target`] runs this device as a target: it listens on TCP, advertises
//! `_cinette._tcp`, and drives the core's `Target`. Commands for the player
//! go to the webview as `remote://command` events, so a remote play goes
//! through the same code as a local one and is recorded in this device's
//! history. The `remote_*` commands in [`commands`] are how the webview
//! answers and changes settings.
//!
//! Android runs the same code as Linux, and iOS the same as macOS, with the
//! device key in the Keychain. On Windows the commands say remote control
//! isn't available.

#[cfg(remote)]
pub mod catalog;
#[cfg(remote)]
pub mod clock;
pub mod commands;
#[cfg(remote)]
mod conn;
#[cfg(remote)]
pub mod device;
#[cfg(any(target_os = "android", test))]
pub mod held;
#[cfg(remote)]
pub mod devices;
#[cfg(remote)]
pub mod history;
#[cfg(remote)]
pub mod identity;
#[cfg(any(target_os = "ios", test))]
mod keychain;
#[cfg(remote)]
mod local;
pub mod logos;
#[cfg(remote)]
pub mod providers;
#[cfg(remote)]
pub mod link;
#[cfg(remote)]
mod service;
#[cfg(remote)]
pub mod target;
#[cfg(all(test, remote))]
mod test_client;

#[cfg(mobile)]
pub use service::{set_foreground, Lifecycle};
#[cfg(remote)]
pub use service::{open, start_at_launch, stop_for_exit, RemoteService};

/// Where remote-control settings are kept, beside the app's other settings.
#[cfg(remote)]
pub const SETTINGS_STORE_FILE: &str = "settings.json";
/// Their key in the store.
#[cfg(remote)]
pub const SETTINGS_KEY: &str = "remote";
