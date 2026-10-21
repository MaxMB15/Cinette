// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! How copied rows join the destination's own.
//!
//! - A position: the one saved later wins, finished or not. Never the larger
//!   one, since the user may be watching again from the start.
//! - A history entry: the earlier first watch, the later last watch, and the
//!   larger play count and watched time. Never a sum, so the same transfer a
//!   second time changes nothing.
//! - Favorites and pinned groups are only ever added.
//!
//! Nothing is deleted, on either device.

use super::matching::{DestChannel, Index, Miss};
use super::refs::AccountTag;
use super::{Export, ItemKind, Position, Watched};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Clocks closer than this are taken as the same.
pub const CLOCK_SLACK: i64 = 60;
/// The most unmatched items a result lists. The rest are only counted.
pub const MAX_UNMATCHED_LISTED: usize = 200;

/// The most plays one history entry takes.
pub const MAX_PLAYS: i64 = 1_000_000;
/// The most watched seconds one history entry takes: a hundred years.
pub const MAX_WATCHED_SECONDS: i64 = 100 * 365 * 24 * 3600;
/// The longest a movie or episode can be, in seconds: a week.
pub const MAX_DURATION: f64 = 7.0 * 24.0 * 3600.0;

/// How far the source's clock is behind the destination's, in seconds, to
/// add to the source's times: the destination's clock when the first chunk
/// arrived, `received_at`, less the source's when it was made, `sent_at`.
/// Rounded to whole minutes, since the time on the way counts too, and 0
/// when the two are within [`CLOCK_SLACK`].
pub fn clock_offset(sent_at: i64, received_at: i64) -> i64 {
    let offset = received_at.saturating_sub(sent_at);
    if offset.abs() > CLOCK_SLACK {
        ((offset as f64 / 60.0).round() as i64).saturating_mul(60)
    } else {
        0
    }
}

/// A history entry that makes sense: counts that aren't negative or huge,
/// and a first watch no later than the last.
fn watched_ok(w: &Watched) -> bool {
    (0..=MAX_PLAYS).contains(&w.play_count)
        && (0..=MAX_WATCHED_SECONDS).contains(&w.watched_seconds)
        && 0 <= w.first_watched_at
        && w.first_watched_at <= w.last_watched_at
}

/// A position that makes sense: within a duration that's positive and
/// not absurd.
fn position_ok(p: &Position) -> bool {
    p.duration > 0.0
        && p.duration <= MAX_DURATION
        && p.position >= 0.0
        && p.position <= p.duration
        && p.updated_at >= 0
}

/// The history entry after the merge, or `None` when the destination's
/// stays as it is.
pub fn merge_watched(old: Option<Watched>, new: Watched) -> Option<Watched> {
    let Some(old) = old else {
        return Some(new);
    };
    // The same plays, seen through clocks a little apart, are the same entry.
    if old.play_count == new.play_count
        && old.watched_seconds == new.watched_seconds
        && (old.last_watched_at - new.last_watched_at).abs() <= CLOCK_SLACK
    {
        return None;
    }
    let merged = Watched {
        first_watched_at: old.first_watched_at.min(new.first_watched_at),
        last_watched_at: old.last_watched_at.max(new.last_watched_at),
        play_count: old.play_count.max(new.play_count),
        watched_seconds: old.watched_seconds.max(new.watched_seconds),
    };
    (merged != old).then_some(merged)
}

/// The position after the merge, or `None` when the destination's stays.
/// A tie keeps the destination's, and so does the same place saved at
/// another time.
pub fn merge_position(old: Option<Position>, new: Position) -> Option<Position> {
    match old {
        Some(old) if old.updated_at >= new.updated_at => None,
        Some(old)
            if old.position == new.position
                && old.duration == new.duration
                && old.finished == new.finished =>
        {
            None
        }
        _ => Some(new),
    }
}

/// A history entry to write.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryRow {
    pub channel: DestChannel,
    pub watched: Watched,
}

/// A pinned group to add.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinRow {
    pub provider_id: String,
    pub content_type: String,
    pub group: String,
}

/// Something that matched nothing, for the result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unmatched {
    pub name: String,
    pub kind: UnmatchedKind,
    pub reason: Miss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnmatchedKind {
    Live,
    Movie,
    Series,
    Episode,
    PinnedGroup,
}

impl From<ItemKind> for UnmatchedKind {
    fn from(kind: ItemKind) -> Self {
        match kind {
            ItemKind::Live => UnmatchedKind::Live,
            ItemKind::Movie => UnmatchedKind::Movie,
            ItemKind::Series => UnmatchedKind::Series,
            ItemKind::Episode => UnmatchedKind::Episode,
        }
    }
}

/// What to write, worked out from an export and the destination's catalog.
/// Two copied items that found the same destination item are one row here.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    /// By destination channel id.
    pub history: BTreeMap<String, HistoryRow>,
    /// By position key.
    pub positions: BTreeMap<String, Position>,
    /// Destination channel ids.
    pub favorites: BTreeSet<String>,
    /// In the source's order.
    pub pins: Vec<PinRow>,
    pub unmatched: Vec<Unmatched>,
    /// Every unmatched item, listed or not.
    pub unmatched_total: u32,
    /// What the source played last, on this device.
    pub resume: Option<Resume>,
}

