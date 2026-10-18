// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Converts a stream on this device into HLS and serves it on the local
//! network, for a receiver that can't play the stream as it is. AirPlay
//! uses it from iOS, and so can Cast from iOS later, since the server sends
//! CORS headers.
//!
//! - `hls-remux` copies the video and copies or converts the audio, and
//!   cuts MPEG-TS segments in memory. MPVKit's FFmpeg has no HLS muxer, so
//!   the playlists come from `mvp_core::convert::hls`.
//! - The segments sit in a sliding window on [`crate::lan_server`], and a
//!   pacer keeps the converter a little ahead of playback, so a movie
//!   remuxed far faster than realtime never fills the memory.
//! - The source URL carries the provider's login. It stays here and in the
//!   converter. The receiver only ever sees this device's address.
//! - Dropping the [`HlsConversion`] stops the converter and the server.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use hls_remux::{Audio, Canceller, RemuxError, Sink, Source, Video};
use mvp_core::convert::hls::{self, MediaPlaylist, Pacer};
use mvp_core::convert::{pick_audio, AudioPlan};
use mvp_core::streams::probe::AudioTrack;
use tokio::sync::{oneshot, watch};

use crate::lan_server::{Files, LanServer, Peers};
use crate::streams::REFUSED;

#[cfg(test)]
mod tests;

/// How long each segment is at least. Segments end at keyframes, so they
/// run longer when the source's keyframes are further apart.
const SEGMENT: f64 = 2.0;
/// How many segments stay on the server: with the pacer's lead of 20 s and
/// 2 s segments, the segments around the playback position.
const WINDOW: usize = 15;
/// How long the converter gets to open the source and make the first
/// segments.
const START_LIMIT: Duration = Duration::from_secs(30);
/// The least bandwidth the master playlist declares.
const MIN_BANDWIDTH: u64 = 500_000;

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

impl From<RemuxError> for HlsError {
    fn from(e: RemuxError) -> Self {
        match e {
            RemuxError::Refused => HlsError::Refused,
            RemuxError::Unreachable => HlsError::Unreachable,
            RemuxError::Failed | RemuxError::Cancelled => HlsError::Failed,
        }
    }
}

/// What to convert, and for whom.
pub struct HlsRequest<'a> {
    pub url: &'a str,
    /// Seconds into a movie or episode. 0 for live.
    pub start_at: f64,
    pub user_agent: Option<&'a str>,
    /// The language whose audio track comes first, when the source has one.
    pub language: Option<&'a str>,
    /// FFmpeg's names for the audio codecs the receiver plays as they are,
    /// so a track in one of them is copied rather than converted.
    pub playable: &'a [&'a str],
    pub peers: Peers,
}

/// What the converter tells the playback clock.
struct Control {
    pacer: Mutex<Pacer>,
    wake: Condvar,
    stopped: AtomicBool,
    clock: Instant,
}

impl Control {
    fn now(&self) -> f64 {
        self.clock.elapsed().as_secs_f64()
    }

