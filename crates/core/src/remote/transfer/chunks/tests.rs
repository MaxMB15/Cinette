// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::message::MAX_MESSAGE;
use crate::remote::transfer::refs::AccountTag;
use crate::remote::transfer::{ItemKind, Position, Watched};

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
    }
}

fn reassemble(chunks: Vec<Chunk>) -> Result<Option<Export>, AssembleError> {
    let mut assembler = Assembler::new();
    let mut result = Ok(None);
    for chunk in chunks {
        let bytes = serde_json::to_vec(&chunk).unwrap().len();
        result = assembler.push(chunk, bytes);
        if result.is_err() {
            break;
        }
    }
    result
}

#[test]
fn a_small_export_is_one_last_chunk() {
    let (chunks, dropped) = split(&export(3, 2));
    assert_eq!(dropped, 0);
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].last);
    assert_eq!(chunks[0].seq, 0);
    assert_eq!(chunks[0].sent_at, Some(1_760_000_100));
}

#[test]
fn an_empty_export_still_sends_one_chunk() {
    let (chunks, _) = split(&Export::default());
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].last && chunks[0].items.is_empty() && chunks[0].pins.is_empty());
}

#[test]
fn a_big_export_is_split_into_chunks_under_the_limit() {
    let original = export(3000, 900);
    let (chunks, dropped) = split(&original);
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
    assert_eq!(reassemble(chunks), Ok(Some(original)));
}

#[test]
fn pins_alone_are_split_too() {
    let original = export(0, 2000);
    let (chunks, _) = split(&original);
    assert!(chunks.len() > 1);
    assert!(chunks
        .iter()
        .all(|c| serde_json::to_vec(c).unwrap().len() <= CHUNK_BYTES));
    assert_eq!(reassemble(chunks), Ok(Some(original)));
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
    let (chunks, dropped) = split(&original);
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
    let (_, dropped) = split(&Export {
        items: vec![infinite],
        ..Export::default()
    });
    assert_eq!(dropped, 1);
}

#[test]
fn a_current_item_over_the_limits_is_left_out() {
    let mut original = export(1, 0);
    original.current = Some(ItemRef::named(
        ItemKind::Movie,
        "x".repeat(MAX_NAME_BYTES + 1),
    ));
    let (chunks, _) = split(&original);
    assert_eq!(chunks[0].current, None);
}

#[test]
fn the_receiver_drops_what_breaks_the_limits() {
    let mut chunk = split(&export(2, 2)).0.remove(0);
    chunk.items[0].reference.name = "x".repeat(MAX_NAME_BYTES + 1);
    chunk.pins[0].content_type = "c".repeat(MAX_ID_BYTES + 1);
    chunk.current = Some(ItemRef::named(
        ItemKind::Movie,
        "x".repeat(MAX_NAME_BYTES + 1),
    ));
    let mut assembler = Assembler::new();
    let export = assembler.push(chunk, 100).unwrap().unwrap();
    assert_eq!(export.items, vec![item(1)]);
    assert_eq!(export.pins, vec![pin(1)]);
    assert_eq!(export.current, None);
    assert_eq!(assembler.dropped, 2);
}

#[test]
fn nothing_comes_out_before_the_last_chunk() {
    let (mut chunks, _) = split(&export(3000, 0));
    chunks.pop();
    assert_eq!(reassemble(chunks), Ok(None));
}

#[test]
fn chunks_out_of_order_or_after_the_last_are_refused() {
    let (chunks, _) = split(&export(3000, 0));
    let mut skipped = chunks.clone();
    skipped.remove(1);
    assert_eq!(reassemble(skipped), Err(AssembleError::OutOfOrder));

    let mut assembler = Assembler::new();
    let only = split(&export(1, 0)).0.remove(0);
    assert!(assembler.push(only.clone(), 10).unwrap().is_some());
    assert_eq!(assembler.push(only, 10), Err(AssembleError::OutOfOrder));

    let mut late_start = Assembler::new();
    assert_eq!(
        late_start.push(chunks[1].clone(), 10),
        Err(AssembleError::OutOfOrder)
    );
}

#[test]
fn a_transfer_over_the_limits_is_refused() {
    let chunk = |items: usize, pins: usize| Chunk {
        seq: 0,
        last: false,
        sent_at: None,
        current: None,
        items: (0..items).map(item).collect(),
        pins: (0..pins).map(pin).collect(),
    };
    assert!(Assembler::new().push(chunk(MAX_ITEMS, 0), 1).is_ok());
    assert_eq!(
        Assembler::new().push(chunk(MAX_ITEMS + 1, 0), 1),
        Err(AssembleError::TooLarge)
    );
    assert!(Assembler::new().push(chunk(0, MAX_PINS), 1).is_ok());
    assert_eq!(
        Assembler::new().push(chunk(0, MAX_PINS + 1), 1),
        Err(AssembleError::TooLarge)
    );
    assert!(Assembler::new().push(chunk(0, 0), MAX_TOTAL_BYTES).is_ok());
    assert_eq!(
        Assembler::new().push(chunk(0, 0), MAX_TOTAL_BYTES + 1),
        Err(AssembleError::TooLarge)
    );

    // The totals count across chunks.
    let mut assembler = Assembler::new();
    assert!(assembler
        .push(chunk(MAX_ITEMS - 1, 0), MAX_TOTAL_BYTES - 1)
        .is_ok());
    let second = Chunk {
        seq: 1,
        ..chunk(1, 0)
    };
    assert_eq!(assembler.push(second, 2), Err(AssembleError::TooLarge));
}

#[test]
fn a_first_chunk_without_a_clock_reads_as_zero() {
    let chunk = Chunk {
        seq: 0,
        last: true,
        sent_at: None,
        current: None,
        items: vec![],
        pins: vec![],
    };
    let export = Assembler::new().push(chunk, 10).unwrap().unwrap();
    assert_eq!(export.sent_at, 0);
}

#[test]
fn a_later_chunk_cant_change_the_clock_or_current_item() {
    let first = Chunk {
        seq: 0,
        last: false,
        sent_at: Some(5),
        current: None,
        items: vec![],
        pins: vec![],
    };
    let second = Chunk {
        seq: 1,
        last: true,
        sent_at: Some(99),
        current: Some(ItemRef::named(ItemKind::Movie, "Heat")),
        items: vec![],
        pins: vec![],
    };
    let mut assembler = Assembler::new();
    assembler.push(first, 10).unwrap();
    let export = assembler.push(second, 10).unwrap().unwrap();
    assert_eq!(export.sent_at, 5);
    assert_eq!(export.current, None);
}
