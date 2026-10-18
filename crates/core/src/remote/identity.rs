// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A device's long-term key and the id other devices know it by.

use blake2::{Blake2s256, Digest};
use curve25519_dalek::MontgomeryPoint;
use serde::{Deserialize, Serialize};
use std::fmt;

/// The length of an X25519 key, private or public.
pub const KEY_LEN: usize = 32;

/// A device's long-term X25519 key pair. The platform saves the private half
/// where only the app can read it, and loads it with [`DeviceKey::from_private`].
#[derive(Clone)]
pub struct DeviceKey {
    private: [u8; KEY_LEN],
    public: [u8; KEY_LEN],
}

impl DeviceKey {
    /// A new random key, for a device that has none yet, or for "Reset device
    /// identity".
    pub fn generate() -> Self {
        Self::from_private(super::random_bytes())
    }

    /// The key whose private half was saved. The public half is worked out
    /// again rather than saved, so the two can't disagree.
    pub fn from_private(private: [u8; KEY_LEN]) -> Self {
        let public = MontgomeryPoint::mul_base_clamped(private).to_bytes();
        Self { private, public }
    }

    /// The private half, for the platform to save.
    pub fn private_bytes(&self) -> &[u8; KEY_LEN] {
        &self.private
    }

    pub fn public_bytes(&self) -> &[u8; KEY_LEN] {
        &self.public
    }

    pub fn device_id(&self) -> DeviceId {
        DeviceId::from_public_key(&self.public)
    }
}

impl fmt::Debug for DeviceKey {
    // Never prints the private half.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceKey")
            .field("id", &self.device_id())
            .finish_non_exhaustive()
    }
}

/// Who a device is: the first 16 bytes of the BLAKE2s-256 hash of its public
/// key, in lowercase base32 without padding. Anyone can check that a key
/// belongs to an id, and no one can choose an id for a key they don't hold.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct DeviceId(String);

/// How many bytes of the hash make the id.
const ID_BYTES: usize = 16;
/// 16 bytes are 128 bits, which take 26 base32 digits.
const ID_LEN: usize = 26;

impl DeviceId {
    pub fn from_public_key(public: &[u8]) -> Self {
        let hash = Blake2s256::digest(public);
        Self(base32(&hash[..ID_BYTES]))
    }

    /// Reads an id from a discovery record or a saved setting.
    pub fn parse(text: &str) -> Option<Self> {
        let valid = text.len() == ID_LEN
            && text.bytes().all(|c| matches!(c, b'a'..=b'z' | b'2'..=b'7'))
            // The last digit holds 3 bits of the hash and 2 bits of padding,
            // which are always zero.
            && base32_value(text.as_bytes()[ID_LEN - 1]).is_some_and(|v| v & 0b11 == 0);
        valid.then(|| Self(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether `public` is the key behind this id.
    pub fn matches_key(&self, public: &[u8]) -> bool {
        *self == Self::from_public_key(public)
    }
}

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for DeviceId {
    type Error = String;
    fn try_from(text: String) -> Result<Self, String> {
        Self::parse(&text).ok_or_else(|| "not a device id".to_owned())
    }
}

impl From<DeviceId> for String {
    fn from(id: DeviceId) -> String {
        id.0
    }
}

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

fn base32_value(c: u8) -> Option<u8> {
    BASE32.iter().position(|&d| d == c).map(|v| v as u8)
}

/// RFC 4648 base32 in lowercase, without padding.
fn base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &b in bytes {
        // mutants: skip BinaryOperator: The shift leaves the low 8 bits zero, so ^ gives the same value.
        buffer = (buffer << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests;
