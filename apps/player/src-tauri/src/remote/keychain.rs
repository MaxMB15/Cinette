// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! This device's remote-control key on iOS, kept in the Keychain.
//!
//! A file in the app's container would go into iCloud and computer backups,
//! and a backup restored onto a new iPhone would give it this one's device
//! id. A Keychain item that's accessible "this device only" never leaves the
//! device. It does survive deleting and reinstalling the app, which keeps
//! the same id on the same device.
//!
//! What to do with each answer the Keychain gives is decided by plain
//! functions that the tests run on every platform. Only the calls into the
//! Keychain are iOS's own.

use mvp_core::remote::identity::{DeviceKey, KEY_LEN};

/// `errSecItemNotFound`. Any other error, such as a locked device or a
/// missing entitlement, must never lead to a new key, which would replace
/// the device's id.
const NOT_FOUND: i32 = -25300;

/// What to do with what reading the key gave.
#[derive(Debug)]
pub(crate) enum Loaded {
    Use(DeviceKey),
    /// There's none, or what's there isn't a key.
    Create,
    Fail(i32),
}

/// Decides on the bytes the Keychain gave, or its error code.
pub(crate) fn on_load(read: Result<Vec<u8>, i32>) -> Loaded {
    match read {
        Ok(bytes) => match <[u8; KEY_LEN]>::try_from(bytes.as_slice()) {
            Ok(private) => Loaded::Use(DeviceKey::from_private(private)),
            Err(_) => {
                let len = bytes.len();
                tracing::warn!(
                    "[remote] the Keychain's device key is {len} bytes, not {KEY_LEN}; making a new one"
                );
                Loaded::Create
            }
        },
        Err(NOT_FOUND) => Loaded::Create,
        Err(code) => Loaded::Fail(code),
    }
}

/// What to do after trying to replace the saved key's bytes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Saving {
    Done,
    /// There's no item yet, so one is added.
    Add,
    Fail(i32),
}

/// Decides on the answer to updating the item in place.
pub(crate) fn after_update(updated: Result<(), i32>) -> Saving {
    match updated {
        Ok(()) => Saving::Done,
        Err(NOT_FOUND) => Saving::Add,
        Err(code) => Saving::Fail(code),
    }
}

#[cfg(target_os = "ios")]
pub use ios::{load_or_create, save};

#[cfg(target_os = "ios")]
mod ios {
    use super::{after_update, on_load, Loaded, Saving};
    use core_foundation::data::CFData;
    use mvp_core::remote::identity::DeviceKey;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::item::{
        update_item, ItemClass, ItemSearchOptions, ItemUpdateOptions, ItemUpdateValue,
    };
    use security_framework::passwords::{
        generic_password, set_generic_password_options, PasswordOptions,
    };
    use std::io;
    use std::path::Path;

    const SERVICE: &str = "app.cinette.remote";
    const ACCOUNT: &str = "device-key";

    fn keychain_error(code: i32) -> io::Error {
        io::Error::other(format!("Keychain error {code}"))
    }

    /// The saved key, or a new one saved in its place when there's none or
    /// the item is broken. A new key means a new device id. `dir` is where
    /// the other platforms keep their key file.
    pub fn load_or_create(dir: &Path) -> io::Result<DeviceKey> {
        let read = generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT))
            .map_err(|e| e.code());
        match on_load(read) {
            Loaded::Use(key) => Ok(key),
            Loaded::Fail(code) => Err(keychain_error(code)),
            Loaded::Create => {
                let key = DeviceKey::generate();
                save(dir, &key)?;
                tracing::info!("[remote] new device id {}", key.device_id());
                Ok(key)
            }
        }
    }

    /// Saves `key` in place of any earlier one. The item is updated in place,
    /// found by its class, service and account only, so a failure leaves the
    /// old key. Only when there's none is a new item added, readable after
    /// the device's first unlock and on this device only.
    pub fn save(_dir: &Path, key: &DeviceKey) -> io::Result<()> {
        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(SERVICE)
            .account(ACCOUNT);
        let mut update = ItemUpdateOptions::new();
        update.set_value(ItemUpdateValue::Data(CFData::from_buffer(
            key.private_bytes(),
        )));
        match after_update(update_item(&search, &update).map_err(|e| e.code())) {
            Saving::Done => Ok(()),
            Saving::Fail(code) => Err(keychain_error(code)),
            Saving::Add => {
                let access = SecAccessControl::create_with_protection(
                    Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                    0,
                )
                .map_err(|e| keychain_error(e.code()))?;
                let mut options = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
                options.set_access_control(access);
                set_generic_password_options(key.private_bytes(), options)
                    .map_err(|e| keychain_error(e.code()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_key_is_used() {
        let key = DeviceKey::generate();
        match on_load(Ok(key.private_bytes().to_vec())) {
            Loaded::Use(found) => assert_eq!(found.device_id(), key.device_id()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_short_or_long_key_is_made_again() {
        assert!(matches!(on_load(Ok(vec![1; 31])), Loaded::Create));
        assert!(matches!(on_load(Ok(vec![1; 33])), Loaded::Create));
    }

    #[test]
    fn no_key_yet_makes_one() {
        assert!(matches!(on_load(Err(-25300)), Loaded::Create));
    }

    #[test]
    fn a_locked_device_or_missing_entitlement_never_makes_a_new_key() {
        // errSecInteractionNotAllowed and errSecMissingEntitlement.
        assert!(matches!(on_load(Err(-25308)), Loaded::Fail(-25308)));
        assert!(matches!(on_load(Err(-34018)), Loaded::Fail(-34018)));
    }

    #[test]
    fn an_update_that_found_the_item_is_done() {
        assert_eq!(after_update(Ok(())), Saving::Done);
    }

    #[test]
    fn an_update_with_no_item_adds_one() {
        assert_eq!(after_update(Err(-25300)), Saving::Add);
    }

    #[test]
    fn any_other_update_error_fails_without_adding() {
        assert_eq!(after_update(Err(-25308)), Saving::Fail(-25308));
        assert_eq!(after_update(Err(-50)), Saving::Fail(-50));
    }
}
