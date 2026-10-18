// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Cast frames: a 4-byte big-endian length, then a protobuf `CastMessage`.
//!
//! `CastMessage` has seven fields, so it's encoded and decoded here by hand
//! instead of through a protobuf compiler:
//!
//! | Field | Number | Wire type |
//! |---|---|---|
//! | `protocol_version` | 1 | varint, always 0 (`CASTV2_1_0`) |
//! | `source_id` | 2 | bytes |
//! | `destination_id` | 3 | bytes |
//! | `namespace` | 4 | bytes |
//! | `payload_type` | 5 | varint, 0 for text, 1 for binary |
//! | `payload_utf8` | 6 | bytes |
//! | `payload_binary` | 7 | bytes |

use std::fmt;

/// The largest message body a receiver sends or takes, as in Chromium.
pub const MAX_MESSAGE: usize = 64 * 1024;

/// Why bytes from the connection aren't a valid frame. Any of these closes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("a message is longer than 64 KiB")]
    TooLong,
    #[error("a message ends in the middle of a field")]
    Truncated,
    #[error("a message has a field of an unknown wire type")]
    WireType,
    #[error("a message's text isn't UTF-8")]
    Utf8,
    #[error("a message lacks a required field")]
    Missing,
}

#[derive(Clone, PartialEq, Eq)]
pub enum Payload {
    Text(String),
    Binary(Vec<u8>),
}

/// Only the size, since a `LOAD` carries the stream's URL.
impl fmt::Debug for Payload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Payload::Text(t) => write!(f, "{} bytes of text", t.len()),
            Payload::Binary(b) => write!(f, "{} bytes", b.len()),
        }
    }
}

/// One message on the connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CastMessage {
    pub source: String,
    pub destination: String,
    pub namespace: String,
    pub payload: Payload,
}

impl CastMessage {
    pub fn text(source: &str, destination: &str, namespace: &str, text: String) -> Self {
        Self {
            source: source.into(),
            destination: destination.into(),
            namespace: namespace.into(),
            payload: Payload::Text(text),
        }
    }

    /// The message as a frame, length first.
    pub fn encode(&self) -> Vec<u8> {
        let mut body = Vec::with_capacity(64);
        put_varint_field(&mut body, 1, 0);
        put_bytes_field(&mut body, 2, self.source.as_bytes());
        put_bytes_field(&mut body, 3, self.destination.as_bytes());
        put_bytes_field(&mut body, 4, self.namespace.as_bytes());
        match &self.payload {
            Payload::Text(text) => {
                put_varint_field(&mut body, 5, 0);
                put_bytes_field(&mut body, 6, text.as_bytes());
            }
            Payload::Binary(bytes) => {
                put_varint_field(&mut body, 5, 1);
                put_bytes_field(&mut body, 7, bytes);
            }
        }
        // Lengths over u32 can't be built from the fields above.
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&body);
        frame
    }

    /// Reads a message body, the part after the length.
    pub fn decode(body: &[u8]) -> Result<Self, FrameError> {
        if body.len() > MAX_MESSAGE {
            return Err(FrameError::TooLong);
        }
        let mut source = None;
        let mut destination = None;
        let mut namespace = None;
        let mut binary_type = false;
        let mut text = None;
        let mut binary = None;
        let mut rest = body;
        while !rest.is_empty() {
            let key = take_varint(&mut rest)?;
            let (number, wire) = (key >> 3, key & 7);
            match wire {
                0 => {
                    let value = take_varint(&mut rest)?;
                    if number == 5 {
                        binary_type = value == 1;
                    }
                }
                1 => skip(&mut rest, 8)?,
                2 => {
                    let len = usize::try_from(take_varint(&mut rest)?)
                        .map_err(|_| FrameError::Truncated)?;
                    let bytes = rest.get(..len).ok_or(FrameError::Truncated)?;
                    rest = &rest[len..];
                    match number {
                        2 => source = Some(utf8(bytes)?),
                        3 => destination = Some(utf8(bytes)?),
                        4 => namespace = Some(utf8(bytes)?),
                        6 => text = Some(utf8(bytes)?),
                        7 => binary = Some(bytes.to_vec()),
                        _ => {}
                    }
                }
                5 => skip(&mut rest, 4)?,
                _ => return Err(FrameError::WireType),
            }
        }
        let payload = if binary_type {
            Payload::Binary(binary.unwrap_or_default())
        } else {
            Payload::Text(text.ok_or(FrameError::Missing)?)
        };
        Ok(Self {
            source: source.ok_or(FrameError::Missing)?,
            destination: destination.ok_or(FrameError::Missing)?,
            namespace: namespace.ok_or(FrameError::Missing)?,
            payload,
        })
    }
}

/// Splits the bytes read from the connection into messages. A read can end
/// anywhere, so it keeps what's left of a frame for the next one.
#[derive(Debug, Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next whole message, `None` while it's still incomplete.
    pub fn next_message(&mut self) -> Option<Result<CastMessage, FrameError>> {
        let len: [u8; 4] = self.buf.get(..4)?.try_into().ok()?;
        let len = u32::from_be_bytes(len) as usize;
        if len > MAX_MESSAGE {
            // Nothing after this can be trusted, so drop it all.
            self.buf.clear();
            return Some(Err(FrameError::TooLong));
        }
        let body = self.buf.get(4..4 + len)?;
        let message = CastMessage::decode(body);
        self.buf.drain(..4 + len);
        Some(message)
    }
}

fn utf8(bytes: &[u8]) -> Result<String, FrameError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| FrameError::Utf8)
}

fn skip(rest: &mut &[u8], n: usize) -> Result<(), FrameError> {
    if rest.len() < n {
        return Err(FrameError::Truncated);
    }
    *rest = &rest[n..];
    Ok(())
}

fn take_varint(rest: &mut &[u8]) -> Result<u64, FrameError> {
    let mut value = 0u64;
    for i in 0..10 {
        let (&byte, tail) = rest.split_first().ok_or(FrameError::Truncated)?;
        *rest = tail;
        value |= u64::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    // More than ten bytes can't be a 64-bit varint.
    Err(FrameError::Truncated)
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn put_varint_field(out: &mut Vec<u8>, number: u64, value: u64) {
    put_varint(out, number << 3);
    put_varint(out, value);
}

fn put_bytes_field(out: &mut Vec<u8>, number: u64, bytes: &[u8]) {
    put_varint(out, (number << 3) | 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}
