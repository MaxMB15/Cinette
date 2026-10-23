// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Checks on the iOS project in `gen/apple` that no build here catches.

const PROJECT: &str = include_str!("../gen/apple/project.yml");
const INFO_PLIST: &str = include_str!("../gen/apple/max-video-player_iOS/Info.plist");
const SHARED_PLIST: &str = include_str!("../Info.plist");
const IOS_PLIST: &str = include_str!("../Info.ios.plist");

/// `tauri ios build` sets each key of the macOS `Info.plist`, then each key of
/// `Info.ios.plist`, on the app's Info.plist, a whole value at a time. So
/// `Info.ios.plist` repeats every key the iOS app needs a different value for,
/// and the checked-in Info.plist is what ships only when a build leaves it as
/// it is.
#[test]
fn a_build_leaves_the_info_plist_as_it_is() {
    let dict = |xml: &str| {
        plist::Value::from_reader_xml(xml.as_bytes())
            .unwrap()
            .into_dictionary()
            .unwrap()
    };
    let shipped = dict(INFO_PLIST);
    let mut built = shipped.clone();
    for layer in [SHARED_PLIST, IOS_PLIST] {
        for (key, value) in dict(layer) {
            built.insert(key, value);
        }
    }
    for (key, value) in &built {
        assert_eq!(shipped.get(key), Some(value), "a build changes {key}");
    }
}

/// iOS refuses DNS-SD for any service type `NSBonjourServices` doesn't list,
/// so both the project and the Info.plist made from it list the one remote
/// control browses and advertises.
#[test]
fn bonjour_services_list_what_the_app_looks_for() {
    let service = mvp_core::remote::target::SERVICE_TYPE;
    assert!(
        PROJECT.contains(&format!("        NSBonjourServices:\n          - {service}\n")),
        "project.yml should list {service}"
    );
    assert!(
        INFO_PLIST.contains(&format!(
            "\t<key>NSBonjourServices</key>\n\t<array>\n\t\t<string>{service}</string>\n"
        )),
        "Info.plist should list {service}"
    );
}

/// iOS shows this when it asks about the local network, which it does when
/// remote control first starts. App Review reads it, so it says what the app
/// does there now: reach IPTV servers, and find and be found by other
/// Cinette devices. Cast and AirPlay don't need it on iOS yet.
#[test]
fn the_local_network_text_says_what_the_app_does() {
    let text = "Cinette uses your local network to reach IPTV servers on it, and to find other \
                devices running Cinette and let them find this one, so one can control the other.";
    assert!(PROJECT.contains(&format!("        NSLocalNetworkUsageDescription: {text}\n")));
    assert!(INFO_PLIST.contains(&format!(
        "\t<key>NSLocalNetworkUsageDescription</key>\n\t<string>{text}</string>\n"
    )));
}
