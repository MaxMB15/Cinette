// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Splits ffmpeg's live Matroska output into its header and its top-level
//! elements, so a receiver that opens the stream again, as players do after
//! a first look, gets the header and then a cluster it can start from.
//!
//! ffmpeg starts a live cluster every 32 KB or every second, so most begin
//! partway through a group of pictures. Only a cluster whose first video
//! block is a keyframe is a start point, so the picture starts clean. With
//! no video, every cluster is one.
//!
//! Matroska is EBML: each element is an ID, a size and its data, and both
//! the ID and the size are variable-length integers. The file is an EBML
//! header element, then a Segment whose size is unknown in a live stream,
//! then the Segment's children: Info, Tracks, then Clusters.

const SEGMENT: u32 = 0x1853_8067;
const CLUSTER: u32 = 0x1F43_B675;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_TYPE: u32 = 0x83;
/// The track type of video.
const VIDEO: u64 = 1;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const REFERENCE_BLOCK: u32 = 0xFB;
/// No element ffmpeg writes for a stream comes near this. A larger one
/// means the bytes aren't what this expects.
const MAX_ELEMENT: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MkvError {
    #[error("the stream isn't Matroska")]
    NotMatroska,
    #[error("an element has a size the stream can't be split by")]
    Size,
}

/// A part of the stream, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    /// Everything before the first cluster: the EBML header, the Segment's
    /// start, Info and Tracks. It comes once, and every request starts
    /// with it.
    Header(Vec<u8>),
    /// One top-level element after it. A request that joins late starts at
    /// one that's a `start`: a cluster that starts with a keyframe.
    Element { bytes: Vec<u8>, start: bool },
}

#[derive(Debug, Default)]
pub struct MkvSplitter {
    buf: Vec<u8>,
    /// How far the header reaches into `buf`, while it's still being read.
    header_end: usize,
    /// Whether the Segment's start is part of the header yet.
    in_segment: bool,
    header_sent: bool,
    /// The video track's number, from Tracks, when the stream has video.
    video_track: Option<u64>,
}

impl MkvSplitter {
    /// Bytes from ffmpeg. Returns the pieces they complete.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Piece>, MkvError> {
        self.buf.extend_from_slice(bytes);
        let mut pieces = Vec::new();
        loop {
            let start = self.header_end;
            let Some((id, size, head_len)) = element_head(&self.buf[start..])? else {
                break;
            };
            if !self.header_sent {
                if !self.in_segment {
                    if start == 0 && id != 0x1A45_DFA3 {
                        return Err(MkvError::NotMatroska);
                    }
                    if id == SEGMENT {
                        // Its children follow at once, whatever its size.
                        self.in_segment = true;
                        self.header_end = start + head_len;
                        continue;
                    }
                } else if id == CLUSTER {
                    let header = self.buf.drain(..start).collect();
                    pieces.push(Piece::Header(header));
                    self.header_end = 0;
                    self.header_sent = true;
                    continue;
                }
                let Some(len) = whole_length(size, head_len)? else {
                    return Err(MkvError::Size);
                };
                // Wait for the rest of the element.
                let Some(whole) = self.buf.get(start..start + len) else {
                    break;
                };
                if self.in_segment && id == TRACKS {
                    self.video_track = video_track(&whole[head_len..]);
                }
                self.header_end = start + len;
                continue;
            }
            let Some(len) = whole_length(size, head_len)? else {
                return Err(MkvError::Size);
            };
            if self.buf.get(..len).is_none() {
                break;
            }
            let bytes: Vec<u8> = self.buf.drain(..len).collect();
            let start = id == CLUSTER
                && self
                    .video_track
                    .is_none_or(|track| starts_with_keyframe(&bytes[head_len..], track));
            pieces.push(Piece::Element { bytes, start });
        }
        Ok(pieces)
    }
}

