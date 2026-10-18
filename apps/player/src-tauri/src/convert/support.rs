// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What the bundled ffmpeg can convert on this computer: whether it has the
//! AAC encoder at all, and whether a hardware video encoder works. The
//! answer is worked out once a run.

use std::io::Write;
use std::process::{Command, Stdio};

use mvp_core::convert::{AacEncoder, Encoders, HardwareEncoder};
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tokio::sync::OnceCell;

/// The frontend's `ConverterSupport`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    /// It can remux and turn audio into AAC.
    pub convert: bool,
    /// The encoders to convert with, when it can.
    #[serde(skip)]
    pub encoders: Option<Encoders>,
    /// A hardware H.264 encoder works.
    pub hardware_encoder: bool,
}

/// What `ffmpeg -encoders` lists, of the encoders a conversion uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Listed {
    pub aac: bool,
    pub aac_at: bool,
    pub videotoolbox: bool,
}

pub fn read_encoders(list: &str) -> Listed {
    let names: Vec<&str> = list
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    Listed {
        aac: names.contains(&"aac"),
        aac_at: names.contains(&"aac_at"),
        videotoolbox: names.contains(&HardwareEncoder::VideoToolbox.name()),
    }
}

/// The encoders to use from what's listed, on macOS or elsewhere, or `None`
/// when there's no AAC encoder. A hardware encoder still has to pass a test.
pub fn choose(listed: Listed, macos: bool) -> Option<Encoders> {
    let aac = if macos && listed.aac_at {
        AacEncoder::AudioToolbox
    } else if listed.aac {
        AacEncoder::Ffmpeg
    } else {
        return None;
    };
    let video = (macos && listed.videotoolbox).then_some(HardwareEncoder::VideoToolbox);
    Some(Encoders { video, aac })
}

/// The arguments that encode one blank 64x64 frame, read from standard
/// input, with `encoder`, and throw it away.
pub fn test_encode_args(encoder: HardwareEncoder) -> Vec<String> {
    [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p",
        "-s",
        "64x64",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-c:v",
        encoder.name(),
        "-f",
        "null",
        "-",
    ]
    .map(String::from)
    .to_vec()
}

/// One blank 64x64 frame in 4:2:0: a full-size plane of brightness and two
/// quarter-size planes of color.
const FRAME_BYTES: usize = 6144;

/// What this computer's ffmpeg can do, asked once a run.
pub async fn support<R: Runtime>(app: &AppHandle<R>) -> Support {
    static SUPPORT: OnceCell<Support> = OnceCell::const_new();
    *SUPPORT
        .get_or_init(|| async {
            let app = app.clone();
            tokio::task::spawn_blocking(move || check(&app))
                .await
                .unwrap_or(NONE)
        })
        .await
}

const NONE: Support = Support {
    convert: false,
    encoders: None,
    hardware_encoder: false,
};

fn check<R: Runtime>(app: &AppHandle<R>) -> Support {
    let Some(list) = run(app, &["-hide_banner", "-encoders"], None) else {
        return NONE;
    };
    let listed = read_encoders(&String::from_utf8_lossy(&list));
    let Some(mut encoders) = choose(listed, cfg!(target_os = "macos")) else {
        return NONE;
    };
    // A listed hardware encoder can still fail, as in a virtual machine.
    encoders.video = encoders.video.filter(|e| {
        let args = test_encode_args(*e);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(app, &args, Some(&[0; FRAME_BYTES])).is_some()
    });
    Support {
        convert: true,
        encoders: Some(encoders),
        hardware_encoder: encoders.video.is_some(),
    }
}

/// Runs the sidecar and returns its standard output, or `None` when it
/// can't start or fails.
pub(super) fn run<R: Runtime>(
    app: &AppHandle<R>,
    args: &[&str],
    input: Option<&[u8]>,
) -> Option<Vec<u8>> {
    use tauri_plugin_shell::ShellExt;
    let sidecar = app
        .shell()
        .sidecar(crate::downloads::FFMPEG_SIDECAR)
        .ok()?
        .args(args);
    let mut child = Command::from(sidecar)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    if let Some(input) = input {
        let _ = stdin.write_all(input);
    }
    drop(stdin);
    let output = child.wait_with_output().ok()?;
    output.status.success().then_some(output.stdout)
}
