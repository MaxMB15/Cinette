// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What the bundled ffmpeg can convert on this computer: whether it has the
//! AAC encoder at all, whether a hardware video encoder works, and which
//! codecs it decodes. The answer is worked out once a run, once a check
//! has finished.

use std::process::Stdio;
use std::time::Duration;

use mvp_core::convert::{AacEncoder, Encoders, HardwareEncoder};
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tokio::io::AsyncWriteExt;
use tokio::sync::OnceCell;

/// How long each run of the check gets. A hardware encoder can hang, as
/// when the GPU is busy or just after the computer wakes.
const RUN_LIMIT: Duration = Duration::from_secs(10);

/// The frontend's `ConverterSupport`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    /// It can remux and turn audio into AAC.
    pub convert: bool,
    /// The encoders to convert with, when it can.
    #[serde(skip)]
    pub encoders: Option<Encoders>,
    /// A hardware H.264 encoder works.
    pub hardware_encoder: bool,
    /// The codecs it decodes, by the names a probe gives them, for
    /// `pick_audio`.
    #[serde(skip)]
    pub decoders: Vec<String>,
}

/// What `ffmpeg -encoders` lists, of the encoders a conversion uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Listed {
    pub aac: bool,
    pub aac_at: bool,
    pub videotoolbox: bool,
}

/// The names in a list from `ffmpeg -encoders` or `ffmpeg -decoders`.
pub fn read_names(list: &str) -> Vec<&str> {
    list.lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect()
}

/// The codecs that `decoders` decode, by the names a probe gives them, for
/// `pick_audio`. Most decoders are named after their codec.
pub fn decoded_codecs(decoders: &[&str]) -> Vec<String> {
    decoders
        .iter()
        .map(|&name| match name {
            "dca" => "dts",
            "mp3float" => "mp3",
            "mp2float" => "mp2",
            "ac3_fixed" => "ac3",
            name => name,
        })
        .map(String::from)
        .collect()
}

pub fn read_encoders(list: &str) -> Listed {
    let names = read_names(list);
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

/// What this computer's ffmpeg can do, asked once a run. A check that
/// couldn't finish, as when the sidecar is missing or a run hangs, isn't
/// kept, so the next call tries again. When only the hardware encoder's
/// test hangs, this call converts without it.
pub async fn support<R: Runtime>(app: &AppHandle<R>) -> Support {
    static SUPPORT: OnceCell<Support> = OnceCell::const_new();
    if let Some(known) = SUPPORT.get() {
        return known.clone();
    }
    match check(app).await {
        Ok((support, Finished(true))) => SUPPORT.get_or_init(|| async { support }).await.clone(),
        Ok((support, Finished(false))) => support,
        Err(Unfinished) => NONE,
    }
}

/// Whether every run of a check finished, so it can be kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Finished(pub bool);

/// Whether the hardware encoder works, from its test encode. A test that
/// hung counts as no encoder, but the check isn't finished.
pub(super) fn encoder_works(test: Result<Option<Vec<u8>>, Unfinished>) -> (bool, Finished) {
    match test {
        Ok(output) => (output.is_some(), Finished(true)),
        Err(Unfinished) => (false, Finished(false)),
    }
}

const NONE: Support = Support {
    convert: false,
    encoders: None,
    hardware_encoder: false,
    decoders: Vec::new(),
};

/// The check didn't finish.
#[derive(Debug)]
pub(super) struct Unfinished;

async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<(Support, Finished), Unfinished> {
    let list = run(app, &["-hide_banner", "-encoders"], None)
        .await?
        .ok_or(Unfinished)?;
    let listed = read_encoders(&String::from_utf8_lossy(&list));
    let Some(mut encoders) = choose(listed, cfg!(target_os = "macos")) else {
        return Ok((NONE, Finished(true)));
    };
    let decoders = run(app, &["-hide_banner", "-decoders"], None)
        .await?
        .ok_or(Unfinished)?;
    let decoders = decoded_codecs(&read_names(&String::from_utf8_lossy(&decoders)));
    // A listed hardware encoder can still fail, as in a virtual machine.
    let mut finished = Finished(true);
    if let Some(encoder) = encoders.video {
        let args = test_encode_args(encoder);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let works;
        (works, finished) = encoder_works(run(app, &args, Some(&[0; FRAME_BYTES])).await);
        encoders.video = encoders.video.filter(|_| works);
    }
    let support = Support {
        convert: true,
        encoders: Some(encoders),
        hardware_encoder: encoders.video.is_some(),
        decoders,
    };
    Ok((support, finished))
}

/// Runs the sidecar and returns its standard output, or `None` when it
/// fails. It's an error when it can't start or runs past [`RUN_LIMIT`],
/// and then it's killed.
pub(super) async fn run<R: Runtime>(
    app: &AppHandle<R>,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Option<Vec<u8>>, Unfinished> {
    run_within(app, args, input, RUN_LIMIT).await
}

/// [`run`] with a time limit of `limit`.
pub(super) async fn run_within<R: Runtime>(
    app: &AppHandle<R>,
    args: &[&str],
    input: Option<&[u8]>,
    limit: Duration,
) -> Result<Option<Vec<u8>>, Unfinished> {
    use tauri_plugin_shell::ShellExt;
    let sidecar = app
        .shell()
        .sidecar(crate::downloads::FFMPEG_SIDECAR)
        .map_err(|_| Unfinished)?
        .args(args);
    let mut command = tokio::process::Command::from(std::process::Command::from(sidecar));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| Unfinished)?;
    let mut stdin = child.stdin.take().ok_or(Unfinished)?;
    let output = tokio::time::timeout(limit, async move {
        if let Some(input) = input {
            let _ = stdin.write_all(input).await;
        }
        drop(stdin);
        child.wait_with_output().await
    })
    .await
    .map_err(|_| Unfinished)?
    .map_err(|_| Unfinished)?;
    Ok(output.status.success().then_some(output.stdout))
}
