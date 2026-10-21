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
use mvp_core::convert::hls::{
    self, bandwidth, MediaPlaylist, Pacer, AVC_FALLBACK, SEGMENT, TARGET, WINDOW,
};
use mvp_core::convert::{pick_audio, AudioPlan};
use mvp_core::streams::probe::AudioTrack;
use tokio::sync::{oneshot, watch};

pub use crate::convert::hls::{Ended, HlsError};
use crate::lan_server::{Files, LanServer, Peers};

// They write their media with `hls_remux::test_media`, which only the
// Linux tests have.
#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests;

/// The most one segment may hold before the conversion fails. The C cuts
/// at 32 MB, so only a broken stream gets here.
const MAX_SEGMENT_BYTES: usize = 48 * 1024 * 1024;
/// How long the converter gets to open the source and make the first
/// segments. A cancel stops it, even while it opens.
const START_LIMIT: Duration = Duration::from_secs(30);

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
    /// A live channel: its pacer never stops, since a live source that
    /// isn't read drops the connection, and the receiver joins at the edge.
    pub live: bool,
}

/// What the converter tells the playback clock.
struct Control {
    pacer: Mutex<Pacer>,
    wake: Condvar,
    stopped: AtomicBool,
    clock: Instant,
    live: bool,
}

impl Control {
    fn now(&self) -> f64 {
        self.clock.elapsed().as_secs_f64()
    }

