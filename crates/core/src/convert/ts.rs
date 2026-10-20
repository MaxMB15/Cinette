// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Cuts ffmpeg's MPEG-TS output into HLS segments, so the app serves HLS
//! from a pipe. ffmpeg's own HLS muxer writes files and never waits, so a
//! receiver that pauses would lose the segments it hasn't played. Reading
//! a pipe holds ffmpeg back instead.
//!
//! - A segment starts at a video random access point, which ffmpeg marks
//!   on every keyframe, at least the shortest length after the last one.
//!   A stream without video is cut at an audio packet.
//! - A group of pictures that runs past the longest length, or a segment
//!   past [`CUT_BYTES`], is cut at the next video packet anyway.
//! - Each segment starts with the PAT and the PMT, so it can be read on
//!   its own. Their continuity counters are renumbered, so the copies
//!   don't read as repeated packets.
//!
//! MPEG-TS is 188-byte packets. Each has a 13-bit PID, and the PAT on PID
//! 0 names the PID of the PMT, which names the PIDs of the streams. A
//! packet that starts a PES packet carries its timestamp in 90 kHz ticks.

use super::hls;

#[cfg(test)]
#[path = "ts_tests.rs"]
mod tests;

const PACKET: usize = 188;
const SYNC: u8 = 0x47;
const PAT_PID: u16 = 0;
/// Timestamps count in 90 kHz ticks and wrap at 33 bits.
const CLOCK: f64 = 90_000.0;
const WRAP: i64 = 1 << 33;
/// A segment cut later than this, at the next video packet, needs no
/// keyframe. The C converter on iOS cuts at the same 4 × its shortest.
const MAX_FACTOR: f64 = 4.0;
/// A segment that holds this much is cut at the next video packet, as the
/// C converter does.
pub const CUT_BYTES: usize = 32 * 1024 * 1024;

/// The PMT's stream types for H.264, and for the other video codecs, which
/// are only cut by, not named.
const H264: u8 = 0x1B;
const VIDEO_TYPES: [u8; 5] = [0x01, 0x02, 0x10, H264, 0x24];
const AUDIO_TYPES: [u8; 6] = [0x03, 0x04, 0x0F, 0x11, 0x81, 0x87];

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TsError {
    #[error("the stream isn't MPEG-TS")]
    NotTs,
}

/// A segment, ready to serve.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub bytes: Vec<u8>,
    /// Seconds.
    pub duration: f64,
}

#[derive(Debug)]
pub struct TsSegmenter {
    /// The shortest segment, in seconds.
    shortest: f64,
    /// Bytes that don't make a whole packet yet.
    partial: Vec<u8>,
    pmt_pid: Option<u16>,
    /// The PID to cut by: the video, or the first audio stream without it.
    cut_pid: Option<u16>,
    video: bool,
    h264: bool,
    /// The last PAT and PMT, which start every segment.
    pat: Vec<[u8; PACKET]>,
    pmt: Vec<[u8; PACKET]>,
    /// The continuity counters this writes for the PAT and the PMT.
    pat_counter: u8,
    pmt_counter: u8,
    current: Vec<u8>,
    /// The current segment's start, in ticks without wraps.
    start: Option<i64>,
    /// The latest timestamp of the PID cut by, without wraps.
    latest: Option<i64>,
    /// The ticks between its last two packets, for the last segment's end.
    step: i64,
    /// Ticks added for the wraps seen so far.
    wraps: i64,
    codec: Option<String>,
    /// How many keyframes were searched for an SPS, so a stream without
    /// one isn't searched forever.
    searched: u32,
}

/// Keyframes searched for an SPS before giving up on the `CODECS` name.
const SPS_SEARCHES: u32 = 8;

impl TsSegmenter {
    /// Cuts segments at least `shortest` seconds long.
    pub fn new(shortest: f64) -> Self {
        Self {
            shortest,
            partial: Vec::new(),
            pmt_pid: None,
            cut_pid: None,
            video: false,
            h264: false,
            pat: Vec::new(),
            pmt: Vec::new(),
            pat_counter: 0,
            pmt_counter: 0,
            current: Vec::new(),
            start: None,
            latest: None,
            step: 0,
            wraps: 0,
            codec: None,
            searched: 0,
        }
    }

    /// The H.264 video's `CODECS` name, such as `avc1.64001f`, once a
    /// keyframe with an SPS went by.
    pub fn video_codec(&self) -> Option<&str> {
        self.codec.as_deref()
    }

    /// Whether the PMT names a video stream.
    pub fn has_video(&self) -> bool {
        self.video
    }

