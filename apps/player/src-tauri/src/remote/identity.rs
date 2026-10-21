// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! This device's long-term remote-control key, kept in a file only the user
//! can read. iOS keeps it in the Keychain instead (see `keychain.rs`).
//!
//! The file holds the 32 private bytes and nothing else. The public half and
//! the device id are worked out from them. The app data folder already holds
//! the cache with every provider's login in it, so the key gets the same
//! protection rather than a store of its own.

use mvp_core::remote::identity::DeviceKey;
#[cfg(not(target_os = "ios"))]
use mvp_core::remote::identity::KEY_LEN;
#[cfg(not(target_os = "ios"))]
use std::fs;
use std::io;
#[cfg(not(target_os = "ios"))]
use std::io::Write;
use std::path::Path;
#[cfg(not(target_os = "ios"))]
use std::path::PathBuf;

/// The key's file name in the app data folder.
#[cfg_attr(target_os = "ios", allow(dead_code))]
pub const KEY_FILE: &str = "remote-device.key";

#[cfg(not(target_os = "ios"))]
fn key_path(dir: &Path) -> PathBuf {
    dir.join(KEY_FILE)
}

/// The saved key, or a new one saved in its place when there's none or the
/// file is broken. A new key means a new device id.
#[cfg(target_os = "ios")]
pub fn load_or_create(_dir: &Path) -> io::Result<DeviceKey> {
    super::keychain::load_or_create()
}

/// Saves `key` in place of any earlier one.
#[cfg(target_os = "ios")]
pub fn save(_dir: &Path, key: &DeviceKey) -> io::Result<()> {
    super::keychain::save(key)
}

/// The saved key, or a new one saved in its place when there's none or the
/// file is broken. A new key means a new device id.
#[cfg(not(target_os = "ios"))]
pub fn load_or_create(dir: &Path) -> io::Result<DeviceKey> {
    let path = key_path(dir);
    match fs::read(&path) {
        Ok(bytes) => match <[u8; KEY_LEN]>::try_from(bytes.as_slice()) {
            Ok(private) => {
                keep_private(&path)?;
                return Ok(DeviceKey::from_private(private));
            }
            Err(_) => tracing::warn!(
                "[remote] {} is {} bytes, not {KEY_LEN}; making a new device key",
                path.display(),
                bytes.len()
            ),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let key = DeviceKey::generate();
    save(dir, &key)?;
    tracing::info!("[remote] new device id {}", key.device_id());
    Ok(key)
}

/// Saves `key` in place of any earlier one. It goes to a temporary file
/// that only the user can read, which then replaces the old file in one
/// step, so a crash leaves either the old key or the new one.
#[cfg(not(target_os = "ios"))]
pub fn save(dir: &Path, key: &DeviceKey) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{KEY_FILE}.tmp"));
    // A leftover from a crash may have other permissions; start afresh.
    match fs::remove_file(&tmp) {
        // mutants: skip MatchArmGuard: Another error leaves the leftover in place, and create_new then fails on it, so saving fails either way.
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(key.private_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, key_path(dir))?;
    // The rename itself is only kept once the folder is written out.
    #[cfg(unix)]
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}

/// Takes away other users' access to a key file that has it, as one copied
/// back from a backup may.
#[cfg(not(target_os = "ios"))]
fn keep_private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)?.permissions().mode();
        if mode & 0o077 != 0 {
            tracing::warn!("[remote] the device key file was readable by others; fixing that");
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

// The file is the desktop's and Android's store; iOS uses the Keychain.
#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::*;

    #[test]
    fn makes_a_key_once_and_reads_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create(dir.path()).unwrap();
        let again = load_or_create(dir.path()).unwrap();
        assert_eq!(first.device_id(), again.device_id());
        assert_eq!(
            fs::read(dir.path().join(KEY_FILE)).unwrap(),
            first.private_bytes().to_vec()
        );
        assert!(!dir.path().join("remote-device.key.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn only_the_user_can_read_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create(dir.path()).unwrap();
        let mode = fs::metadata(dir.path().join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_broken_file_gets_a_new_key() {
        let dir = tempfile::tempdir().unwrap();
        for broken in [&[1u8; 31][..], &[1u8; 33][..], &[][..]] {
            fs::write(dir.path().join(KEY_FILE), broken).unwrap();
            let key = load_or_create(dir.path()).unwrap();
            assert_eq!(
                fs::read(dir.path().join(KEY_FILE)).unwrap(),
                key.private_bytes().to_vec(),
                "{} bytes",
                broken.len()
            );
        }
    }

    #[test]
    fn saving_replaces_the_key_and_a_leftover_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let old = load_or_create(dir.path()).unwrap();
        fs::write(dir.path().join("remote-device.key.tmp"), b"junk").unwrap();
        let new = DeviceKey::generate();
        save(dir.path(), &new).unwrap();
        let read = load_or_create(dir.path()).unwrap();
        assert_eq!(read.device_id(), new.device_id());
        assert_ne!(read.device_id(), old.device_id());
    }

    #[test]
    fn makes_the_folder_if_needed() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("a").join("b");
        load_or_create(&inner).unwrap();
        assert!(inner.join(KEY_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_key_file_it_may_not_read_is_kept_and_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(KEY_FILE);
        fs::write(&path, [7u8; KEY_LEN]).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&path).is_ok() {
            // Running as root, which reads anything.
            return;
        }
        assert!(load_or_create(dir.path()).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), vec![7u8; KEY_LEN], "not replaced");
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_is_an_error_not_a_new_key() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(KEY_FILE)).unwrap();
        assert!(load_or_create(dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_key_file_others_can_read_is_made_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let key = load_or_create(dir.path()).unwrap();
        let path = dir.path().join(KEY_FILE);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let again = load_or_create(dir.path()).unwrap();
        assert_eq!(again.device_id(), key.device_id());
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // One the user alone can read is left as it is.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        load_or_create(dir.path()).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o400);
    }
}
