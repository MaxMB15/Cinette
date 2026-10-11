// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! HTTP clients shared by the online services, so every request gets the same
//! timeouts and user agent and reuses pooled connections.

use std::sync::OnceLock;
use std::time::Duration;

/// A server that hasn't accepted the connection by now is down or unreachable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Metadata and API calls return small JSON bodies, so anything slower is stuck.
const API_TIMEOUT: Duration = Duration::from_secs(30);

/// XMLTV guides and Xtream catalogues can be tens of megabytes on a slow server,
/// so downloads get no total limit and fail only when the data stops arriving.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

static USER_AGENT: OnceLock<String> = OnceLock::new();

/// Sets the app version that the user agent reports.
///
/// mvp-core's own crate version doesn't follow app releases, so the app should
/// call this at startup with its real version. It only works before the first
/// request, because the clients read the user agent once when they're built.
/// Returns false when it was too late.
pub fn set_app_version(version: &str) -> bool {
    USER_AGENT.set(user_agent_for(version)).is_ok()
}

fn user_agent() -> &'static str {
    USER_AGENT.get_or_init(|| user_agent_for(env!("CARGO_PKG_VERSION")))
}

/// OpenSubtitles asks every app to identify itself by name and version.
fn user_agent_for(version: &str) -> String {
    format!("MaxVideoPlayer/{version}")
}

/// The client for API calls that return small JSON bodies.
///
/// A request that needs longer can raise its own limit with
/// `RequestBuilder::timeout`.
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| build(reqwest::Client::builder().timeout(API_TIMEOUT)))
}

/// The client for large downloads such as EPG guides and Xtream catalogues.
pub fn download_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| build(reqwest::Client::builder().read_timeout(READ_TIMEOUT)))
}

fn build(builder: reqwest::ClientBuilder) -> reqwest::Client {
    builder
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(user_agent())
        .build()
        // Same failure as reqwest::Client::new, which the services used before.
        .expect("HTTP client could not be built, the TLS backend failed to start")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_names_the_app_and_version() {
        assert_eq!(user_agent_for("1.2.3"), "MaxVideoPlayer/1.2.3");
    }

    #[test]
    fn app_version_is_fixed_once_a_client_exists() {
        client();
        assert!(!set_app_version("9.9.9"));
        assert_ne!(user_agent(), "MaxVideoPlayer/9.9.9");
    }
}
