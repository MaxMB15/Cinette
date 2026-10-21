// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::message::MAX_MESSAGE;
use crate::remote::transfer::refs::AccountTag;
use crate::remote::transfer::{ItemKind, Position, Watched};

/// The source's clock when it splits, and this device's when a chunk arrives.
const CLOCK: i64 = 1_760_000_100;

fn item(n: usize) -> Item {
    Item {
        reference: ItemRef {
            tvg_id: Some(format!("channel-{n}.example")),
            ..ItemRef::named(
                ItemKind::Live,
                format!("Channel number {n} with a long name"),
            )
        },
        watched: Some(Watched {
            first_watched_at: 1_700_000_000,
            last_watched_at: 1_760_000_000,
            play_count: 12,
            watched_seconds: 36_000,
        }),
        position: None,
        favorite: n.is_multiple_of(2),
    }
}

fn pin(n: usize) -> Pin {
    Pin {
        account: AccountTag::try_from("ab".repeat(16)).unwrap(),
        content_type: "live".into(),
        group: format!("Group {n}"),
    }
}

fn export(items: usize, pins: usize) -> Export {
    Export {
        items: (0..items).map(item).collect(),
        pins: (0..pins).map(pin).collect(),
        current: Some(ItemRef::named(ItemKind::Movie, "Heat")),
        sent_at: 1_760_000_100,
        ..Export::default()
    }
}

/// An export as the receiver gets it: stamped when it was split and when
/// it arrived.
fn arrived(export: Export) -> Export {
    Export {
        sent_at: CLOCK,
        received_at: CLOCK,
        ..export
    }
}

fn reassemble(chunks: Vec<Chunk>) -> Result<Option<Export>, AssembleError> {
    let mut assembler = Assembler::new();
    let mut result = Ok(None);
    for chunk in chunks {
        let bytes = serde_json::to_vec(&chunk).unwrap().len();
        result = assembler.push(chunk, bytes, CLOCK);
        if result.is_err() {
            break;
        }
    }
    result
}

#[test]
fn a_small_export_is_one_last_chunk() {
    let (chunks, dropped) = split(&export(3, 2), CLOCK);
    assert_eq!(dropped, 0);
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].last);
    assert_eq!(chunks[0].seq, 0);
    assert_eq!(chunks[0].sent_at, Some(1_760_000_100));
}

#[test]
fn an_empty_export_still_sends_one_chunk() {
    let (chunks, _) = split(&Export::default(), CLOCK);
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].last && chunks[0].items.is_empty() && chunks[0].pins.is_empty());
}

#[test]
fn a_big_export_is_split_into_chunks_under_the_limit() {
    let original = export(3000, 900);
    let (chunks, dropped) = split(&original, CLOCK);
    assert_eq!(dropped, 0);
    assert!(chunks.len() > 3, "{} chunks", chunks.len());
    for (i, chunk) in chunks.iter().enumerate() {
        let len = serde_json::to_vec(chunk).unwrap().len();
        assert!(len <= CHUNK_BYTES, "chunk {i} is {len} bytes");
        assert!(len + 200 < MAX_MESSAGE);
        assert_eq!(chunk.seq as usize, i);
        assert_eq!(chunk.last, i == chunks.len() - 1);
        assert_eq!(chunk.sent_at.is_some(), i == 0);
        assert_eq!(chunk.current.is_some(), i == 0);
    }
    // Chunks are filled up: each but the last is at least half full.
    for chunk in &chunks[..chunks.len() - 1] {
        assert!(serde_json::to_vec(chunk).unwrap().len() > CHUNK_BYTES / 2);
    }
    assert_eq!(reassemble(chunks), Ok(Some(arrived(original))));
}

#[test]
fn pins_alone_are_split_too() {
    let original = export(0, 2000);
    let (chunks, _) = split(&original, CLOCK);
    assert!(chunks.len() > 1);
    assert!(chunks
        .iter()
        .all(|c| serde_json::to_vec(c).unwrap().len() <= CHUNK_BYTES));
    assert_eq!(reassemble(chunks), Ok(Some(arrived(original))));
}

