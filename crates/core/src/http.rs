// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! HTTP clients shared by the online services, so requests get the same
//! timeouts and reuse pooled connections.

use std::sync::OnceLock;
use std::time::Duration;

/// A server that hasn't accepted the connection by now is down or unreachable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Metadata and API calls return small JSON bodies, so anything slower is stuck.
///
/// It is the total limit on `client()`. A small request on `download_client()`
/// can set it with `RequestBuilder::timeout`.
pub const API_TIMEOUT: Duration = Duration::from_secs(30);

/// XMLTV guides, playlists and Xtream stream lists can be tens of megabytes on
/// a slow server, so downloads get no total limit, only this one on each wait
/// for data.
///
/// The first wait runs from sending the request to the response headers, so it
/// also covers the panel building its reply. Large panels can take minutes to
/// build a full stream list or guide before they send a byte.
const READ_TIMEOUT: Duration = Duration::from_secs(300);

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
    CLIENT.get_or_init(|| {
        build(
            reqwest::Client::builder()
                .timeout(API_TIMEOUT)
                .user_agent(user_agent()),
        )
    })
}

/// The client for IPTV panels and large downloads such as EPG guides,
/// playlists and Xtream stream lists.
///
/// It sends no user agent. Some IPTV panels filter requests by user agent, and
/// these requests have always gone out without one.
pub fn download_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| build(reqwest::Client::builder().read_timeout(READ_TIMEOUT)))
}

/// The scheme, host and port of `url`, for log lines.
///
/// IPTV panels put the login in the path, the query or before the host,
/// depending on the panel, so logs get only the part that can't hold one.
/// The mpv plugin has its own copy in `log_url.rs`, since it doesn't depend
/// on this crate.
pub fn origin_for_log(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return "<unreadable URL>".to_string();
    };
    let scheme = parsed.scheme();
    // Not `Url::origin`, which gives "null" for schemes such as rtmp.
    match (
        parsed.host_str().filter(|host| !host.is_empty()),
        parsed.port(),
    ) {
        (Some(host), Some(port)) => format!("{scheme}://{host}:{port}"),
        (Some(host), None) => format!("{scheme}://{host}"),
        (None, _) => format!("{scheme}:"),
    }
}

