// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Captures log lines in tests, so a test can check what was logged and that
//! no login got into it.
//!
//! The app's `test_support.rs` has a copy of [`Logged`], so a fix to one
//! belongs in both.

/// What was logged while a test held [`Logged::start`]'s guard.
#[derive(Clone, Default)]
pub(crate) struct Logged(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl Logged {
    /// Logs everything on this thread until the guard drops. A tokio test
    /// runs its awaits on its own thread, so their logs land here too.
    pub(crate) fn start(&self) -> tracing::subscriber::DefaultGuard {
        // tracing remembers whether each log line is wanted. While this
        // test's dispatcher is the only one alive, tracing asks only the
        // thread that first reaches a line, so a line another test's thread
        // reaches first stays off here too. With a second dispatcher alive
        // for the whole run, tracing asks every dispatcher instead.
        static SECOND: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
        SECOND.get_or_init(|| tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default()));
        let logged = self.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || logged.clone())
            .finish();
        tracing::subscriber::set_default(subscriber)
    }

    /// Everything logged so far.
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl std::io::Write for Logged {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
