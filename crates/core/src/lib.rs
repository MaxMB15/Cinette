// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The parts of MaxVideoPlayer that don't depend on a platform or a UI, kept
//! apart so they can be tested without running the app.

/// Optional AI helpers for organising playlists.
pub mod ai;
/// The SQLite store for providers, channels, guides, metadata and watch history.
pub mod cache;
/// Film and episode downloads, their file paths and the ffmpeg arguments they
/// run with.
pub mod downloads;
pub mod http;
/// Playlist, guide and metadata sources.
pub mod iptv;
mod json;
/// Data types shared by the app and the services.
pub mod models;
