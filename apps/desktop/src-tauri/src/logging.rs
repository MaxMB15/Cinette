// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Sets up `tracing` for the whole app.

use tracing_subscriber::EnvFilter;

fn filter() -> EnvFilter {
    EnvFilter::from_default_env()
        .add_directive("max_video_player=debug".parse().unwrap())
        .add_directive("tauri_plugin_mpv=debug".parse().unwrap())
        .add_directive("mvp_core=debug".parse().unwrap())
}

#[cfg(not(target_os = "ios"))]
pub fn init() {
    tracing_subscriber::fmt().with_env_filter(filter()).init();
}

/// On iOS nothing reads stdout. Tauri forwards it to the system log, but
/// only in debug builds, and reading a device's system log from a Mac's
/// command line needs root. So the logs go to the system log directly, under
/// the app's bundle ID, and to a file that `devicectl` can copy off the
/// device. See "Logs" in docs/ios.md.
///
/// Both outlive the session and can end up with someone else, so every line
/// goes through [`scrub`] on the way to either one.
#[cfg(target_os = "ios")]
pub fn init() {
    use tracing_subscriber::prelude::*;

    let system = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .without_time()
        .with_writer(ios_oslog::SystemLog::new("com.maxvideoplayer.app", "rust"));
    let file = ios_file::open().map(|log| {
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(move || log.clone())
    });
    tracing_subscriber::registry()
        .with(filter())
        .with(system)
        .with(file)
        .init();
}

/// Removes logins, passwords and API keys from a log line. Stream, playlist
/// and EPG addresses carry the provider's login, and network errors repeat
/// the address they failed on, API key included.
#[cfg(target_os = "ios")]
fn scrub(line: &str) -> String {
    use mvp_core::downloads::redact::{redact_credentials, scrub_urls};
    redact_credentials(&scrub_urls(line))
}

#[cfg(target_os = "ios")]
mod ios_oslog {
    use oslog::{Level as OsLevel, OsLog};
    use std::io::{self, Write};
    use tracing::{Level, Metadata};
    use tracing_subscriber::fmt::MakeWriter;

    /// Sends each formatted line to os_log. The `oslog` crate logs with
    /// `%{public}s`, so Console shows the text without a logging profile.
    /// That's only safe because `scrub` has already taken out logins and
    /// keys.
    pub struct SystemLog(OsLog);

    impl SystemLog {
        pub fn new(subsystem: &str, category: &str) -> Self {
            Self(OsLog::new(subsystem, category))
        }

        fn line(&self, level: Level) -> Line<'_> {
            Line {
                log: &self.0,
                level,
                buf: Vec::new(),
            }
        }
    }

    impl<'a> MakeWriter<'a> for SystemLog {
        type Writer = Line<'a>;

        fn make_writer(&'a self) -> Self::Writer {
            self.line(Level::INFO)
        }

        fn make_writer_for(&'a self, meta: &Metadata<'_>) -> Self::Writer {
            self.line(*meta.level())
        }
    }

    /// Collects one event's text and logs it when dropped.
    pub struct Line<'a> {
        log: &'a OsLog,
        level: Level,
        buf: Vec<u8>,
    }

    impl Write for Line<'_> {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.buf.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for Line<'_> {
        fn drop(&mut self) {
            if self.buf.is_empty() {
                return;
            }
            let text = String::from_utf8_lossy(&self.buf);
            self.log
                .with_level(os_level(self.level), &super::scrub(text.trim_end()));
        }
    }

    /// The mapping tracing-oslog used. os_log only stores default, error and
    /// fault lines on the device, so DEBUG and TRACE lines show up only while
    /// Console is streaming with info and debug messages turned on.
    fn os_level(level: Level) -> OsLevel {
        match level {
            Level::TRACE => OsLevel::Debug,
            Level::DEBUG => OsLevel::Info,
            Level::INFO => OsLevel::Default,
            Level::WARN => OsLevel::Error,
            Level::ERROR => OsLevel::Fault,
        }
    }
}

#[cfg(target_os = "ios")]
mod ios_file {
    use std::fs::{self, File};
    use std::io::{self, Write};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    /// When `app.log` reaches this size it becomes `app.log.1`, replacing an
    /// older one, and a new `app.log` starts. A run keeps at most about twice
    /// this, and the newest lines always survive, since those are the ones
    /// that explain a crash.
    const MAX_BYTES: u64 = 5 * 1024 * 1024;

    const CONTINUED: &[u8] = b"Continues from app.log.1\n";

    /// `Library/Caches/Logs/app.log` in the app's container. iOS doesn't
    /// back up Caches and may clear it when storage runs low, which is fine
    /// for logs.
    pub fn open() -> Option<CappedLog> {
        let dir = PathBuf::from(std::env::var_os("HOME")?).join("Library/Caches/Logs");
        fs::create_dir_all(&dir).ok()?;
        let path = dir.join("app.log");
        let older = dir.join("app.log.1");
        // Keep the last run's log, which is the one that matters after a
        // crash. The part of that run that had already moved to app.log.1
        // goes.
        let _ = fs::rename(&path, dir.join("app.previous.log"));
        let _ = fs::remove_file(&older);
        let file = File::create(&path).ok()?;
        Some(CappedLog(Arc::new(Inner {
            path,
            older,
            state: Mutex::new(State { file, written: 0 }),
        })))
    }

    struct Inner {
        path: PathBuf,
        older: PathBuf,
        state: Mutex<State>,
    }

    struct State {
        file: File,
        written: u64,
    }

    impl Inner {
        /// Moves `app.log` to `app.log.1` and starts a new `app.log`. Returns
        /// false if the new file couldn't be created.
        fn rotate(&self, state: &mut State) -> bool {
            let _ = fs::rename(&self.path, &self.older);
            let Ok(mut file) = File::create(&self.path) else {
                return false;
            };
            let _ = file.write_all(CONTINUED);
            *state = State {
                file,
                written: CONTINUED.len() as u64,
            };
            true
        }
    }

    #[derive(Clone)]
    pub struct CappedLog(Arc<Inner>);

    impl Write for CappedLog {
        /// `tracing` writes each line in one call, so a line is scrubbed whole
        /// and never split between two files.
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let line = super::scrub(&String::from_utf8_lossy(buf));
            let len = line.len() as u64;
            let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.written + len > MAX_BYTES && !self.0.rotate(&mut state) {
                // Without a new file, drop the line rather than let the old
                // one grow past the cap.
                return Ok(buf.len());
            }
            state.file.write_all(line.as_bytes())?;
            state.written += len;
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
