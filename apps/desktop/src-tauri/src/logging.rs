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
/// goes through [`scrub_log_line`](mvp_core::downloads::redact::scrub_log_line)
/// once, on its way to both.
#[cfg(target_os = "ios")]
pub fn init() {
    use tracing_subscriber::prelude::*;

    /// When `app.log` would grow past this, it becomes `app.log.1`. A run
    /// keeps at most about twice this.
    const MAX_BYTES: u64 = 5 * 1024 * 1024;

    // `Library/Caches/Logs` in the app's container. iOS doesn't back up
    // Caches and may clear it when storage runs low, which is fine for logs.
    let file = std::env::var_os("HOME")
        .map(|home| std::path::PathBuf::from(home).join("Library/Caches/Logs"))
        .and_then(|dir| capped::CappedLog::open(&dir, MAX_BYTES).ok());
    let sink = ios::Sink::new("com.maxvideoplayer.app", "rust", file);
    tracing_subscriber::registry()
        .with(filter())
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .without_time()
                .with_writer(sink),
        )
        .init();
    log_panics();
}

/// A panic's message goes to stderr, which nothing reads on iOS outside
/// Xcode. This sends it through `tracing` instead, so it reaches both logs,
/// scrubbed like any other line, before the thread unwinds or the app aborts.
#[cfg(target_os = "ios")]
fn log_panics() {
    use std::backtrace::{Backtrace, BacktraceStatus};

    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        // Captured only when RUST_BACKTRACE is set, as with the default hook.
        let backtrace = Backtrace::capture();
        if backtrace.status() == BacktraceStatus::Captured {
            tracing::error!("thread '{name}' {info}\n{backtrace}");
        } else {
            tracing::error!("thread '{name}' {info}");
        }
    }));
}

#[cfg(target_os = "ios")]
mod ios {
    use super::capped::CappedLog;
    use mvp_core::downloads::redact::scrub_log_line;
    use oslog::{Level as OsLevel, OsLog};
    use std::io::{self, Write};
    use tracing::{Level, Metadata};
    use tracing_subscriber::fmt::MakeWriter;

    /// Sends each formatted line to os_log and, if it could be opened, the log
    /// file. The `oslog` crate logs with `%{public}s`, so Console shows the
    /// text without a logging profile. That's only safe because each line is
    /// scrubbed first.
    pub struct Sink {
        system: OsLog,
        file: Option<CappedLog>,
    }

    impl Sink {
        pub fn new(subsystem: &str, category: &str, file: Option<CappedLog>) -> Self {
            Self {
                system: OsLog::new(subsystem, category),
                file,
            }
        }

        fn line(&self, level: Level) -> Line<'_> {
            Line {
                sink: self,
                level,
                buf: Vec::new(),
            }
        }
    }

    impl<'a> MakeWriter<'a> for Sink {
        type Writer = Line<'a>;

        fn make_writer(&'a self) -> Self::Writer {
            self.line(Level::INFO)
        }

        fn make_writer_for(&'a self, meta: &Metadata<'_>) -> Self::Writer {
            self.line(*meta.level())
        }
    }

    /// Collects one event's text and sends it on when dropped.
    pub struct Line<'a> {
        sink: &'a Sink,
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
            let line = scrub_log_line(String::from_utf8_lossy(&self.buf).trim_end());
            self.sink.system.with_level(os_level(self.level), &line);
            if let Some(file) = &self.sink.file {
                let time = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
                file.append(&format!("{time} {line}\n"));
            }
        }
    }

    /// os_log stores default, error and fault lines on the device, so INFO
    /// and up survive, and DEBUG and TRACE lines show up only while Console
    /// is streaming with info and debug messages turned on. Fault is meant for
    /// bugs in the system rather than the app, so ERROR maps to error.
    fn os_level(level: Level) -> OsLevel {
        match level {
            Level::TRACE => OsLevel::Debug,
            Level::DEBUG => OsLevel::Info,
            Level::INFO | Level::WARN => OsLevel::Default,
            Level::ERROR => OsLevel::Error,
        }
    }
}

/// Built for tests on every target, so the rotation can be tested off the
/// device.
#[cfg(any(target_os = "ios", test))]
mod capped {
    use std::fs::{self, File};
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    const CONTINUED: &str = "Continues from app.log.1\n";

