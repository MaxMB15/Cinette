// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Mutex locking that survives a poisoned lock.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks `mutex` and takes the guard back if another thread panicked while
/// holding it.
///
/// Use it where the guarded data stays usable after a panic, so one panic
/// doesn't disable the renderer or the idle inhibitor for the rest of the
/// session.
pub(crate) fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn recovers_a_poisoned_mutex() {
        let mutex = Arc::new(Mutex::new(1));
        let held = Arc::clone(&mutex);
        let _ = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        assert!(mutex.is_poisoned());

        *lock_or_recover(&mutex) += 1;
        assert_eq!(*lock_or_recover(&mutex), 2);
    }
}
