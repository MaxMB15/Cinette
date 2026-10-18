// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What a stream is made of, in the terms of `StreamFormat` in the
//! frontend's `src/lib/route.ts`. The names serialize to the same strings.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Container {
    /// HLS whose segments are MPEG-TS.
    HlsTs,
    /// HLS whose segments are fragmented MP4.
    HlsFmp4,
    Mp4,
    Mkv,
    /// A raw MPEG-TS stream or file.
    Ts,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    Hevc,
    Mpeg2,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    Aac,
    Mp3,
    Ac3,
    Eac3,
    Mp2,
    Dts,
    Opus,
    Other,
}

/// One way of fetching an item, and what it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFormat {
    pub container: Container,
    /// `None` when the stream has no video.
    pub video: Option<VideoCodec>,
    pub interlaced: bool,
    /// `None` when the stream has no audio.
    pub audio: Option<AudioCodec>,
    /// For HLS, whether the playlist and its segments send CORS headers.
    pub cors: bool,
}

/// What kind of container a demuxer name means, as ffmpeg's `Input #0, …`
/// line and mpv's `file-format` give it. HLS comes back as [`Container::HlsTs`]
/// until its playlist says otherwise.
pub fn container_from_demuxer(name: &str) -> Container {
    let name = name.trim().to_ascii_lowercase();
    match name.as_str() {
        "hls" | "applehttp" => Container::HlsTs,
        "mpegts" | "ts" => Container::Ts,
        "matroska,webm" | "matroska" | "mkv" | "webm" => Container::Mkv,
        "mov,mp4,m4a,3gp,3g2,mj2" | "mp4" | "mov" => Container::Mp4,
        _ => Container::Other,
    }
}

/// A video codec from ffmpeg's or mpv's name for it.
pub fn video_codec(name: &str) -> VideoCodec {
    match name.trim().to_ascii_lowercase().as_str() {
        "h264" | "avc" | "avc1" => VideoCodec::H264,
        "hevc" | "h265" => VideoCodec::Hevc,
        "mpeg2video" | "mpeg2" => VideoCodec::Mpeg2,
        _ => VideoCodec::Other,
    }
}

/// An audio codec from ffmpeg's or mpv's name for it.
pub fn audio_codec(name: &str) -> AudioCodec {
    match name.trim().to_ascii_lowercase().as_str() {
        "aac" | "aac_latm" => AudioCodec::Aac,
        "mp3" | "mp3float" => AudioCodec::Mp3,
        "ac3" => AudioCodec::Ac3,
        "eac3" => AudioCodec::Eac3,
        "mp2" | "mp2float" => AudioCodec::Mp2,
        "dts" | "dca" => AudioCodec::Dts,
        "opus" => AudioCodec::Opus,
        _ => AudioCodec::Other,
    }
}

/// What mpv says about the item it's playing: `file-format`, the selected
/// tracks' `codec`, and `video-frame-info/interlaced`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayingInfo {
    pub file_format: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    #[serde(default)]
    pub interlaced: bool,
}

impl PlayingInfo {
    /// The format of what mpv plays, which needs no new connection to the
    /// provider. CORS is unknown here, so it's false.
    pub fn format(&self) -> StreamFormat {
        StreamFormat {
            container: self
                .file_format
                .as_deref()
                .map_or(Container::Other, container_from_demuxer),
            video: self.video_codec.as_deref().map(video_codec),
            interlaced: self.interlaced,
            audio: self.audio_codec.as_deref().map(audio_codec),
            cors: false,
        }
    }
}
