// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Checks on the iOS project in `gen/apple` that no build here catches.

const PROJECT: &str = include_str!("../gen/apple/project.yml");
const INFO_PLIST: &str = include_str!("../gen/apple/max-video-player_iOS/Info.plist");

/// iOS refuses DNS-SD for any service type `NSBonjourServices` doesn't list,
/// so both the project and the Info.plist made from it list each one the
/// app browses or advertises.
#[test]
fn bonjour_services_list_what_the_app_looks_for() {
    for service in [
        mvp_core::remote::target::SERVICE_TYPE,
        crate::cast::receivers::SERVICE_TYPE,
    ] {
        assert!(
            PROJECT.contains(&format!("          - {service}\n")),
            "project.yml should list {service}"
        );
        assert!(
            INFO_PLIST.contains(&format!("\t\t<string>{service}</string>\n")),
            "Info.plist should list {service}"
        );
    }
    assert!(PROJECT.contains("        NSBonjourServices:\n"));
    assert!(INFO_PLIST.contains("\t<key>NSBonjourServices</key>\n\t<array>\n"));
}
