// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! This device's remote-control key on iOS, kept in the Keychain.
//!
//! A file in the app's container would go into iCloud and computer backups,
//! and a backup restored onto a new iPhone would give it this one's device
//! id. A Keychain item that's accessible "this device only" never leaves the
//! device. It does survive deleting and reinstalling the app, which keeps
//! the same id on the same device.

use mvp_core::remote::identity::{DeviceKey, KEY_LEN};
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::passwords::{
    generic_password, set_generic_password_options, PasswordOptions,
};
use std::io;

const SERVICE: &str = "app.cinette.remote";
const ACCOUNT: &str = "device-key";
/// `errSecItemNotFound`.
const NOT_FOUND: i32 = -25300;

fn options() -> PasswordOptions {
    PasswordOptions::new_generic_password(SERVICE, ACCOUNT)
}

/// The saved key, or a new one saved in its place when there's none or the
/// item is broken. A new key means a new device id.
pub fn load_or_create() -> io::Result<DeviceKey> {
    match generic_password(options()) {
        Ok(bytes) => match <[u8; KEY_LEN]>::try_from(bytes.as_slice()) {
            Ok(private) => return Ok(DeviceKey::from_private(private)),
            Err(_) => tracing::warn!(
                "[remote] the Keychain's device key is {} bytes, not {KEY_LEN}; making a new one",
                bytes.len()
            ),
        },
        Err(e) if e.code() == NOT_FOUND => {}
        Err(e) => return Err(io::Error::other(e)),
    }
    let key = DeviceKey::generate();
    save(&key)?;
    tracing::info!("[remote] new device id {}", key.device_id());
    Ok(key)
}

/// Saves `key` in place of any earlier one, readable after the device's
/// first unlock and on this device only.
pub fn save(key: &DeviceKey) -> io::Result<()> {
    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
        0,
    )
    .map_err(io::Error::other)?;
    let mut options = options();
    options.set_access_control(access);
    set_generic_password_options(key.private_bytes(), options).map_err(io::Error::other)
}
