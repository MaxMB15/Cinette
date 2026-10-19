// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

/// Stands in for the JVM's check when there's nothing to compare.
fn never_asked(_: &i32, _: &i32) -> bool {
    panic!("only_resized asked about a missing surface")
}

#[test]
fn the_same_surface_again_is_a_resize() {
    assert!(only_resized(Some(&1), Some(&1), |a, b| a == b));
}

#[test]
fn a_different_surface_is_not_a_resize() {
    assert!(!only_resized(Some(&1), Some(&2), |a, b| a == b));
}

#[test]
fn a_first_surface_is_not_a_resize() {
    assert!(!only_resized(None, Some(&1), never_asked));
}

#[test]
fn a_destroyed_surface_is_not_a_resize() {
    assert!(!only_resized(Some(&1), None, never_asked));
    assert!(!only_resized(None, None, never_asked));
}

#[test]
fn surface_size_is_width_by_height() {
    assert_eq!(surface_size(1920, 1080), "1920x1080");
}