#[test]
fn items_and_pins_over_the_limits_are_left_out() {
    let mut original = export(4, 2);
    original.items[1].reference.name = "x".repeat(MAX_NAME_BYTES + 1);
    original.items[2].reference.panel_id = Some("1".repeat(MAX_ID_BYTES + 1));
    original.items[3].position = Some(Position {
        position: f64::NAN,
        duration: 10.0,
        updated_at: 0,
        finished: false,
    });
    original.pins[0].group = "g".repeat(MAX_NAME_BYTES + 1);
    let (chunks, dropped) = split(&original, CLOCK);
    assert_eq!(dropped, 4);
    let back = reassemble(chunks).unwrap().unwrap();
    assert_eq!(back.items, vec![item(0)]);
    assert_eq!(back.pins, vec![pin(1)]);
}

#[test]
fn a_reference_at_the_limits_fits() {
    let r = ItemRef {
        series: Some("s".repeat(MAX_NAME_BYTES)),
        imdb: Some("i".repeat(MAX_ID_BYTES)),
        tvg_id: Some("t".repeat(MAX_ID_BYTES)),
        panel_id: Some("p".repeat(MAX_ID_BYTES)),
        ..ItemRef::named(ItemKind::Episode, "n".repeat(MAX_NAME_BYTES))
    };
    assert!(ref_fits(&r));
    for broken in [
        ItemRef {
            series: Some("s".repeat(MAX_NAME_BYTES + 1)),
            ..r.clone()
        },
        ItemRef {
            imdb: Some("i".repeat(MAX_ID_BYTES + 1)),
            ..r.clone()
        },
        ItemRef {
            tvg_id: Some("t".repeat(MAX_ID_BYTES + 1)),
            ..r.clone()
        },
    ] {
        assert!(!ref_fits(&broken));
    }
    let mut infinite = item(0);
    infinite.position = Some(Position {
        position: 1.0,
        duration: f64::INFINITY,
        updated_at: 0,
        finished: false,
    });
    let (_, dropped) = split(
        &Export {
            items: vec![infinite],
            ..Export::default()
        },
        CLOCK,
    );
    assert_eq!(dropped, 1);
}

#[test]
fn a_current_item_over_the_limits_is_left_out() {
    let mut original = export(1, 0);
    original.current = Some(ItemRef::named(
        ItemKind::Movie,
        "x".repeat(MAX_NAME_BYTES + 1),
    ));
    let (chunks, _) = split(&original, CLOCK);
    assert_eq!(chunks[0].current, None);
}

#[test]
fn the_receiver_drops_what_breaks_the_limits() {
    let mut chunk = split(&export(2, 2), CLOCK).0.remove(0);
    chunk.items[0].reference.name = "x".repeat(MAX_NAME_BYTES + 1);
    chunk.pins[0].content_type = "c".repeat(MAX_ID_BYTES + 1);
    chunk.current = Some(ItemRef::named(
        ItemKind::Movie,
        "x".repeat(MAX_NAME_BYTES + 1),
    ));
    let mut assembler = Assembler::new();
    let export = assembler.push(chunk, 100, CLOCK).unwrap().unwrap();
    assert_eq!(export.items, vec![item(1)]);
    assert_eq!(export.pins, vec![pin(1)]);
    assert_eq!(export.current, None);
    assert_eq!(assembler.dropped, 2);
}

#[test]
fn nothing_comes_out_before_the_last_chunk() {
    let (mut chunks, _) = split(&export(3000, 0), CLOCK);
    chunks.pop();
    assert_eq!(reassemble(chunks), Ok(None));
}

#[test]
fn chunks_out_of_order_or_after_the_last_are_refused() {
    let (chunks, _) = split(&export(3000, 0), CLOCK);
    let mut skipped = chunks.clone();
    skipped.remove(1);
    assert_eq!(reassemble(skipped), Err(AssembleError::OutOfOrder));

    let mut assembler = Assembler::new();
    let only = split(&export(1, 0), CLOCK).0.remove(0);
    assert!(assembler.push(only.clone(), 10, CLOCK).unwrap().is_some());
    assert_eq!(
        assembler.push(only, 10, CLOCK),
        Err(AssembleError::OutOfOrder)
    );

    let mut late_start = Assembler::new();
    assert_eq!(
        late_start.push(chunks[1].clone(), 10, CLOCK),
        Err(AssembleError::OutOfOrder)
    );
}