    fn pacer(&self) -> std::sync::MutexGuard<'_, Pacer> {
        self.pacer.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// A running conversion. Dropping it stops the converter and the server.
pub struct HlsConversion {
    /// The master playlist's address, for the receiver.
    pub url: String,
    /// The source's length in seconds, for a movie or an episode.
    pub duration: Option<f64>,
    /// Where the first segment starts in the source, in seconds: the
    /// keyframe at or before where it was asked to start.
    pub start: f64,
    /// Changes from `None` when the converter thread ends, after it has
    /// closed the source's connection.
    pub ended: watch::Receiver<Option<Ended>>,
    control: Arc<Control>,
    canceller: Canceller,
    _server: LanServer,
}

impl HlsConversion {
    /// Whether the receiver is playing, which runs the pacer's clock. A
    /// live conversion's clock always runs.
    pub fn set_playing(&self, playing: bool) {
        if self.control.live {
            return;
        }
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

/// What the converter thread says once it can be played: the source's
/// length and where the first segment starts. Or why not.
type Started = Result<(Option<f64>, f64), HlsError>;

/// Starts converting `request.url`, and returns once the receiver can
/// start: the first three segments are on the server, or the source ended.
/// A source that refuses the login fails here, before the receiver is told
/// anything.
pub async fn start(request: HlsRequest<'_>) -> Result<HlsConversion, HlsError> {
    start_within(request, START_LIMIT).await
}

/// [`start`], with `limit` for the source to open and the first segments
/// to be made.
async fn start_within(
    request: HlsRequest<'_>,
    limit: Duration,
) -> Result<HlsConversion, HlsError> {
    let server = LanServer::start_for(request.peers)
        .await
        .map_err(|_| HlsError::NoNetwork)?;
    let source = Source::new().map_err(|_| HlsError::Failed)?;
    let canceller = source.canceller();
    let control = Arc::new(Control {
        // A movie's clock starts when the receiver plays, so the converter
        // doesn't run ahead while the receiver loads.
        pacer: Mutex::new(if request.live {
            Pacer::new(0.0)
        } else {
            Pacer::paused()
        }),
        wake: Condvar::new(),
        stopped: AtomicBool::new(false),
        clock: Instant::now(),
        live: request.live,
    });
    let (started_tx, started_rx) = oneshot::channel::<Started>();
    let (ended_tx, ended) = watch::channel(None);
    let job = Job {
        source,
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
    let started = tokio::time::timeout(limit, started_rx).await;
    let (duration, start) = match started {
        Ok(Ok(Ok(started))) => started,
        Ok(Ok(Err(e))) => return Err(e),
        // The thread ended without a word, or it took too long. It may
        // still be opening the source, which the cancel stops.
        _ => {
            control.stopped.store(true, Ordering::Release);
            canceller.cancel();
            control.wake.notify_all();
            return Err(HlsError::Unreachable);
        }
    };
    Ok(HlsConversion {
        url: server.url(hls::MASTER),
        duration,
        start,
        ended,
        control,
        canceller,
        _server: server,
    })
}

/// What the converter thread works from.
struct Job {
    source: Source,
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
        let mut source = self.source;
        if let Err(e) = source.connect(&self.url, self.start_at, self.user_agent.as_deref()) {
            let _ = started.send(Err(e.into()));
            return Err(e.into());
        }
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
        let playlist = MediaPlaylist::new(WINDOW, TARGET);
        let mut sink = HlsSink {
            files: self.files,
            playlist: if self.control.live {
                playlist
            } else {
                playlist.from_start()
            },
            buffer: Vec::new(),
            overflowed: false,
            first_start: None,
            codecs: plan.codecs,
            master: false,
            control: self.control,
            started: Some(started),
            duration: source.duration(),
        };
        let result = source.run(plan.audio, SEGMENT, &mut sink);
        let result = if sink.overflowed {
            Err(HlsError::Failed)
        } else {
            result.map_err(HlsError::from)
        };
        sink.finish(result)
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
    source_tracks: &[hls_remux::AudioTrack],
    language: Option<&str>,
    playable: &[String],
) -> Result<OutputPlan, HlsError> {
    let mut codecs = Vec::new();
    match video {
        Video::None => {}
        Video::H264 => {
            codecs.push(hls::avc_codec(extradata).unwrap_or_else(|| AVC_FALLBACK.to_string()))
        }
        Video::Hevc | Video::Other => return Err(HlsError::VideoCodec),
    }
    let tracks: Vec<AudioTrack> = source_tracks
        .iter()
        .map(|t| AudioTrack {
            codec: t.codec.clone(),
            language: t.language.clone(),
            default: t.default,
            // The converter doesn't read layouts, and the choice of track
            // doesn't use them.
            layout: None,
        })
        .collect();
    let playable: Vec<&str> = playable.iter().map(String::as_str).collect();
    // What this device's FFmpeg can decode, as the converter found it.
    let decodable: Vec<&str> = source_tracks
        .iter()
        .filter(|t| t.decodable)
        .map(|t| t.codec.as_str())
        .collect();
    // The converter makes stereo AAC only, so it never asks for 5.1.
    let (track, audio) = match pick_audio(&tracks, language, &playable, &decodable, false) {
        (_, AudioPlan::None) => (None, Audio::None),
        (i, AudioPlan::Copy) => (Some(tracks[i].codec.as_str()), Audio::Copy(i)),
        (i, AudioPlan::Aac { downmix }) => (Some("aac"), Audio::Aac { track: i, downmix }),
        (_, AudioPlan::Surround) => unreachable!("5.1 wasn't asked for"),
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
    /// A segment grew past [`MAX_SEGMENT_BYTES`], so the conversion stops.
    overflowed: bool,
    /// Where the first segment started in the source.
    first_start: Option<f64>,
    codecs: Vec<String>,
    master: bool,
    control: Arc<Control>,
    started: Option<oneshot::Sender<Started>>,
    duration: Option<f64>,
}

impl HlsSink {
    fn tell_started(&mut self) {
        if let Some(started) = self.started.take() {
            let _ = started.send(Ok((self.duration, self.first_start.unwrap_or(0.0))));
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
        if self.buffer.len() + bytes.len() > MAX_SEGMENT_BYTES {
            self.overflowed = true;
            return;
        }
        self.buffer.extend_from_slice(bytes);
    }

    fn cut(&mut self, duration: f64, start: f64) -> bool {
        if self.overflowed {
            return false;
        }
        self.first_start.get_or_insert(start);
        let bytes = std::mem::take(&mut self.buffer);
        if !self.master {
            self.master = true;
            self.files.put(
                hls::MASTER,
                hls::PLAYLIST_TYPE,
                hls::master(bandwidth(bytes.len(), duration), &self.codecs).into_bytes(),
            );
        }
        let (sequence, dropped) = self.playlist.push(duration, bytes.len());
        self.files
            .put(&hls::segment_name(sequence), hls::SEGMENT_TYPE, bytes);
        for old in dropped {
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
