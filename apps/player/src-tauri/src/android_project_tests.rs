// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Checks on the Android project in `gen/android` that no build catches.

/// The version cargo locked for `package`.
fn locked_version(lock: &str, package: &str) -> String {
    let name = format!("name = \"{package}\"");
    let mut lines = lock.lines().skip_while(|line| *line != name);
    lines.next().unwrap_or_else(|| panic!("{package} isn't in Cargo.lock"));
    let version = lines.next().unwrap();
    version
        .strip_prefix("version = \"")
        .and_then(|v| v.strip_suffix('"'))
        .unwrap()
        .to_string()
}

/// The Kotlin half of rustls-platform-verifier has to be the version its
/// Rust half expects, or certificate checks fail at runtime.
#[test]
fn gradle_pins_the_verifier_cargo_locked() {
    let version = locked_version(
        include_str!("../../../../Cargo.lock"),
        "rustls-platform-verifier-android",
    );
    let gradle = include_str!("../gen/android/app/build.gradle.kts");
    let dependency = format!("implementation(\"org.rustls:rustls-platform-verifier:{version}\")");
    assert!(
        gradle.contains(&dependency),
        "app/build.gradle.kts should have {dependency}"
    );
}

#[test]
fn locked_version_reads_the_line_after_the_name() {
    let lock = "[[package]]\nname = \"a\"\nversion = \"1.2.3\"\n\n[[package]]\nname = \"b\"\nversion = \"4.5.6\"\n";
    assert_eq!(locked_version(lock, "b"), "4.5.6");
}

/// Restored onto another device, the remote-control key would give it this
/// device's id, so both of Android's backup rule files leave it out, and
/// the manifest names both.
// The key's file name lives with remote control, which iOS doesn't build yet.
#[cfg(remote)]
#[test]
fn backups_leave_out_the_remote_control_key() {
    let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
    assert!(manifest.contains(r#"android:fullBackupContent="@xml/backup_rules""#));
    assert!(manifest.contains(r#"android:dataExtractionRules="@xml/data_extraction_rules""#));
    let key = crate::remote::identity::KEY_FILE;
    let rules = [
        (include_str!("../gen/android/app/src/main/res/xml/backup_rules.xml"), 1),
        // Cloud backups and device transfers each.
        (include_str!("../gen/android/app/src/main/res/xml/data_extraction_rules.xml"), 2),
    ];
    for (xml, sections) in rules {
        for name in [key.to_owned(), format!("{key}.tmp")] {
            let rule = format!(r#"<exclude domain="root" path="{name}" />"#);
            assert_eq!(xml.matches(&rule).count(), sections, "{rule}");
        }
    }
}

/// DNS-SD over Wi-Fi needs the multicast lock, which needs this permission.
#[test]
fn the_manifest_asks_for_the_multicast_lock() {
    let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
    assert!(manifest.contains(
        r#"<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />"#
    ));
}

/// `android_device.rs` reads the store from the manifest, which gets it from
/// the Gradle property through a placeholder.
#[test]
fn the_manifest_names_the_store_from_gradle() {
    let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
    assert!(manifest.contains(
        r#"<meta-data android:name="app.cinette.STORE" android:value="${store}" />"#
    ));
    let gradle = include_str!("../gen/android/app/build.gradle.kts");
    assert!(gradle.contains(r#"manifestPlaceholders["store"] = store"#));
    assert!(gradle.contains(r#"val stores = listOf("google", "amazon")"#));
}

/// The multicast permission implies Wi-Fi, so without this the stores would
/// hide the app from TVs on Ethernet only.
#[test]
fn wifi_is_not_required() {
    let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
    assert!(manifest.contains(
        r#"<uses-feature android:name="android.hardware.wifi" android:required="false" />"#
    ));
}

/// Rust's temporary folder comes from TMPDIR, which Android doesn't set, so
/// the activity sets it before `super.onCreate` loads the Rust library.
#[test]
fn the_activity_sets_tmpdir_before_rust_loads() {
    let activity = include_str!("../gen/android/app/src/main/java/app/cinette/MainActivity.kt");
    let on_create = activity.find("override fun onCreate").unwrap();
    let set = activity[on_create..].find("useCacheForTemporaryFiles()").unwrap();
    let load = activity[on_create..].find("super.onCreate(").unwrap();
    assert!(set < load, "TMPDIR has to be set before super.onCreate");
    assert!(activity.contains(r#"Os.setenv("TMPDIR", dir, true)"#));
}

/// Fire TV's launcher shows a sideloaded app's activity icon, not its
/// banner, so the Amazon build makes that icon the banner.
#[test]
fn the_amazon_launcher_icon_is_the_banner() {
    let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
    assert!(manifest.contains(r#"android:icon="${launcherIcon}""#));
    let gradle = include_str!("../gen/android/app/build.gradle.kts");
    assert!(gradle.contains(
        r#"if (store == "amazon") "@drawable/banner" else "@mipmap/ic_launcher""#
    ));
}
