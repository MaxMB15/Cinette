// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;
use crate::remote::channel::FrameReader;
use crate::remote::message::{decode, PROTOCOL_VERSION};
use crate::remote::tests::hello;

/// The contents of the one frame in `bytes`.
fn unframe(bytes: &[u8]) -> Vec<u8> {
    let mut reader = FrameReader::new();
    reader.push(bytes);
    let frame = reader.next_frame().unwrap().unwrap();
    assert!(reader.next_frame().unwrap().is_none());
    frame
}

struct Run {
    controller: Established,
    target: Established,
}

/// Runs a whole handshake between two new keys.
fn run(
    controller_hello: impl FnOnce(&DeviceKey) -> Hello,
    target_hello: impl FnOnce(&DeviceKey) -> Hello,
) -> Result<Run, Failure> {
    let ck = DeviceKey::generate();
    let tk = DeviceKey::generate();
    let (c, m1) = ControllerHandshake::start(&ck, controller_hello(&ck), tk.device_id())?;
    let t = TargetHandshake::new(&tk, target_hello(&tk))?;
    let (m2, Next::Continue(t)) = t.read(&unframe(&m1))? else {
        panic!("done too soon")
    };
    let (m3, Next::Continue(c)) = c.read(&unframe(&m2.unwrap()))? else {
        panic!("done too soon")
    };
    let (nonce, Next::Continue(t)) = t.read(&unframe(&m3.unwrap()))? else {
        panic!("done too soon")
    };
    let (reveal, Next::Done(controller)) = c.read(&unframe(&nonce.unwrap()))? else {
        panic!("not done")
    };
    let (none, Next::Done(target)) = t.read(&unframe(&reveal.unwrap()))? else {
        panic!("not done")
    };
    assert!(none.is_none());
    Ok(Run {
        controller: *controller,
        target: *target,
    })
}

fn standard(name: &'static str, t: DeviceType) -> impl FnOnce(&DeviceKey) -> Hello {
    move |key| hello(key, name, t)
}

#[test]
fn both_sides_learn_who_the_other_is_and_get_the_same_code() {
    let run = run(
        standard("Phone", DeviceType::Iphone),
        standard("TV", DeviceType::FireTv),
    )
    .unwrap();
    assert_eq!(run.controller.peer.name, "TV");
    assert_eq!(run.controller.peer.device_type, DeviceType::FireTv);
    assert_eq!(run.target.peer.name, "Phone");
    assert_eq!(run.controller.code, run.target.code);
    assert_eq!(run.controller.code.to_string().len(), 6);
    assert_eq!(run.controller.version, PROTOCOL_VERSION);
}

#[test]
fn the_channel_works_both_ways_after_the_handshake() {
    let Run {
        mut controller,
        mut target,
    } = run(
        standard("Phone", DeviceType::Iphone),
        standard("TV", DeviceType::FireTv),
    )
    .unwrap();
    let sealed = controller.channel.seal(&Message::Ping).unwrap();
    let plain = target.channel.open(&unframe(&sealed)).unwrap();
    assert_eq!(decode(&plain).unwrap(), Message::Ping);
    let sealed = target.channel.seal(&Message::Pong).unwrap();
    let plain = controller.channel.open(&unframe(&sealed)).unwrap();
    assert_eq!(decode(&plain).unwrap(), Message::Pong);
}

#[test]
fn a_target_with_another_key_is_refused() {
    let ck = DeviceKey::generate();
    let tk = DeviceKey::generate();
    let expected = DeviceKey::generate().device_id();
    let (c, m1) =
        ControllerHandshake::start(&ck, hello(&ck, "Phone", DeviceType::Iphone), expected).unwrap();
    let t = TargetHandshake::new(&tk, hello(&tk, "TV", DeviceType::FireTv)).unwrap();
    let Ok((m2, _)) = t.read(&unframe(&m1)) else {
        panic!()
    };
    let Err(failure) = c.read(&unframe(&m2.unwrap())) else {
        panic!("accepted the wrong key")
    };
    assert_eq!(failure.reason, CloseReason::IdentityMismatch);
}

