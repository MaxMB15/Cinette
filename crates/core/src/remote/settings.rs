// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The two remote-control settings and what they allow.

use super::message::{CloseReason, DeviceType};
use serde::{Deserialize, Serialize};

/// Who may control this device. Spec 4 B.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlMode {
    /// Accept requests without asking.
    Always,
    /// Ask on this device for each new connection.
    #[default]
    Ask,
    /// Refuse every request without asking.
    Never,
}

/// The remote-control settings, as saved in `settings.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteSettings {
    /// "Discoverable on this network". Spec 4 A.
    pub discoverable: bool,
    /// "Remote control". Spec 4 B.
    pub remote_control: ControlMode,
    /// The name the user gave this device. `None` uses [`default_name`].
    pub device_name: Option<String>,
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            discoverable: true,
            remote_control: ControlMode::Ask,
            device_name: None,
        }
    }
}

/// What to do with a new request to control this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Ask,
    Reject(CloseReason),
}

/// The longest device name, in bytes. A DNS-SD TXT entry holds 255 bytes, and
/// this leaves room for the key.
pub const MAX_NAME_BYTES: usize = 63;

impl RemoteSettings {
    /// The decision for a new connection that asks for control. A session
    /// that resumes isn't new, so it doesn't come here.
    pub fn decide(&self) -> Decision {
        if !self.discoverable {
            return Decision::Reject(CloseReason::NotDiscoverable);
        }
        match self.remote_control {
            ControlMode::Always => Decision::Accept,
            ControlMode::Ask => Decision::Ask,
            ControlMode::Never => Decision::Reject(CloseReason::NotAllowed),
        }
    }

    /// Whether to advertise the device at all.
    pub fn advertise(&self) -> bool {
        self.discoverable
    }

    /// Whether the discovery record says the device can be controlled. It
    /// doesn't say whether the device asks first.
    pub fn available(&self) -> bool {
        self.remote_control != ControlMode::Never
    }

    /// The name to show and advertise.
    pub fn name(&self, device_type: DeviceType) -> String {
        self.device_name
            .as_deref()
            .and_then(clean_name)
            .unwrap_or_else(|| default_name(device_type).to_owned())
    }
}

/// The name a device has until the user names it. It's the kind of device
/// rather than the system's device name, which often carries the owner's name.
pub fn default_name(device_type: DeviceType) -> &'static str {
    match device_type {
        DeviceType::Mac => "Mac",
        DeviceType::LinuxPc => "Linux PC",
        DeviceType::WindowsPc => "Windows PC",
        DeviceType::Iphone => "iPhone",
        DeviceType::Ipad => "iPad",
        DeviceType::AndroidPhone => "Android phone",
        DeviceType::AndroidTablet => "Android tablet",
        DeviceType::AndroidTv => "Android TV",
        DeviceType::FireTv => "Fire TV",
    }
}

/// A name with control characters removed, outer spaces trimmed and the
/// length cut to [`MAX_NAME_BYTES`] at a character boundary. `None` when
/// nothing is left.
pub fn clean_name(name: &str) -> Option<String> {
    let mut cleaned: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_owned();
    // mutants: skip BinaryOperator: Cutting a name of exactly MAX_NAME_BYTES to that length changes nothing.
    if cleaned.len() > MAX_NAME_BYTES {
        let mut end = MAX_NAME_BYTES;
        while !cleaned.is_char_boundary(end) {
            end -= 1;
        }
        cleaned.truncate(end);
        cleaned.truncate(cleaned.trim_end().len());
    }
    (!cleaned.is_empty()).then_some(cleaned)
}

#[cfg(test)]
mod tests;
