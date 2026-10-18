// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The Cast receivers on the local network, as `_googlecast._tcp` browsing
//! finds them. The registry holds what the picker lists and what the Cast
//! destination connects to.
//!
//! - A receiver's id is `cast:` and its TXT `id`, which stays the same when
//!   its name or address changes.
//! - A receiver that goes away is dropped, unless the frontend holds it,
//!   as it does the active destination and the rows of an open picker.
//!   Then it stays listed as unavailable.
//! - A receiver that couldn't be reached is unavailable until discovery
//!   reports it again.

// The Cast destination looks receivers up and marks them unreachable from
// the next step on.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;

use serde::Serialize;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::discovery::Event;

/// The service type Cast receivers advertise.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub const SERVICE_TYPE: &str = "_googlecast._tcp";

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

#[derive(Debug, Default)]
pub struct Registry {
    /// By id.
    receivers: BTreeMap<String, CastReceiver>,
    /// Which receiver each DNS-SD instance is, since a goodbye names only
    /// the instance.
    instances: BTreeMap<String, String>,
    held: HashSet<String>,
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
                let (Some(id), Some(&addr)) = (txt.get_str("id"), addrs.first()) else {
                    return false;
                };
                let receiver = CastReceiver {
                    id: format!("cast:{id}"),
                    name: txt.get_str("fn").unwrap_or(&instance).to_string(),
                    model: txt.get_str("md").unwrap_or_default().to_string(),
                    status: txt.get_str("rs").map(str::to_string),
                    available: true,
                    addr,
                    port,
                };
                self.found(instance, receiver)
            }
            Event::Removed { instance } => self.removed(&instance),
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn found(&mut self, instance: String, receiver: CastReceiver) -> bool {
        let id = receiver.id.clone();
        if let Some(old) = self.instances.insert(instance, id.clone())
            && old != id
        {
            self.forget(&old);
        }
        self.receivers.insert(id, receiver.clone()) != Some(receiver)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn removed(&mut self, instance: &str) -> bool {
        let Some(id) = self.instances.remove(instance) else {
            return false;
        };
        self.forget(&id)
    }

    /// Drops `id`, or marks it unavailable while it's held.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn forget(&mut self, id: &str) -> bool {
        if self.held.contains(id) {
            return self.unreachable(id);
        }
        self.receivers.remove(id).is_some()
    }

    /// A connection to `id` failed.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn unreachable(&mut self, id: &str) -> bool {
        match self.receivers.get_mut(id) {
            Some(receiver) if receiver.available => {
                receiver.available = false;
                true
            }
            _ => false,
        }
    }

    /// Keeps `ids` listed while they're gone, and lets go of any held
    /// before. Returns whether the list changed.
    pub fn hold(&mut self, ids: impl IntoIterator<Item = String>) -> bool {
        self.held = ids.into_iter().collect();
        let known: HashSet<&String> = self.instances.values().collect();
        let gone: Vec<String> = self
            .receivers
            .keys()
            .filter(|id| !known.contains(id) && !self.held.contains(*id))
            .cloned()
            .collect();
        for id in &gone {
            self.receivers.remove(id);
        }
        !gone.is_empty()
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn get(&self, id: &str) -> Option<&CastReceiver> {
        self.receivers.get(id)
    }

    /// Every receiver, by name.
    pub fn list(&self) -> Vec<CastReceiver> {
        let mut list: Vec<CastReceiver> = self.receivers.values().cloned().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        list
    }
}