#[test]
fn a_transfer_over_the_limits_is_refused() {
    let chunk = |items: usize, pins: usize| Chunk {
        seq: 0,
        last: false,
        sent_at: Some(CLOCK),
        current: None,
        dropped: None,
        items: (0..items).map(item).collect(),
        pins: (0..pins).map(pin).collect(),
    };
    assert!(Assembler::new().push(chunk(MAX_ITEMS, 0), 1, CLOCK).is_ok());
    assert_eq!(
        Assembler::new().push(chunk(MAX_ITEMS + 1, 0), 1, CLOCK),
        Err(AssembleError::TooLarge)
    );
    assert!(Assembler::new().push(chunk(0, MAX_PINS), 1, CLOCK).is_ok());
    assert_eq!(
        Assembler::new().push(chunk(0, MAX_PINS + 1), 1, CLOCK),
        Err(AssembleError::TooLarge)
    );
    assert!(Assembler::new()
        .push(chunk(0, 0), MAX_TOTAL_BYTES, CLOCK)
        .is_ok());
    assert_eq!(
        Assembler::new().push(chunk(0, 0), MAX_TOTAL_BYTES + 1, CLOCK),
        Err(AssembleError::TooLarge)
    );

    // The totals count across chunks.
    let mut assembler = Assembler::new();
    assert!(assembler
        .push(chunk(MAX_ITEMS - 1, 0), MAX_TOTAL_BYTES - 1, CLOCK)
        .is_ok());
    let second = Chunk {
        seq: 1,
        ..chunk(1, 0)
    };
    assert_eq!(
        assembler.push(second, 2, CLOCK),
        Err(AssembleError::TooLarge)
    );
}

#[test]
fn a_first_chunk_without_a_clock_is_refused() {
    // Read as 0, it would make every time in it decades ahead.
    let chunk = Chunk {
        seq: 0,
        last: true,
        sent_at: None,
        current: None,
        dropped: None,
        items: vec![],
        pins: vec![],
    };
    assert_eq!(
        Assembler::new().push(chunk, 10, CLOCK),
        Err(AssembleError::NoClock)
    );
}

#[test]
fn the_receiver_learns_how_many_the_source_left_out() {
    let mut original = export(3, 1);
    original.items[0].reference.name = "x".repeat(MAX_NAME_BYTES + 1);
    let (mut chunks, dropped) = split(&original, CLOCK);
    assert_eq!(dropped, 1);
    assert_eq!(chunks[0].dropped, Some(1));
    // And one more this side leaves out.
    chunks[0].items[0].reference.name = "y".repeat(MAX_NAME_BYTES + 1);
    let export = reassemble(chunks).unwrap().unwrap();
    assert_eq!(export.dropped, 2);
    assert_eq!(export.items.len(), 1);
}

#[test]
fn nothing_left_out_says_nothing() {
    let (chunks, _) = split(&export(1, 0), CLOCK);
    assert_eq!(chunks[0].dropped, None);
    assert_eq!(reassemble(chunks).unwrap().unwrap().dropped, 0);
}

#[test]
fn the_clocks_come_from_the_split_and_the_arrival() {
    let mut original = export(1, 0);
    original.sent_at = 5;
    let (chunks, _) = split(&original, 700);
    assert_eq!(chunks[0].sent_at, Some(700));
    let mut assembler = Assembler::new();
    let got = assembler.push(chunks[0].clone(), 10, 900).unwrap().unwrap();
    assert_eq!((got.sent_at, got.received_at), (700, 900));
}

#[test]
fn a_later_chunk_cant_change_the_clock_or_current_item() {
    let first = Chunk {
        seq: 0,
        last: false,
        sent_at: Some(5),
        current: None,
        dropped: None,
        items: vec![],
        pins: vec![],
    };
    let second = Chunk {
        seq: 1,
        last: true,
        sent_at: Some(99),
        current: Some(ItemRef::named(ItemKind::Movie, "Heat")),
        dropped: None,
        items: vec![],
        pins: vec![],
    };
    let mut assembler = Assembler::new();
    assembler.push(first, 10, CLOCK).unwrap();
    let export = assembler.push(second, 10, CLOCK).unwrap().unwrap();
    assert_eq!(export.sent_at, 5);
    assert_eq!(export.current, None);
}

