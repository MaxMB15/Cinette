// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::frame::{CastMessage, FrameError, FrameReader, Payload, MAX_MESSAGE};

fn sample() -> CastMessage {
    CastMessage::text(
        "sender-1",
        "receiver-0",
        "urn:x-cast:com.google.cast.tp.heartbeat",
        r#"{"type":"PING"}"#.into(),
    )
}

#[test]
fn encodes_the_fields_in_protobuf_order() {
    let frame = sample().encode();
    let body = &frame[4..];
    assert_eq!(
        u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize,
        body.len()
    );
    // protocol_version = 0, then source_id "sender-1".
    assert_eq!(&body[..4], &[0x08, 0x00, 0x12, 8]);
    assert_eq!(&body[4..12], b"sender-1");
    // destination_id "receiver-0".
    assert_eq!(&body[12..14], &[0x1a, 10]);
    // payload_type = 0 just before payload_utf8.
    let text = br#"{"type":"PING"}"#;
    let tail = body.len() - text.len() - 2;
    assert_eq!(
        &body[tail - 2..tail + 2],
        &[0x28, 0x00, 0x32, text.len() as u8]
    );
}

#[test]
fn decodes_what_it_encodes() {
    let message = sample();
    let frame = message.encode();
    assert_eq!(CastMessage::decode(&frame[4..]).unwrap(), message);

    let binary = CastMessage {
        payload: Payload::Binary(vec![1, 2, 3]),
        ..sample()
    };
    let frame = binary.encode();
    assert_eq!(CastMessage::decode(&frame[4..]).unwrap(), binary);
}

#[test]
fn long_strings_get_multi_byte_lengths() {
    let text = "x".repeat(300);
    let message = CastMessage::text("s", "d", "n", text.clone());
    let frame = message.encode();
    let decoded = CastMessage::decode(&frame[4..]).unwrap();
    assert_eq!(decoded.payload, Payload::Text(text));
}

#[test]
fn skips_fields_it_doesnt_know() {
    let mut body = sample().encode()[4..].to_vec();
    // Field 8 as a varint, field 9 as 8 bytes, field 10 as bytes, field 11 as 4 bytes.
    body.extend_from_slice(&[0x40, 0x96, 0x01]);
    body.extend_from_slice(&[0x49, 1, 2, 3, 4, 5, 6, 7, 8]);
    body.extend_from_slice(&[0x52, 2, 9, 9]);
    body.extend_from_slice(&[0x5d, 1, 2, 3, 4]);
    assert_eq!(CastMessage::decode(&body).unwrap(), sample());
}

#[test]
fn turns_down_broken_bodies() {
    let body = sample().encode()[4..].to_vec();
    // Cut in the middle of the payload.
    assert_eq!(
        CastMessage::decode(&body[..body.len() - 3]),
        Err(FrameError::Truncated)
    );
    // A group, wire type 3, which Cast never uses.
    assert_eq!(CastMessage::decode(&[0x0b]), Err(FrameError::WireType));
    // A varint that never ends.
    assert_eq!(
        CastMessage::decode(&[0x08, 0xff, 0xff]),
        Err(FrameError::Truncated)
    );
    let mut too_long = vec![0x08];
    too_long.extend([0xff; 11]);
    assert_eq!(CastMessage::decode(&too_long), Err(FrameError::Truncated));
    // Fixed-width fields cut short.
    assert_eq!(
        CastMessage::decode(&[0x49, 1, 2]),
        Err(FrameError::Truncated)
    );
    assert_eq!(CastMessage::decode(&[0x5d, 1]), Err(FrameError::Truncated));
    // Text that isn't UTF-8.
    assert_eq!(CastMessage::decode(&[0x12, 1, 0xff]), Err(FrameError::Utf8));
    // No namespace.
    assert_eq!(
        CastMessage::decode(&[0x12, 1, b's', 0x1a, 1, b'd', 0x32, 0]),
        Err(FrameError::Missing)
    );
    assert_eq!(
        CastMessage::decode(&vec![0; MAX_MESSAGE + 1]),
        Err(FrameError::TooLong)
    );
}