/// The children of `data`, an element's data, as their IDs and data. It
/// stops at the first child that's cut short or has an unknown size.
fn children(data: &[u8]) -> impl Iterator<Item = (u32, &[u8])> {
    let mut rest = data;
    std::iter::from_fn(move || {
        let (id, size, head_len) = element_head(rest).ok()??;
        let len = whole_length(size, head_len).ok()??;
        let child = rest.get(head_len..len)?;
        rest = &rest[len..];
        Some((id, child))
    })
}

/// An unsigned integer element's value.
fn uint(data: &[u8]) -> u64 {
    data.iter().fold(0, |acc, &b| acc << 8 | u64::from(b))
}

/// The number of the first video track in Tracks' data.
fn video_track(tracks: &[u8]) -> Option<u64> {
    children(tracks)
        .filter(|&(id, _)| id == TRACK_ENTRY)
        .find_map(|(_, entry)| {
            let field = |wanted| {
                children(entry)
                    .find(|&(id, _)| id == wanted)
                    .map(|(_, data)| uint(data))
            };
            (field(TRACK_TYPE) == Some(VIDEO))
                .then(|| field(TRACK_NUMBER))
                .flatten()
        })
}

/// Whether the first block of `track` in a cluster's data is a keyframe:
/// a SimpleBlock with its keyframe flag, or a BlockGroup that refers to no
/// other frame. CRC-32, Void, the cluster's Timestamp and the other tracks'
/// blocks come and go before it. A cluster with no block of the track
/// isn't a start.
fn starts_with_keyframe(cluster: &[u8], track: u64) -> bool {
    children(cluster)
        .find_map(|(id, data)| match id {
            SIMPLE_BLOCK => {
                let (len, number) = vint(data)?;
                // The flags come after the track number and a two-byte
                // timestamp.
                let flags = *data.get(len + 2)?;
                (number == track).then_some(flags & 0x80 != 0)
            }
            BLOCK_GROUP => {
                let (_, block) = children(data).find(|&(id, _)| id == BLOCK)?;
                let (_, number) = vint(block)?;
                (number == track).then(|| children(data).all(|(id, _)| id != REFERENCE_BLOCK))
            }
            _ => None,
        })
        .unwrap_or(false)
}

/// A variable-length integer's length and value, without its marker.
fn vint(bytes: &[u8]) -> Option<(usize, u64)> {
    let &first = bytes.first()?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 {
        return None;
    }
    let value = bytes
        .get(1..len)?
        .iter()
        .fold(u64::from(first) & (0xFF >> len), |acc, &b| {
            acc << 8 | u64::from(b)
        });
    Some((len, value))
}

/// An element's whole length, its head and its data, or `None` when its
/// size is unknown.
fn whole_length(size: Option<u64>, head_len: usize) -> Result<Option<usize>, MkvError> {
    match size {
        None => Ok(None),
        Some(size) if size > MAX_ELEMENT => Err(MkvError::Size),
        Some(size) => Ok(Some(head_len + size as usize)),
    }
}

/// The ID, the size (`None` when unknown) and the head's length of the
/// element at the start of `bytes`, or `None` while it's incomplete.
fn element_head(bytes: &[u8]) -> Result<Option<(u32, Option<u64>, usize)>, MkvError> {
    let Some(&first) = bytes.first() else {
        return Ok(None);
    };
    let id_len = first.leading_zeros() as usize + 1;
    if id_len > 4 {
        return Err(MkvError::NotMatroska);
    }
    let Some(&size_first) = bytes.get(id_len) else {
        return Ok(None);
    };
    let size_len = size_first.leading_zeros() as usize + 1;
    if size_len > 8 {
        return Err(MkvError::NotMatroska);
    }
    let Some(head) = bytes.get(..id_len + size_len) else {
        return Ok(None);
    };
    let id = head[..id_len]
        .iter()
        .fold(0u32, |acc, &b| acc * 256 + u32::from(b));
    // The size without its length marker.
    let marker_free = u64::from(size_first) & (0xFF >> size_len);
    let size = head[id_len + 1..]
        .iter()
        .fold(marker_free, |acc, &b| acc * 256 + u64::from(b));
    let unknown = size == (1u64 << (7 * size_len)) - 1;
    Ok(Some((id, (!unknown).then_some(size), id_len + size_len)))
}
