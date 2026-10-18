// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::tests::peer;

#[test]
fn a_session_gets_a_random_id_and_is_found_by_its_connection() {
    let now = Instant::now();
    let mut sessions = Sessions::new();
    let a = sessions.open(peer("A"), ConnId(1), now).unwrap();
    let b = sessions.open(peer("B"), ConnId(2), now).unwrap();
    assert_eq!(a.id.len(), 32);
    assert_ne!(a.id, b.id);
    assert_eq!(sessions.by_conn(ConnId(2)).unwrap().id, b.id);
}

#[test]
fn a_device_with_a_session_gets_a_new_one_in_its_place() {
    let now = Instant::now();
    let mut sessions = Sessions::new();
    let p = peer("P");
    let first = sessions.open(p.clone(), ConnId(1), now).unwrap();
    let second = sessions.open(p, ConnId(2), now).unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(sessions.list().len(), 1);
}

#[test]
fn there_are_at_most_eight() {
    let now = Instant::now();
    let mut sessions = Sessions::new();
    for i in 0..MAX_SESSIONS {
        sessions.open(peer("P"), ConnId(i as u64), now).unwrap();
    }
    assert_eq!(
        sessions.open(peer("X"), ConnId(99), now).err(),
        Some(CloseReason::Busy)
    );
}

#[test]
fn only_the_same_device_resumes_and_only_in_time() {
    let now = Instant::now();
    let mut sessions = Sessions::new();
    let p = peer("P");
    let s = sessions.open(p.clone(), ConnId(1), now).unwrap();
    sessions.detach(ConnId(1), now);
    let other = peer("Q");
    assert_eq!(
        sessions.resume(&s.id, &other.id, ConnId(2), now),
        Err(NoSession)
    );
    assert_eq!(
        sessions.resume("nope", &p.id, ConnId(2), now),
        Err(NoSession)
    );
    assert_eq!(
        sessions.resume(&s.id, &p.id, ConnId(2), now + RESUME_GRACE),
        Err(NoSession)
    );
    assert_eq!(
        sessions.resume(
            &s.id,
            &p.id,
            ConnId(2),
            now + RESUME_GRACE - Duration::from_millis(1)
        ),
        Ok(None)
    );
    assert_eq!(sessions.by_conn(ConnId(2)).unwrap().dropped_at, None);
}

#[test]
fn resuming_a_session_still_connected_hands_back_the_old_connection() {
    let now = Instant::now();
    let mut sessions = Sessions::new();
    let p = peer("P");
    let s = sessions.open(p.clone(), ConnId(1), now).unwrap();
    assert_eq!(
        sessions.resume(&s.id, &p.id, ConnId(2), now),
        Ok(Some(ConnId(1)))
    );
}

#[test]
fn dropped_sessions_end_after_the_grace_period() {
    let now = Instant::now();
    let mut sessions = Sessions::new();
    sessions.open(peer("A"), ConnId(1), now).unwrap();
    sessions.open(peer("B"), ConnId(2), now).unwrap();
    sessions.detach(ConnId(1), now);
    assert_eq!(sessions.next_deadline(), Some(now + RESUME_GRACE));
    assert!(sessions
        .expire(now + RESUME_GRACE - Duration::from_millis(1))
        .is_empty());
    let gone = sessions.expire(now + RESUME_GRACE);
    assert_eq!(gone.len(), 1);
    assert_eq!(gone[0].peer.name, "A");
    assert_eq!(sessions.list().len(), 1);
    assert_eq!(sessions.next_deadline(), None);
}

#[test]
fn end_and_end_all() {
    let now = Instant::now();
    let mut sessions = Sessions::new();
    let a = sessions.open(peer("A"), ConnId(1), now).unwrap();
    sessions.open(peer("B"), ConnId(2), now).unwrap();
    assert_eq!(sessions.end(&a.id).unwrap().id, a.id);
    assert!(sessions.end(&a.id).is_none());
    assert_eq!(sessions.end_all().len(), 1);
    assert!(sessions.is_empty());
}