    fn pacer(&self) -> std::sync::MutexGuard<'_, Pacer> {
        self.pacer.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// How a conversion ended.
pub type Ended = Result<(), HlsError>;

/// A running conversion. Dropping it stops the converter and the server.
pub struct HlsConversion {
    /// The master playlist's address, for the receiver.
    pub url: String,
    /// The source's length in seconds, for a movie or an episode.
    pub duration: Option<f64>,
    /// Changes from `None` when the converter stops.
    pub ended: watch::Receiver<Option<Ended>>,
    control: Arc<Control>,
    canceller: Canceller,
    _server: LanServer,
}

impl HlsConversion {
    /// Whether the receiver is playing, which runs the pacer's clock.
    pub fn set_playing(&self, playing: bool) {
        let now = self.control.now();
        let mut pacer = self.control.pacer();
        if playing {
            pacer.resume(now);
        } else {
            pacer.pause(now);
        }
        drop(pacer);
        self.control.wake.notify_all();
    }
}

impl Drop for HlsConversion {
    fn drop(&mut self) {
        self.control.stopped.store(true, Ordering::Release);
        self.canceller.cancel();
        self.control.wake.notify_all();
    }
}

/// What the converter thread says once it can be played, or why not.
type Started = Result<(Option<f64>, Canceller), HlsError>;

/// Starts converting `request.url`, and returns once the receiver can
/// start: the first three segments are on the server, or the source ended.
/// A source that refuses the login fails here, before the receiver is told
/// anything.
pub async fn start(request: HlsRequest<'_>) -> Result<HlsConversion, HlsError> {
    let server = LanServer::start_for(request.peers)
        .await
        .map_err(|_| HlsError::NoNetwork)?;
    let control = Arc::new(Control {
        pacer: Mutex::new(Pacer::new(0.0)),
        wake: Condvar::new(),
        stopped: AtomicBool::new(false),
        clock: Instant::now(),
    });
    let (started_tx, started_rx) = oneshot::channel::<Started>();
    let (ended_tx, ended) = watch::channel(None);
    let job = Job {
        url: request.url.to_string(),
        start_at: request.start_at,
        user_agent: request.user_agent.map(str::to_string),
        language: request.language.map(str::to_string),
        playable: request.playable.iter().map(|c| c.to_string()).collect(),
        files: server.files.clone(),
        control: control.clone(),
    };
    std::thread::Builder::new()
        .name("hls-convert".into())
        .spawn(move || {
            let end = job.run(started_tx);
            let _ = ended_tx.send(Some(end));
        })
        .map_err(|_| HlsError::Failed)?;
    let started = tokio::time::timeout(START_LIMIT, started_rx).await;
    let (duration, canceller) = match started {
        Ok(Ok(Ok(started))) => started,
        Ok(Ok(Err(e))) => return Err(e),
        // The thread ended without a word, or it took too long. Dropping
        // the control here doesn't stop a thread still opening the
        // source, so it's told to stop.
        _ => {
            control.stopped.store(true, Ordering::Release);
            control.wake.notify_all();
            return Err(HlsError::Unreachable);
        }
    };
    Ok(HlsConversion {
        url: server.url(hls::MASTER),
        duration,
        ended,
        control,
        canceller,
        _server: server,
    })
}

/// What the converter thread works from.
struct Job {
    url: String,
    start_at: f64,
    user_agent: Option<String>,
    language: Option<String>,
    playable: Vec<String>,
    files: Files,
    control: Arc<Control>,
}

impl Job {
    fn run(self, started: oneshot::Sender<Started>) -> Ended {
        let mut source = match Source::open(&self.url, self.start_at, self.user_agent.as_deref()) {
            Ok(source) => source,
            Err(e) => {
                let _ = started.send(Err(e.into()));
                return Err(e.into());
            }
        };
        if self.control.stopped.load(Ordering::Acquire) {
            return Err(HlsError::Failed);
        }
        let (video, extradata) = source.video();
        let tracks = source.audio_tracks();
        let plan = match plan(
            video,
            &extradata,
            &tracks,
            self.language.as_deref(),
            &self.playable,
        ) {
            Ok(plan) => plan,
            Err(e) => {
                let _ = started.send(Err(e));
                return Err(e);
            }
        };
        let mut sink = HlsSink {
            files: self.files,
            playlist: MediaPlaylist::new(WINDOW),
            buffer: Vec::new(),
            codecs: plan.codecs,
            master: false,
            control: self.control,
            started: Some(started),
            duration: source.duration(),
            canceller: source.canceller(),
        };
        let result = source.run(plan.audio, SEGMENT, &mut sink);
        sink.finish(result.map_err(HlsError::from))
    }
}

/// What to make of a source: its audio, and the codecs the playlist names.
#[derive(Debug, Clone, PartialEq)]
struct OutputPlan {
    audio: Audio,
    codecs: Vec<String>,
}

/// Copies H.264 as it is, and picks the audio with the cast converter's
/// rule: a playable track in the chosen language first, copied, or else
/// the default track as stereo AAC.
fn plan(
    video: Video,
    extradata: &[u8],
    tracks: &[hls_remux::AudioTrack],
    language: Option<&str>,
    playable: &[String],
) -> Result<OutputPlan, HlsError> {
    let mut codecs = Vec::new();
    match video {
        Video::None => {}
        Video::H264 => codecs.extend(hls::avc_codec(extradata)),
        Video::Hevc | Video::Other => return Err(HlsError::VideoCodec),
    }
    let tracks: Vec<AudioTrack> = tracks
        .iter()
        .map(|t| AudioTrack {
            codec: t.codec.clone(),
            language: t.language.clone(),
            default: t.default,
        })
        .collect();
    let playable: Vec<&str> = playable.iter().map(String::as_str).collect();
    let (track, audio) = match pick_audio(&tracks, language, &playable) {
        (_, AudioPlan::None) => (None, Audio::None),
        (i, AudioPlan::Copy) => (Some(tracks[i].codec.as_str()), Audio::Copy(i)),
        (i, AudioPlan::Aac { downmix }) => (Some("aac"), Audio::Aac { track: i, downmix }),
    };
    codecs.extend(track.and_then(hls::audio_codec).map(str::to_string));
    if video == Video::None && audio == Audio::None {
        return Err(HlsError::Unreachable);
    }
    Ok(OutputPlan { audio, codecs })
}

/// Puts each segment on the server as it's cut.
struct HlsSink {
    files: Files,
    playlist: MediaPlaylist,
    buffer: Vec<u8>,
    codecs: Vec<String>,
    master: bool,
    control: Arc<Control>,
    started: Option<oneshot::Sender<Started>>,
    duration: Option<f64>,
    canceller: Canceller,
}

impl HlsSink {
    fn tell_started(&mut self) {
        if let Some(started) = self.started.take() {
            let _ = started.send(Ok((self.duration, self.canceller.clone())));
        }
    }