#[test]
fn a_hello_that_names_another_id_is_refused() {
    let other = DeviceKey::generate().device_id();
    let liar = move |key: &DeviceKey| Hello {
        id: other,
        ..hello(key, "Phone", DeviceType::Iphone)
    };
    let Err(failure) = run(liar, standard("TV", DeviceType::FireTv)) else {
        panic!()
    };
    assert_eq!(failure.reason, CloseReason::IdentityMismatch);
}

#[test]
fn a_target_hello_that_names_another_id_is_refused() {
    let other = DeviceKey::generate().device_id();
    let liar = move |key: &DeviceKey| Hello {
        id: other,
        ..hello(key, "TV", DeviceType::FireTv)
    };
    let Err(failure) = run(standard("Phone", DeviceType::Iphone), liar) else {
        panic!()
    };
    assert_eq!(failure.reason, CloseReason::IdentityMismatch);
}

#[test]
fn no_shared_version_fails_on_both_sides() {
    let future = |key: &DeviceKey| Hello {
        versions: vec![99],
        ..hello(key, "TV", DeviceType::FireTv)
    };
    let Err(failure) = run(standard("Phone", DeviceType::Iphone), future) else {
        panic!()
    };
    assert_eq!(failure.reason, CloseReason::Version);

    // The target tells the controller why.
    let ck = DeviceKey::generate();
    let tk = DeviceKey::generate();
    let ch = Hello {
        versions: vec![99],
        ..hello(&ck, "Phone", DeviceType::Iphone)
    };
    let (c, m1) = ControllerHandshake::start(&ck, ch, tk.device_id()).unwrap();
    let t = TargetHandshake::new(&tk, hello(&tk, "TV", DeviceType::FireTv)).unwrap();
    let Ok((m2, Next::Continue(t))) = t.read(&unframe(&m1)) else {
        panic!()
    };
    // The controller only speaks 99, so it gives up on reading the target's 1.
    let Err(failure) = c.read(&unframe(&m2.unwrap())) else {
        panic!()
    };
    assert_eq!(failure.reason, CloseReason::Version);
    let _ = t;
}

#[test]
fn the_highest_shared_version_is_used() {
    let both = |key: &DeviceKey| Hello {
        versions: vec![1, 2],
        ..hello(key, "Phone", DeviceType::Iphone)
    };
    let target = |key: &DeviceKey| Hello {
        versions: vec![1, 2, 3],
        ..hello(key, "TV", DeviceType::FireTv)
    };
    let run = run(both, target).unwrap();
    assert_eq!(run.controller.version, 2);
    assert_eq!(run.target.version, 2);
}

#[test]
fn a_blank_or_junk_name_falls_back_to_the_device_type() {
    let blank = |key: &DeviceKey| hello(key, " \u{7} ", DeviceType::Ipad);
    let run = run(blank, standard("TV", DeviceType::FireTv)).unwrap();
    assert_eq!(run.target.peer.name, "iPad");
}

#[test]
fn a_reveal_that_doesnt_match_the_commitment_fails() {
    let ck = DeviceKey::generate();
    let tk = DeviceKey::generate();
    let (c, m1) =
        ControllerHandshake::start(&ck, hello(&ck, "P", DeviceType::Iphone), tk.device_id())
            .unwrap();
    let t = TargetHandshake::new(&tk, hello(&tk, "T", DeviceType::FireTv)).unwrap();
    let Ok((m2, Next::Continue(t))) = t.read(&unframe(&m1)) else {
        panic!()
    };
    let Ok((m3, Next::Continue(c))) = c.read(&unframe(&m2.unwrap())) else {
        panic!()
    };
    let Ok((nonce, Next::Continue(t))) = t.read(&unframe(&m3.unwrap())) else {
        panic!()
    };
    let Ok((_, Next::Done(mut controller))) = c.read(&unframe(&nonce.unwrap())) else {
        panic!()
    };
    // A different nonce, sealed on the real channel.
    let forged = controller
        .channel
        .seal(&Message::Reveal {
            nonce: crate::remote::to_hex(&[7u8; 32]),
        })
        .unwrap();
    let Err(failure) = t.read(&unframe(&forged)) else {
        panic!("took a nonce it wasn't promised")
    };
    assert_eq!(failure.reason, CloseReason::Protocol);
}

