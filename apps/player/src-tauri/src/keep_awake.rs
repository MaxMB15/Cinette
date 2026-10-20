// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Keeps the computer from going to sleep while a recording runs, or while
//! it converts a stream for a TV. It starts the system's own tool for this,
//! which exits by itself when that ffmpeg does. macOS has `caffeinate`, and
//! Linux has `systemd-inhibit`. Where the tool is missing, the work still
//! runs.

use std::process::{Command, Stdio};

/// Why the computer stays awake, which Linux shows the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Recording,
    Casting,
}

impl Reason {
    fn text(self) -> &'static str {
        match self {
            Reason::Recording => "Recording a live channel",
            Reason::Casting => "Converting a stream for a TV",
        }
    }
}

/// The command that keeps the computer awake until the process `pid` exits,
/// or `None` where the app has no way to do that.
fn command(pid: u32, why: Reason) -> Option<(&'static str, Vec<String>)> {
    if cfg!(target_os = "macos") {
        // -i stops idle sleep, and -w ends the hold when `pid` exits.
        Some((
            "/usr/bin/caffeinate",
            vec!["-i".into(), "-w".into(), pid.to_string()],
        ))
    } else if cfg!(target_os = "linux") {
        // The hold lasts while the command after it runs, and `tail --pid`
        // runs until `pid` exits.
        Some((
            "systemd-inhibit",
            vec![
                "--what=idle:sleep".into(),
                "--who=Cinette".into(),
                format!("--why={}", why.text()),
                "--mode=block".into(),
                "tail".into(),
                format!("--pid={pid}"),
                "-f".into(),
                "/dev/null".into(),
            ],
        ))
    } else {
        None
    }
}

/// Keep the computer awake while the process `pid` runs.
pub fn hold_while_running(pid: u32, why: Reason) {
    let Some((program, args)) = command(pid, why) else {
        return;
    };
    let spawned = Command::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match spawned {
        Ok(mut child) => {
            // Wait on it so it doesn't linger as a zombie after it exits.
            let _ = std::thread::Builder::new()
                .name("keep-awake".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
        Err(e) => tracing::warn!("Could not keep the computer awake ({}): {e}", why.text()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn holds_until_the_recording_exits_on_macos() {
        let (program, args) = command(42, Reason::Recording).unwrap();
        assert_eq!(program, "/usr/bin/caffeinate");
        assert_eq!(args, vec!["-i", "-w", "42"]);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn holds_until_the_recording_exits_on_linux() {
        let (program, args) = command(42, Reason::Recording).unwrap();
        assert_eq!(program, "systemd-inhibit");
        assert!(args.contains(&"--pid=42".to_string()));
        assert!(args.contains(&"--mode=block".to_string()));
        assert!(args.contains(&"--why=Recording a live channel".to_string()));
        let (_, args) = command(42, Reason::Casting).unwrap();
        assert!(args.contains(&"--why=Converting a stream for a TV".to_string()));
    }
}