#[test]
fn a_text_message_needs_its_text() {
    let mut body = Vec::new();
    for (field, value) in [(0x12u8, "s"), (0x1a, "d"), (0x22, "n")] {
        body.extend_from_slice(&[field, value.len() as u8]);
        body.extend_from_slice(value.as_bytes());
    }
    assert_eq!(CastMessage::decode(&body), Err(FrameError::Missing));
    // A binary message without its bytes is an empty one.
    body.extend_from_slice(&[0x28, 1]);
    assert_eq!(
        CastMessage::decode(&body).unwrap().payload,
        Payload::Binary(vec![])
    );
}

#[test]
fn the_reader_waits_for_whole_frames() {
    let one = sample().encode();
    let two = CastMessage::text("a", "b", "c", "{}".into()).encode();
    let mut bytes = one.clone();
    bytes.extend_from_slice(&two);

    let mut reader = FrameReader::default();
    assert!(reader.next_message().is_none());
    reader.push(&bytes[..3]);
    assert!(reader.next_message().is_none());
    reader.push(&bytes[3..one.len() + 2]);
    assert_eq!(reader.next_message().unwrap().unwrap(), sample());
    assert!(reader.next_message().is_none());
    reader.push(&bytes[one.len() + 2..]);
    assert_eq!(reader.next_message().unwrap().unwrap().namespace, "c");
    assert!(reader.next_message().is_none());
}

#[test]
fn the_reader_refuses_a_frame_over_the_limit() {
    let mut reader = FrameReader::default();
    reader.push(&((MAX_MESSAGE + 1) as u32).to_be_bytes());
    assert_eq!(reader.next_message(), Some(Err(FrameError::TooLong)));
    assert!(reader.next_message().is_none());

    // A frame of exactly the limit is fine, though this one isn't a message.
    let mut reader = FrameReader::default();
    reader.push(&(MAX_MESSAGE as u32).to_be_bytes());
    reader.push(&[0x08]);
    assert!(reader.next_message().is_none());
}

#[test]
fn debug_leaves_the_payload_out() {
    let message = CastMessage::text("s", "d", "n", "http://user:pass@host/x".into());
    let shown = format!("{message:?}");
    assert!(!shown.contains("pass"), "{shown}");
    assert!(shown.contains("23 bytes of text"), "{shown}");
    let binary = CastMessage {
        payload: Payload::Binary(vec![0; 5]),
        ..message
    };
    assert!(format!("{binary:?}").contains("5 bytes"));
}

#[test]
fn takes_messages_up_to_64_kib() {
    // A body of exactly the limit.
    let empty = CastMessage::text("s", "d", "n", String::new())
        .encode()
        .len()
        - 4;
    // The payload's length takes three bytes instead of one.
    let text = "x".repeat(MAX_MESSAGE - empty - 2);
    let message = CastMessage::text("s", "d", "n", text);
    let frame = message.encode();
    assert_eq!(frame.len() - 4, MAX_MESSAGE);
    assert_eq!(CastMessage::decode(&frame[4..]).unwrap(), message);
    let mut reader = FrameReader::default();
    reader.push(&frame);
    assert_eq!(reader.next_message().unwrap().unwrap(), message);
    assert_eq!(MAX_MESSAGE, 65536);
}

#[test]
fn the_reader_reads_many_frames_from_one_read_and_keeps_the_rest() {
    let frame = sample().encode();
    let mut bytes: Vec<u8> = std::iter::repeat_n(frame.clone(), 1000).flatten().collect();
    bytes.extend_from_slice(&frame[..7]);
    let mut reader = FrameReader::default();
    reader.push(&bytes);
    for _ in 0..1000 {
        assert_eq!(reader.next_message(), Some(Ok(sample())));
    }
    assert_eq!(reader.next_message(), None);
    // The part frame stays for the next read.
    reader.push(&frame[7..]);
    assert_eq!(reader.next_message(), Some(Ok(sample())));
    assert_eq!(reader.next_message(), None);
}

#[test]
fn printing_the_reader_shows_only_how_much_it_holds() {
    let mut reader = FrameReader::default();
    let mut text = sample();
    text.payload = Payload::Text("http://host/live/user/secret/1.m3u8".into());
    let frame = text.encode();
    reader.push(&frame);
    reader.push(&frame[..10]);
    assert_eq!(reader.next_message().map(|m| m.is_ok()), Some(true));
    let printed = format!("{reader:?}");
    assert_eq!(printed, "FrameReader { buffered: 10 }");
}
