// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Whether a transfer with another device is under way here, so the app can
//! ask the system to keep it running when it goes to the background. iOS
//! suspends an app soon after it leaves the screen, which would stall a
//! transfer until it expires with nothing written.

use mvp_core::remote::transfer::flow::Progress;
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

/// Asks the system to keep the app running (`true`) or says it no longer
/// needs to (`false`).
pub type KeepRunning = Box<dyn Fn(bool) + Send + Sync>;

/// The transfers under way, by a key each side picks.
pub struct Transfers {
    running: Mutex<HashSet<String>>,
    keep: KeepRunning,
}

impl Transfers {
    pub fn new(keep: KeepRunning) -> Self {
        Self {
            running: Mutex::new(HashSet::new()),
            keep,
        }
    }

    /// For a platform that keeps the app running anyway, or can't be asked.
    // iOS asks, so only its tests use this.
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    pub fn untracked() -> Self {
        Self::new(Box::new(|_| {}))
    }

    fn lock(&self) -> MutexGuard<'_, HashSet<String>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Notes that the transfer `key` is under way or over. The system is
    /// asked when the first one starts and told when the last one ends.
    pub fn set(&self, key: &str, running: bool) {
        let mut set = self.lock();
        let before = !set.is_empty();
        if running {
            set.insert(key.to_owned());
        } else {
            set.remove(key);
        }
        let now = !set.is_empty();
        if now != before {
            (self.keep)(now);
        }
    }
}

/// Whether a transfer that reports `progress` is still under way.
pub fn under_way(progress: &Progress) -> bool {
    !matches!(
        progress,
        Progress::Done(_) | Progress::ProvidersDone(_) | Progress::Failed(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mvp_core::remote::message::ErrorCode;
    use std::sync::Arc;

    fn watched() -> (Transfers, Arc<Mutex<Vec<bool>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let log = asked.clone();
        let transfers = Transfers::new(Box::new(move |on| log.lock().unwrap().push(on)));
        (transfers, asked)
    }

    #[test]
    fn the_first_transfer_asks_and_the_last_one_lets_go() {
        let (transfers, asked) = watched();
        transfers.set("link:1", true);
        transfers.set("in:a", true);
        transfers.set("link:1", true);
        assert_eq!(*asked.lock().unwrap(), [true], "asked once");
        transfers.set("link:1", false);
        assert_eq!(*asked.lock().unwrap(), [true], "one still runs");
        transfers.set("in:a", false);
        assert_eq!(*asked.lock().unwrap(), [true, false]);
    }

    #[test]
    fn ending_one_that_never_ran_changes_nothing() {
        let (transfers, asked) = watched();
        transfers.set("link:9", false);
        assert!(asked.lock().unwrap().is_empty());
    }

    #[test]
    fn untracked_asks_nothing_and_still_counts() {
        let transfers = Transfers::untracked();
        transfers.set("link:1", true);
        transfers.set("link:1", false);
        assert!(transfers.lock().is_empty());
    }

    #[test]
    fn a_transfer_is_under_way_until_it_finishes_or_fails() {
        assert!(under_way(&Progress::Sending { done: 1, total: 3 }));
        assert!(under_way(&Progress::Receiving { received: 2 }));
        assert!(under_way(&Progress::Saving));
        assert!(!under_way(&Progress::Done(Box::default())));
        assert!(!under_way(&Progress::ProvidersDone(Vec::new())));
        assert!(!under_way(&Progress::Failed(ErrorCode::Failed)));
    }
}
