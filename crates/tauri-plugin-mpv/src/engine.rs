// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Platform-agnostic libmpv instance management.
//! Options (vo, hwdec, ao) are passed in by the caller; this file has zero #[cfg] blocks.

use libmpv2::Mpv;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub is_playing: bool,
    pub is_paused: bool,
    pub current_url: Option<String>,
    pub volume: f64,
    pub position: f64,
    pub duration: f64,
}

pub struct MpvEngine {
    mpv: Option<Mpv>,
    current_url: Option<String>,
    audio_logged_playing: bool,
}

impl MpvEngine {
    pub fn new() -> Self {
        Self { mpv: None, current_url: None, audio_logged_playing: false }
    }

    /// Create a new Mpv instance with the provided options.
    /// Drops any existing instance first (calls stop()).
    /// Returns a mutable reference so the caller can attach a render context
    /// before calling `loadfile`.
    pub fn create(&mut self, options: &[(&str, &str)]) -> Result<&mut Mpv, String> {
        self.stop();
        tracing::info!("[MPV] create with options: {:?}", options);
        let opts: Vec<(String, String)> = options
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        // Name the option that failed. A bare "Raw(-5)" doesn't say which one
        // this libmpv build doesn't know.
        let mut failed: Option<&str> = None;
        let mpv = Mpv::with_initializer(|init| {
            for (k, v) in &opts {
                if let Err(e) = init.set_option(k.as_str(), v.as_str()) {
                    failed = Some(k.as_str());
                    return Err(e);
                }
            }
            Ok(())
        })
        .map_err(|e| match failed {
            Some(k) => format!("mpv init: option {k}: {e}"),
            None => format!("mpv init: {e}"),
        })?;
        self.mpv = Some(mpv);
        Ok(self.mpv.as_mut().unwrap())
    }

    /// Set audio properties after mpv_initialize. Options like `aid` and `mute`
    /// must be set as properties (not init options) because `mpv_set_option_string`
    /// rejects them with MPV_ERROR_OPTION_ERROR (-7) on many libmpv builds.
    pub fn configure_audio(&self) -> Result<(), String> {
        let mpv = self.mpv.as_ref().ok_or("no mpv instance")?;
        if let Err(e) = mpv.set_property("aid", "auto") {
            tracing::warn!("[MPV] set aid=auto failed: {e}");
        }
        if let Err(e) = mpv.set_property("mute", false) {
            tracing::warn!("[MPV] set mute=false failed: {e}");
        }
        if let Err(e) = mpv.set_property("volume", 100.0_f64) {
            tracing::warn!("[MPV] set volume=100 failed: {e}");
        }
        self.log_audio_state("after configure_audio");
        Ok(())
    }

    /// Issue a `loadfile <url> replace` command. Must be called AFTER the
    /// render context is attached.
    ///
    /// When `start_pos` is `Some(p)` with `p > 1.0`, attach a `start=+<p>`
    /// per-file option so playback resumes at the given position (used by
    /// the reconnect / auto-recovery paths). For non-seekable inputs mpv
    /// silently ignores `start=`, so it's always safe to pass through.
    ///
    /// Matches the 4-arg form `loadfile <url> <flags> <index> <options>`
    /// used by `crates/tauri-plugin-mpv/src/reconnect.rs` for its internal
    /// retries — keeping both paths on the same syntax avoids divergent
    /// per-file option handling.
    pub fn loadfile(&self, url: &str, start_pos: Option<f64>) -> Result<(), String> {
        let mpv = self.mpv.as_ref().ok_or("no mpv instance")?;
        let resume_opt = start_pos.filter(|p| *p > 1.0).map(|p| format!("start=+{p:.3}"));
        let result = if let Some(ref opts) = resume_opt {
            mpv.command("loadfile", &[url, "replace", "0", opts])
        } else {
            mpv.command("loadfile", &[url, "replace"])
        };
        result.map_err(|e| format!("loadfile: {}", e))?;
        if let Some(p) = start_pos.filter(|p| *p > 1.0) {
            tracing::info!("[MPV engine] loadfile resumed at start=+{p:.3} url={url}");
        }
        self.log_audio_state("after loadfile");
        Ok(())
    }

