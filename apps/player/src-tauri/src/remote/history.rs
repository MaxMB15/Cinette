// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! "Transfer history and favorites": reading this device's history out for
//! another device, and writing another device's in. Matching and merging
//! are in `mvp_core::remote::transfer`; this runs them against the cache.
//! Each call reads or writes SQLite, so call it on a blocking thread.

use mvp_core::cache::store::CacheStore;
use mvp_core::models::channel::Channel;
use mvp_core::remote::message::ErrorCode;
use mvp_core::remote::transfer::merge::{self, Report};
use mvp_core::remote::transfer::refs::Salt;
use mvp_core::remote::transfer::{Counts, Export, What};
use serde::Serialize;
use std::sync::Mutex;

/// Unix seconds now.
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn locked<T>(
    cache: &Mutex<CacheStore>,
    f: impl FnOnce(&CacheStore) -> Result<T, mvp_core::cache::store::CacheError>,
) -> Result<T, ErrorCode> {
    let cache = cache.lock().map_err(|_| ErrorCode::Failed)?;
    f(&cache).map_err(|e| {
        tracing::warn!("[remote] the history transfer couldn't use the cache: {e}");
        ErrorCode::Failed
    })
}

/// How many of each this device would send, for the preview.
pub fn counts(cache: &Mutex<CacheStore>, what: What) -> Result<Counts, ErrorCode> {
    // The tags don't count, so any salt does.
    locked(cache, |c| {
        c.export_transfer(&Salt::generate(), what, None, now())
    })
    .map(|e| e.counts())
}

/// This device's history under the other device's `salt`. `playing` is the
/// channel the player has open, for "Continue watching here".
pub fn export(
    cache: &Mutex<CacheStore>,
    salt: &Salt,
    what: What,
    playing: Option<&str>,
) -> Result<Export, ErrorCode> {
    locked(cache, |c| c.export_transfer(salt, what, playing, now()))
}

/// What writing another device's history did here, with the channel to
/// continue watching, when it matched one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub report: Report,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<Channel>,
}

/// Matches another device's history against this device's catalog and
/// writes it in one transaction.
pub fn import(
    cache: &Mutex<CacheStore>,
    salt: &Salt,
    export: &Export,
) -> Result<Imported, ErrorCode> {
    locked(cache, |c| {
        let index = c.transfer_index(salt)?;
        let plan = merge::plan(export, &index, merge::clock_offset(export.sent_at, now()));
        let report = c.apply_transfer(&plan)?;
        let channel = match &report.resume {
            Some(resume) => c.find_channel(&resume.channel_id)?,
            None => None,
        };
        Ok(Imported { report, channel })
    })
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
