// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The other Cinette devices on the network, as `_cinette._tcp` browsing
//! finds them.
//!
//! A record is only a hint: the handshake proves which key is behind an id.
//! Records that don't read as a Cinette device (an unknown version, an id
//! that doesn't parse) are left out, and so is this device's own record.

use crate::discovery::{Event, Txt};
use mvp_core::remote::identity::DeviceId;
use mvp_core::remote::message::{DeviceType, PROTOCOL_VERSION};
use mvp_core::remote::settings::clean_name;
use serde::Serialize;
use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr};

/// A device as the picker shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub device_id: String,
    pub name: String,
    pub device_type: DeviceType,
    /// False when its owner set Remote control to Never allow.
    pub control_allowed: bool,
    /// False once discovery lost it. Only the device this one controls is
    /// kept listed after that.
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    id: DeviceId,
    device: RemoteDevice,
    addrs: Vec<IpAddr>,
    port: u16,
}

/// What a record says, if it's a Cinette device this one can talk to.
fn read_record(txt: &Txt) -> Option<(DeviceId, String, DeviceType, bool)> {
    let speaks_ours = txt
        .get_str("v")?
        .split(',')
        .any(|v| v.trim().parse::<u32>().ok() == Some(PROTOCOL_VERSION));
    if !speaks_ours {
        return None;
    }
    let id = DeviceId::parse(txt.get_str("id")?)?;
    let device_type = txt
        .get_str("t")
        .and_then(DeviceType::parse)
        .unwrap_or(DeviceType::Other);
    let name = txt
        .get_str("n")
        .and_then(clean_name)
        .unwrap_or_else(|| mvp_core::remote::settings::default_name(device_type).to_owned());
    let control_allowed = txt.get_str("rc") == Some("1");
    Some((id, name, device_type, control_allowed))
}

/// The devices found so far, by DNS-SD instance name.
#[derive(Debug, Default)]
pub struct Devices {
    own: Option<DeviceId>,
    entries: BTreeMap<String, Entry>,
    /// The device being controlled stays listed when discovery loses it.
    keep: Option<DeviceId>,
}

impl Devices {
    /// Devices, leaving out the one with id `own`.
    pub fn new(own: DeviceId) -> Self {
        Self {
            own: Some(own),
            ..Self::default()
        }
    }

    /// This device's id changed.
    pub fn set_own(&mut self, own: DeviceId) {
        self.entries.retain(|_, e| e.id != own);
        self.own = Some(own);
    }

    /// Keeps `id` listed, as unavailable, if discovery loses it.
    pub fn keep(&mut self, id: Option<DeviceId>) {
        self.keep = id;
        let keep = self.keep.clone();
        self.entries
            .retain(|_, e| e.device.available || Some(&e.id) == keep.as_ref());
    }

    /// Takes in a discovery event. True when the list changed.
    pub fn apply(&mut self, event: Event) -> bool {
        match event {
            Event::Found {
                instance,
                addrs,
                port,
                txt,
                ..
            } => {
                let Some((id, name, device_type, control_allowed)) = read_record(&txt) else {
                    return self.entries.remove(&instance).is_some();
                };
                if Some(&id) == self.own.as_ref() {
                    return false;
                }
                let entry = Entry {
                    device: RemoteDevice {
                        device_id: id.to_string(),
                        name,
                        device_type,
                        control_allowed,
                        available: true,
                    },
                    id,
                    addrs,
                    port,
                };
                // The same device under a new instance name replaces the old one.
                let before = self.entries.len();
                self.entries
                    .retain(|i, e| *i == instance || e.id != entry.id);
                let replaced = self.entries.len() != before;
                let changed = self.entries.get(&instance) != Some(&entry);
                self.entries.insert(instance, entry);
                changed || replaced
            }
            Event::Removed { instance } => {
                let keep = self.keep.clone();
                match self.entries.get_mut(&instance) {
                    Some(e) if Some(&e.id) == keep.as_ref() => {
                        let was = e.device.available;
                        e.device.available = false;
                        was
                    }
                    Some(_) => self.entries.remove(&instance).is_some(),
                    None => false,
                }
            }
        }
    }

    /// The list for the picker, by name.
    pub fn list(&self) -> Vec<RemoteDevice> {
        let mut list: Vec<RemoteDevice> = self.entries.values().map(|e| e.device.clone()).collect();
        list.sort_by(|a, b| a.name.cmp(&b.name).then(a.device_id.cmp(&b.device_id)));
        list
    }

    /// Where to reach a device, IPv4 first, or nothing when it isn't
    /// available now.
    pub fn addresses(&self, id: &DeviceId) -> Vec<SocketAddr> {
        self.entries
            .values()
            .filter(|e| &e.id == id && e.device.available)
            .flat_map(|e| e.addrs.iter().map(|a| SocketAddr::new(*a, e.port)))
            .collect()
    }

    /// The device with this id, if it's listed.
    pub fn get(&self, id: &DeviceId) -> Option<&RemoteDevice> {
        self.entries
            .values()
            .find(|e| &e.id == id)
            .map(|e| &e.device)
    }
}

#[cfg(test)]
#[path = "devices_tests.rs"]
mod tests;
