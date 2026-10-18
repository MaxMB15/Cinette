// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Frames on the wire, and the encrypted channel after the handshake.
//!
//! Each frame is a 2-byte big-endian length followed by that many bytes of a
//! Noise message. Noise counts the messages each way, so a frame that is
//! replayed, dropped, reordered or changed fails to decrypt.

use super::message::{self, MAX_FRAME, MAX_MESSAGE};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ChannelError {
    #[error("message too large")]
    TooLarge,
    #[error("frame failed to decrypt")]
    Decrypt,
}

/// The encrypted channel two devices share once the handshake is done.
pub struct Channel {
    transport: Box<snow::TransportState>,
}

impl Channel {
    pub(crate) fn new(transport: snow::TransportState) -> Self {
        Self {
            transport: Box::new(transport),
        }
    }

    /// Encrypts a message and frames it for sending.
    pub fn seal<T: Serialize>(&mut self, message: &T) -> Result<Vec<u8>, ChannelError> {
        self.seal_bytes(&message::encode(message))
    }

    pub(crate) fn seal_bytes(&mut self, plain: &[u8]) -> Result<Vec<u8>, ChannelError> {
        if plain.len() > MAX_MESSAGE {
            return Err(ChannelError::TooLarge);
        }
        let mut out = vec![0u8; MAX_FRAME];
        let len = self
            .transport
            .write_message(plain, &mut out)
            .map_err(|_| ChannelError::TooLarge)?;
        Ok(frame(&out[..len]))
    }

    /// Decrypts one frame's contents, as [`FrameReader`] returns them.
    pub fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>, ChannelError> {
        let mut out = vec![0u8; frame.len()];
        let len = self
            .transport
            .read_message(frame, &mut out)
            .map_err(|_| ChannelError::Decrypt)?;
        out.truncate(len);
        Ok(out)
    }
}

/// Puts the length in front of a Noise message.
pub(crate) fn frame(noise: &[u8]) -> Vec<u8> {
    debug_assert!(noise.len() <= MAX_FRAME);
    let mut out = Vec::with_capacity(noise.len() + 2);
    out.extend_from_slice(&(noise.len() as u16).to_be_bytes());
    out.extend_from_slice(noise);
    out
}

/// Splits the bytes read from a connection into frames.
#[derive(Debug, Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
}

/// A frame with no contents. No Noise message is empty, so the other side is
/// broken or hostile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("empty frame")]
pub struct EmptyFrame;

impl FrameReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds bytes as they arrive.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// The next whole frame's contents, if one has arrived.
    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>, EmptyFrame> {
        if self.buffer.len() < 2 {
            return Ok(None);
        }
        let len = usize::from(u16::from_be_bytes([self.buffer[0], self.buffer[1]]));
        if len == 0 {
            return Err(EmptyFrame);
        }
        if self.buffer.len() < 2 + len {
            return Ok(None);
        }
        let frame = self.buffer[2..2 + len].to_vec();
        self.buffer.drain(..2 + len);
        Ok(Some(frame))
    }
}

#[cfg(test)]
mod tests;
