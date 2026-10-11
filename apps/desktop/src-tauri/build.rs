// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

fn main() {
    // This `cfg` checks the host, so also check the target: an iOS build
    // runs this script on macOS too.
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        embed_macos_rpath();
    }

    tauri_build::build();
}

/// Bake an rpath into the binary so it finds libmpv.2.dylib in libs/macos/
/// at runtime without requiring DYLD_LIBRARY_PATH.
#[cfg(target_os = "macos")]
fn embed_macos_rpath() {
    let libs_macos = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../libs/macos");

    match libs_macos.canonicalize() {
        Ok(abs) => {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", abs.display());
        }
        Err(_) => {
            eprintln!(
                "cargo:warning=libs/macos/ not found — run ./scripts/build-libmpv.sh macos first"
            );
        }
    }
}
