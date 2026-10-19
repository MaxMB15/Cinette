// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Converting a stream on this device for a receiver that can't play it as
//! it is. The video is copied, and an audio track the receiver plays is
//! copied too when there is one. Otherwise the audio becomes AAC: 5.1 from a
//! 5.1 source when the receiver takes it, and stereo from anything else. A
//! full video transcode only runs on a hardware encoder. ffmpeg writes live
//! Matroska to its standard output, which the app serves to the receiver
//! over the local network.

pub mod hls;
pub mod mkv;
pub mod serve;

#[cfg(test)]
mod tests;

use crate::streams::probe::AudioTrack;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoPlan {
    /// The stream has no video.
    None,
    Copy,
    /// Encode again on the hardware encoder, deinterlacing first when the
    /// source is interlaced.
    Transcode {
        deinterlace: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioPlan {
    /// The stream has no audio.
    None,
    Copy,
    /// Stereo AAC. `downmix` asks the decoder for stereo, which AC-3,
    /// E-AC-3 and DTS decoders do with the mix levels in the stream.
    Aac {
        downmix: bool,
    },
    /// 5.1 AAC from a 5.1 source.
    Surround,
}

/// The audio codecs a Cast receiver plays as they are, by ffmpeg's names,
/// for [`pick_audio`]. Each destination passes its own list.
pub const CAST_AUDIO: [&str; 4] = ["aac", "mp3", "opus", "vorbis"];
/// The codecs whose decoders mix down to stereo themselves.
const DECODER_DOWNMIX: [&str; 3] = ["ac3", "eac3", "dts"];

/// Which audio track to keep, and how. A track in `language` comes first
/// when there is one, and among those, one whose codec is in `playable`,
/// the ffmpeg names of what the receiver plays as it is, so there's no
/// second lossy pass. Otherwise the default track is converted, to 5.1 AAC
/// when it's 5.1 and the receiver takes `surround`, and to stereo AAC
/// otherwise. Stereo is the fallback for a receiver that plays 5.1 AAC
/// without sound.
pub fn pick_audio(
    tracks: &[AudioTrack],
    language: Option<&str>,
    playable: &[&str],
    surround: bool,
) -> (usize, AudioPlan) {
    let in_language: Vec<usize> = (0..tracks.len())
        .filter(|&i| language.is_some_and(|l| tracks[i].language.as_deref() == Some(l)))
        .collect();
    let mut ordered = if in_language.is_empty() {
        (0..tracks.len()).collect()
    } else {
        in_language
    };
    // The default track first, then the rest in order.
    ordered.sort_by_key(|&i| !tracks[i].default);
    let Some(&first) = ordered.first() else {
        return (0, AudioPlan::None);
    };
    if let Some(&copy) = ordered
        .iter()
        .find(|&&i| playable.contains(&tracks[i].codec.as_str()))
    {
        return (copy, AudioPlan::Copy);
    }
    let track = &tracks[first];
    // `5.1` or `5.1(side)`, which AC-3, E-AC-3 and DTS decode to.
    if surround
        && track
            .layout
            .as_deref()
            .is_some_and(|l| l.starts_with("5.1"))
    {
        return (first, AudioPlan::Surround);
    }
    let downmix = DECODER_DOWNMIX.contains(&track.codec.as_str());
    (first, AudioPlan::Aac { downmix })
}

/// A hardware H.264 encoder the bundled ffmpeg can use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardwareEncoder {
    /// macOS.
    VideoToolbox,
}

impl HardwareEncoder {
    pub fn name(self) -> &'static str {
        match self {
            HardwareEncoder::VideoToolbox => "h264_videotoolbox",
        }
    }
}

/// The AAC encoder the bundled ffmpeg uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AacEncoder {
    /// ffmpeg's own, on Linux.
    Ffmpeg,
    /// Apple's, from AudioToolbox, on macOS. It's rated above ffmpeg's and
    /// ran faster in a test on a Mac.
    AudioToolbox,
}

