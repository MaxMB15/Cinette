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

/// Builds an error that carries `url` the way a failed request's error does,
/// without touching the network.
///
/// `url` must have no host, such as `unix:/path?key=value`, because that is
/// what makes reqwest reject the request.
#[cfg(test)]
pub(crate) fn error_with_url(url: &str) -> reqwest::Error {
    reqwest::Client::new()
        .get(url)
        .build()
        .expect_err("a URL without a host is rejected")
}

/// A one-shot local HTTP server, so tests can check how a client handles a
/// response without reaching a real service.
#[cfg(test)]
pub(crate) mod test_server {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Answers a single request with `status` and `body`, and returns the
    /// server's base URL.
    pub(crate) fn serve_once(status: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let addr = listener.local_addr().expect("read the bound address");
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            // The request has to be read before replying, or the client may
            // see the connection reset instead of the response.
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => request.extend_from_slice(&buf[..n]),
                }
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        format!("http://{addr}")
    }

    /// A client that reaches the loopback server even when the machine has a
    /// proxy configured.
    pub(crate) fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build a test client")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_names_the_app_and_version() {
        assert_eq!(user_agent_for("1.2.3"), "MaxVideoPlayer/1.2.3");
    }

    #[test]
    fn test_errors_carry_their_url() {
        let err = error_with_url("unix:/?key=SECRET");
        assert!(err.to_string().contains("SECRET"), "{err}");
        assert!(!err.without_url().to_string().contains("SECRET"));
    }

    #[test]
    fn app_version_is_fixed_once_a_client_exists() {
        client();
        assert!(!set_app_version("9.9.9"));
        assert_ne!(user_agent(), "MaxVideoPlayer/9.9.9");
    }
}
