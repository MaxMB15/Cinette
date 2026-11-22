// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

fn step(pick: &mut Pick, ready: bool, external: bool, at: Instant) -> Step {
    pick.step(ready, external, at)
}

#[test]
fn stays_muted_until_the_video_is_on_a_receiver() {
    let now = Instant::now();
    let mut pick = Pick::loaded(now);
    let quiet = Step {
        muted: true,
        on_receiver: false,
        pause: false,
        not_picked: false,
        ready_after: None,
        reached_after: None,
        changed: false,
    };
    assert_eq!(step(&mut pick, false, false, now), quiet);
    let ready = Step {
        ready_after: Some(Duration::ZERO),
        ..quiet
    };
    assert_eq!(step(&mut pick, true, false, now), ready);
    let out = step(&mut pick, true, true, now);
    assert!(!out.muted);
    assert!(out.on_receiver);
    assert!(!out.pause);
}

#[test]
fn mutes_at_once_and_pauses_once_when_the_video_stays_off_the_receiver() {
    let now = Instant::now();
    let mut pick = Pick::loaded(now);
    step(&mut pick, true, true, now);
    let left = now + Duration::from_secs(60);
    let quiet = Step {
        muted: true,
        on_receiver: true,
        pause: false,
        not_picked: false,
        ready_after: None,
        reached_after: None,
        changed: true,
    };
    assert_eq!(step(&mut pick, true, false, left), quiet);
    // It still counts as there, and the grace runs from when it left.
    let just_short = left + LEAVE_GRACE - Duration::from_millis(1);
    assert_eq!(
        step(&mut pick, true, false, just_short),
        Step {
            changed: false,
            ..quiet
        }
    );
    let gone = Step {
        on_receiver: false,
        pause: true,
        changed: false,
        ..quiet
    };
    assert_eq!(step(&mut pick, true, false, left + LEAVE_GRACE), gone);
    // Only the turn to gone pauses, so a play while it's gone stays quiet,
    // and never counts as no pick, however long it lasts.
    assert_eq!(
        step(&mut pick, true, false, left + PICK_LIMIT * 2),
        Step {
            pause: false,
            ..gone
        }
    );
    // Back on the receiver, it's heard there again.
    let back = step(&mut pick, true, true, left + PICK_LIMIT * 2);
    assert!(!back.muted);
    assert!(back.on_receiver);
}

#[test]
fn the_video_back_on_the_receiver_in_time_never_counts_as_gone() {
    let now = Instant::now();
    let mut pick = Pick::loaded(now);
    step(&mut pick, true, true, now);
    let left = now + Duration::from_secs(60);
    step(&mut pick, true, false, left);
    let back = step(&mut pick, true, true, left + Duration::from_secs(1));
    assert!(!back.muted);
    assert!(back.on_receiver);
    // Past the grace from the first time it left, it's still there.
    let later = step(&mut pick, true, true, left + LEAVE_GRACE * 2);
    assert!(later.on_receiver);
    assert!(!later.pause);
    // Leaving again starts a new grace.
    let again = left + LEAVE_GRACE * 3;
    assert!(step(&mut pick, true, false, again).on_receiver);
    let short = again + LEAVE_GRACE - Duration::from_millis(1);
    assert!(!step(&mut pick, true, false, short).pause);
    assert!(step(&mut pick, true, false, again + LEAVE_GRACE).pause);
}

#[test]
fn the_video_counts_as_on_the_receiver_only_once_it_got_there() {
    let now = Instant::now();
    let mut pick = Pick::loaded(now);
    for at in [now, now + LEAVE_GRACE, now + PICK_LIMIT] {
        let out = step(&mut pick, true, false, at);
        assert!(!out.on_receiver);
        assert!(!out.pause);
    }
}

#[test]
fn no_receiver_by_the_limit_after_ready_is_no_pick() {
    let now = Instant::now();
    let mut pick = Pick::loaded(now);
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
    let mut pick = Pick::loaded(now);
    step(&mut pick, true, false, now);
    step(&mut pick, true, true, now + Duration::from_secs(1));
    assert!(!step(&mut pick, true, false, now + PICK_LIMIT).not_picked);
}

#[test]
fn times_the_load_to_ready_and_to_the_receiver_once_each() {
    let loaded = Instant::now();
    let mut pick = Pick::loaded(loaded);
    let at = |ms: u64| loaded + Duration::from_millis(ms);
    let opening = step(&mut pick, false, false, at(300));
    assert_eq!((opening.ready_after, opening.reached_after), (None, None));
    let ready = step(&mut pick, true, false, at(800));
    assert_eq!(ready.ready_after, Some(Duration::from_millis(800)));
    assert_eq!(ready.reached_after, None);
    let there = step(&mut pick, true, true, at(2500));
    assert_eq!(there.ready_after, None);
    assert_eq!(there.reached_after, Some(Duration::from_millis(2500)));
    // Neither again, even after the video leaves and comes back.
    step(&mut pick, true, false, at(3000));
    let back = step(&mut pick, true, true, at(4000));
    assert_eq!((back.ready_after, back.reached_after), (None, None));
    // The limit counts from ready, not from the load.
    let mut slow = Pick::loaded(loaded);
    step(&mut slow, true, false, at(5000));
    assert!(
        !step(
            &mut slow,
            true,
            false,
            at(5000) + PICK_LIMIT - Duration::from_millis(1)
        )
        .not_picked
    );
}

#[test]
fn says_each_time_the_video_goes_to_or_leaves_the_receiver() {
    let now = Instant::now();
    let mut pick = Pick::loaded(now);
    let changes: Vec<bool> = [false, false, true, true, false, false, true]
        .into_iter()
        .map(|external| step(&mut pick, true, external, now).changed)
        .collect();
    assert_eq!(changes, [false, false, true, false, true, false, true]);
}