fn build(builder: reqwest::ClientBuilder) -> reqwest::Client {
    builder
        .connect_timeout(CONNECT_TIMEOUT)
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

/// Local HTTP servers, so tests can check how a client handles a response
/// without reaching a real service.
///
/// Each server records a request before it replies, so once the client has
/// its response the request is waiting, and `try_recv` or `try_iter` on the
/// receiver won't block. A test that waits with `recv` should use
/// `recv_timeout` instead, so a request that never comes fails the test
/// rather than hanging it.
///
/// Other crates get it from the `test-util` feature, which only their
/// dev-dependencies should turn on.
#[cfg(any(test, feature = "test-util"))]
pub mod test_server {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::time::Duration;

    /// How long a server waits for the rest of a request before dropping the
    /// connection, so a client that stalls can't hold it up.
    const READ_TIMEOUT: Duration = Duration::from_secs(10);

    /// Answers a single request with `status` and `body`, and returns the
    /// server's base URL.
    pub fn serve_once(status: &str, body: impl Into<String>) -> String {
        serve_once_recording(status, body).0
    }

    /// Like [`serve_once`], and also hands back the request the server read,
    /// with its request line, headers and body.
    pub fn serve_once_recording(
        status: &str,
        body: impl Into<String>,
    ) -> (String, mpsc::Receiver<String>) {
        let body: String = body.into();
        serve_in_order(&[(status, &body)])
    }

    /// Like [`serve_once_recording`], with a [`client`] to reach the server.
    /// Returns the base URL, the client and the request the server read.
    pub fn serve_once_with_client(
        status: &str,
        body: impl Into<String>,
    ) -> (String, reqwest::Client, mpsc::Receiver<String>) {
        let (url, requests) = serve_once_recording(status, body);
        (url, client(), requests)
    }

    /// Answers one request with each status and body in turn, and stops after
    /// the last reply. A client that closes or stalls before sending a whole
    /// request gets no reply and doesn't use one up, so wait on the requests
    /// with a timeout. Returns the base URL and the requests the server read,
    /// in order.
    pub fn serve_in_order(replies: &[(&str, &str)]) -> (String, mpsc::Receiver<String>) {
        let replies: Vec<(String, String)> = replies
            .iter()
            .map(|&(status, body)| (status.to_string(), body.to_string()))
            .collect();
        let (listener, url) = bind();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for (status, body) in replies {
                let Some((mut stream, request)) = accept(&listener) else {
                    return;
                };
                let _ = sender.send(request);
                respond(&mut stream, &status, &body);
            }
        });
        (url, receiver)
    }

    /// One reply of [`serve_routes`].
    pub struct Route {
        pattern: String,
        status: String,
        body: String,
    }

    /// A route that answers requests whose request line contains `pattern`,
    /// such as a path or a query parameter, with `status` and `body`.
    pub fn route(pattern: &str, status: &str, body: impl Into<String>) -> Route {
        Route {
            pattern: pattern.to_string(),
            status: status.to_string(),
            body: body.into(),
        }
    }

    /// Answers every request with the first route that matches it, or with
    /// 404 Not Found when none does, for clients that send several requests
    /// in no fixed order. A pattern matches anywhere in the request line, so
    /// `/two` also matches `/twofold`. List the more specific route first.
    /// Returns the base URL and the requests the server read. It runs until
    /// the test process ends.
    pub fn serve_routes(routes: Vec<Route>) -> (String, mpsc::Receiver<String>) {
        let (listener, url) = bind();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            while let Some((mut stream, request)) = accept(&listener) {
                let line = request.lines().next().unwrap_or_default();
                let (status, body) = routes
                    .iter()
                    .find(|route| line.contains(&route.pattern))
                    .map_or(("404 Not Found", ""), |route| {
                        (route.status.as_str(), route.body.as_str())
                    });
                // A test that dropped the receiver still gets its replies.
                let _ = sender.send(request);
                respond(&mut stream, status, body);
            }
        });
        (url, receiver)
    }

    /// A base URL on loopback port 0, which nothing listens on, so a request
    /// to it fails to connect and the error carries the full URL.
    pub fn refused_url() -> String {
        // Binding port 0 asks the system for any free port, so no server can
        // ever be handed port 0 itself. This doesn't bind and drop a
        // listener, since the freed port could go to another test's server
        // first. Linux refuses the connection and macOS turns down the
        // address, both before the request is sent.
        "http://127.0.0.1:0".to_string()
    }

    /// A client that reaches the loopback server even when the machine has a
    /// proxy configured.
    pub fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build a test client")
    }

    /// A password for test logins. Tests pass this wherever a function takes
    /// a password, because CodeQL reads any literal passed to a parameter
    /// named `password` as a hard-coded credential. One made at run time
    /// isn't a literal.
    pub fn password() -> String {
        format!("secret-{}", std::process::id())
    }

    /// Asserts that `secret` shows up in neither the `Display` nor the
    /// `Debug` text of `err`.
    #[track_caller]
    pub fn assert_hides(err: &(impl std::fmt::Debug + std::fmt::Display), secret: &str) {
        assert!(!err.to_string().contains(secret), "{err}");
        assert!(!format!("{err:?}").contains(secret), "{err:?}");
    }

    /// A listener on a free loopback port, and its base URL.
    fn bind() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let addr = listener.local_addr().expect("read the bound address");
        (listener, format!("http://{addr}"))
    }

    /// Waits for a client that sends a whole request, and returns its
    /// connection and what it sent. None once the listener fails.
    fn accept(listener: &TcpListener) -> Option<(TcpStream, String)> {
        loop {
            let (mut stream, _) = listener.accept().ok()?;
            let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
            if let Some(request) = read_request(&mut stream) {
                return Some((stream, request));
            }
        }
    }

    /// Reads the request line and headers, then as many bytes of body as
    /// `Content-Length` gives. All of it has to be read before replying, or
    /// the client may see the connection reset instead of the response.
    /// None when the client closes or stalls first.
    ///
    /// # Panics
    ///
    /// On a chunked body, which the clients under test never send. The panic
    /// names the cause, where a half read request would only show up as a
    /// reset connection.
    fn read_request(stream: &mut TcpStream) -> Option<String> {
        let mut request = Vec::new();
        let mut buf = [0u8; 4096];
        let mut total = None;
        loop {
            if total.is_none()
                && let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n")
            {
                let head = String::from_utf8_lossy(&request[..end]);
                let chunked = header(&head, "transfer-encoding")
                    .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
                assert!(
                    !chunked,
                    "the test server doesn't read chunked request bodies"
                );
                total = Some((end + 4).saturating_add(content_length(&head)));
            }
            if let Some(total) = total.filter(|&total| request.len() >= total) {
                request.truncate(total);
                return Some(String::from_utf8_lossy(&request).into_owned());
            }
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return None,
                Ok(n) => request.extend_from_slice(&buf[..n]),
            }
        }
    }

    /// The value of the header called `name` in a request, matched in any
    /// case. Only the headers are read, not the body after them.
    pub(crate) fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
        request
            .lines()
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.trim().eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
    }

    /// The `Content-Length` in a request's headers, or 0 when there's none.
    fn content_length(head: &str) -> usize {
        header(head, "content-length")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    }

    /// Sends a reply with `status` and `body`, and closes the connection.
    fn respond(stream: &mut TcpStream, status: &str, body: &str) {
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
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
    fn log_lines_get_only_the_server() {
        for url in [
            "http://host.test:8080/get.php?username=U&password=SECRET&type=m3u_plus",
            "http://host.test:8080/playlist/U/SECRET/m3u_plus",
            "http://U:SECRET@host.test:8080/list.m3u",
        ] {
            assert_eq!(origin_for_log(url), "http://host.test:8080", "{url}");
        }
        assert_eq!(origin_for_log("not a url SECRET"), "<unreadable URL>");
    }

    #[test]
    fn log_lines_name_the_server_for_any_scheme() {
        assert_eq!(
            origin_for_log("rtmp://U:SECRET@host.test:1935/live/SECRET"),
            "rtmp://host.test:1935"
        );
        assert_eq!(
            origin_for_log("rtsp://host.test/stream?token=SECRET"),
            "rtsp://host.test"
        );
        assert_eq!(
            origin_for_log("https://host.test:443/SECRET.xml"),
            "https://host.test"
        );
        assert_eq!(
            origin_for_log("http://[2001:db8::1]:8080/U/SECRET"),
            "http://[2001:db8::1]:8080"
        );
        assert_eq!(origin_for_log("file:///Users/U/SECRET.xml"), "file:");
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

    /// Set for a copy of the test binary that runs a single test, so nothing
    /// has read the user agent before that test starts.
    const RUN_ALONE: &str = "MVP_CORE_TEST_RUN_ALONE";

    #[test]
    fn app_version_can_be_set_before_any_client_exists() {
        const NAME: &str = "http::tests::app_version_can_be_set_before_any_client_exists";
        if std::env::var_os(RUN_ALONE).is_some() {
            assert!(set_app_version("7.7.7"));
            assert_eq!(user_agent(), "MaxVideoPlayer/7.7.7");
            assert!(!set_app_version("8.8.8"));
            return;
        }
        // Other tests in this process may have built a client already, so
        // the test runs again in a process of its own.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--test-threads=1"])
            .env(RUN_ALONE, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}{stderr}");
        assert!(stdout.contains("1 passed"), "{stdout}");
    }

    #[tokio::test]
    async fn built_clients_keep_the_builders_settings() {
        let (url, requests) = test_server::serve_once_recording("200 OK", "");
        let client = build(reqwest::Client::builder().no_proxy().user_agent("probe/1"));
        client.get(url).send().await.unwrap();
        let request = requests.try_recv().unwrap();
        assert_eq!(test_server::header(&request, "user-agent"), Some("probe/1"));
    }

    async fn get(url: String) -> (u16, String) {
        let response = test_server::client().get(url).send().await.unwrap();
        (response.status().as_u16(), response.text().await.unwrap())
    }

    #[tokio::test]
    async fn the_test_server_answers_in_order_and_records_each_request() {
        let (url, requests) = test_server::serve_in_order(&[
            ("200 OK", "first"),
            ("500 Internal Server Error", "second"),
        ]);
        assert_eq!(get(format!("{url}/a")).await, (200, "first".into()));
        assert_eq!(get(format!("{url}/b")).await, (500, "second".into()));
        let requests: Vec<_> = requests.try_iter().collect();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /a "));
        assert!(requests[1].starts_with("GET /b "));
    }

    #[tokio::test]
    async fn the_test_server_reads_and_records_the_whole_body() {
        let (url, requests) = test_server::serve_once_recording("200 OK", "done");
        // Larger than one read, so the body arrives in pieces.
        let body = "x".repeat(256 * 1024);
        let response = test_server::client()
            .post(format!("{url}/upload"))
            .body(body.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "done");
        let request = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.starts_with("POST /upload "));
        assert!(request.ends_with(&format!("\r\n\r\n{body}")));
    }

    #[test]
    fn the_test_server_records_only_the_body_content_length_gives() {
        use std::io::{Read, Write};

        let (url, requests) = test_server::serve_once_recording("200 OK", "done");
        let mut stream = std::net::TcpStream::connect(url.trim_start_matches("http://")).unwrap();
        stream
            .write_all(b"POST / HTTP/1.1\r\ncontent-LENGTH: 3\r\n\r\nabcextra")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.ends_with("\r\n\r\ndone"), "{response}");
        let request = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.ends_with("\r\n\r\nabc"), "{request}");
    }

    #[tokio::test]
    async fn the_test_server_routes_by_request_line_and_answers_404_to_the_rest() {
        let (url, _) = test_server::serve_routes(vec![
            test_server::route("action=one", "200 OK", "one"),
            test_server::route("/two", "201 Created", "two"),
        ]);
        let (one, two, other) = tokio::join!(
            get(format!("{url}/api?action=one")),
            get(format!("{url}/two")),
            get(format!("{url}/three")),
        );
        assert_eq!(one, (200, "one".into()));
        assert_eq!(two, (201, "two".into()));
        assert_eq!(other, (404, String::new()));
    }
}
