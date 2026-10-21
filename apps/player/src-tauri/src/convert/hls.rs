// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! HLS from the bundled ffmpeg, for a receiver that only plays HLS, as
//! AirPlay does from a Mac. `hls_out` does the same on iOS with the FFmpeg
//! libraries, and both serve what they make the same way.
//!
//! - ffmpeg converts by the same [`Plan`] as for Cast, and writes MPEG-TS
//!   to its standard output. [`TsSegmenter`] cuts it into segments.
//! - The segments sit in a sliding window on [`crate::lan_server`], and a
//!   pacer keeps the conversion a little ahead of playback. While it
//!   waits, nothing reads ffmpeg's output, which holds ffmpeg back.
//! - The source URL carries the provider's login. It stays with ffmpeg.
//! - Dropping the [`FfmpegHls`] stops ffmpeg and the server.

use crate::streams::REFUSED;
#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
pub use planning::plan;

/// Why a conversion to HLS didn't start, or stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HlsError {
    #[error("the provider refused the stream")]
    Refused,
    #[error("couldn't reach the stream")]
    Unreachable,
    /// The video isn't H.264, and this device can't transcode it.
    #[error("the receiver can't play this video, and this device can't convert it")]
    VideoCodec,
    #[error("this device isn't on a network the receiver can reach")]
    NoNetwork,
    #[error("the converter failed")]
    Failed,
}

impl HlsError {
    /// What the player shows when a conversion doesn't start. A refused
    /// login is [`REFUSED`], which the player words itself, as it does for
    /// `get_stream_formats`.
    pub fn for_player(self) -> String {
        match self {
            HlsError::Refused => REFUSED,
            HlsError::Unreachable => "Couldn't reach the stream to convert it.",
            HlsError::VideoCodec => {
                "The TV can't play this video, and this device can't convert it."
            }
            HlsError::NoNetwork => "Connect to Wi-Fi to send this to the TV.",
            HlsError::Failed => "Couldn't convert the stream on this device.",
        }
        .to_string()
    }
}

/// How a conversion ended.
pub type Ended = Result<(), HlsError>;

impl From<super::ConvertError> for HlsError {
    fn from(e: super::ConvertError) -> Self {
        use super::ConvertError;
        match e {
            ConvertError::Refused(_) => HlsError::Refused,
            ConvertError::Unreachable => HlsError::Unreachable,
            ConvertError::NoEncoder | ConvertError::Unsupported => HlsError::VideoCodec,
            ConvertError::Failed(_) => HlsError::Failed,
            ConvertError::NoRoute => HlsError::NoNetwork,
        }
    }
}

// Only a Mac plans for ffmpeg. iOS's `hls_out` plans for the FFmpeg
// libraries from what they read, and never transcodes video.
#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
mod planning {
    use mvp_core::convert::hls;
    use mvp_core::convert::{pick_audio, AudioPlan, Encoders, Plan, VideoPlan};
    use mvp_core::streams::format::VideoCodec;
    use mvp_core::streams::probe::Probed;

    use super::super::support::Support;
    use super::HlsError;

    /// How ffmpeg converts a probed source for a receiver that plays H.264 and
    /// the `playable` audio, starting `start_at` seconds into a movie or an
    /// episode. The H.264 is copied, unless it's interlaced. Other video, and
    /// interlaced H.264, are encoded again on the hardware encoder, or refused
    /// without one. HDR is refused, since nothing maps it to SDR. The audio is
    /// [`pick_audio`]'s, as on iOS. Returns the plan and the `CODECS` name of
    /// the audio it makes.
    ///
    /// [`pick_audio`]: mvp_core::convert::pick_audio
    pub fn plan(
        probed: &Probed,
        start_at: f64,
        live: bool,
        playable: &[&str],
        support: &Support,
    ) -> Result<(Plan, Encoders, Option<&'static str>), HlsError> {
        let encoders = support.encoders.ok_or(HlsError::Failed)?;
        if probed.hdr {
            return Err(HlsError::VideoCodec);
        }
        let video = match probed.video {
            None => VideoPlan::None,
            Some(VideoCodec::H264) if !probed.interlaced => VideoPlan::Copy,
            Some(_) if encoders.video.is_some() => VideoPlan::Transcode {
                deinterlace: probed.interlaced,
            },
            Some(_) => return Err(HlsError::VideoCodec),
        };
        let decodable: Vec<&str> = support.decoders.iter().map(String::as_str).collect();
        let tracks = &probed.audio_tracks;
        let (track, audio) = pick_audio(tracks, None, playable, &decodable, false);
        let codec = match audio {
            AudioPlan::None => None,
            AudioPlan::Copy => hls::audio_codec(&tracks[track].codec),
            AudioPlan::Aac { .. } | AudioPlan::Surround => hls::audio_codec("aac"),
        };
        if video == VideoPlan::None && audio == AudioPlan::None {
            return Err(HlsError::Unreachable);
        }
        let plan = Plan {
            video,
            audio,
            live,
            start_at: (!live && start_at > 0.0).then_some(start_at),
            audio_track: track,
        };
        Ok((plan, encoders, codec))
    }
}

