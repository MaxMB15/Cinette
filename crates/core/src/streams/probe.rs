// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Finding out what a stream holds with the bundled ffmpeg, when mpv isn't
//! playing it. There's no ffprobe in the sidecar, so ffmpeg runs with an
//! input and no output. It prints the input's streams, then exits because
//! nothing was asked of it.
//!
//! ffmpeg's text names the URL, logins included, so it's never logged. Only
//! what [`parse`] makes of it leaves this module.

use super::format::{
    audio_codec, container_from_demuxer, video_codec, AudioCodec, Container, VideoCodec,
};

/// The ffmpeg arguments that print what `url` holds. It gives up after 10 s
/// without data and reads at most 5 MB.
pub fn args(url: &str) -> Vec<String> {
    [
        "-hide_banner",
        "-nostdin",
        "-rw_timeout",
        "10000000",
        "-probesize",
        "5000000",
        "-analyzeduration",
        "5000000",
        "-i",
        url,
    ]
    .map(String::from)
    .to_vec()
}

/// What the probe found.
#[derive(Debug, Clone, PartialEq)]
pub struct Probed {
    pub container: Container,
    pub video: Option<VideoCodec>,
    pub interlaced: bool,
    pub audio: Option<AudioCodec>,
    /// Seconds, when the input has a length.
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProbeError {
    /// The server answered 401 or 403: the login may have expired, or
    /// another device may be using the account.
    #[error("the provider refused the stream ({0})")]
    Refused(u16),
    #[error("couldn't reach the stream")]
    Unreachable,
    #[error("the stream has no audio or video")]
    NoStreams,
}

/// Reads ffmpeg's text from a run with [`args`].
pub fn parse(stderr: &str) -> Result<Probed, ProbeError> {
    let mut container = None;
    let mut duration = None;
    let mut video = None;
    let mut interlaced = false;
    let mut audio = None;
    let mut default_audio = None;
    for line in stderr.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Input #0, ") {
            // Demuxer names can have commas in them, as `mov,mp4,m4a,…` does.
            let demuxer = rest.split(", from '").next().unwrap_or(rest);
            container = Some(container_from_demuxer(demuxer));
        } else if let Some(rest) = line.strip_prefix("Duration: ") {
            duration = parse_duration(rest.split(',').next().unwrap_or(""));
        } else if line.starts_with("Stream #0:") {
            // Cover art shows up as a video stream.
            if line.contains("(attached pic)") {
                continue;
            }
            if let Some(rest) = after(line, "Video: ") {
                if video.is_none() {
                    video = Some(video_codec(first_word(rest)));
                    interlaced = [
                        "top first",
                        "bottom first",
                        "top coded first",
                        "bottom coded first",
                    ]
                    .iter()
                    .any(|order| rest.contains(order));
                }
            } else if let Some(rest) = after(line, "Audio: ") {
                let codec = audio_codec(first_word(rest));
                audio.get_or_insert(codec);
                if line.ends_with("(default)") {
                    default_audio.get_or_insert(codec);
                }
            }
        }
    }
    let Some(container) = container else {
        return Err(http_error(stderr));
    };
    if video.is_none() && audio.is_none() {
        return Err(ProbeError::NoStreams);
    }
    Ok(Probed {
        container,
        video,
        interlaced,
        audio: default_audio.or(audio),
        duration,
    })
}

/// Why ffmpeg couldn't open the input. It names an HTTP status as
/// `Server returned 403 Forbidden` or `HTTP error 403 Forbidden`.
fn http_error(stderr: &str) -> ProbeError {
    for marker in ["Server returned ", "HTTP error "] {
        for (i, _) in stderr.match_indices(marker) {
            let code = stderr[i + marker.len()..]
                .get(..3)
                .and_then(|c| c.parse().ok());
            if let Some(code @ (401 | 403)) = code {
                return ProbeError::Refused(code);
            }
        }
    }
    ProbeError::Unreachable
}

fn after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.find(marker).map(|i| &line[i + marker.len()..])
}

fn first_word(text: &str) -> &str {
    text.split([' ', ',']).next().unwrap_or("")
}

/// `01:02:03.50` as seconds. `N/A`, a live stream, is `None`.
fn parse_duration(text: &str) -> Option<f64> {
    let mut parts = text.trim().split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let total = hours * 3600.0 + minutes * 60.0 + seconds;
    (total > 0.0).then_some(total)
}
