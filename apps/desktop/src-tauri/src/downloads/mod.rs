// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

pub mod manager;
pub mod retention;
pub mod scheduler;
#[cfg(test)]
pub(crate) mod test_support;

/// The name Tauri knows the bundled ffmpeg by. The Linux packages install it in
/// `/usr/bin`, so it can't be plain `ffmpeg`, which the distribution's own
/// ffmpeg package owns. `tauri.conf.json`, `scripts/fetch-ffmpeg.sh` and
/// `scripts/bundle-libmpv.sh` use the same name. The app starts it from Rust,
/// which capabilities don't govern, so no capability names it.
pub const FFMPEG_SIDECAR: &str = "max-video-player-ffmpeg";

#[cfg(test)]
mod tests {
    use super::FFMPEG_SIDECAR;
    use serde_json::Value;

    /// The sidecar's path as the bundle config gives it.
    fn sidecar_path() -> String {
        format!("binaries/{FFMPEG_SIDECAR}")
    }

    /// The identifier of each permission in the capability file `json`.
    fn permissions(json: &str) -> Vec<String> {
        let capability: Value = serde_json::from_str(json).unwrap();
        capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().or(p["identifier"].as_str()).unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_bundle_ships_the_sidecar_under_its_name() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["externalBin"],
            Value::from(vec![sidecar_path()])
        );
    }

    /// The downloads code doesn't need a shell permission to start ffmpeg. One
    /// would only let the web view run it, with any arguments.
    #[test]
    fn no_capability_lets_the_web_view_run_programs() {
        for json in [
            include_str!("../../capabilities/default.json"),
            include_str!("../../capabilities/desktop.json"),
        ] {
            let shell: Vec<_> = permissions(json)
                .into_iter()
                .filter(|p| p.starts_with("shell:"))
                .collect();
            assert!(shell.is_empty(), "{shell:?}");
        }
    }

    #[test]
    fn the_fetch_script_names_the_binary_for_the_sidecar() {
        let script = include_str!("../../../../../scripts/fetch-ffmpeg.sh");
        let name = format!("SIDECAR={FFMPEG_SIDECAR}");
        assert!(
            script.lines().any(|line| line.trim_end() == name),
            "scripts/fetch-ffmpeg.sh should set {name}"
        );
        assert!(script.contains(r#"DEST="$OUT_DIR/${SIDECAR}-"#));
    }

    #[test]
    fn the_bundle_script_checks_the_sidecars_minimum_macos() {
        let script = include_str!("../../../../../scripts/bundle-libmpv.sh");
        assert!(script.contains(&format!("binaries/{FFMPEG_SIDECAR}-*")));
    }
}
