// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

fn main() {
    // This `cfg` checks the host, so also check the target: an iOS build
    // runs this script on macOS too.
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        embed_macos_rpath();
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        link_ios_cdylib_without_libmpv();
    }

    // `remote`: where remote control between Cinette devices runs.
    println!("cargo::rustc-check-cfg=cfg(remote)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if matches!(os.as_str(), "macos" | "linux" | "android") {
        println!("cargo:rustc-cfg=remote");
    }

    tauri_build::build();
}

/// Cargo builds every crate type, and nothing uses the cdylib on iOS, where
/// libmpv comes from MPVKit in the Xcode project. libmpv2-sys still asks for
/// `-lmpv`, so an empty `libmpv.a` answers that, and the cdylib's mpv symbols
/// are left undefined. The staticlib that Xcode links doesn't use either.
fn link_ios_cdylib_without_libmpv() {
    let dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("no-libmpv");
    std::fs::create_dir_all(&dir).expect("create the folder for the empty libmpv");
    // An ar archive with no members.
    std::fs::write(dir.join("libmpv.a"), b"!<arch>\n").expect("write the empty libmpv");
    println!("cargo:rustc-link-search=native={}", dir.display());
    println!("cargo:rustc-link-arg-cdylib=-Wl,-undefined,dynamic_lookup");
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
                "cargo:warning=libs/macos/ not found. Run ./scripts/build-libmpv.sh macos first"
            );
        }
    }
}
