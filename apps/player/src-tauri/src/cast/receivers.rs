// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The Cast receivers on the local network, as `_googlecast._tcp` browsing
//! finds them. The registry holds what the picker lists and what the Cast
//! destination connects to.
//!
//! - A receiver's id is `cast:` and its TXT `id`, which stays the same when
//!   its name or address changes.
//! - Several DNS-SD instances can claim one id, as a receiver does for a
//!   while after a restart, when mDNS renames it "TV (2)". The first live
//!   one is listed, with its address, and the id goes only when none is
//!   left.
//! - A receiver that goes away is dropped, unless the frontend holds it,
//!   as it does the active destination and the rows of an open picker.
//!   Then it stays listed as unavailable.
//! - A receiver that couldn't be reached is unavailable for
//!   [`UNREACHABLE_FOR`], or until discovery reports it again. Discovery
//!   only reports a receiver again when its record changes, so the time
//!   limit is what usually ends it.
//! - At most [`MAX_RECEIVERS`] are listed, so a host that advertises
//!   without end can't flood the picker.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::IpAddr;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::Duration;
use std::time::Instant;

use serde::Serialize;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::discovery::Event;

/// The service type Cast receivers advertise.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub const SERVICE_TYPE: &str = "_googlecast._tcp";

/// The most receivers listed. A home has a handful.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub const MAX_RECEIVERS: usize = 128;

/// How long a receiver that couldn't be reached shows as unavailable.
#[cfg(any(target_os = "linux", target_os = "macos"))]
// The Cast destination uses it from step 6.
#[cfg_attr(not(test), allow(dead_code))]
pub const UNREACHABLE_FOR: Duration = Duration::from_secs(30);

/// The longest name, model or status kept, in characters.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const MAX_TEXT: usize = 64;

/// A receiver as the frontend sees it. Its address stays in Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastReceiver {
    /// `cast:<TXT id>`.
    pub id: String,
    /// The name its owner gave it, such as "Living Room TV".
    pub name: String,
    /// Such as "Chromecast Ultra", for `castProfile`.
    pub model: String,
    /// What it shows now, such as "YouTube", when it says.
    pub status: Option<String>,
    pub available: bool,
    #[serde(skip)]
    pub addr: IpAddr,
    #[serde(skip)]
    pub port: u16,
}

/// The list the frontend gets. A newer list has a higher `revision`, so the
/// frontend keeps the newest of the command's reply and the events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverList {
    pub revision: u64,
    pub receivers: Vec<CastReceiver>,
    /// macOS refuses this app local network access, so nothing can be
    /// found until it's allowed in System Settings.
    pub local_network_denied: bool,
}

#[derive(Debug, Default)]
pub struct Registry {
    /// What each DNS-SD instance advertised, by instance name.
    records: BTreeMap<String, CastReceiver>,
    /// The instances that claim each id, in the order they came.
    claims: BTreeMap<String, Vec<String>>,
    /// Held receivers that went away, by id.
    gone: BTreeMap<String, CastReceiver>,
    /// Until when each receiver that couldn't be reached shows so, by id.
    unreachable: HashMap<String, Instant>,
    held: HashSet<String>,
    revision: u64,
}

/// `text` without control or bidi formatting characters, trimmed and
/// capped, so one name can't pass for another in the picker or a log.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn clean(text: &str) -> String {
    let bidi = |c: char| {
        matches!(c, '\u{200E}' | '\u{200F}' | '\u{061C}')
            || ('\u{202A}'..='\u{202E}').contains(&c)
            || ('\u{2066}'..='\u{2069}').contains(&c)
    };
    text.chars()
        .filter(|&c| !c.is_control() && !bidi(c))
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_TEXT)
        .collect()
}