    /// Bytes from ffmpeg. Returns the segments they complete.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Segment>, TsError> {
        let mut segments = Vec::new();
        let mut data = bytes;
        if !self.partial.is_empty() {
            let need = PACKET - self.partial.len();
            if data.len() < need {
                self.partial.extend_from_slice(data);
                return Ok(segments);
            }
            let mut packet = [0u8; PACKET];
            packet[..self.partial.len()].copy_from_slice(&self.partial);
            packet[self.partial.len()..].copy_from_slice(&data[..need]);
            self.partial.clear();
            data = &data[need..];
            self.packet(packet, &mut segments)?;
        }
        let (packets, rest) = data.as_chunks::<PACKET>();
        for packet in packets {
            self.packet(*packet, &mut segments)?;
        }
        self.partial.extend_from_slice(rest);
        Ok(segments)
    }

    /// The stream ended. Returns what's left as the last segment.
    pub fn finish(mut self) -> Option<Segment> {
        let start = self.start?;
        let latest = self.latest.unwrap_or(start);
        if !has_media(&self.current, self.pat.len() + self.pmt.len()) {
            return None;
        }
        let duration = ((latest - start + self.step).max(0)) as f64 / CLOCK;
        Some(Segment {
            bytes: std::mem::take(&mut self.current),
            duration,
        })
    }

    fn packet(
        &mut self,
        mut packet: [u8; PACKET],
        segments: &mut Vec<Segment>,
    ) -> Result<(), TsError> {
        if packet[0] != SYNC {
            return Err(TsError::NotTs);
        }
        let pid = pid(&packet);
        let unit_start = packet[1] & 0x40 != 0;
        if pid == PAT_PID {
            self.pat_counter = renumber(&mut packet, self.pat_counter);
            if unit_start {
                self.pat.clear();
                self.pmt_pid = payload(&packet).and_then(read_pat);
            }
            self.pat.push(packet);
            self.current.extend_from_slice(&packet);
            return Ok(());
        }
        if Some(pid) == self.pmt_pid {
            self.pmt_counter = renumber(&mut packet, self.pmt_counter);
            if unit_start {
                self.pmt.clear();
                if let Some(streams) = payload(&packet).and_then(read_pmt) {
                    self.take_streams(&streams);
                }
            }
            self.pmt.push(packet);
            self.current.extend_from_slice(&packet);
            return Ok(());
        }
        if unit_start
            && Some(pid) == self.cut_pid
            && let Some(pts) = payload(&packet).and_then(pes_pts)
        {
            let pts = self.unwrap(pts);
            let random_access = random_access(&packet);
            if random_access && self.h264 && self.codec.is_none() {
                self.find_codec(&packet);
            }
            self.cut_before(pts, random_access, segments);
        }
        self.current.extend_from_slice(&packet);
        Ok(())
    }

    /// The PMT's streams decide which PID segments are cut by.
    fn take_streams(&mut self, streams: &[(u8, u16)]) {
        let video = streams.iter().find(|(kind, _)| VIDEO_TYPES.contains(kind));
        let audio = streams.iter().find(|(kind, _)| AUDIO_TYPES.contains(kind));
        self.video = video.is_some();
        self.h264 = video.is_some_and(|(kind, _)| *kind == H264);
        self.cut_pid = video.or(audio).map(|(_, pid)| *pid);
    }

    /// Ends the current segment before a packet at `pts`, when it's long
    /// enough and the packet is a random access point, or when it's far too
    /// long. The new segment starts with the PAT and the PMT.
    fn cut_before(&mut self, pts: i64, random_access: bool, segments: &mut Vec<Segment>) {
        let Some(start) = self.start else {
            self.start = Some(pts);
            self.latest = Some(pts);
            return;
        };
        if let Some(latest) = self.latest
            && pts > latest
        {
            self.step = pts - latest;
        }
        self.latest = Some(self.latest.map_or(pts, |l| l.max(pts)));
        let length = (pts - start) as f64 / CLOCK;
        let due = (random_access || !self.video) && length + 0.001 >= self.shortest;
        let overdue = length >= self.shortest * MAX_FACTOR || self.current.len() >= CUT_BYTES;
        if !(due || overdue) || length <= 0.0 {
            return;
        }
        let mut next = Vec::with_capacity(self.current.capacity());
        for packet in self.pat.clone() {
            self.pat_counter = self.copy_psi(&mut next, packet, self.pat_counter);
        }
        for packet in self.pmt.clone() {
            self.pmt_counter = self.copy_psi(&mut next, packet, self.pmt_counter);
        }
        let bytes = std::mem::replace(&mut self.current, next);
        segments.push(Segment {
            bytes,
            duration: length,
        });
        self.start = Some(pts);
    }

    /// Writes a copy of a PAT or PMT packet with the next counter.
    fn copy_psi(&self, out: &mut Vec<u8>, mut packet: [u8; PACKET], counter: u8) -> u8 {
        let next = renumber(&mut packet, counter);
        out.extend_from_slice(&packet);
        next
    }

    /// Takes timestamps past a wrap of the 33-bit clock as later ones.
    fn unwrap(&mut self, pts: i64) -> i64 {
        let mut pts = pts + self.wraps;
        if let Some(latest) = self.latest
            && pts < latest - WRAP / 2
        {
            self.wraps += WRAP;
            pts += WRAP;
        }
        pts
    }

    fn find_codec(&mut self, packet: &[u8; PACKET]) {
        if self.searched >= SPS_SEARCHES {
            return;
        }
        self.searched += 1;
        self.codec = payload(packet).and_then(pes_data).and_then(hls::avc_codec);
    }
}