impl AacEncoder {
    /// The arguments for stereo at 256 kbps. A second lossy pass needs the
    /// headroom, and the local network has the bandwidth.
    fn args(self) -> &'static [&'static str] {
        match self {
            AacEncoder::Ffmpeg => &["-c:a", "aac", "-b:a", "256k"],
            AacEncoder::AudioToolbox => &["-c:a", "aac_at", "-aac_at_mode", "cvbr", "-b:a", "256k"],
        }
    }

    /// The arguments for 5.1 at 448 kbps. Decoders give `5.1(side)`, which
    /// ffmpeg's encoder writes with no standard channel configuration, so
    /// the side channels are renamed back ones first. Nothing is mixed.
    /// Apple's encoder maps the layout itself.
    fn surround_args(self) -> &'static [&'static str] {
        match self {
            AacEncoder::Ffmpeg => &[
                "-af",
                "channelmap=channel_layout=5.1",
                "-c:a",
                "aac",
                "-b:a",
                "448k",
            ],
            AacEncoder::AudioToolbox => &["-c:a", "aac_at", "-aac_at_mode", "cvbr", "-b:a", "448k"],
        }
    }
}

/// The encoders this device's ffmpeg has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Encoders {
    pub video: Option<HardwareEncoder>,
    pub aac: AacEncoder,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan {
    pub video: VideoPlan,
    pub audio: AudioPlan,
    /// Where to start, in seconds, for a file with a length.
    pub start_at: Option<f64>,
    /// Which of the source's audio tracks to keep, counting from 0.
    pub audio_track: usize,
}

/// Why a plan can't run on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("this device has no hardware video encoder")]
pub struct NoEncoder;

/// The ffmpeg arguments that convert `url` by `plan` and write live
/// Matroska to standard output.
pub fn args(url: &str, plan: &Plan, encoders: Encoders) -> Result<Vec<String>, NoEncoder> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        // Pick a file up where the connection broke off. There's no
        // `-reconnect_streamed`, for the reason in `stream_copy_args`: a live
        // stream that drops ends ffmpeg, and the app starts it again.
        "-reconnect",
        "1",
        "-reconnect_delay_max",
        "5",
        // Give up after 15 s without data.
        "-rw_timeout",
        "15000000",
    ]
    .map(String::from)
    .to_vec();
    if let AudioPlan::Aac { downmix: true } = plan.audio {
        args.extend(["-downmix".into(), "stereo".into()]);
    }
    if let Some(at) = plan.start_at.filter(|at| *at > 0.0) {
        args.extend(["-ss".into(), format!("{at:.3}")]);
    }
    args.extend(["-i".into(), url.into()]);
    if plan.video != VideoPlan::None {
        args.extend(["-map".into(), "0:v:0".into()]);
    }
    if plan.audio != AudioPlan::None {
        args.extend(["-map".into(), format!("0:a:{}?", plan.audio_track)]);
    }
    // Subtitles and data tracks stay behind. Subtitle files go to the
    // receiver on their own.
    args.extend(["-sn".into(), "-dn".into()]);
    match plan.video {
        VideoPlan::None => {}
        VideoPlan::Copy => args.extend(["-c:v".into(), "copy".into()]),
        VideoPlan::Transcode { deinterlace } => {
            let encoder = encoders.video.ok_or(NoEncoder)?;
            // bwdif makes a frame of each field, so 50i stays 50 frames a
            // second. Then 8-bit 4:2:0, which every H.264 receiver plays.
            let filters = if deinterlace {
                "bwdif=mode=send_field,format=yuv420p"
            } else {
                "format=yuv420p"
            };
            args.extend(
                [
                    "-vf",
                    filters,
                    "-c:v",
                    encoder.name(),
                    // Enough for 1080p50.
                    "-b:v",
                    "10M",
                    "-maxrate",
                    "12M",
                    "-bufsize",
                    "20M",
                    // A keyframe every 2 s whatever the frame rate, so a
                    // receiver that joins late waits little for the next
                    // cluster.
                    "-force_key_frames",
                    "expr:gte(t,n_forced*2)",
                ]
                .map(String::from),
            );
        }
    }
    match plan.audio {
        AudioPlan::None => {}
        AudioPlan::Copy => args.extend(["-c:a".into(), "copy".into()]),
        AudioPlan::Aac { .. } => {
            args.extend(encoders.aac.args().iter().map(|a| a.to_string()));
            // Stereo whatever the decoder gave. After a decoder's own
            // downmix this changes nothing.
            args.extend(["-ac".into(), "2".into()]);
        }
        AudioPlan::Surround => {
            args.extend(encoders.aac.surround_args().iter().map(|a| a.to_string()));
        }
    }
    args.extend(
        [
            "-f",
            "matroska",
            // No seeking back to fill in sizes and cues, which a pipe can't do.
            "-live",
            "1",
            "-flush_packets",
            "1",
            "pipe:1",
        ]
        .map(String::from),
    );
    Ok(args)
}
