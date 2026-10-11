// swift-tools-version:5.3
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import PackageDescription

// The UIKit side of tauri-plugin-mpv. The plugin's build script copies the
// Tauri Swift API into `../.tauri/tauri-api` and links this package into the
// Rust static library.
let package = Package(
  name: "tauri-plugin-mpv",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-mpv",
      type: .static,
      targets: ["tauri-plugin-mpv"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-mpv",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
