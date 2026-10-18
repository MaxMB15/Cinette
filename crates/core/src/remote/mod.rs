// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Remote control between Cinette devices on the same network.
//!
//! Nothing here touches a socket or a clock. The platform layer finds
//! devices, opens connections and keeps time, and passes the bytes it reads
//! and the current time in. What comes back says what to send, what to show
//! and what to apply to the player. That way every platform runs the same
//! permission, consent and encryption code.
//!
//! A controller connects to a target and runs a Noise XX handshake
//! ([`handshake`]). Both sides then show a verification code. The target
//! decides from its [`settings`] whether to accept, ask the user ([`consent`])
//! or refuse. An accepted controller gets a session ([`sessions`]), sees the
//! target's playback state and sends it commands ([`target`],
//! [`controller`]).

pub mod catalog;
pub mod channel;
pub mod consent;
pub mod controller;
pub mod handshake;
pub mod identity;
pub mod message;
pub mod sessions;
pub mod settings;
pub mod target;

#[cfg(test)]
mod tests;

/// A connection the platform layer opened, as [`target::Target`] numbers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ConnId(pub u64);

/// Random bytes from the operating system.
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // The OS random source only fails on a broken system, where nothing
    // here could be made safe anyway.
    getrandom::fill(&mut bytes).expect("the operating system's random source failed");
    bytes
}

/// Lowercase hex, for nonces and ids inside messages.
pub(crate) fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0xf)] as char);
    }
    out
}

/// Reads exactly `N` bytes of lowercase or uppercase hex.
pub(crate) fn from_hex<const N: usize>(text: &str) -> Option<[u8; N]> {
    let text = text.as_bytes();
    if text.len() != N * 2 {
        return None;
    }
    let digit = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    // Built from the text alone, with no filler bytes, since the result
    // becomes a nonce.
    let bytes: Vec<u8> = text
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[hi, lo]| Some((digit(hi)? << 4) | digit(lo)?))
        .collect::<Option<_>>()?;
    bytes.try_into().ok()
}
