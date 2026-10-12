// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

pub mod manager;
pub mod retention;
pub mod scheduler;

/// The name Tauri knows the bundled ffmpeg by. The Linux packages install it in
/// `/usr/bin`, so it can't be plain `ffmpeg`, which the distribution's own
/// ffmpeg package owns. `tauri.conf.json`, the desktop capability and
/// `scripts/fetch-ffmpeg.sh` use the same name.
pub const FFMPEG_SIDECAR: &str = "max-video-player-ffmpeg";

#[cfg(test)]
mod tests {
    use super::FFMPEG_SIDECAR;
    use serde_json::Value;

    /// The sidecar's path as the bundle config and the capability give it.
    fn sidecar_path() -> String {
        format!("binaries/{FFMPEG_SIDECAR}")
    }

    #[test]
    fn the_bundle_ships_the_sidecar_under_its_name() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["externalBin"],
            Value::from(vec![sidecar_path()])
        );
    }

    #[test]
    fn the_desktop_capability_lets_the_app_run_the_sidecar() {
        let capability: Value =
            serde_json::from_str(include_str!("../../capabilities/desktop.json")).unwrap();
        let allowed = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["identifier"] == "shell:allow-execute")
            .expect("the capability allows running a program");
        assert_eq!(allowed["allow"][0]["name"], sidecar_path());
        assert_eq!(allowed["allow"][0]["sidecar"], true);
    }

    #[test]
    fn the_fetch_script_names_the_binary_for_the_sidecar() {
        let script = include_str!("../../../../../scripts/fetch-ffmpeg.sh");
        assert!(
            script.contains(&format!("SIDECAR={FFMPEG_SIDECAR}\n")),
            "scripts/fetch-ffmpeg.sh should set SIDECAR={FFMPEG_SIDECAR}"
        );
    }
}