    /// The source ended, with `result`. Whatever's left becomes the last
    /// segment, and the playlist says no more come.
    fn finish(mut self, result: Ended) -> Ended {
        if result.is_ok() {
            self.playlist.finish();
            self.files.put(
                hls::MEDIA,
                hls::PLAYLIST_TYPE,
                self.playlist.text().into_bytes(),
            );
            if self.playlist.ready() {
                self.tell_started();
            }
        }
        if let Some(started) = self.started.take() {
            let _ = started.send(Err(result.err().unwrap_or(HlsError::Unreachable)));
        }
        result
    }
}

impl Sink for HlsSink {
    fn write(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    fn cut(&mut self, duration: f64) -> bool {
        let bytes = std::mem::take(&mut self.buffer);
        if !self.master {
            self.master = true;
            self.files.put(
                hls::MASTER,
                hls::PLAYLIST_TYPE,
                hls::master(bandwidth(bytes.len(), duration), &self.codecs).into_bytes(),
            );
        }
        let (sequence, dropped) = self.playlist.push(duration);
        self.files
            .put(&hls::segment_name(sequence), hls::SEGMENT_TYPE, bytes);
        if let Some(old) = dropped {
            self.files.remove(&hls::segment_name(old));
        }
        self.files.put(
            hls::MEDIA,
            hls::PLAYLIST_TYPE,
            self.playlist.text().into_bytes(),
        );
        if self.playlist.ready() {
            self.tell_started();
        }
        self.control.pace(duration)
    }
}

/// The bandwidth the master playlist declares, from the first segment's
/// size and length: a fifth more than it took, and at least
/// [`MIN_BANDWIDTH`].
fn bandwidth(bytes: usize, duration: f64) -> u64 {
    let bits = bytes as f64 * 8.0 / duration.max(0.1);
    ((bits * 1.2) as u64).max(MIN_BANDWIDTH)
}

impl Control {
    /// Counts a segment `duration` seconds long, then waits while the
    /// converter is far enough ahead of playback. Returns false once the
    /// conversion is stopped.
    fn pace(&self, duration: f64) -> bool {
        let control = self;
        let mut pacer = control.pacer();
        pacer.made(duration);
        loop {
            if control.stopped.load(Ordering::Acquire) {
                return false;
            }
            pacer = match pacer.wait(control.now()) {
                Some(wait) if wait <= 0.0 => return true,
                Some(wait) => {
                    let limit = Duration::from_secs_f64(wait.min(1.0));
                    control
                        .wake
                        .wait_timeout(pacer, limit)
                        .unwrap_or_else(|p| p.into_inner())
                        .0
                }
                None => control.wake.wait(pacer).unwrap_or_else(|p| p.into_inner()),
            };
        }
    }
}
