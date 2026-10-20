// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! On Linux, builds `native/remux.c` against the system's FFmpeg, which
//! only the tests use, with `test-media/test_media.c`, which writes their
//! media. On iOS, Xcode builds the same file against MPVKit's
//! FFmpeg in the app target, so there's nothing to do here. Other
//! platforms don't use the crate.

fn main() {
    println!("cargo:rerun-if-changed=native/remux.c");
    println!("cargo:rerun-if-changed=native/remux.h");
    println!("cargo:rerun-if-changed=test-media/test_media.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    let mut build = cc::Build::new();
    for library in ["libavformat", "libavcodec", "libavutil", "libswresample"] {
        let found = pkg_config::Config::new()
            .probe(library)
            .unwrap_or_else(|e| {
                panic!("{library} not found ({e}). Install the FFmpeg dev packages.")
            });
        for path in found.include_paths {
            build.include(path);
        }
    }
    build
        .file("native/remux.c")
        .file("test-media/test_media.c")
        .std("c11")
        .warnings(true)
        .compile("cinette_remux");
}