// AirPlay from a Mac starts them. Linux's Cast converter doesn't use HLS.
#[cfg(target_os = "macos")]
pub use desktop::{start, FfmpegHls};

// Only the Linux tests stop a conversion and read its process id.
#[cfg(desktop)]
#[cfg_attr(all(test, not(target_os = "linux")), allow(dead_code))]
mod desktop {
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    use mvp_core::convert::hls::{
        self, bandwidth, MediaPlaylist, Pacer, AVC_FALLBACK, SEGMENT, TARGET, WINDOW,
    };
    use mvp_core::convert::ts::{Segment, TsSegmenter};
    use mvp_core::convert::{output_args, Encoders, Output, Plan};
    use tauri::{AppHandle, Runtime};
    use tokio::io::AsyncReadExt;
    use tokio::process::Child;
    use tokio::sync::{oneshot, watch, Notify};
    use tokio::task::JoinHandle;

    use super::{Ended, HlsError};
    use crate::convert::{collect_errors, spawn, Errors, STOP_LIMIT};
    use crate::keep_awake;
    use crate::lan_server::{Files, LanServer, Peers};

    /// How long ffmpeg gets to open the source and make the first segments.
    const START_LIMIT: Duration = Duration::from_secs(30);
    /// The most one segment may hold before the conversion fails. The
    /// segmenter cuts at 32 MB, so only a broken stream gets here.
    pub(in crate::convert) const MAX_SEGMENT_BYTES: usize = 48 * 1024 * 1024;

    /// A running conversion. Dropping it stops ffmpeg and the server.
    pub struct FfmpegHls {
        /// The master playlist's address, for the receiver.
        pub url: String,
        /// Changes from `None` when ffmpeg has exited.
        pub ended: watch::Receiver<Option<Ended>>,
        /// ffmpeg's process id, while it runs.
        pub(crate) pid: Option<u32>,
        pace: Arc<Pace>,
        /// Dropping it tells the writer task to kill ffmpeg and wait for it.
        stop: oneshot::Sender<()>,
        writer: JoinHandle<()>,
        _server: LanServer,
    }

    impl FfmpegHls {
        /// Whether the receiver is playing, which runs the pacer's clock.
        /// A live conversion's clock always runs.
        pub fn set_playing(&self, playing: bool) {
            self.pace.set_playing(playing);
        }

        /// Stops ffmpeg and waits until it has exited, so a conversion
        /// started next isn't a second connection to the provider.
        pub async fn stop(self) {
            let FfmpegHls { stop, writer, .. } = self;
            drop(stop);
            let _ = tokio::time::timeout(STOP_LIMIT, writer).await;
        }
    }

    /// Starts converting `source` by `plan` for `peers`, and returns once
    /// the receiver can start: the first three segments are on the server,
    /// or the source ended. `audio` is the `CODECS` name of the audio the
    /// segments carry. A source that refuses the login fails here, before
    /// the receiver is told anything.
    pub async fn start<R: Runtime>(
        app: &AppHandle<R>,
        source: &str,
        plan: &Plan,
        encoders: Encoders,
        peers: Peers,
        audio: Option<&'static str>,
    ) -> Result<FfmpegHls, HlsError> {
        start_within(app, source, plan, encoders, peers, audio, START_LIMIT).await
    }

