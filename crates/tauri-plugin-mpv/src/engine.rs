// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Platform-agnostic libmpv instance management.
//! Options (vo, hwdec, ao) are passed in by the caller. The only platform code
//! here is in `configure_audio`, which Linux needs after mpv starts, and in
//! `loaded_libmpv`, which finds the libmpv file on Linux.

use crate::loadfile::{loadfile, resume_option};
use crate::log_url::origin_for_log;
use crate::reconnect::ended_early;
use libmpv2::Mpv;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::Once;

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub is_playing: bool,
    pub is_paused: bool,
    pub current_url: Option<String>,
    pub volume: f64,
    pub position: f64,
    pub duration: f64,
    /// The current load has opened and shown its first frame (or started its
    /// audio). Stays true until the next load, so seeks and buffering later
    /// on don't clear it. Works for live streams, where duration stays 0.
    pub playback_started: bool,
    /// The current load stopped before it ever started playing, for example
    /// because the server returned an error. mpv goes back to idle when that
    /// happens.
    pub open_failed: bool,
    /// Playback ran to the end of the file. With keep-open, mpv then pauses on
    /// the last frame once the audio drains. A pause near the end leaves this
    /// false, and so does a connection that closed early, which `reconnect.rs`
    /// reloads. A seek back or the next load clears it.
    pub reached_end: bool,
    /// Playback isn't paused, but the picture doesn't move on, as while mpv
    /// opens a file, seeks or waits for more of the stream. This is mpv's
    /// `core-idle` when it isn't paused.
    pub waiting: bool,
    /// mpv plays in a window of its own, which the frontend can't draw over.
    /// `MpvState` sets it, since the engine doesn't know which window it has.
    pub fallback_active: bool,
}

/// Written out by hand so a logged state shows only the stream's origin,
/// since the URL can hold the login.
impl fmt::Debug for PlayerState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PlayerState")
            .field("is_playing", &self.is_playing)
            .field("is_paused", &self.is_paused)
            .field(
                "current_url",
                &self.current_url.as_deref().map(origin_for_log),
            )
            .field("volume", &self.volume)
            .field("position", &self.position)
            .field("duration", &self.duration)
            .field("playback_started", &self.playback_started)
            .field("open_failed", &self.open_failed)
            .field("reached_end", &self.reached_end)
            .field("waiting", &self.waiting)
            .field("fallback_active", &self.fallback_active)
            .finish()
    }
}

pub struct MpvEngine {
    mpv: Option<Mpv>,
    current_url: Option<String>,
    audio_logged_playing: bool,
    playback_started: bool,
}

