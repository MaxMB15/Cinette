// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

const COMMANDS: &[&str] = &[
    "mpv_load",
    "mpv_play",
    "mpv_pause",
    "mpv_stop",
    "mpv_seek",
    "mpv_set_volume",
    "mpv_set_bounds",
    "mpv_set_visible",
    "mpv_get_state",
    "mpv_set_media_info",
];

fn main() {
    // iOS gets libmpv from MPVKit, which the Xcode project links. The
    // `#[cfg]` blocks in `link_libmpv` check the host, not the target, so
    // they'd point an iOS build at the macOS dylib.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        link_libmpv();
    }
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}

/// Configure linking to libmpv from libs/<platform>/ or pkg-config.
fn link_libmpv() {
    // Allow override via environment variable
    if let Ok(dir) = std::env::var("MPV_LIB_DIR") {
        println!("cargo:rustc-link-search=native={}", dir);
        return;
    }

    #[cfg(target_os = "macos")]
    {
        // Try libs/macos/ at workspace root
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let libs_macos = std::path::Path::new(&manifest_dir)
            .join("..")
            .join("..")
            .join("libs")
            .join("macos");
        if libs_macos.join("libmpv.dylib").exists()
            || libs_macos.join("libmpv.2.dylib").exists()
        {
            if let Ok(abs) = libs_macos.canonicalize() {
                println!("cargo:rustc-link-search=native={}", abs.display());
            } else {
                println!("cargo:rustc-link-search=native={}", libs_macos.display());
            }
            return;
        }
        // Fallback: Homebrew path (for development)
        if let Ok(brew_prefix) = std::process::Command::new("brew")
            .args(["--prefix", "mpv"])
            .output()
        {
            if brew_prefix.status.success() {
                let prefix = String::from_utf8_lossy(&brew_prefix.stdout).trim().to_string();
                let lib_dir = std::path::Path::new(&prefix).join("lib");
                if lib_dir.exists() {
                    println!("cargo:rustc-link-search=native={}", lib_dir.display());
                    return;
                }
            }
        }
        println!("cargo:warning=libmpv not found. Run ./scripts/build-libmpv.sh macos or install mpv via Homebrew.");
    }

    #[cfg(target_os = "linux")]
    {
        // Prefer libs/linux/ (source build with audio support) over system pkg-config
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let libs_linux = std::path::Path::new(&manifest_dir)
            .join("..")
            .join("..")
            .join("libs")
            .join("linux");
        if libs_linux.join("libmpv.so").exists() {
            let path = libs_linux.canonicalize().unwrap_or(libs_linux.clone());
            println!("cargo:rustc-link-search=native={}", path.display());
            // Bake RPATH into the binary so the freshly built libmpv.so (which
            // has our required AO/VO backends) is preferred over the system
            // /usr/lib/x86_64-linux-gnu/libmpv.so.2 at runtime. Without this
            // the dynamic loader falls back to whatever libmpv-dev installed,
            // which may or may not match what we linked against.
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", path.display());
            return;
        }
        // Fallback: system pkg-config (for development with libmpv-dev)
        if let Ok(output) = std::process::Command::new("pkg-config")
            .args(["--libs", "--cflags", "libmpv"])
            .output()
        {
            if output.status.success() {
                let args = String::from_utf8_lossy(&output.stdout);
                for arg in args.split_whitespace() {
                    if arg.starts_with("-L") {
                        println!("cargo:rustc-link-search=native={}", &arg[2..]);
                    }
                }
                return;
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let libs_win = std::path::Path::new(&manifest_dir)
            .join("..")
            .join("..")
            .join("libs")
            .join("windows");
        if libs_win.join("mpv.dll").exists() || libs_win.join("mpv-2.dll").exists() {
            println!("cargo:rustc-link-search=native={}", libs_win.display());
            return;
        }
    }
}