/// "Continue watching here": the source's item, as found on this device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    pub channel_id: String,
    pub name: String,
    /// Where to start, in seconds: the position saved on this device once
    /// the transfer is written. `None` for a live channel, or nothing saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
    /// The key that position is saved under.
    #[serde(skip)]
    pub key: Option<String>,
}

impl Plan {
    fn miss(&mut self, name: &str, kind: UnmatchedKind, reason: Miss) {
        self.unmatched_total = self.unmatched_total.saturating_add(1);
        if self.unmatched.len() < MAX_UNMATCHED_LISTED {
            self.unmatched.push(Unmatched {
                name: name.to_string(),
                kind,
                reason,
            });
        }
    }
}

/// Matches every item and pin, shifts the source's times by `offset` (see
/// [`clock_offset`]), and folds items that found the same destination item
/// together by the merge rules.
pub fn plan(export: &Export, index: &Index, now: i64) -> Plan {
    let mut plan = Plan::default();
    let offset = clock_offset(export.sent_at, export.received_at);
    // A time from the future, from a wrong clock or a broken row, would win
    // every merge after it, so none goes past now.
    let shift = |t: i64| t.saturating_add(offset).clamp(0, now.max(0));
    for item in &export.items {
        let r = &item.reference;
        let found = match index.find(r) {
            Ok(found) => found,
            Err(reason) => {
                plan.miss(&r.name, r.kind.into(), reason);
                continue;
            }
        };
        let watched = item.watched.filter(watched_ok);
        let position = item.position.filter(position_ok);
        if (item.watched.is_some() && watched.is_none())
            || (item.position.is_some() && position.is_none())
        {
            plan.miss(&r.name, r.kind.into(), Miss::Invalid);
        }
        if let (Some(position), Some(key)) = (position, found.key.as_ref()) {
            let position = Position {
                updated_at: shift(position.updated_at),
                ..position
            };
            let kept = plan.positions.get(key).copied();
            if let Some(newer) = merge_position(kept, position) {
                plan.positions.insert(key.clone(), newer);
            }
        }
        // A history entry and a favorite need a channel of their own. An
        // episode from a saved list has no row in `channels`, so it can't
        // be a favorite there.
        let favorite = item.favorite;
        let row_channel = found.channel.as_ref();
        let lost = (watched.is_some() && row_channel.is_none())
            || (favorite && row_channel.is_none_or(|c| c.show.is_some()));
        if lost {
            plan.miss(&r.name, r.kind.into(), found.why);
        }
        let Some(channel) = found.channel else {
            continue;
        };
        if let Some(watched) = watched {
            let watched = Watched {
                first_watched_at: shift(watched.first_watched_at),
                last_watched_at: shift(watched.last_watched_at),
                ..watched
            };
            match plan.history.get_mut(&channel.id) {
                Some(row) => {
                    if let Some(merged) = merge_watched(Some(row.watched), watched) {
                        row.watched = merged;
                    }
                }
                None => {
                    plan.history.insert(
                        channel.id.clone(),
                        HistoryRow {
                            channel: channel.clone(),
                            watched,
                        },
                    );
                }
            }
        }
        if favorite && channel.show.is_none() {
            plan.favorites.insert(channel.id.clone());
        }
    }
    // Items the source or this device left out for being too large.
    plan.unmatched_total = plan.unmatched_total.saturating_add(export.dropped);
    for pin in &export.pins {
        match pin_row(index, &pin.account, &pin.content_type, &pin.group) {
            Ok(rows) => {
                for row in rows {
                    if !plan.pins.contains(&row) {
                        plan.pins.push(row);
                    }
                }
            }
            Err(reason) => plan.miss(&pin.group, UnmatchedKind::PinnedGroup, reason),
        }
    }
    plan.resume = export.current.as_ref().and_then(|r| {
        let found = index.find(r).ok()?;
        let channel = found.channel?;
        Some(Resume {
            channel_id: channel.id,
            name: channel.name,
            position: None,
            key: found.key,
        })
    });
    plan
}

/// The destination's providers with that account and group. A device can
/// have the same account twice, and each copy gets the pin.
fn pin_row(
    index: &Index,
    account: &AccountTag,
    content_type: &str,
    group: &str,
) -> Result<Vec<PinRow>, Miss> {
    let rows: Vec<PinRow> = index
        .providers_of(account)
        .iter()
        .filter(|p| index.has_group(p, content_type, group))
        .map(|p| PinRow {
            provider_id: p.clone(),
            content_type: content_type.to_string(),
            group: group.to_string(),
        })
        .collect();
    if rows.is_empty() {
        Err(Miss::Missing)
    } else {
        Ok(rows)
    }
}

/// How one kind of row fared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tally {
    /// New on the destination.
    pub added: u32,
    /// Replaced by a newer copy.
    pub updated: u32,
    /// The destination's was newer or the same.
    pub unchanged: u32,
}

impl Tally {
    pub fn count(&mut self, outcome: Outcome) {
        let n = match outcome {
            Outcome::Added => &mut self.added,
            Outcome::Updated => &mut self.updated,
            Outcome::Unchanged => &mut self.unchanged,
        };
        *n = n.saturating_add(1);
    }
}

/// What writing one row did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Added,
    Updated,
    Unchanged,
}

/// What a transfer did on the destination.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Report {
    pub history: Tally,
    pub positions: Tally,
    pub favorites: Tally,
    pub pins: Tally,
    pub unmatched: Vec<Unmatched>,
    pub unmatched_total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<Resume>,
}

#[cfg(test)]
mod tests;