impl MpvEngine {
    pub fn new() -> Self {
        Self {
            mpv: None,
            current_url: None,
            audio_logged_playing: false,
            playback_started: false,
        }
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
                match init.set_option(k.as_str(), v.as_str()) {
                    Ok(()) => {}
                    Err(e) if can_skip(k, &e) => {
                        tracing::info!("[MPV] option {k} skipped, this libmpv has no Lua");
                    }
                    Err(e) => {
                        failed = Some(k.as_str());
                        return Err(e);
                    }
                }
            }
            Ok(())
        })
        .map_err(|e| {
            // A libmpv other than the one the app expects often fails here
            // first, on an option it doesn't know, so name the file.
            let from = loaded_libmpv()
                .map(|path| format!(", libmpv {path:?}"))
                .unwrap_or_default();
            match failed {
                Some(k) => format!("mpv init: option {k}: {e}{from}"),
                None => format!("mpv init: {e}{from}"),
            }
        })?;
        log_build(&mpv);
        self.mpv = Some(mpv);
        Ok(self.mpv.as_mut().unwrap())
    }

    /// Set audio properties after mpv_initialize. Options like `aid` and `mute`
    /// must be set as properties (not init options) because `mpv_set_option_string`
    /// rejects them with MPV_ERROR_OPTION_ERROR (-7) on many libmpv builds.
    #[cfg(target_os = "linux")]
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
    /// This and the reconnect watcher's retries both go through
    /// `crate::loadfile`, which picks the form the loaded mpv accepts.
    pub fn loadfile(&self, url: &str, start_pos: Option<f64>) -> Result<(), String> {
        let mpv = self.mpv.as_ref().ok_or("no mpv instance")?;
        let resume_opt = resume_option(start_pos);
        loadfile(mpv, url, resume_opt.as_deref()).map_err(|e| format!("loadfile: {}", e))?;
        if let Some(opts) = &resume_opt {
            tracing::info!(
                "[MPV engine] loadfile resumed at {opts} origin={}",
                origin_for_log(url)
            );
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
    ///
    /// The client keeps mpv's default name. libmpv2 frees a name it is
    /// given before it calls `mpv_create_client`, so mpv can read an
    /// empty name and return no handle, which libmpv2 doesn't check for.
    pub fn create_event_client(&self) -> Result<libmpv2::Mpv, String> {
        let mpv = self.mpv.as_ref().ok_or("no mpv instance")?;
        mpv.create_client(None)
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
        // mpv also ends up here when it has audio drivers but none of them
        // could open a device, for example with no sound server running, so
        // the message names both causes.
        if current_ao.is_empty() || current_ao == "<unset>" {
            let at = loaded_libmpv()
                .map(|path| format!(" at {path:?}"))
                .unwrap_or_default();
            tracing::error!(
                "[MPV] no audio output opened. Either no sound server or device \
                 is available, or libmpv was built without audio drivers. On \
                 Linux, check that PipeWire or PulseAudio is running. If mpv's \
                 own log says \"Audio output pulse not found\", and the same \
                 for pipewire and alsa, the loaded libmpv{at} was built without \
                 them. If you built libmpv yourself, install libpulse-dev, \
                 libasound2-dev and libpipewire-0.3-dev and run \
                 ./scripts/build-libmpv.sh linux again."
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
        self.playback_started = false;
    }

    /// The URL that plays, or None once playback has stopped.
    pub fn current_url(&self) -> Option<&str> {
        self.current_url.as_deref()
    }

    /// Stop playback and destroy the mpv instance.
    pub fn stop(&mut self) {
        if let Some(ref mpv) = self.mpv {
            let _ = mpv.command("stop", &[]);
        }
        self.mpv = None;
        self.current_url = None;
        self.audio_logged_playing = false;
        self.playback_started = false;
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

    /// Add a subtitle track from a local file path and select it in place of
    /// the track in use, which it then removes. mpv only draws the new track
    /// when `visible` is true. When the file can't be added, the track in use
    /// stays. mpv draws it as before when `visible` is true, and hides it when
    /// it's false, since the frontend draws the new subtitles.
    pub fn sub_add(&self, path: &str, visible: bool) -> Result<(), String> {
        let mpv = self.mpv.as_ref().ok_or_else(|| "no mpv instance".to_string())?;
        let uri = subtitle_uri(path);
        // "no" when no track is in use, which isn't a number.
        let in_use = mpv
            .get_property::<String>("sid")
            .ok()
            .and_then(|id| id.parse::<i64>().ok());
        let set_visible = || {
            if let Err(e) = mpv.set_property("sub-visibility", visible) {
                tracing::warn!("[MPV] sub-visibility={} failed: {}", visible, e);
            }
        };
        // mpv hides subtitles before it adds a track the overlay draws, so it
        // never draws a frame of that track. It shows them only after the add
        // has switched away from the track in use, since the overlay may still
        // draw that track's cues.
        if !visible {
            set_visible();
        }
        tracing::info!("[MPV] sub-add: {}", origin_for_log(&uri));
        if let Err(e) = mpv.command("sub-add", &[&uri, "select"]) {
            tracing::warn!("[MPV] sub-add failed: {}", e);
            return Err(e.to_string());
        }
        // A track that came with the stream can't be removed, and is only no
        // longer selected.
        if let Some(id) = in_use
            && let Err(e) = mpv.command("sub-remove", &[&id.to_string()])
        {
            tracing::debug!("[MPV] sub-remove {} failed: {}", id, e);
        }
        if visible {
            set_visible();
        }
        set_sub_files(mpv, Some(&uri));
        tracing::info!("[MPV] sub-add: complete, sub-visibility={}", visible);
        Ok(())
    }

    /// Remove an external subtitle track. Pass -1 to remove the current track (no-arg form).
    /// mpv also stops adding the file when it reloads the stream.
    pub fn sub_remove(&self, id: i64) -> Result<(), String> {
        let mpv = self
            .mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?;
        set_sub_files(mpv, None);
        if id == -1 {
            mpv.command("sub-remove", &[]).map_err(|e| e.to_string())
        } else {
            mpv.command("sub-remove", &[&id.to_string()]).map_err(|e| e.to_string())
        }
    }

    /// Set subtitle vertical position (0 = top, 100 = bottom). Default is 100.
    ///
    /// mpv 0.37 made `sub-pos` a float, and older versions turn a float down.
    /// Every version takes a whole number, so the position is rounded.
    pub fn set_sub_pos(&self, pos: f64) -> Result<(), String> {
        self.mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?
            .set_property("sub-pos", pos.clamp(0.0, 150.0).round() as i64)
            .map_err(|e| e.to_string())
    }

    /// Gives a new mpv instance the subtitles the last one had, before its
    /// first `loadfile`. mpv adds and selects `file` with the stream, draws
    /// it only when `visible` is true, and shifts it by `delay` seconds.
    pub fn restore_subtitles(&self, file: &str, visible: bool, delay: f64) -> Result<(), String> {
        let mpv = self
            .mpv
            .as_ref()
            .ok_or_else(|| "no mpv instance".to_string())?;
        set_sub_files(mpv, Some(&subtitle_uri(file)));
        mpv.set_property("sub-visibility", visible)
            .and_then(|()| mpv.set_property("sub-delay", delay))
            .map_err(|e| e.to_string())
    }

    /// Whether there's an mpv instance. A stop or a failed load leaves none.
    pub fn has_instance(&self) -> bool {
        self.mpv.is_some()
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
            state.waiting =
                state.is_playing && mpv.get_property::<bool>("core-idle").unwrap_or(false);
            if state.current_url.is_some() {
                // Once playback has started the properties aren't read again.
                let started = self.playback_started;
                let read = |name: &str| {
                    if started {
                        None
                    } else {
                        mpv.get_property::<bool>(name).ok()
                    }
                };
                (self.playback_started, state.open_failed) =
                    open_status(started, read("seeking"), read("idle-active"));
                state.reached_end = mpv.get_property::<bool>("eof-reached").unwrap_or(false)
                    && !ended_early(Some(state.position), Some(state.duration));
            }
            state.playback_started = self.playback_started;
        }
        if !self.audio_logged_playing && state.position > 0.0 {
            self.audio_logged_playing = true;
            self.log_audio_state("playing");
            self.ensure_audio_selected();
        }
        state
    }
}

/// Options that only exist when libmpv was built with Lua.
const LUA_OPTIONS: [&str; 2] = ["osc", "ytdl"];

/// Whether `create` can go on without an option mpv turned down. That's one
/// of the Lua options on a libmpv built without Lua, which doesn't know them.
/// The fallback window then has no on-screen controls, and with no Lua there
/// is no `ytdl_hook` to turn off.
fn can_skip(key: &str, error: &libmpv2::Error) -> bool {
    LUA_OPTIONS.contains(&key)
        && matches!(error, libmpv2::Error::Raw(code) if *code == libmpv2::mpv_error::OptionNotFound)
}

/// A local path as a `file://` URI, so mpv can't read it as anything else.
fn subtitle_uri(path: &str) -> String {
    if path.starts_with('/') {
        format!("file://{path}")
    } else {
        path.to_string()
    }
}

/// Makes `uri` the only file in mpv's `sub-files` list, or empties the list.
/// mpv adds and selects the list's files each time it loads a file, so a
/// reconnect's reload keeps the subtitles. Adding to the list doesn't add a
/// track to the file that's playing.
fn set_sub_files(mpv: &Mpv, uri: Option<&str>) {
    let result = mpv.command("change-list", &["sub-files", "clr", ""]).and_then(|()| match uri {
        // `append` takes the URI as one item. Setting the whole list would
        // split it at its colons.
        Some(uri) => mpv.command("change-list", &["sub-files", "append", uri]),
        None => Ok(()),
    });
    if let Err(e) = result {
        tracing::warn!("[MPV] sub-files: {e}");
    }
}

/// Works out `(playback_started, open_failed)` for a load from the latch kept
/// across polls and mpv's `seeking` and `idle-active` properties, which are
/// `None` when they can't be read.
///
/// `seeking` is unavailable until the file is initialized and reads true until
/// mpv's first playback restart is done, which is when the first frame is
/// ready and audio has started. That also covers live streams and a resume
/// start position. The result is latched so later seeks and stalls don't flip
/// it back. libmpv defaults to idle=yes, so a load that fails before playing
/// leaves mpv idle instead of closing it.
fn open_status(started: bool, seeking: Option<bool>, idle_active: Option<bool>) -> (bool, bool) {
    if started {
        return (true, false);
    }
    let started = seeking == Some(false);
    (started, !started && idle_active == Some(true))
}

/// Logs mpv's version and, on Linux, the libmpv file that was loaded, so a
/// "no sound" report shows which build ran. The library can't change while
/// the app runs, so this logs once per process.
fn log_build(mpv: &Mpv) {
    static LOGGED: Once = Once::new();
    LOGGED.call_once(|| {
        let version = mpv
            .get_property::<String>("mpv-version")
            .unwrap_or_else(|_| "<unset>".to_string());
        match loaded_libmpv() {
            Some(path) => tracing::info!("[MPV] mpv-version={version:?} libmpv={path:?}"),
            None => tracing::info!("[MPV] mpv-version={version:?}"),
        }
    });
}

/// The libmpv file this process loaded, read from `/proc/self/maps`. Only
/// Linux reports it.
fn loaded_libmpv() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    // Any mapped file can have a name that isn't UTF-8, and that mustn't
    // hide libmpv.
    let maps = std::fs::read("/proc/self/maps").ok()?;
    libmpv_in_maps(&String::from_utf8_lossy(&maps)).map(str::to_string)
}

/// The path of the first mapped file whose name starts with `libmpv.so`, in
/// the text of `/proc/<pid>/maps`.
///
/// Each line has five fields separated by single spaces, then padding and
/// the path. The path can hold spaces of its own.
fn libmpv_in_maps(maps: &str) -> Option<&str> {
    maps.lines()
        .filter_map(|line| line.splitn(6, ' ').nth(5))
        .map(str::trim_start)
        .find(|path| {
            path.rsplit('/')
                .next()
                .is_some_and(|name| name.starts_with("libmpv.so"))
        })
}

#[cfg(test)]
mod playback_tests;

#[cfg(test)]
mod tests {
    use super::{can_skip, libmpv_in_maps, open_status, subtitle_uri, PlayerState};
    use libmpv2::mpv_error;

    #[test]
    fn a_logged_state_hides_the_login_in_the_url() {
        let state = PlayerState {
            current_url: Some("http://host.test:8080/live/USER/SECRET/1.ts".into()),
            ..PlayerState::default()
        };
        let logged = format!("{state:?}");
        assert!(logged.contains("http://host.test:8080"), "{logged}");
        assert!(!logged.contains("USER") && !logged.contains("SECRET"), "{logged}");
    }

    #[test]
    fn can_skip_only_a_lua_option_mpv_does_not_know() {
        let unknown = libmpv2::Error::Raw(mpv_error::OptionNotFound);
        assert!(can_skip("osc", &unknown));
        assert!(can_skip("ytdl", &unknown));
        assert!(!can_skip("vo", &unknown));
        let bad_value = libmpv2::Error::Raw(mpv_error::OptionFormat);
        assert!(!can_skip("osc", &bad_value));
        assert!(!can_skip("osc", &libmpv2::Error::Null));
    }

    #[test]
    fn subtitle_uri_turns_a_path_into_a_file_uri() {
        assert_eq!(subtitle_uri("/tmp/a b.srt"), "file:///tmp/a b.srt");
        assert_eq!(subtitle_uri("file:///tmp/a.srt"), "file:///tmp/a.srt");
    }

    #[test]
    fn open_status_waits_while_the_file_is_not_initialized() {
        assert_eq!(open_status(false, None, Some(false)), (false, false));
        assert_eq!(open_status(false, None, None), (false, false));
    }

    #[test]
    fn open_status_waits_while_the_first_seek_runs() {
        assert_eq!(open_status(false, Some(true), Some(false)), (false, false));
    }

    #[test]
    fn open_status_starts_when_seeking_ends() {
        assert_eq!(open_status(false, Some(false), Some(false)), (true, false));
    }

    #[test]
    fn open_status_fails_when_mpv_goes_idle_before_playing() {
        assert_eq!(open_status(false, None, Some(true)), (false, true));
        assert_eq!(open_status(false, Some(true), Some(true)), (false, true));
    }

    #[test]
    fn open_status_stays_started_once_latched() {
        assert_eq!(open_status(true, Some(true), Some(false)), (true, false));
        assert_eq!(open_status(true, None, Some(true)), (true, false));
    }

    #[test]
    fn serializes_open_status_in_camel_case() {
        let state = PlayerState {
            playback_started: true,
            open_failed: true,
            reached_end: true,
            waiting: true,
            ..Default::default()
        };
        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["playbackStarted"], true);
        assert_eq!(json["openFailed"], true);
        assert_eq!(json["reachedEnd"], true);
        assert_eq!(json["waiting"], true);
        assert_eq!(json["fallbackActive"], false);
    }

    #[test]
    fn libmpv_in_maps_finds_libmpv_among_other_mappings() {
        let maps = "\
55d0c0a00000-55d0c0a21000 r--p 00000000 08:02 1048602                    /usr/bin/max-video-player
55d0c2b00000-55d0c2b21000 rw-p 00000000 00:00 0                          [heap]
7f2c49e00000-7f2c49e80000 r--p 00000000 08:02 1311234                    /usr/lib/x86_64-linux-gnu/libmpv.so.2.3.0
7f2c49e80000-7f2c4a000000 r-xp 00080000 08:02 1311234                    /usr/lib/x86_64-linux-gnu/libmpv.so.2.3.0
7f2c4a000000-7f2c4a021000 rw-p 00000000 00:00 0
";
        assert_eq!(
            libmpv_in_maps(maps),
            Some("/usr/lib/x86_64-linux-gnu/libmpv.so.2.3.0")
        );
    }

    #[test]
    fn libmpv_in_maps_keeps_spaces_in_the_path() {
        let maps = "\
7f2c49e00000-7f2c49e80000 r--p 00000000 08:02 1311234                    /opt/Max Video/libs/libmpv.so.2
";
        assert_eq!(
            libmpv_in_maps(maps),
            Some("/opt/Max Video/libs/libmpv.so.2")
        );
    }

    #[test]
    fn libmpv_in_maps_finds_nothing_without_libmpv() {
        let maps = "\
55d0c0a00000-55d0c0a21000 r--p 00000000 08:02 1048602                    /usr/bin/max-video-player
7f2c4a200000-7f2c4a228000 r--p 00000000 08:02 1310001                    /usr/lib/x86_64-linux-gnu/libc.so.6
7f2c4a000000-7f2c4a021000 rw-p 00000000 00:00 0
7ffd1c9f0000-7ffd1c9f2000 r-xp 00000000 00:00 0                          [vdso]
";
        assert_eq!(libmpv_in_maps(maps), None);
        assert_eq!(libmpv_in_maps(""), None);
    }

    #[test]
    fn libmpv_in_maps_skips_lookalike_names() {
        let maps = "\
7f2c49e00000-7f2c49e80000 r--p 00000000 08:02 1311234                    /usr/lib/libmpv-helper.so
7f2c49e80000-7f2c4a000000 r--p 00000000 08:02 1311235                    /usr/lib/notlibmpv.so.2
7f2c4a000000-7f2c4a021000 r--p 00000000 08:02 1311236                    /opt/libmpv.so.d/libfoo.so
";
        assert_eq!(libmpv_in_maps(maps), None);
    }

    #[test]
    fn libmpv_in_maps_reads_anonymous_and_deleted_mappings() {
        // The kernel ends the line of an anonymous mapping with a space, and
        // adds " (deleted)" to a file that was deleted or replaced on disk.
        let maps = concat!(
            "7f2c4a000000-7f2c4a021000 rw-p 00000000 00:00 0 \n",
            "7f2c49e00000-7f2c49e80000 r-xp 00000000 08:02 1311234                    /usr/lib/libmpv.so.2 (deleted)\n",
        );
        assert_eq!(libmpv_in_maps(maps), Some("/usr/lib/libmpv.so.2 (deleted)"));
    }

    /// The test binary links libmpv, so its own maps list it.
    #[test]
    #[cfg(target_os = "linux")]
    fn loaded_libmpv_finds_the_linked_library() {
        let path = super::loaded_libmpv().expect("libmpv in /proc/self/maps");
        let name = path.rsplit('/').next().unwrap_or_default();
        assert!(name.starts_with("libmpv.so"), "{path}");
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn loaded_libmpv_finds_nothing_off_linux() {
        assert_eq!(super::loaded_libmpv(), None);
    }
}
