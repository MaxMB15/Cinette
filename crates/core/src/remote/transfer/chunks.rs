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
    /// How many items and pins the source left out for being over the
    /// limits, in the first chunk only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped: Option<u32>,
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

/// The export in chunks, stamped with the source's clock `now`, and how
/// many items and pins were left out for being over the limits. The first
/// chunk says how many too. There's always at least one chunk, the last one.
pub fn split(export: &Export, now: i64) -> (Vec<Chunk>, u32) {
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let dropped = count(export.items.iter().filter(|i| !item_fits(i)).count())
        .saturating_add(count(export.pins.iter().filter(|p| !pin_fits(p)).count()));
    let mut chunks = Vec::new();
    let mut chunk = Chunk {
        seq: 0,
        last: false,
        sent_at: Some(now),
        current: export.current.clone().filter(ref_fits),
        dropped: (dropped > 0).then_some(dropped),
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
                dropped: None,
                items: Vec::new(),
                pins: Vec::new(),
            },
        );
        chunks.push(full);
        *used = json_len(chunk);
    };
    for item in &export.items {
        if !item_fits(item) {
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
    serde_json::to_vec(value)
        .expect("transfer items always serialize")
        .len()
}

/// Whether an export is within what a receiver takes, checked before it's
/// sent so it doesn't fail halfway.
pub fn within_limits(export: &Export) -> bool {
    if export.items.len() > MAX_ITEMS || export.pins.len() > MAX_PINS {
        return false;
    }
    let bytes: usize = export.items.iter().map(|i| json_len(i) + 1).sum::<usize>()
        + export.pins.iter().map(|p| json_len(p) + 1).sum::<usize>();
    bytes <= MAX_TOTAL_BYTES
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
    /// The first chunk has no clock to compare times by.
    #[error("first chunk without the source's clock")]
    NoClock,
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

    /// Adds a chunk that arrived as `bytes` bytes of JSON when this device's
    /// clock read `now`. Returns the whole export with the last chunk.
    pub fn push(
        &mut self,
        chunk: Chunk,
        bytes: usize,
        now: i64,
    ) -> Result<Option<Export>, AssembleError> {
        if self.done || chunk.seq != self.next {
            return Err(AssembleError::OutOfOrder);
        }
        if chunk.seq == 0 && chunk.sent_at.is_none() {
            return Err(AssembleError::NoClock);
        }
        self.bytes = self.bytes.saturating_add(bytes);
        let items = self.export.items.len() + chunk.items.len();
        let pins = self.export.pins.len() + chunk.pins.len();
        if self.bytes > MAX_TOTAL_BYTES || items > MAX_ITEMS || pins > MAX_PINS {
            return Err(AssembleError::TooLarge);
        }
        if let Some(sent_at) = chunk.sent_at.filter(|_| chunk.seq == 0) {
            self.export.sent_at = sent_at;
            self.export.received_at = now;
            self.export.current = chunk.current.filter(ref_fits);
            self.dropped = self.dropped.saturating_add(chunk.dropped.unwrap_or(0));
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
            self.export.dropped = self.dropped;
            return Ok(Some(std::mem::take(&mut self.export)));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests;