    /// Create an independent client handle for use on a dedicated event-monitor
    /// thread. The returned `Mpv` shares the same underlying player but has its
    /// own event queue, so `wait_event` calls from the reconnect watcher do not
    /// compete with the main-thread accesses.
    ///
    /// **Lifetime caveat.** Per the libmpv docs, the handle returned by
    /// `mpv_create_client` holds a *strong* reference to the player core —
    /// dropping our parent `Mpv` does NOT terminate the core (or fire
    /// `MPV_EVENT_SHUTDOWN`) while a client is still alive. Callers that
    /// need deterministic teardown (so the next load gets a clean hardware
    /// decoder + audio device on macOS) must explicitly signal the monitor
    /// thread to drop this client. See `MpvState::reconnect_kill` and the
    /// kill-flag flow in `crates/tauri-plugin-mpv/src/reconnect.rs`.
    pub fn create_event_client(&self, name: &str) -> Result<libmpv2::Mpv, String> {
        let mpv = self.mpv.as_ref().ok_or("no mpv instance")?;
        mpv.create_client(Some(name))
            .map_err(|e| format!("mpv_create_client: {}", e))
    }

    /// Log audio-related mpv properties to help diagnose "no sound" reports.
    /// Called both right after loadfile (before mpv has picked an output) and
    /// from a delayed check once the decoder has started.
    pub fn log_audio_state(&self, stage: &str) {
        let Some(ref mpv) = self.mpv else { return };
        let get_str = |k: &str| {
            mpv.get_property::<String>(k)
                .unwrap_or_else(|_| "<unset>".to_string())
        };
        let get_bool = |k: &str| {
            mpv.get_property::<bool>(k)
                .map(|v| v.to_string())
                .unwrap_or_else(|_| "<unset>".to_string())
        };
        let get_f64 = |k: &str| {
            mpv.get_property::<f64>(k)
                .map(|v| v.to_string())
                .unwrap_or_else(|_| "<unset>".to_string())
        };
        tracing::info!(
            "[MPV audio {stage}] current-ao={} audio-device={} aid={} mute={} volume={} ao-volume={} audio-codec={} audio-params={} track-count={} track-list={}",
            get_str("current-ao"),
            get_str("audio-device"),
            get_str("aid"),
            get_bool("mute"),
            get_f64("volume"),
            get_f64("ao-volume"),
            get_str("audio-codec"),
            get_str("audio-params"),
            get_str("track-list/count"),
            get_str("track-list"),
        );
    }

    /// If mpv ended up with `aid=no` despite available audio tracks, force
    /// `aid=auto` so the audio track gets selected. This can happen when a
    /// system-wide config or internal mpv logic disables audio after our
    /// initial `configure_audio()` call.
    fn ensure_audio_selected(&self) {
        let Some(ref mpv) = self.mpv else { return };
        let aid = mpv.get_property::<String>("aid").unwrap_or_default();
        if aid != "no" {
            return;
        }
        let track_count = mpv
            .get_property::<String>("track-list/count")
            .and_then(|s| s.parse::<i64>().map_err(|_| libmpv2::Error::Null))
            .unwrap_or(0);
        if track_count == 0 {
            return;
        }

        let current_ao = mpv
            .get_property::<String>("current-ao")
            .unwrap_or_default();
        if current_ao.is_empty() || current_ao == "<unset>" {
            tracing::error!(
                "[MPV] NO AUDIO OUTPUT DRIVER — libmpv has no AO backends compiled in. \
                 Rebuild libmpv with audio support: \
                 sudo apt-get install libpulse-dev libasound2-dev libpipewire-0.3-dev && \
                 ./scripts/build-libmpv.sh linux"
            );
            return;
        }

        tracing::warn!(
            "[MPV] aid=no despite {track_count} tracks — forcing aid=auto"
        );
        if let Err(e) = mpv.set_property("aid", "auto") {
            tracing::error!("[MPV] failed to force aid=auto: {e}");
        }
        self.log_audio_state("after force-aid");
    }