    /// `app.log` in a directory of its own. When the next line would take it
    /// past `max_bytes`, it becomes `app.log.1`, replacing an older one, and
    /// a new `app.log` starts. The newest lines always survive, since those
    /// are the ones that explain a crash.
    pub struct CappedLog {
        path: PathBuf,
        older: PathBuf,
        max_bytes: u64,
        state: Mutex<State>,
    }

    struct State {
        file: File,
        written: u64,
    }

    impl CappedLog {
        /// Starts a new `app.log` in `dir`. The last run's `app.log` becomes
        /// `app.previous.log`, since that's the one that matters after a
        /// crash. The part of that run that had already moved to `app.log.1`
        /// goes.
        pub fn open(dir: &Path, max_bytes: u64) -> io::Result<Self> {
            fs::create_dir_all(dir)?;
            let path = dir.join("app.log");
            let older = dir.join("app.log.1");
            let _ = fs::rename(&path, dir.join("app.previous.log"));
            let _ = fs::remove_file(&older);
            let file = File::create(&path)?;
            Ok(Self {
                path,
                older,
                max_bytes,
                state: Mutex::new(State { file, written: 0 }),
            })
        }

        /// Adds `line`, which ends in a newline. A line never gets split
        /// between two files.
        pub fn append(&self, line: &str) {
            let len = line.len() as u64;
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.written + len > self.max_bytes && !self.rotate(&mut state) {
                // Without a new file, drop the line rather than let the old
                // one grow past the cap.
                return;
            }
            if state.file.write_all(line.as_bytes()).is_ok() {
                state.written += len;
            }
        }

        /// Moves `app.log` to `app.log.1` and starts a new `app.log`. Returns
        /// false if the new file couldn't be created.
        fn rotate(&self, state: &mut State) -> bool {
            let _ = fs::rename(&self.path, &self.older);
            let Ok(mut file) = File::create(&self.path) else {
                return false;
            };
            let _ = file.write_all(CONTINUED.as_bytes());
            *state = State {
                file,
                written: CONTINUED.len() as u64,
            };
            true
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn read(dir: &Path, name: &str) -> String {
            fs::read_to_string(dir.join(name)).unwrap_or_default()
        }

        #[test]
        fn open_keeps_the_last_run_and_drops_its_older_part() {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("app.log"), "last run\n").unwrap();
            fs::write(dir.path().join("app.log.1"), "start of last run\n").unwrap();

            let log = CappedLog::open(dir.path(), 1024).unwrap();
            log.append("this run\n");

            assert_eq!(read(dir.path(), "app.previous.log"), "last run\n");
            assert!(!dir.path().join("app.log.1").exists());
            assert_eq!(read(dir.path(), "app.log"), "this run\n");
        }

        #[test]
        fn rotates_before_a_line_would_pass_the_cap() {
            let dir = tempfile::tempdir().unwrap();
            let line = |n: u32| format!("line {n:02} {}\n", "x".repeat(10));
            let max_bytes = 2 * line(0).len() as u64 + CONTINUED.len() as u64;
            let log = CappedLog::open(dir.path(), max_bytes).unwrap();

            for n in 1..=7 {
                log.append(&line(n));
            }

            // Lines 1 to 3 fit in the first file, and every later file starts
            // with the note and holds two lines.
            assert_eq!(
                read(dir.path(), "app.log.1"),
                format!("{CONTINUED}{}{}", line(4), line(5))
            );
            assert_eq!(
                read(dir.path(), "app.log"),
                format!("{CONTINUED}{}{}", line(6), line(7))
            );
            for name in ["app.log", "app.log.1"] {
                let size = fs::metadata(dir.path().join(name)).unwrap().len();
                assert!(size <= max_bytes, "{name} is {size} bytes");
            }
        }

        #[test]
        fn drops_lines_when_it_cannot_start_a_new_file() {
            let dir = tempfile::tempdir().unwrap();
            let logs = dir.path().join("Logs");
            let log = CappedLog::open(&logs, 16).unwrap();
            log.append("fits in the cap\n");
            fs::remove_dir_all(&logs).unwrap();

            log.append("needs a new file\n");

            assert!(!logs.exists());
        }
    }
}