    /// [`start`], with `limit` for the source to open and the first
    /// segments to be made.
    pub(in crate::convert) async fn start_within<R: Runtime>(
        app: &AppHandle<R>,
        source: &str,
        plan: &Plan,
        encoders: Encoders,
        peers: Peers,
        audio: Option<&'static str>,
        limit: Duration,
    ) -> Result<FfmpegHls, HlsError> {
        let args = output_args(source, plan, encoders, Output::MpegTs)
            .map_err(|_| HlsError::VideoCodec)?;
        let server = LanServer::start_for(peers)
            .await
            .map_err(|_| HlsError::NoNetwork)?;
        let mut child = spawn(app, args)?;
        let pid = child.id();
        if let Some(pid) = pid {
            keep_awake::hold_while_running(pid, keep_awake::Reason::Casting);
        }
        let stdout = child.stdout.take().ok_or(HlsError::Failed)?;
        let stderr = child.stderr.take().ok_or(HlsError::Failed)?;
        let text = Arc::new(Mutex::new(Vec::new()));
        let errors = Errors {
            text: text.clone(),
            collector: tokio::spawn(collect_errors(stderr, text)),
        };
        let pace = Arc::new(Pace::new(plan.live));
        let (started_tx, started) = oneshot::channel();
        let (ended_tx, ended) = watch::channel(None);
        let (stop, stopped) = oneshot::channel();
        let playlist = MediaPlaylist::new(WINDOW, TARGET);
        let out = Publisher {
            files: server.files.clone(),
            playlist: if plan.live {
                playlist
            } else {
                playlist.from_start()
            },
            audio,
            master: false,
            started: Some(started_tx),
        };
        let writer = tokio::spawn(write_segments(
            child,
            stdout,
            stopped,
            out,
            pace.clone(),
            ended_tx,
            errors,
        ));
        match tokio::time::timeout(limit, started).await {
            Ok(Ok(Ok(()))) => {}
            // Dropping `stop` kills ffmpeg.
            Ok(Ok(Err(e))) => return Err(e),
            _ => return Err(HlsError::Unreachable),
        }
        Ok(FfmpegHls {
            url: server.url(hls::MASTER),
            ended,
            pid,
            pace,
            stop,
            writer,
            _server: server,
        })
    }

    /// The pacer, and the clock it runs on.
    pub(in crate::convert) struct Pace {
        pacer: Mutex<Pacer>,
        wake: Notify,
        clock: Instant,
        live: bool,
    }

    impl Pace {
        /// A movie's clock starts when the receiver plays, so ffmpeg doesn't
        /// run ahead while the receiver loads.
        pub(in crate::convert) fn new(live: bool) -> Self {
            Self {
                pacer: Mutex::new(if live {
                    Pacer::new(0.0)
                } else {
                    Pacer::paused()
                }),
                wake: Notify::new(),
                clock: Instant::now(),
                live,
            }
        }

        fn now(&self) -> f64 {
            self.clock.elapsed().as_secs_f64()
        }

        fn pacer(&self) -> MutexGuard<'_, Pacer> {
            self.pacer.lock().unwrap_or_else(|p| p.into_inner())
        }

        pub(in crate::convert) fn set_playing(&self, playing: bool) {
            if self.live {
                return;
            }
            let now = self.now();
            let mut pacer = self.pacer();
            if playing {
                pacer.resume(now);
            } else {
                pacer.pause(now);
            }
            drop(pacer);
            // A permit is kept when no one waits yet, so a change between
            // a check and the wait isn't lost.
            self.wake.notify_one();
        }

