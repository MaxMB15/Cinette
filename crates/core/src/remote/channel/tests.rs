// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

#[test]
fn frames_split_however_the_bytes_arrive() {
    let mut bytes = frame(b"hello");
    bytes.extend(frame(b"world!"));
    let mut reader = FrameReader::new();
    let mut got = Vec::new();
    for b in &bytes {
        reader.push(std::slice::from_ref(b));
        while let Some(f) = reader.next_frame().unwrap() {
            got.push(f);
        }
    }
    assert_eq!(got, [b"hello".to_vec(), b"world!".to_vec()]);
}

#[test]
fn a_frame_starts_with_its_big_endian_length() {
    assert_eq!(frame(&[9; 258])[..2], [1, 2]);
}

#[test]
fn an_empty_frame_is_an_error() {
    let mut reader = FrameReader::new();
    reader.push(&[0, 0, 1]);
    assert_eq!(reader.next_frame(), Err(EmptyFrame));
}

#[test]
fn half_a_length_waits_for_more() {
    let mut reader = FrameReader::new();
    reader.push(&[0]);
    assert_eq!(reader.next_frame(), Ok(None));
    reader.push(&[2, b'h']);
    assert_eq!(reader.next_frame(), Ok(None));
    reader.push(b"i");
    assert_eq!(reader.next_frame(), Ok(Some(b"hi".to_vec())));
}
