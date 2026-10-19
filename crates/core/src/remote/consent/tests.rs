// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::tests::peer;

const CODE: VerificationCode = VerificationCode::for_tests(123456);

fn submit(
    queue: &mut ConsentQueue,
    now: Instant,
    conn: u64,
    peer: &Peer,
) -> Result<RequestId, CloseReason> {
    queue
        .submit(now, ConnId(conn), peer.clone(), CODE, RequestKind::Control)
        .map(|(id, _)| id)
}

#[test]
fn only_allow_grants() {
    let now = Instant::now();
    for (answer, outcome) in [
        (Answer::Allow, Outcome::Granted),
        (Answer::Deny, Outcome::Refused(CloseReason::Denied)),
        (Answer::Dismiss, Outcome::Refused(CloseReason::Denied)),
    ] {
        let mut queue = ConsentQueue::new();
        let id = submit(&mut queue, now, 1, &peer("P")).unwrap();
        assert!(!queue.is_empty());
        assert_eq!(queue.answer(id, answer, now).unwrap().outcome, outcome);
        assert!(queue.is_empty());
    }
}

#[test]
fn requests_expire_thirty_seconds_after_they_arrive() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let id = submit(&mut queue, now, 1, &peer("A")).unwrap();
    submit(&mut queue, now + Duration::from_secs(10), 2, &peer("B")).unwrap();
    assert_eq!(queue.next_deadline(), Some(now + CONSENT_TIMEOUT));
    assert!(queue
        .expire(now + CONSENT_TIMEOUT - Duration::from_millis(1))
        .is_empty());
    let gone = queue.expire(now + CONSENT_TIMEOUT);
    assert_eq!(gone.len(), 1);
    assert_eq!(gone[0].request.id, id);
    assert_eq!(gone[0].outcome, Outcome::Refused(CloseReason::Expired));
    assert_eq!(queue.len(), 1);
    assert!(queue.answer(id, Answer::Allow, now).is_none());
}

#[test]
fn a_late_answer_grants_nothing() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let id = submit(&mut queue, now, 1, &peer("A")).unwrap();
    assert!(queue
        .answer(id, Answer::Allow, now + CONSENT_TIMEOUT)
        .is_none());
}

#[test]
fn the_front_request_is_the_one_shown() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let a = submit(&mut queue, now, 1, &peer("A")).unwrap();
    let b = submit(&mut queue, now, 2, &peer("B")).unwrap();
    assert_eq!(queue.showing().unwrap().id, a);
    // B can be answered from a notification while A is on screen.
    assert_eq!(queue.answer(b, Answer::Deny, now).unwrap().request.id, b);
    assert_eq!(queue.showing().unwrap().id, a);
}

#[test]
fn asking_again_replaces_the_earlier_request() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let p = peer("P");
    submit(&mut queue, now, 1, &p).unwrap();
    let (_, replaced) = queue
        .submit(now, ConnId(2), p.clone(), CODE, RequestKind::Control)
        .unwrap();
    assert_eq!(replaced.len(), 1);
    assert_eq!(replaced[0].request.conn, ConnId(1));
    assert_eq!(
        replaced[0].outcome,
        Outcome::Refused(CloseReason::Cancelled)
    );
    assert_eq!(queue.len(), 1);
}

#[test]
fn a_full_queue_refuses_but_takes_a_repeat_from_a_device_in_it() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let peers: Vec<_> = (0..MAX_WAITING).map(|i| peer(&format!("P{i}"))).collect();
    for (i, p) in peers.iter().enumerate() {
        submit(&mut queue, now, i as u64, p).unwrap();
    }
    assert_eq!(
        submit(&mut queue, now, 99, &peer("X")),
        Err(CloseReason::Busy)
    );
    assert!(submit(&mut queue, now, 100, &peers[2]).is_ok());
    assert_eq!(queue.len(), MAX_WAITING);
}

#[test]
fn a_denied_device_waits_out_the_cooldown_but_a_dismissed_one_doesnt() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let denied = peer("D");
    let dismissed = peer("X");
    let first = submit(&mut queue, now, 1, &denied).unwrap();
    let second = submit(&mut queue, now, 2, &dismissed).unwrap();
    queue.answer(first, Answer::Deny, now);
    queue.answer(second, Answer::Dismiss, now);
    let after_backoff = now + DENIAL_BACKOFF;
    assert_eq!(
        submit(&mut queue, after_backoff, 3, &denied),
        Err(CloseReason::Denied)
    );
    assert!(submit(&mut queue, after_backoff, 4, &dismissed).is_ok());
    queue.withdraw(ConnId(4)).unwrap();
    let later = now + DENIAL_COOLDOWN;
    queue.expire(later);
    assert!(submit(&mut queue, later, 5, &denied).is_ok());
}

