// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use super::*;

#[test]
fn defaults_are_discoverable_and_ask() {
    let settings = RemoteSettings::default();
    assert!(settings.discoverable);
    assert_eq!(settings.remote_control, ControlMode::Ask);
    assert_eq!(settings.device_name, None);
    assert_eq!(settings.decide(), Decision::Ask);
    assert!(settings.advertise());
    assert!(settings.available());
}

#[test]
fn missing_fields_in_saved_settings_take_the_defaults() {
    let settings: RemoteSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(settings, RemoteSettings::default());
    let settings: RemoteSettings = serde_json::from_str(r#"{"remoteControl":"never"}"#).unwrap();
    assert!(settings.discoverable);
    assert_eq!(settings.remote_control, ControlMode::Never);
}

#[test]
fn settings_save_in_camel_case() {
    let settings = RemoteSettings {
        discoverable: false,
        remote_control: ControlMode::Always,
        device_name: Some("Den".into()),
    };
    assert_eq!(
        serde_json::to_value(&settings).unwrap(),
        serde_json::json!({"discoverable": false, "remoteControl": "always", "deviceName": "Den"})
    );
}

#[test]
fn each_mode_decides_as_the_spec_says() {
    let with = |remote_control| RemoteSettings {
        remote_control,
        ..RemoteSettings::default()
    };
    assert_eq!(with(ControlMode::Always).decide(), Decision::Accept);
    assert_eq!(with(ControlMode::Ask).decide(), Decision::Ask);
    assert_eq!(
        with(ControlMode::Never).decide(),
        Decision::Reject(CloseReason::NotAllowed)
    );
}

#[test]
fn never_allow_still_advertises_but_as_unavailable() {
    let settings = RemoteSettings {
        remote_control: ControlMode::Never,
        ..RemoteSettings::default()
    };
    assert!(settings.advertise());
    assert!(!settings.available());
}

#[test]
fn not_discoverable_refuses_new_connections_in_every_mode() {
    for remote_control in [ControlMode::Always, ControlMode::Ask, ControlMode::Never] {
        let settings = RemoteSettings {
            discoverable: false,
            remote_control,
            device_name: None,
        };
        assert!(!settings.advertise());
        assert_eq!(
            settings.decide(),
            Decision::Reject(CloseReason::NotDiscoverable)
        );
    }
}

#[test]
fn the_default_name_is_the_device_type() {
    let settings = RemoteSettings::default();
    assert_eq!(settings.name(DeviceType::Mac), "Mac");
    assert_eq!(settings.name(DeviceType::FireTv), "Fire TV");
    assert_eq!(settings.name(DeviceType::Other), "Device");
    let blank = RemoteSettings {
        device_name: Some("  \n ".into()),
        ..RemoteSettings::default()
    };
    assert_eq!(blank.name(DeviceType::Iphone), "iPhone");
    let named = RemoteSettings {
        device_name: Some(" Living room ".into()),
        ..RemoteSettings::default()
    };
    assert_eq!(named.name(DeviceType::AndroidTv), "Living room");
}

#[test]
fn every_device_type_has_its_own_default_name() {
    let names: std::collections::HashSet<_> =
        DeviceType::ALL.iter().map(|&t| default_name(t)).collect();
    assert_eq!(names.len(), DeviceType::ALL.len());
}

#[test]
fn clean_name_drops_what_could_reorder_or_hide_the_text_around_it() {
    // A right-to-left override would turn the rest of a sentence around.
    assert_eq!(clean_name("TV\u{202E}nwod"), Some("TVnwod".into()));
    assert_eq!(clean_name("\u{2066}Den\u{2069}"), Some("Den".into()));
    assert_eq!(clean_name("Den\u{200B}TV\u{FEFF}"), Some("DenTV".into()));
    assert_eq!(
        clean_name("Den\u{2028}TV\u{2029}x"),
        Some("Den TV x".into())
    );
    assert_eq!(clean_name("a\u{AD}b\u{E0041}"), Some("ab".into()));
    assert_eq!(clean_name("\u{200E}\u{200F}"), None);
    // Letters and marks next to those stay.
    assert_eq!(
        clean_name("Café \u{5D0}\u{5D1}"),
        Some("Café \u{5D0}\u{5D1}".into())
    );
    for c in [
        '\u{600}',
        '\u{605}',
        '\u{61C}',
        '\u{6DD}',
        '\u{70F}',
        '\u{890}',
        '\u{8E2}',
        '\u{180E}',
        '\u{2060}',
        '\u{2064}',
        '\u{206F}',
        '\u{FFF9}',
        '\u{FFFB}',
        '\u{110BD}',
        '\u{110CD}',
        '\u{13430}',
        '\u{1343F}',
        '\u{1BCA0}',
        '\u{1BCA3}',
        '\u{1D173}',
        '\u{1D17A}',
        '\u{E0001}',
        '\u{E007F}',
    ] {
        assert_eq!(clean_name(&format!("a{c}b")), Some("ab".into()), "{c:?}");
    }
    // Just outside the ranges.
    for c in [
        '\u{606}',
        '\u{2065}',
        '\u{1D17B}',
        '\u{E0080}',
        '\u{2027}',
        '\u{202F}',
    ] {
        assert_eq!(
            clean_name(&format!("a{c}b")),
            Some(format!("a{c}b")),
            "{c:?}"
        );
    }
}

#[test]
fn clean_name_drops_control_characters_and_cuts_long_names() {
    assert_eq!(clean_name("Den\u{0}TV\n"), Some("Den TV".into()));
    assert_eq!(clean_name(""), None);
    let long = "é".repeat(40);
    let cut = clean_name(&long).unwrap();
    assert!(cut.len() <= MAX_NAME_BYTES);
    assert_eq!(cut, "é".repeat(31));
    assert_eq!(clean_name(&"a".repeat(63)).unwrap().len(), 63);
    // A cut that ends in a space doesn't keep it.
    let spaced = format!("{} b", "a".repeat(62));
    assert_eq!(clean_name(&spaced), Some("a".repeat(62)));
}

#[test]
fn a_name_another_device_gave_is_cleaned_or_its_types() {
    assert_eq!(shown_name(" Den\u{202E} ", DeviceType::Mac), "Den");
    assert_eq!(shown_name("\u{200B}", DeviceType::Mac), "Mac");
}
