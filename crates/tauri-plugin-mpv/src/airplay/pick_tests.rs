// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn step(pick: &mut Pick, ready: bool, external: bool, at: Instant) -> Step {
    pick.step(ready, external, at)
}

#[test]
fn stays_muted_until_the_video_is_on_a_receiver() {
    let now = Instant::now();
    let mut pick = Pick::default();
    let quiet = Step {
        muted: true,
        pause: false,
        not_picked: false,
    };
    assert_eq!(step(&mut pick, false, false, now), quiet);
    assert_eq!(step(&mut pick, true, false, now), quiet);
    let out = step(&mut pick, true, true, now);
    assert!(!out.muted);
    assert!(!out.pause);
}

#[test]
fn mutes_and_pauses_once_when_the_video_leaves_the_receiver() {
    let now = Instant::now();
    let mut pick = Pick::default();
    step(&mut pick, true, true, now);
    let left = step(&mut pick, true, false, now);
    assert_eq!(
        left,
        Step {
            muted: true,
            pause: true,
            not_picked: false
        }
    );
    // Only the change pauses, so a play while it's gone stays quiet,
    // and never counts as no pick, however long it lasts.
    let later = step(&mut pick, true, false, now + PICK_LIMIT * 2);
    assert_eq!(
        later,
        Step {
            muted: true,
            pause: false,
            not_picked: false
        }
    );
    // Back on the receiver, it's heard there again.
    assert!(!step(&mut pick, true, true, now + PICK_LIMIT * 2).muted);
}

#[test]
fn no_receiver_by_the_limit_after_ready_is_no_pick() {
    let now = Instant::now();
    let mut pick = Pick::default();
    // Opening doesn't count toward the limit.
    assert!(!step(&mut pick, false, false, now + PICK_LIMIT * 3).not_picked);
    let ready = now + PICK_LIMIT * 3;
    step(&mut pick, true, false, ready);
    let just_short = ready + PICK_LIMIT - Duration::from_millis(1);
    assert!(!step(&mut pick, true, false, just_short).not_picked);
    assert!(step(&mut pick, true, false, ready + PICK_LIMIT).not_picked);
}

#[test]
fn a_receiver_in_time_is_a_pick() {
    let now = Instant::now();
    let mut pick = Pick::default();
    step(&mut pick, true, false, now);
    step(&mut pick, true, true, now + Duration::from_secs(1));
    assert!(!step(&mut pick, true, false, now + PICK_LIMIT).not_picked);
}