#[test]
fn withdraw_and_refuse_all_grant_nothing() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    submit(&mut queue, now, 1, &peer("A")).unwrap();
    submit(&mut queue, now, 2, &peer("B")).unwrap();
    let w = queue.withdraw(ConnId(1)).unwrap();
    assert_eq!(w.outcome, Outcome::Refused(CloseReason::Cancelled));
    assert!(queue.withdraw(ConnId(1)).is_none());
    let all = queue.refuse_all(CloseReason::NotAllowed);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].outcome, Outcome::Refused(CloseReason::NotAllowed));
    assert!(queue.is_empty());
    assert_eq!(queue.next_deadline(), None);
}

#[test]
fn tidying_up_during_the_cooldown_keeps_the_denial() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let denied = peer("D");
    let id = submit(&mut queue, now, 1, &denied).unwrap();
    queue.answer(id, Answer::Deny, now);
    queue.expire(now);
    queue.expire(now + DENIAL_COOLDOWN / 2);
    assert_eq!(
        submit(&mut queue, now + DENIAL_COOLDOWN / 2, 2, &denied),
        Err(CloseReason::Denied)
    );
}

#[test]
fn a_denied_device_may_ask_again_the_moment_the_cooldown_ends() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let denied = peer("D");
    let id = submit(&mut queue, now, 1, &denied).unwrap();
    queue.answer(id, Answer::Deny, now);
    let end = now + DENIAL_COOLDOWN;
    assert_eq!(
        submit(&mut queue, end - Duration::from_millis(1), 2, &denied),
        Err(CloseReason::Denied)
    );
    assert!(submit(&mut queue, end, 3, &denied).is_ok());
}

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

/// Denies a request from a new device at `at`.
fn deny_one(queue: &mut ConsentQueue, at: Instant) {
    let id = submit(queue, at, 1, &peer("D")).unwrap();
    assert!(queue.answer(id, Answer::Deny, at).is_some());
}

/// Checks that new devices are refused until `until` and let in then.
fn quiet_until(queue: &mut ConsentQueue, until: Instant) {
    let just_before = until - Duration::from_millis(1);
    assert_eq!(
        submit(queue, just_before, 2, &peer("N")),
        Err(CloseReason::Busy)
    );
    submit(queue, until, 2, &peer("N")).unwrap();
    queue.withdraw(ConnId(2)).unwrap();
}

#[test]
fn after_a_denial_every_device_waits_longer_each_time() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let mut at = now;
    for wait in [5, 10, 20, 40, 60, 60] {
        deny_one(&mut queue, at);
        quiet_until(&mut queue, at + secs(wait));
        at += secs(wait);
    }
}

#[test]
fn a_request_already_waiting_stays_through_the_backoff() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let waiting = submit(&mut queue, now, 7, &peer("W")).unwrap();
    deny_one(&mut queue, now);
    assert_eq!(queue.showing().unwrap().id, waiting);
    assert_eq!(
        queue.answer(waiting, Answer::Allow, now).unwrap().outcome,
        Outcome::Granted
    );
}

#[test]
fn allowing_a_request_ends_the_backoff() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let waiting = submit(&mut queue, now, 7, &peer("W")).unwrap();
    deny_one(&mut queue, now);
    let at = now + secs(5);
    deny_one(&mut queue, at);
    // The second wait runs to 15 s, but allowing ends it.
    let at = at + secs(1);
    queue.answer(waiting, Answer::Allow, at).unwrap();
    assert!(submit(&mut queue, at, 4, &peer("B")).is_ok());
    queue.withdraw(ConnId(4)).unwrap();
    // And the next denial waits 5 s again.
    deny_one(&mut queue, at);
    quiet_until(&mut queue, at + secs(5));
}

#[test]
fn a_quiet_minute_after_the_wait_starts_the_backoff_again() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    deny_one(&mut queue, now);
    // The first wait ends at 5 s, so a minute later is 65 s.
    let almost = now + secs(65) - Duration::from_millis(1);
    deny_one(&mut queue, almost);
    quiet_until(&mut queue, almost + secs(10));

    let mut queue = ConsentQueue::new();
    deny_one(&mut queue, now);
    let then = now + secs(65);
    deny_one(&mut queue, then);
    quiet_until(&mut queue, then + secs(5));
}

#[test]
fn dismissing_a_request_starts_no_backoff() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let id = submit(&mut queue, now, 1, &peer("A")).unwrap();
    queue.answer(id, Answer::Dismiss, now);
    assert!(submit(&mut queue, now, 2, &peer("B")).is_ok());
}

#[test]
fn a_request_that_runs_out_backs_off_as_a_denial_does() {
    let now = Instant::now();
    let mut queue = ConsentQueue::new();
    let mut at = now;
    // Letting each one run out waits longer each time, as denials do.
    for wait in [5, 10, 20] {
        submit(&mut queue, at, 1, &peer("A")).unwrap();
        at += CONSENT_TIMEOUT;
        assert_eq!(queue.expire(at).len(), 1);
        quiet_until(&mut queue, at + secs(wait));
        at += secs(wait);
    }
    // Tidying up with nothing run out changes nothing.
    queue.expire(at);
    assert!(submit(&mut queue, at, 3, &peer("C")).is_ok());
}