fn pid(packet: &[u8; PACKET]) -> u16 {
    (u16::from(packet[1] & 0x1F) << 8) | u16::from(packet[2])
}

/// Sets a packet's continuity counter to `counter`, and returns the next.
/// Only a packet with a payload counts, and PAT and PMT packets have one.
fn renumber(packet: &mut [u8; PACKET], counter: u8) -> u8 {
    packet[3] = (packet[3] & 0xF0) | (counter & 0x0F);
    (counter + 1) & 0x0F
}

/// The packet's payload, after its adaptation field.
fn payload(packet: &[u8; PACKET]) -> Option<&[u8]> {
    let control = (packet[3] >> 4) & 0x3;
    if control & 0x1 == 0 {
        return None;
    }
    let start = if control & 0x2 != 0 {
        5 + usize::from(packet[4])
    } else {
        4
    };
    packet.get(start..)
}

/// Whether the adaptation field marks a random access point.
fn random_access(packet: &[u8; PACKET]) -> bool {
    let control = (packet[3] >> 4) & 0x3;
    control & 0x2 != 0 && packet[4] > 0 && packet[5] & 0x40 != 0
}

/// A PSI section's body, after its pointer field and up to its CRC.
fn section(payload: &[u8]) -> Option<&[u8]> {
    let pointer = usize::from(*payload.first()?);
    let table = payload.get(1 + pointer..)?;
    let length = (usize::from(table.get(1)? & 0x0F) << 8) | usize::from(*table.get(2)?);
    // The CRC's 4 bytes end the section.
    table.get(..3 + length.checked_sub(4)?)
}

/// The PMT's PID, for the first program in the PAT.
fn read_pat(payload: &[u8]) -> Option<u16> {
    let table = section(payload)?;
    table
        .get(8..)?
        .as_chunks::<4>()
        .0
        .iter()
        .find(|entry| entry[0] != 0 || entry[1] != 0)
        .map(|entry| (u16::from(entry[2] & 0x1F) << 8) | u16::from(entry[3]))
}

/// The PMT's streams, as their stream types and PIDs.
fn read_pmt(payload: &[u8]) -> Option<Vec<(u8, u16)>> {
    let table = section(payload)?;
    let info = (usize::from(table.get(10)? & 0x0F) << 8) | usize::from(*table.get(11)?);
    let mut rest = table.get(12 + info..)?;
    let mut streams = Vec::new();
    while rest.len() >= 5 {
        let kind = rest[0];
        let pid = (u16::from(rest[1] & 0x1F) << 8) | u16::from(rest[2]);
        let es_info = (usize::from(rest[3] & 0x0F) << 8) | usize::from(rest[4]);
        streams.push((kind, pid));
        rest = rest.get(5 + es_info..).unwrap_or(&[]);
    }
    Some(streams)
}

/// A PES packet's PTS, in 90 kHz ticks.
fn pes_pts(payload: &[u8]) -> Option<i64> {
    if payload.get(..3)? != [0, 0, 1] || payload.get(7)? & 0x80 == 0 {
        return None;
    }
    let b = payload.get(9..14)?;
    let pts = (i64::from(b[0] & 0x0E) << 29)
        | (i64::from(b[1]) << 22)
        | (i64::from(b[2] & 0xFE) << 14)
        | (i64::from(b[3]) << 7)
        | (i64::from(b[4]) >> 1);
    Some(pts)
}

/// The data a PES packet carries, after its header.
fn pes_data(payload: &[u8]) -> Option<&[u8]> {
    let header = usize::from(*payload.get(8)?);
    payload.get(9 + header..)
}

/// Whether `bytes` holds more than the PAT and PMT copies a segment
/// starts with, which are `psi` packets.
fn has_media(bytes: &[u8], psi: usize) -> bool {
    bytes.len() > psi * PACKET
}
