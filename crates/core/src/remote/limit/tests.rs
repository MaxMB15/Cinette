// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use std::time::Duration;

/// How many tokens `bucket` hands out at `now`, taking them all.
fn drain(bucket: &mut TokenBucket, now: Instant) -> usize {
    let mut taken = 0;
    while bucket.take(now) {
        taken += 1;
        assert!(taken <= 1000, "the bucket never ran out");
    }
    taken
}

#[test]
fn a_new_bucket_holds_its_burst() {
    let mut bucket = TokenBucket::new(1.0, 5.0);
    assert_eq!(drain(&mut bucket, Instant::now()), 5);
}

#[test]
fn tokens_come_back_at_the_rate() {
    let now = Instant::now();
    let mut bucket = TokenBucket::new(2.0, 5.0);
    drain(&mut bucket, now);
    assert_eq!(drain(&mut bucket, now + Duration::from_millis(250)), 0);
    assert_eq!(drain(&mut bucket, now + Duration::from_millis(500)), 1);
    assert_eq!(drain(&mut bucket, now + Duration::from_millis(1500)), 2);
}

#[test]
fn a_long_wait_refills_no_more_than_the_burst() {
    let now = Instant::now();
    let mut bucket = TokenBucket::new(1.0, 3.0);
    drain(&mut bucket, now);
    assert_eq!(drain(&mut bucket, now + Duration::from_secs(60)), 3);
}

#[test]
fn part_of_a_token_carries_over() {
    let now = Instant::now();
    let mut bucket = TokenBucket::new(1.0, 1.0);
    assert!(bucket.take(now));
    assert!(!bucket.take(now + Duration::from_millis(500)));
    assert!(bucket.take(now + Duration::from_millis(1000)));
}

#[test]
fn a_clock_that_steps_back_adds_nothing() {
    let now = Instant::now() + Duration::from_secs(10);
    let mut bucket = TokenBucket::new(1.0, 2.0);
    drain(&mut bucket, now);
    assert!(!bucket.take(now - Duration::from_secs(5)));
    // The step back moved the count's starting point, so a token comes back
    // a second after the earlier time.
    assert!(bucket.take(now - Duration::from_secs(4)));
}
