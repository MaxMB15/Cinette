// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Splitting an export into messages that fit a frame, and putting it back
//! together on the other side.
//!
//! The receiver keeps every chunk until the last one arrives, and only then
//! hands the export over. A transfer cut off before that leaves nothing
//! behind.

use super::{Export, Item, ItemRef, Pin};
use serde::{Deserialize, Serialize};

/// The most JSON in one chunk's items and pins, well under the 64 KiB frame,
/// with room for the message around them.
pub const CHUNK_BYTES: usize = 48 * 1024;
/// The longest name, show title or group a reference may have, in bytes.
pub const MAX_NAME_BYTES: usize = 512;
/// The longest id (IMDb, `tvg-id`, panel id) a reference may have, in bytes.
pub const MAX_ID_BYTES: usize = 128;
/// The most items one transfer takes.
pub const MAX_ITEMS: usize = 50_000;
/// The most pinned groups one transfer takes.
pub const MAX_PINS: usize = 2_000;
/// The most JSON one transfer takes, over all its chunks.
pub const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;

/// One piece of an export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// 0 for the first, one more for each after.
    pub seq: u32,
    /// The export ends with this one.
    #[serde(default)]
    pub last: bool,
    /// The source's clock, in the first chunk only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<i64>,
    /// What the source played last, in the first chunk only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<ItemRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Item>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pins: Vec<Pin>,
}

/// Whether every text in a reference is within the limits, and every number
/// is one JSON can carry.
pub fn ref_fits(r: &ItemRef) -> bool {
    let name = |s: &str| s.len() <= MAX_NAME_BYTES;
    let id = |s: &Option<String>| s.as_ref().is_none_or(|s| s.len() <= MAX_ID_BYTES);
    name(&r.name)
        && r.series.as_deref().is_none_or(name)
        && id(&r.imdb)
        && id(&r.tvg_id)
        && id(&r.panel_id)
}

fn item_fits(item: &Item) -> bool {
    ref_fits(&item.reference)
        && item
            .position
            .is_none_or(|p| p.position.is_finite() && p.duration.is_finite())
}

fn pin_fits(pin: &Pin) -> bool {
    pin.group.len() <= MAX_NAME_BYTES && pin.content_type.len() <= MAX_ID_BYTES
}

/// The export in chunks, and how many items and pins were left out for
/// being over the limits. There's always at least one chunk, the last one.
pub fn split(export: &Export) -> (Vec<Chunk>, u32) {
    let mut dropped = 0u32;
    let mut chunks = Vec::new();
    let mut chunk = Chunk {
        seq: 0,
        last: false,
        sent_at: Some(export.sent_at),
        current: export.current.clone().filter(ref_fits),
        items: Vec::new(),
        pins: Vec::new(),
    };
    let mut used = json_len(&chunk);
    let mut start_next = |chunk: &mut Chunk, used: &mut usize| {
        let seq = chunk.seq + 1;
        let full = std::mem::replace(
            chunk,
            Chunk {
                seq,
                last: false,
                sent_at: None,
                current: None,
                items: Vec::new(),
                pins: Vec::new(),
            },
        );
        chunks.push(full);
        *used = json_len(chunk);
    };
    for item in &export.items {
        if !item_fits(item) {
            dropped = dropped.saturating_add(1);
            continue;
        }
        let len = json_len(item) + 1;
        if used + len > CHUNK_BYTES && !chunk.items.is_empty() {
            start_next(&mut chunk, &mut used);
        }
        if chunk.items.is_empty() {
            used += ITEMS_KEY.len();
        }
        chunk.items.push(item.clone());
        used += len;
    }
    for pin in &export.pins {
        if !pin_fits(pin) {
            dropped = dropped.saturating_add(1);
            continue;
        }
        // The first pin after items also opens the list of pins.
        let key = if chunk.pins.is_empty() {
            PINS_KEY.len()
        } else {
            0
        };
        let len = json_len(pin) + 1;
        if used + len + key > CHUNK_BYTES && !(chunk.items.is_empty() && chunk.pins.is_empty()) {
            start_next(&mut chunk, &mut used);
        }
        if chunk.pins.is_empty() {
            used += PINS_KEY.len();
        }
        chunk.pins.push(pin.clone());
        used += len;
    }
    chunk.last = true;
    chunks.push(chunk);
    (chunks, dropped)
}

/// What the first item or pin adds to a chunk besides itself, since an
/// empty list isn't written.
const ITEMS_KEY: &str = ",\"items\":[]";
const PINS_KEY: &str = ",\"pins\":[]";

fn json_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX / 2, |v| v.len())
}

/// Why the receiver gave up on a transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AssembleError {
    /// A chunk came out of order, or after the last.
    #[error("chunk out of order")]
    OutOfOrder,
    /// More than a transfer takes.
    #[error("transfer too large")]
    TooLarge,
}

/// Collects chunks until the last one.
#[derive(Debug, Default)]
pub struct Assembler {
    next: u32,
    bytes: usize,
    export: Export,
    done: bool,
    /// Items and pins that broke the limits, and were left out.
    pub dropped: u32,
}

impl Assembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a chunk that arrived as `bytes` bytes of JSON. Returns the whole
    /// export with the last chunk.
    pub fn push(&mut self, chunk: Chunk, bytes: usize) -> Result<Option<Export>, AssembleError> {
        if self.done || chunk.seq != self.next {
            return Err(AssembleError::OutOfOrder);
        }
        self.bytes = self.bytes.saturating_add(bytes);
        let items = self.export.items.len() + chunk.items.len();
        let pins = self.export.pins.len() + chunk.pins.len();
        if self.bytes > MAX_TOTAL_BYTES || items > MAX_ITEMS || pins > MAX_PINS {
            return Err(AssembleError::TooLarge);
        }
        if chunk.seq == 0 {
            self.export.sent_at = chunk.sent_at.unwrap_or(0);
            self.export.current = chunk.current.filter(ref_fits);
        }
        for item in chunk.items {
            if item_fits(&item) {
                self.export.items.push(item);
            } else {
                self.dropped = self.dropped.saturating_add(1);
            }
        }
        for pin in chunk.pins {
            if pin_fits(&pin) {
                self.export.pins.push(pin);
            } else {
                self.dropped = self.dropped.saturating_add(1);
            }
        }
        self.next += 1;
        if chunk.last {
            self.done = true;
            return Ok(Some(std::mem::take(&mut self.export)));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests;