    /// Record the current URL (called by MpvState after loadfile succeeds).
    pub fn set_current_url(&mut self, url: &str) {
        self.current_url = Some(url.to_string());
    }

    /// Stop playback and destroy the mpv instance.
    pub fn stop(&mut self) {
        if let Some(ref mpv) = self.mpv {
            let _ = mpv.command("stop", &[]);
        }
        self.mpv = None;
        self.current_url = None;
        self.audio_logged_playing = false;
    }

    pub fn play(&self) -> Result<(), String> {
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .set_property("pause", false)
            .map_err(|e| e.to_string())
    }

    pub fn pause(&self) -> Result<(), String> {
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .set_property("pause", true)
            .map_err(|e| e.to_string())
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .command("seek", &[&position.to_string(), "absolute"])
            .map_err(|e| e.to_string())
    }

    pub fn seek_relative(&self, offset: f64) -> Result<(), String> {
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .command("seek", &[&offset.to_string(), "relative"])
            .map_err(|e| e.to_string())
    }

    /// `vid=no` drops the video track and closes the video output; `vid=auto`
    /// brings both back.
    pub fn set_video_enabled(&self, enabled: bool) -> Result<(), String> {
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .set_property("vid", if enabled { "auto" } else { "no" })
            .map_err(|e| e.to_string())
    }

    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        let v = volume.clamp(0.0, 150.0);
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .set_property("volume", v)
            .map_err(|e| e.to_string())
    }

    /// Add a subtitle track from a local file path.
    pub fn sub_add(&self, path: &str) -> Result<(), String> {
        let mpv = self.mpv.as_ref().ok_or_else(|| "no mpv instance".to_string())?;
        // Convert to file:// URI so MPV path resolution is unambiguous for local files
        let uri = if path.starts_with('/') {
            format!("file://{path}")
        } else {
            path.to_string()
        };
        tracing::info!("[MPV] sub-add: uri={}", uri);
        mpv.command("sub-add", &[&uri, "select"])
            .map_err(|e| {
                tracing::warn!("[MPV] sub-add failed: {}", e);
                e.to_string()
            })?;
        let _ = mpv.set_property("sub-visibility", true);
        tracing::info!("[MPV] sub-add: complete, sub-visibility set");
        Ok(())
    }

    /// Remove an external subtitle track. Pass -1 to remove the current track (no-arg form).
    pub fn sub_remove(&self, id: i64) -> Result<(), String> {
        let mpv = self
            .mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?;
        if id == -1 {
            mpv.command("sub-remove", &[]).map_err(|e| e.to_string())
        } else {
            mpv.command("sub-remove", &[&id.to_string()]).map_err(|e| e.to_string())
        }
    }

    /// Set subtitle vertical position (0 = top, 100 = bottom). Default is 100.
    pub fn set_sub_pos(&self, pos: f64) -> Result<(), String> {
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .set_property("sub-pos", pos.clamp(0.0, 150.0))
            .map_err(|e| e.to_string())
    }

    /// Set subtitle time delay in seconds (negative = earlier, positive = later).
    pub fn set_sub_delay(&self, delay: f64) -> Result<(), String> {
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .set_property("sub-delay", delay)
            .map_err(|e| e.to_string())
    }

    pub fn get_state(&mut self) -> PlayerState {
        let mut state = PlayerState {
            current_url: self.current_url.clone(),
            volume: 100.0,
            ..Default::default()
        };
        if let Some(ref mpv) = self.mpv {
            state.position = mpv.get_property::<f64>("time-pos").unwrap_or(0.0);
            state.duration = mpv.get_property::<f64>("duration").unwrap_or(0.0);
            state.is_paused = mpv.get_property::<bool>("pause").unwrap_or(false);
            state.volume = mpv.get_property::<f64>("volume").unwrap_or(100.0);
            state.is_playing = !state.is_paused && state.current_url.is_some();
        }
        if !self.audio_logged_playing && state.position > 0.0 {
            self.audio_logged_playing = true;
            self.log_audio_state("playing");
            self.ensure_audio_selected();
        }
        state
    }
}