        /// Counts a segment `duration` seconds long, then waits while the
        /// conversion is far enough ahead of playback.
        pub(in crate::convert) async fn after(&self, duration: f64) {
            self.pacer().made(duration);
            loop {
                let wait = self.pacer().wait(self.now());
                match wait {
                    Some(wait) if wait <= 0.0 => return,
                    Some(wait) => {
                        let limit = Duration::from_secs_f64(wait.min(1.0));
                        let _ = tokio::time::timeout(limit, self.wake.notified()).await;
                    }
                    None => self.wake.notified().await,
                }
            }
        }
    }

    /// Puts each segment on the server as it's cut.
    pub(in crate::convert) struct Publisher {
        pub(in crate::convert) files: Files,
        pub(in crate::convert) playlist: MediaPlaylist,
        pub(in crate::convert) audio: Option<&'static str>,
        pub(in crate::convert) master: bool,
        pub(in crate::convert) started: Option<oneshot::Sender<Result<(), HlsError>>>,
    }

    impl Publisher {
        /// Serves `segment`, and the playlists that list it. `video` is the
        /// video's `CODECS` name, when the stream has video. Returns false
        /// for a segment too big to keep.
        pub(in crate::convert) fn publish(
            &mut self,
            segment: Segment,
            video: Option<String>,
        ) -> bool {
            if segment.bytes.len() > MAX_SEGMENT_BYTES {
                return false;
            }
            if !self.master {
                self.master = true;
                let codecs: Vec<String> = video
                    .into_iter()
                    .chain(self.audio.map(str::to_string))
                    .collect();
                let declared = bandwidth(segment.bytes.len(), segment.duration);
                self.files.put(
                    hls::MASTER,
                    hls::PLAYLIST_TYPE,
                    hls::master(declared, &codecs).into_bytes(),
                );
            }
            let (sequence, dropped) = self.playlist.push_after(
                segment.duration,
                segment.bytes.len(),
                segment.discontinuity,
            );
            self.files.put(
                &hls::segment_name(sequence),
                hls::SEGMENT_TYPE,
                segment.bytes,
            );
            for old in dropped {
                self.files.remove(&hls::segment_name(old));
            }
            self.put_media();
            if self.playlist.ready() {
                self.tell(Ok(()));
            }
            true
        }

        /// The source ended, with `result`. The playlist says no more
        /// segments come, and a start still waiting hears how it went.
        pub(in crate::convert) fn finish(&mut self, result: Ended) {
            if result.is_ok() {
                self.playlist.finish();
                self.put_media();
                if self.playlist.ready() {
                    self.tell(Ok(()));
                }
            }
            self.tell(Err(result.err().unwrap_or(HlsError::Unreachable)));
        }

        fn put_media(&self) {
            self.files.put(
                hls::MEDIA,
                hls::PLAYLIST_TYPE,
                self.playlist.text().into_bytes(),
            );
        }

        fn tell(&mut self, result: Result<(), HlsError>) {
            if let Some(started) = self.started.take() {
                let _ = started.send(result);
            }
        }
    }

    /// The video's `CODECS` name, from what the segmenter read: the H.264
    /// profile, or [`AVC_FALLBACK`] for video without a readable one.
    fn video_codec(segmenter: &TsSegmenter) -> Option<String> {
        segmenter
            .has_video()
            .then(|| segmenter.video_codec().unwrap_or(AVC_FALLBACK).to_string())
    }

    /// Cuts ffmpeg's output into segments until it exits, then says how it
    /// ended. `stop` closing kills ffmpeg and waits for it, and ends the
    /// task.
    async fn write_segments(
        mut child: Child,
        mut stdout: tokio::process::ChildStdout,
        mut stop: oneshot::Receiver<()>,
        mut out: Publisher,
        pace: Arc<Pace>,
        ended: watch::Sender<Option<Ended>>,
        errors: Errors,
    ) {
        let mut segmenter = TsSegmenter::new(SEGMENT);
        let mut buf = vec![0u8; 64 * 1024];
        let mut broken = false;
        let stopped = 'read: loop {
            let read = tokio::select! {
                read = stdout.read(&mut buf) => read,
                _ = &mut stop => break 'read true,
            };
            let n = match read {
                Ok(0) | Err(_) => break false,
                Ok(n) => n,
            };
            let Ok(segments) = segmenter.push(&buf[..n]) else {
                broken = true;
                break false;
            };
            for segment in segments {
                let duration = segment.duration;
                if !out.publish(segment, video_codec(&segmenter)) {
                    broken = true;
                    break 'read false;
                }
                tokio::select! {
                    () = pace.after(duration) => {}
                    _ = &mut stop => break 'read true,
                }
            }
        };
        if stopped || broken {
            let _ = child.start_kill();
        }
        let status = tokio::select! {
            status = child.wait() => status,
            // ffmpeg exits once its output closes. If it doesn't, a stop
            // still ends it.
            _ = &mut stop, if !stopped => {
                let _ = child.kill().await;
                return;
            }
        };
        if stopped {
            return;
        }
        let end = if broken {
            Err(HlsError::Failed)
        } else if status.is_ok_and(|s| s.success()) {
            let video = video_codec(&segmenter);
            let kept = segmenter
                .finish()
                .is_none_or(|last| out.publish(last, video));
            if kept {
                Ok(())
            } else {
                Err(HlsError::Failed)
            }
        } else {
            Err(errors.reason().await.into())
        };
        out.finish(end);
        let _ = ended.send(Some(end));
    }
}

#[cfg(test)]
#[cfg(target_os = "linux")]
#[path = "hls_tests.rs"]
mod tests;