impl Registry {
    /// Applies what browsing found. Returns whether the list changed.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn apply(&mut self, event: Event) -> bool {
        match event {
            Event::Found {
                instance,
                addrs,
                port,
                txt,
                ..
            } => {
                // The address the converter's server routes to, IPv4 first.
                let id = txt.get_str("id").map(clean).filter(|id| !id.is_empty());
                let (Some(id), Some(&addr)) = (id, addrs.first()) else {
                    return false;
                };
                let name = txt
                    .get_str("fn")
                    .map(clean)
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| clean(&instance));
                let receiver = CastReceiver {
                    id: format!("cast:{id}"),
                    name,
                    model: txt.get_str("md").map(clean).unwrap_or_default(),
                    status: txt.get_str("rs").map(clean).filter(|s| !s.is_empty()),
                    available: true,
                    addr,
                    port,
                };
                self.found(instance, receiver)
            }
            Event::Removed { instance } => self.removed(&instance),
        }
    }

    /// What the frontend would see, to tell whether a change shows.
    fn view(&self) -> Vec<(String, String, String, Option<String>, bool)> {
        self.list()
            .into_iter()
            .map(|r| (r.id, r.name, r.model, r.status, r.available))
            .collect()
    }

    /// Runs `change`, and moves to a new revision when the list it shows
    /// changed. Returns whether it did.
    fn changing(&mut self, change: impl FnOnce(&mut Self)) -> bool {
        let before = self.view();
        change(self);
        let changed = self.view() != before;
        if changed {
            self.revision += 1;
        }
        changed
    }

    /// `instance` advertised `receiver`.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn found(&mut self, instance: String, receiver: CastReceiver) -> bool {
        let id = receiver.id.clone();
        let known = self.claims.contains_key(&id) || self.gone.contains_key(&id);
        if !known && self.claims.len() + self.gone.len() >= MAX_RECEIVERS {
            return false;
        }
        self.changing(|registry| {
            // The instance may have claimed another id before.
            registry.release(&instance);
            registry.gone.remove(&id);
            // Seen again, so it can be tried again.
            registry.unreachable.remove(&id);
            registry
                .claims
                .entry(id)
                .or_default()
                .push(instance.clone());
            registry.records.insert(instance, receiver);
        })
    }

    /// `instance` went away.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn removed(&mut self, instance: &str) -> bool {
        self.changing(|registry| registry.release(instance))
    }

    /// The browse stopped, so nothing it found can be counted on.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn ended(&mut self) -> bool {
        self.changing(|registry| {
            let instances: Vec<String> = registry.records.keys().cloned().collect();
            for instance in instances {
                registry.release(&instance);
            }
        })
    }

    /// Drops `instance`'s claim. An id with no claim left is dropped, or
    /// kept as gone while it's held.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn release(&mut self, instance: &str) {
        let Some(record) = self.records.remove(instance) else {
            return;
        };
        let Some(claim) = self.claims.get_mut(&record.id) else {
            return;
        };
        claim.retain(|i| i != instance);
        if claim.is_empty() {
            self.claims.remove(&record.id);
            if self.held.contains(&record.id) {
                self.gone.insert(record.id.clone(), record);
            }
        }
    }

    /// A connection to `id` failed at `now`.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn unreachable(&mut self, id: &str, until: Instant) -> bool {
        if !self.claims.contains_key(id) {
            return false;
        }
        self.changing(|registry| {
            registry.unreachable.insert(id.to_string(), until);
        })
    }

    /// Ends the marks from [`Self::unreachable`] that are over at `now`.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn expire(&mut self, now: Instant) -> bool {
        self.changing(|registry| {
            registry.unreachable.retain(|_, until| *until > now);
        })
    }

    /// Keeps `ids` listed while they're gone, and lets go of any held
    /// before. Returns whether the list changed.
    pub fn hold(&mut self, ids: impl IntoIterator<Item = String>) -> bool {
        self.changing(|registry| {
            registry.held = ids.into_iter().collect();
            let held = &registry.held;
            registry.gone.retain(|id, _| held.contains(id));
        })
    }

    /// The receiver listed as `id`, from the first instance that claims it.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    // The Cast destination uses it from step 6.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn get(&self, id: &str) -> Option<CastReceiver> {
        let first = self.claims.get(id)?.first()?;
        let mut receiver = self.records.get(first)?.clone();
        receiver.available = !self.unreachable.contains_key(id);
        Some(receiver)
    }

    /// Every receiver, by name.
    pub fn list(&self) -> Vec<CastReceiver> {
        let mut list: Vec<CastReceiver> = self
            .claims
            .iter()
            .filter_map(|(id, instances)| {
                let mut receiver = self.records.get(instances.first()?)?.clone();
                receiver.available = !self.unreachable.contains_key(id);
                Some(receiver)
            })
            .chain(self.gone.values().map(|r| CastReceiver {
                available: false,
                ..r.clone()
            }))
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        list
    }

    /// The list with its revision.
    pub fn snapshot(&self, local_network_denied: bool) -> ReceiverList {
        ReceiverList {
            revision: self.revision,
            receivers: self.list(),
            local_network_denied,
        }
    }
}
