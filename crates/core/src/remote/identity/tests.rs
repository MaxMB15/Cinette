// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

#[test]
fn base32_matches_rfc_4648() {
    // The test vectors from RFC 4648 section 10, in lowercase and unpadded.
    assert_eq!(base32(b""), "");
    assert_eq!(base32(b"f"), "my");
    assert_eq!(base32(b"fo"), "mzxq");
    assert_eq!(base32(b"foo"), "mzxw6");
    assert_eq!(base32(b"foob"), "mzxw6yq");
    assert_eq!(base32(b"fooba"), "mzxw6ytb");
    assert_eq!(base32(b"foobar"), "mzxw6ytboi");
}

#[test]
fn a_saved_private_key_gives_the_same_key_and_id() {
    let key = DeviceKey::generate();
    let loaded = DeviceKey::from_private(*key.private_bytes());
    assert_eq!(loaded.public_bytes(), key.public_bytes());
    assert_eq!(loaded.device_id(), key.device_id());
}

#[test]
fn the_public_key_is_the_x25519_base_point_multiple() {
    // RFC 7748 section 6.1, Alice's key pair.
    let private = super::super::from_hex::<32>(
        "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
    )
    .unwrap();
    let key = DeviceKey::from_private(private);
    assert_eq!(
        super::super::to_hex(key.public_bytes()),
        "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
    );
}

#[test]
fn new_keys_differ() {
    assert_ne!(
        DeviceKey::generate().device_id(),
        DeviceKey::generate().device_id()
    );
}

#[test]
fn an_id_is_26_base32_digits_of_the_key_hash() {
    let key = DeviceKey::generate();
    let id = key.device_id();
    assert_eq!(id.as_str().len(), 26);
    assert_eq!(DeviceId::parse(id.as_str()), Some(id.clone()));
    let hash = Blake2s256::digest(key.public_bytes());
    assert_eq!(id.as_str(), base32(&hash[..16]));
}

#[test]
fn an_id_matches_only_its_own_key() {
    let a = DeviceKey::generate();
    let b = DeviceKey::generate();
    assert!(a.device_id().matches_key(a.public_bytes()));
    assert!(!a.device_id().matches_key(b.public_bytes()));
}

#[test]
fn parse_refuses_anything_but_an_id() {
    let id = DeviceKey::generate().device_id();
    let text = id.as_str();
    assert_eq!(DeviceId::parse(&text[..25]), None);
    assert_eq!(DeviceId::parse(&format!("{text}a")), None);
    assert_eq!(DeviceId::parse(&text.to_uppercase()), None);
    assert_eq!(DeviceId::parse(&format!("1{}", &text[1..])), None);
    assert_eq!(DeviceId::parse(""), None);
    // A last digit with its padding bits set can't come from 16 bytes.
    assert_eq!(DeviceId::parse(&format!("{}b", &text[..25])), None);
    assert!(DeviceId::parse(&format!("{}a", &text[..25])).is_some());
    assert!(DeviceId::parse(&format!("{}e", &text[..25])).is_some());
}

#[test]
fn an_id_reads_back_from_json_and_refuses_junk() {
    let id = DeviceKey::generate().device_id();
    let json = serde_json::to_string(&id).unwrap();
    assert_eq!(json, format!("\"{id}\""));
    assert_eq!(serde_json::from_str::<DeviceId>(&json).unwrap(), id);
    assert!(serde_json::from_str::<DeviceId>("\"junk\"").is_err());
}

#[test]
fn debug_never_prints_the_private_key() {
    let key = DeviceKey::generate();
    let printed = format!("{key:?}");
    assert!(printed.contains(key.device_id().as_str()));
    assert!(!printed.contains(&super::super::to_hex(key.private_bytes())));
    assert!(!printed.contains(&format!("{:?}", key.private_bytes())));
}
