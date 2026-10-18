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
