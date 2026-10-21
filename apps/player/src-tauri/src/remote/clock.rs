// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Time that keeps counting while the computer sleeps.
//!
//! `std::time::Instant` stops during sleep on macOS, Linux and Android. The
//! remote core measures the 30 s a dropped session may resume in with
//! `Instant`s, so after an hour asleep a session would look seconds old and
//! come back without asking. [`now`] gives an `Instant` that moves on by the time
//! slept, so those deadlines pass as they should.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// The time on a clock that counts sleep, since some fixed point.
fn awake_and_asleep() -> Duration {
    // Linux's and Android's CLOCK_MONOTONIC stops in suspend and
    // CLOCK_BOOTTIME doesn't.
    // macOS's CLOCK_MONOTONIC counts sleep (CLOCK_UPTIME_RAW is the one that
    // stops, and Instant uses it).
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const CLOCK: libc::clockid_t = libc::CLOCK_BOOTTIME;
    #[cfg(target_os = "macos")]
    const CLOCK: libc::clockid_t = libc::CLOCK_MONOTONIC;
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `ts` is a valid timespec to write into, and CLOCK exists on
    // this platform, so the call can't fail.
    unsafe { libc::clock_gettime(CLOCK, &mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

/// Now, as an `Instant` that includes the time slept since the first call.
pub fn now() -> Instant {
    static START: OnceLock<(Instant, Duration)> = OnceLock::new();
    let (instant, clock) = *START.get_or_init(|| (Instant::now(), awake_and_asleep()));
    instant + awake_and_asleep().saturating_sub(clock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_with_real_time_while_awake() {
        let a = now();
        let real = Instant::now();
        std::thread::sleep(Duration::from_millis(30));
        let elapsed = now() - a;
        let real_elapsed = real.elapsed();
        assert!(elapsed >= Duration::from_millis(30), "{elapsed:?}");
        let drift = elapsed.abs_diff(real_elapsed);
        assert!(drift < Duration::from_millis(5), "{drift:?}");
    }

    #[test]
    fn never_goes_backwards() {
        let mut last = now();
        for _ in 0..1000 {
            let next = now();
            assert!(next >= last);
            last = next;
        }
    }
}
