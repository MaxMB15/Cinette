// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! HLS output for a converted stream: the playlists for MPEG-TS segments
//! cut on this device, and the `CODECS` string they declare.
//!
//! AVPlayer, and so AirPlay, reads them. The segments sit in a sliding
//! window, so a long movie never piles up in memory: the converter is paced
//! to stay a little ahead of playback, and a seek outside the window starts
//! the conversion again from there.

use std::collections::VecDeque;
use std::fmt::Write;

#[cfg(test)]
#[path = "hls_tests.rs"]
mod tests;

/// The media playlist's name on the server.
pub const MEDIA: &str = "media.m3u8";
/// The master playlist's name, which the receiver is given.
pub const MASTER: &str = "index.m3u8";
pub const PLAYLIST_TYPE: &str = "application/vnd.apple.mpegurl";
pub const SEGMENT_TYPE: &str = "video/mp2t";

/// What a segment is called on the server.
pub fn segment_name(sequence: u64) -> String {
    format!("seg{sequence}.ts")
}

/// The segments a receiver can fetch, and the playlist that lists them.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaPlaylist {
    /// How many segments stay listed.
    window: usize,
    /// The listed segments' durations, oldest first.
    segments: VecDeque<f64>,
    /// The first listed segment's sequence number.
    first: u64,
    /// The longest segment so far, rounded up. A playlist's target duration
    /// shouldn't drop, so it only grows.
    target: u32,
    ended: bool,
}

impl MediaPlaylist {
    /// A playlist that keeps the last `window` segments, at least one.
    pub fn new(window: usize) -> Self {
        Self {
            window: window.max(1),
            segments: VecDeque::new(),
            first: 0,
            target: 1,
            ended: false,
        }
    }

    /// Adds the next segment, `duration` seconds long. Returns its sequence
    /// number and, when the window was full, the one that left it.
    pub fn push(&mut self, duration: f64) -> (u64, Option<u64>) {
        let sequence = self.first + self.segments.len() as u64;
        let duration = if duration.is_finite() {
            duration.max(0.0)
        } else {
            0.0
        };
        self.target = self.target.max(duration.ceil() as u32);
        self.segments.push_back(duration);
        let dropped = (self.segments.len() > self.window).then(|| {
            self.segments.pop_front();
            self.first += 1;
            self.first - 1
        });
        (sequence, dropped)
    }

    /// The stream reached its end, so the playlist says no more come.
    pub fn finish(&mut self) {
        self.ended = true;
    }

    /// Whether a receiver can start: three segments, as Apple asks for live
    /// HLS, or whatever there is once the stream ended.
    pub fn ready(&self) -> bool {
        self.segments.len() >= 3 || (self.ended && !self.segments.is_empty())
    }

    pub fn len(&self) -> usize {
        self.segments.len()
    }

    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    /// The playlist's text.
    pub fn text(&self) -> String {
        let mut out = String::from("#EXTM3U\n#EXT-X-VERSION:3\n");
        let _ = writeln!(out, "#EXT-X-TARGETDURATION:{}", self.target);
        let _ = writeln!(out, "#EXT-X-MEDIA-SEQUENCE:{}", self.first);
        for (i, duration) in self.segments.iter().enumerate() {
            let _ = writeln!(out, "#EXTINF:{duration:.3},");
            let _ = writeln!(out, "{}", segment_name(self.first + i as u64));
        }
        if self.ended {
            out.push_str("#EXT-X-ENDLIST\n");
        }
        out
    }
}

/// The master playlist, naming the media playlist with its codecs.
/// AirPlay 2 TVs are reported to refuse a master playlist without `CODECS`,
/// so it's left out only when no codec is known.
pub fn master(bandwidth: u64, codecs: &[String]) -> String {
    let mut out = String::from("#EXTM3U\n#EXT-X-VERSION:3\n");
    let _ = write!(out, "#EXT-X-STREAM-INF:BANDWIDTH={bandwidth}");
    if !codecs.is_empty() {
        let _ = write!(out, ",CODECS=\"{}\"", codecs.join(","));
    }
    let _ = writeln!(out, "\n{MEDIA}");
    out
}

/// The `CODECS` name of H.264 video, such as `avc1.64001f`, from the
/// stream's extradata: an `avcC` record, or Annex B with the SPS in it.
pub fn avc_codec(extradata: &[u8]) -> Option<String> {
    let sps = if extradata.first() == Some(&1) {
        // avcC: version, then profile, compatibility and level.
        extradata.get(1..4)?
    } else {
        annex_b_sps(extradata)?
    };
    Some(format!("avc1.{:02x}{:02x}{:02x}", sps[0], sps[1], sps[2]))
}

/// The three bytes after an Annex B SPS's NAL header.
fn annex_b_sps(data: &[u8]) -> Option<&[u8]> {
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i..i + 3] == [0, 0, 1] {
            let nal = i + 3;
            if data.get(nal).is_some_and(|h| h & 0x1f == 7) {
                return data.get(nal + 1..nal + 4);
            }
            i = nal;
        } else {
            i += 1;
        }
    }
    None
}

/// The `CODECS` name of audio the segments carry, by ffmpeg's codec name.
pub fn audio_codec(name: &str) -> Option<&'static str> {
    match name {
        "aac" => Some("mp4a.40.2"),
        "mp3" => Some("mp4a.40.34"),
        "ac3" => Some("ac-3"),
        "eac3" => Some("ec-3"),
        _ => None,
    }
}

/// How far ahead of playback a converter may get, in seconds of media.
pub const LEAD: f64 = 20.0;

/// Keeps a converter from racing ahead of playback. A remux runs far
/// faster than realtime, and every segment it makes sits in memory until
/// the window drops it, so the converter waits once it's [`LEAD`] seconds
/// ahead of the time playback has had.
#[derive(Debug, Clone, PartialEq)]
pub struct Pacer {
    /// Seconds of media made so far.
    made: f64,
    /// Seconds of playback time before the last pause.
    played: f64,
    /// When playback last started, in the caller's seconds, or `None`
    /// while paused.
    since: Option<f64>,
}

impl Pacer {
    /// A pacer whose clock starts at `now`.
    pub fn new(now: f64) -> Self {
        Self {
            made: 0.0,
            played: 0.0,
            since: Some(now),
        }
    }

    /// The converter made a segment `duration` seconds long.
    pub fn made(&mut self, duration: f64) {
        self.made += duration.max(0.0);
    }

    pub fn pause(&mut self, now: f64) {
        if let Some(since) = self.since.take() {
            self.played += (now - since).max(0.0);
        }
    }

    pub fn resume(&mut self, now: f64) {
        if self.since.is_none() {
            self.since = Some(now);
        }
    }

    /// How long the converter should wait before making more, in seconds:
    /// zero while it's less than [`LEAD`] ahead, and `None` while paused
    /// and ahead, when only a resume lets it go on.
    pub fn wait(&self, now: f64) -> Option<f64> {
        let played = self.played + self.since.map_or(0.0, |s| (now - s).max(0.0));
        let ahead = self.made - played;
        if ahead < LEAD {
            Some(0.0)
        } else if self.since.is_some() {
            Some(ahead - LEAD)
        } else {
            None
        }
    }
}
