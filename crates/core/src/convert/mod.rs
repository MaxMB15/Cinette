// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Converting a stream on this device for a receiver that can't play it as
//! it is. The video is copied, and only the audio the receiver can't play
//! becomes AAC. A full video transcode only runs on a hardware encoder.
//! ffmpeg writes live Matroska to its standard output, which the app serves
//! to the receiver over the local network.

pub mod mkv;
pub mod serve;

#[cfg(test)]
mod tests;

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
    /// Stereo AAC.
    Aac,
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
pub fn args(
    url: &str,
    plan: &Plan,
    encoder: Option<HardwareEncoder>,
) -> Result<Vec<String>, NoEncoder> {
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
            let encoder = encoder.ok_or(NoEncoder)?;
            // 8-bit 4:2:0, which every H.264 receiver plays.
            let filters = if deinterlace {
                "yadif=mode=send_frame,format=yuv420p"
            } else {
                "format=yuv420p"
            };
            args.extend(
                [
                    "-vf",
                    filters,
                    "-c:v",
                    encoder.name(),
                    "-b:v",
                    "6M",
                    "-maxrate",
                    "8M",
                    "-bufsize",
                    "12M",
                    // A keyframe every 2 s at 25 fps, so a receiver that
                    // joins late waits little for the next cluster.
                    "-g",
                    "50",
                ]
                .map(String::from),
            );
        }
    }
    match plan.audio {
        AudioPlan::None => {}
        AudioPlan::Copy => args.extend(["-c:a".into(), "copy".into()]),
        AudioPlan::Aac => {
            args.extend(["-c:a", "aac", "-b:a", "192k", "-ac", "2"].map(String::from))
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