#[test]
fn a_chunk_holds_up_to_48_kib() {
    // About 40 KB of items fit in one chunk.
    let (chunks, _) = split(&export(220, 0), CLOCK);
    let len = serde_json::to_vec(&chunks[0]).unwrap().len();
    assert!(len > 45_000, "{len}");
    assert_eq!(chunks.len(), 1);
}

#[test]
fn a_transfer_takes_up_to_16_mib() {
    let chunk = Chunk {
        seq: 0,
        last: true,
        sent_at: Some(CLOCK),
        current: None,
        dropped: None,
        items: vec![],
        pins: vec![],
    };
    assert!(Assembler::new().push(chunk, 16_000_000, CLOCK).is_ok());
}

#[test]
fn no_chunk_goes_over_the_limit_wherever_the_boundary_falls() {
    // Lengthening the last item a byte at a time puts the end of the items
    // at every distance from the limit, including the few bytes the first
    // pin's list adds.
    let padded = |pad: usize| {
        let mut original = export(230, 1);
        original.items[229]
            .reference
            .name
            .push_str(&"x".repeat(pad));
        split(&original, CLOCK).0
    };
    let base = serde_json::to_vec(&padded(0)[0]).unwrap().len();
    let room = CHUNK_BYTES - base;
    assert!((40..460).contains(&room), "{room}");
    let mut fullest = 0;
    for pad in room - 40..room + 5 {
        for chunk in padded(pad) {
            let len = serde_json::to_vec(&chunk).unwrap().len();
            assert!(len <= CHUNK_BYTES, "pad {pad}: {len}");
            fullest = fullest.max(len);
        }
    }
    // Some chunk came within a few bytes of the limit.
    assert!(fullest > CHUNK_BYTES - 4, "{fullest}");
}

#[test]
fn items_fill_a_chunk_right_up_to_the_limit() {
    // The count runs a little over what's written, such as the first
    // item's comma, which is counted but never written, so a full chunk
    // comes within a couple of bytes of the limit.
    // As many items as leave a few hundred bytes of room in one chunk.
    let one_chunk = |n: usize| {
        serde_json::to_vec(&split(&export(n, 0), CLOCK).0[0])
            .unwrap()
            .len()
    };
    let n = (200..).find(|&n| CHUNK_BYTES - one_chunk(n) < 400).unwrap();
    let padded = |pad: usize| {
        let mut original = export(n, 0);
        original.items[n - 1]
            .reference
            .name
            .push_str(&"x".repeat(pad));
        split(&original, CLOCK).0
    };
    let room = CHUNK_BYTES - one_chunk(n);
    let fullest = (room.saturating_sub(40)..room + 5)
        .flat_map(padded)
        .map(|chunk| serde_json::to_vec(&chunk).unwrap().len())
        .max()
        .unwrap();
    assert!(fullest + 2 >= CHUNK_BYTES, "{fullest}");
    assert!(fullest <= CHUNK_BYTES);
}

#[test]
fn the_limits_before_sending_take_each_one_exactly() {
    let small = || 0;
    assert!(fits(MAX_ITEMS, MAX_PINS, || MAX_TOTAL_BYTES));
    assert!(!fits(MAX_ITEMS + 1, 0, small));
    assert!(!fits(0, MAX_PINS + 1, small));
    assert!(!fits(0, 0, || MAX_TOTAL_BYTES + 1));
    // The size isn't worked out when the counts are already over.
    assert!(!fits(MAX_ITEMS + 1, 0, || unreachable!()));
}

#[test]
fn an_exports_size_counts_each_item_and_pin_with_its_comma() {
    let sent = export(2, 3);
    let expected = sent
        .items
        .iter()
        .map(|i| serde_json::to_vec(i).unwrap().len() + 1)
        .sum::<usize>()
        + sent
            .pins
            .iter()
            .map(|p| serde_json::to_vec(p).unwrap().len() + 1)
            .sum::<usize>();
    assert_eq!(export_bytes(&sent), expected);
    assert!(within_limits(&sent));
    assert!(!within_limits(&export(MAX_ITEMS + 1, 0)));
}