#[test]
fn a_changed_handshake_frame_fails() {
    let ck = DeviceKey::generate();
    let tk = DeviceKey::generate();
    let (c, m1) =
        ControllerHandshake::start(&ck, hello(&ck, "P", DeviceType::Iphone), tk.device_id())
            .unwrap();
    let t = TargetHandshake::new(&tk, hello(&tk, "T", DeviceType::FireTv)).unwrap();
    let Ok((m2, _)) = t.read(&unframe(&m1)) else {
        panic!()
    };
    let mut m2 = unframe(&m2.unwrap());
    let last = m2.len() - 1;
    m2[last] ^= 1;
    assert_eq!(c.read(&m2).err().unwrap().reason, CloseReason::Protocol);
}

#[test]
fn garbage_instead_of_a_handshake_fails() {
    let tk = DeviceKey::generate();
    let t = TargetHandshake::new(&tk, hello(&tk, "T", DeviceType::FireTv)).unwrap();
    // The first message is a 32-byte ephemeral key, so 3 bytes can't be one.
    assert!(t.read(b"GET").is_err());
}

#[test]
fn the_code_comes_from_both_nonces() {
    let hash = [1u8; 32];
    let a = code(&hash, &[2; 32], &[3; 32]);
    assert_eq!(a, code(&hash, &[2; 32], &[3; 32]));
    assert_ne!(a, code(&hash, &[2; 32], &[4; 32]));
    assert_ne!(a, code(&hash, &[5; 32], &[3; 32]));
    assert_ne!(a, code(&[9; 32], &[2; 32], &[3; 32]));
    assert!(a.value() < 1_000_000);
}

#[test]
fn a_code_prints_six_digits_and_debug_hides_it() {
    assert_eq!(VerificationCode(42).to_string(), "000042");
    assert_eq!(
        format!("{:?}", VerificationCode(123456)),
        "VerificationCode(..)"
    );
}

#[test]
fn handshake_hash_is_the_state_s_own_hash() {
    let key = DeviceKey::generate();
    let mut state = builder(&key).unwrap().build_initiator().unwrap();
    write(&mut state, &[]).unwrap();
    let hash = handshake_hash(&state);
    assert_eq!(&hash[..], state.get_handshake_hash());
    assert_ne!(hash, [0; 32]);
    assert_ne!(hash, [1; 32]);
}

#[test]
fn the_commitment_is_blake2s_of_its_label_the_hash_and_the_nonce() {
    let expected: [u8; 32] = Blake2s256::new()
        .chain_update(b"cinette-commit")
        .chain_update([1u8; 32])
        .chain_update([2u8; 32])
        .finalize()
        .into();
    assert_eq!(commitment(&[1; 32], &[2; 32]), expected);
    assert_ne!(commitment(&[1; 32], &[3; 32]), expected);
}

#[test]
fn the_code_is_the_first_four_hash_bytes_mod_a_million() {
    let digest = Blake2s256::new()
        .chain_update(b"cinette-code")
        .chain_update([1u8; 32])
        .chain_update([2u8; 32])
        .chain_update([3u8; 32])
        .finalize();
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    assert_eq!(code(&[1; 32], &[2; 32], &[3; 32]).value(), n % 1_000_000);
}

#[test]
fn the_controller_hears_why_the_target_refused_the_version() {
    // Both sides work out the same shared version, so only a controller that
    // offers one list and checks another can get this far.
    let ck = DeviceKey::generate();
    let tk = DeviceKey::generate();
    let offered = Hello {
        versions: vec![99],
        ..hello(&ck, "P", DeviceType::Iphone)
    };
    let (mut c, m1) = ControllerHandshake::start(&ck, offered, tk.device_id()).unwrap();
    c.versions = vec![PROTOCOL_VERSION];
    let t = TargetHandshake::new(&tk, hello(&tk, "T", DeviceType::FireTv)).unwrap();
    let Ok((m2, Next::Continue(t))) = t.read(&unframe(&m1)) else {
        panic!()
    };
    let Ok((m3, Next::Continue(c))) = c.read(&unframe(&m2.unwrap())) else {
        panic!()
    };
    let Err(refusal) = t.read(&unframe(&m3.unwrap())) else {
        panic!("the target took version 99")
    };
    assert_eq!(refusal.reason, CloseReason::Version);
    let Err(failure) = c.read(&unframe(&refusal.send.unwrap())) else {
        panic!()
    };
    assert_eq!(failure.reason, CloseReason::Version);
}
