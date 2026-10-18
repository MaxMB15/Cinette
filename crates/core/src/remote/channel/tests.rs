// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::message::{MAX_FRAME, MAX_MESSAGE};

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

#[test]
fn an_empty_frame_on_its_own_is_an_error_too() {
    let mut reader = FrameReader::new();
    reader.push(&[0, 0]);
    assert_eq!(reader.next_frame(), Err(EmptyFrame));
}

/// Two channels from a finished handshake.
fn pair() -> (Channel, Channel) {
    use crate::remote::handshake::{ControllerHandshake, Next, TargetHandshake};
    use crate::remote::identity::DeviceKey;
    use crate::remote::message::DeviceType;
    use crate::remote::tests::hello;
    let unframe = |bytes: Vec<u8>| bytes[2..].to_vec();
    let ck = DeviceKey::generate();
    let tk = DeviceKey::generate();
    let (c, m1) =
        ControllerHandshake::start(&ck, hello(&ck, "C", DeviceType::Mac), tk.device_id()).unwrap();
    let t = TargetHandshake::new(&tk, hello(&tk, "T", DeviceType::Mac)).unwrap();
    let Ok((Some(m2), Next::Continue(t))) = t.read(&unframe(m1)) else {
        panic!()
    };
    let Ok((Some(m3), Next::Continue(c))) = c.read(&unframe(m2)) else {
        panic!()
    };
    let Ok((Some(nonce), Next::Continue(t))) = t.read(&unframe(m3)) else {
        panic!()
    };
    let Ok((Some(reveal), Next::Done(c))) = c.read(&unframe(nonce)) else {
        panic!()
    };
    let Ok((None, Next::Done(t))) = t.read(&unframe(reveal)) else {
        panic!()
    };
    (c.channel, t.channel)
}

#[test]
fn a_message_of_the_largest_size_fits_and_one_byte_more_doesnt() {
    let (mut a, mut b) = pair();
    let largest = vec![b'x'; MAX_MESSAGE];
    let sealed = a.seal_bytes(&largest).unwrap();
    assert_eq!(sealed.len(), 2 + MAX_FRAME);
    assert_eq!(b.open(&sealed[2..]).unwrap(), largest);
    assert_eq!(
        a.seal_bytes(&vec![b'x'; MAX_MESSAGE + 1]),
        Err(ChannelError::TooLarge)
    );
}
