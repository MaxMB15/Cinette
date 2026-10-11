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
#[cfg(target_os = "ios")]
pub fn init() {
    use tracing_subscriber::prelude::*;

    let file = ios_file::open().map(|log| {
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(move || log.clone())
    });
    tracing_subscriber::registry()
        .with(filter())
        .with(tracing_oslog::OsLogger::new(
            "com.maxvideoplayer.app",
            "rust",
        ))
        .with(file)
        .init();
}

#[cfg(target_os = "ios")]
mod ios_file {
    use std::fs::{self, File};
    use std::io::{self, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    /// Lines past this many bytes in one run are dropped, so a long session
    /// can't fill the device.
    const MAX_BYTES: u64 = 5 * 1024 * 1024;

    /// `Library/Caches/Logs/app.log` in the app's container. iOS doesn't
    /// back up Caches and may clear it when storage runs low, which is fine
    /// for logs.
    pub fn open() -> Option<CappedLog> {
        let dir = PathBuf::from(std::env::var_os("HOME")?).join("Library/Caches/Logs");
        fs::create_dir_all(&dir).ok()?;
        let path = dir.join("app.log");
        // Keep the last run's log, which is the one that matters after a
        // crash.
        let _ = fs::rename(&path, dir.join("app.previous.log"));
        let file = File::create(&path).ok()?;
        Some(CappedLog(Arc::new(Inner {
            file: Mutex::new(file),
            written: AtomicU64::new(0),
        })))
    }

    struct Inner {
        file: Mutex<File>,
        written: AtomicU64,
    }

    #[derive(Clone)]
    pub struct CappedLog(Arc<Inner>);

    impl Write for CappedLog {
        /// `tracing` writes each line in one call, so a line is either kept
        /// whole or dropped.
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let len = buf.len() as u64;
            if self.0.written.fetch_add(len, Ordering::Relaxed) + len <= MAX_BYTES {
                let mut file = self.0.file.lock().unwrap_or_else(|p| p.into_inner());
                file.write_all(buf)?;
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
