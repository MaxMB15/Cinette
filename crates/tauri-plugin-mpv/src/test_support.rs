// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Helpers the plugin's tests share.
//!
//! Every mpv a test makes is headless. It has no video or audio output, so
//! tests open no windows and play no sound. The media is generated here, as
//! silent WAV audio and blank Y4M video, so nothing comes from the network or
//! from fixture files. Streams come from a server on the loopback address.

use crate::mpv::MpvState;
use crate::renderer::PlatformRenderer;
use libmpv2::Mpv;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::utils::config::AppDirectoriesOverride;
use tauri::{App, AppHandle, Listener, Manager, State};
use tempfile::TempDir;

/// How long a test waits for mpv or a watcher before it fails. Things
/// usually take well under a second, so this only matters on a slow runner.
const PATIENCE: Duration = Duration::from_secs(20);

/// Polls `check` until it returns a value and returns that value. Fails the
/// test after `PATIENCE`, naming `what` it was waiting for.
pub(crate) fn wait_for<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Polls `check` until it holds. See `wait_for`.
pub(crate) fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
    wait_for(what, || check().then_some(()));
}

/// How far a reported position can be from where a seek or a load put it,
/// in seconds. The null audio output keeps a simulated buffer of 0.2
/// seconds, and mpv takes whatever sits in it off the position.
pub(crate) const POSITION_SLACK: f64 = 0.25;

/// Polls `position` until it reads within `POSITION_SLACK` of `target`.
pub(crate) fn wait_for_position(target: f64, mut position: impl FnMut() -> f64) {
    wait_until(&format!("the position to reach {target}"), || {
        (position() - target).abs() < POSITION_SLACK
    });
}

/// Options for an mpv that shows and plays nothing. It also skips config
/// files, so a developer's own mpv.conf can't change what tests see, and
/// keeps the file open at the end, as the app does.
pub(crate) fn headless_options() -> &'static [(&'static str, &'static str)] {
    static OPTIONS: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    OPTIONS.get_or_init(|| {
        // mpv won't start under a locale that writes numbers differently.
        #[cfg(target_os = "linux")]
        crate::ensure_c_locale();
        let mut options = vec![
            ("vo", "null"),
            ("ao", "null"),
            ("config", "no"),
            ("terminal", "no"),
            ("keep-open", "yes"),
        ];
        // These two only exist in builds with scripting, which the Linux
        // build turns off. Where they exist they keep the bundled scripts
        // off, so ytdl_hook never starts yt-dlp for a loopback URL.
        let probe = new_mpv(&options);
        for name in ["load-scripts", "ytdl"] {
            let key = format!("option-info/{name}/name");
            if probe.get_property::<String>(&key).is_ok() {
                options.push((name, "no"));
            }
        }
        options
    })
}

/// The headless options followed by `extra`.
pub(crate) fn headless<'a>(extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let mut options: Vec<(&'a str, &'a str)> = headless_options().to_vec();
    options.extend_from_slice(extra);
    options
}

/// A headless mpv, with `extra` options on top.
pub(crate) fn player(extra: &[(&str, &str)]) -> Mpv {
    new_mpv(&headless(extra))
}

fn new_mpv(options: &[(&str, &str)]) -> Mpv {
    Mpv::with_initializer(|init| {
        for (key, value) in options {
            init.set_option(key, *value)?;
        }
        Ok(())
    })
    .expect("create a headless mpv")
}

/// Bytes per second of the WAV audio, which is 8 kHz mono 16-bit.
pub(crate) const WAV_BYTES_PER_SEC: usize = 16_000;

/// Length of the WAV header in front of the samples.
pub(crate) const WAV_HEADER_LEN: usize = 44;

/// `seconds` of silent WAV audio.
pub(crate) fn wav(seconds: usize) -> Vec<u8> {
    let data_len = (seconds * WAV_BYTES_PER_SEC) as u32;
    let mut out = Vec::with_capacity(WAV_HEADER_LEN + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&8_000u32.to_le_bytes()); // sample rate
    out.extend_from_slice(&(WAV_BYTES_PER_SEC as u32).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // bytes per frame
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.resize(WAV_HEADER_LEN + data_len as usize, 0);
    out
}

/// `seconds` of blank 16x16 Y4M video at 25 frames a second.
pub(crate) fn y4m(seconds: usize) -> Vec<u8> {
    const SIDE: usize = 16;
    let mut out = b"YUV4MPEG2 W16 H16 F25:1 Ip A1:1 C420jpeg\n".to_vec();
    for _ in 0..seconds * 25 {
        out.extend_from_slice(b"FRAME\n");
        out.resize(out.len() + SIDE * SIDE, 16); // luma
        out.resize(out.len() + SIDE * SIDE / 2, 128); // both chroma planes
    }
    out
}

/// A temporary folder for media files, deleted when it drops.
pub(crate) struct MediaDir(TempDir);

impl MediaDir {
    pub(crate) fn new() -> Self {
        Self(tempfile::tempdir().expect("create a folder for test media"))
    }

    /// Writes `bytes` to `name` in the folder and returns the full path.
    pub(crate) fn file(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.0.path().join(name);
        std::fs::write(&path, bytes).expect("write test media");
        path_string(&path)
    }

    /// A path in the folder that doesn't exist.
    pub(crate) fn missing(&self, name: &str) -> String {
        path_string(&self.0.path().join(name))
    }
}

fn path_string(path: &Path) -> String {
    path.to_str().expect("a UTF-8 temp path").to_string()
}

/// How the loopback server answers one request.
pub(crate) enum Reply {
    /// The whole body, or the requested part of it when the request has a
    /// `Range`.
    Whole,
    /// A 200 that promises the whole body but closes after the first `n`
    /// bytes. It leaves out `Accept-Ranges`, so FFmpeg can't resume the read
    /// on its own and mpv sees the stream end early.
    CutAfter(usize),
    /// Like `CutAfter`, but the connection stays open and the rest of the
    /// body follows once the receiver gets a message or its sender drops.
    HoldAfter(usize, Receiver<()>),
    /// An empty reply with this status code.
    Status(u16),
}

/// An HTTP server on the loopback address that serves one body.
///
/// Each new connection takes the next reply from the list it was started
/// with, and gets `Reply::Whole` once the list runs out.
pub(crate) struct Server {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl Server {
    pub(crate) fn start(body: Vec<u8>, replies: Vec<Reply>) -> Self {
        // Port 0 lets the system pick a free port.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let addr = listener.local_addr().expect("read the bound address");
        let body = Arc::new(body);
        let replies = Mutex::new(VecDeque::from(replies));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let accept = {
            let (requests, stop) = (requests.clone(), stop.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let reply = replies.lock().unwrap().pop_front().unwrap_or(Reply::Whole);
                    let (body, requests) = (body.clone(), requests.clone());
                    // A held reply blocks, so each connection gets a thread.
                    std::thread::spawn(move || {
                        // A client that hangs up early is fine.
                        let _ = serve(stream, reply, &body, &requests);
                    });
                }
            })
        };
        Self {
            addr,
            requests,
            stop,
            accept: Some(accept),
        }
    }

    pub(crate) fn url(&self) -> String {
        format!("http://{}/clip.wav", self.addr)
    }

    /// The request lines received so far, in the order they arrived.
    pub(crate) fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Wakes the accept loop so it sees the flag.
        let _ = TcpStream::connect(self.addr);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

fn serve(
    mut stream: TcpStream,
    reply: Reply,
    body: &[u8],
    requests: &Mutex<Vec<String>>,
) -> std::io::Result<()> {
    let head = read_head(&mut stream)?;
    let line = head.lines().next().unwrap_or_default().to_string();
    requests.lock().unwrap().push(line);
    let total = body.len();
    match reply {
        Reply::Whole => match range_start(&head).filter(|start| *start < total) {
            Some(start) => {
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    total - 1,
                    total - start
                );
                stream.write_all(head.as_bytes())?;
                stream.write_all(&body[start..])
            }
            None => {
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
                );
                stream.write_all(head.as_bytes())?;
                stream.write_all(body)
            }
        },
        Reply::CutAfter(n) => {
            stream.write_all(promise_whole(total).as_bytes())?;
            stream.write_all(&body[..n])
        }
        Reply::HoldAfter(n, release) => {
            stream.write_all(promise_whole(total).as_bytes())?;
            stream.write_all(&body[..n])?;
            // A test that fails drops its sender, which ends the wait too.
            let _ = release.recv();
            stream.write_all(&body[n..])
        }
        Reply::Status(code) => {
            let head = format!(
                "HTTP/1.1 {code} Status {code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(head.as_bytes())
        }
    }
}

fn promise_whole(total: usize) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
    )
}

fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buf[..n]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

fn range_start(head: &str) -> Option<usize> {
    head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.eq_ignore_ascii_case("range") {
            return None;
        }
        let start = value.trim().strip_prefix("bytes=")?.split('-').next()?;
        start.parse().ok()
    })
}

/// A mock app with the plugin installed, which manages an `MpvState`.
///
/// Dropping it stops the player, as closing the app does. That ends the
/// watcher and releases the idle inhibit even when the state outlives the
/// app, since a watcher thread holds a handle to it for up to a second.
pub(crate) struct TestApp {
    // Fields drop in order, so the app goes before its folder.
    app: App<MockRuntime>,
    _dir: TempDir,
}

impl Drop for TestApp {
    fn drop(&mut self) {
        self.state().stop();
    }
}

impl TestApp {
    pub(crate) fn new() -> Self {
        let dir = tempfile::tempdir().expect("create a folder for the test app");
        let mut context = mock_context(noop_assets());
        // The mock's identifier is blank, which would put files straight in
        // the user's data folder if the override below were ever dropped.
        context.config_mut().identifier = "com.maxvideoplayer.test".into();
        // Keeps anything that asks for the app's folders out of the real ones.
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Root(dir.path().join("app")));
        let app = mock_builder()
            .plugin(crate::init())
            .build(context)
            .expect("build the mock app");
        Self { app, _dir: dir }
    }

    /// A handle to pass to commands and watchers, which take one by value.
    pub(crate) fn handle(&self) -> AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    /// The state the plugin manages.
    pub(crate) fn state(&self) -> State<'_, MpvState> {
        self.app.state()
    }

    /// Starts recording the events in `names`. Call it before whatever sends
    /// them.
    pub(crate) fn record(&self, names: &[&'static str]) -> Events {
        let events = Events::default();
        for &name in names {
            let events = events.clone();
            self.app.listen_any(name, move |event| {
                let payload = serde_json::from_str(event.payload()).expect("a JSON payload");
                events.0.lock().unwrap().push((name, payload));
            });
        }
        events
    }
}

/// Events the app sent, with their payloads, in the order they went out.
#[derive(Clone, Default)]
pub(crate) struct Events(Arc<Mutex<Vec<(&'static str, serde_json::Value)>>>);

impl Events {
    pub(crate) fn all(&self) -> Vec<(&'static str, serde_json::Value)> {
        self.0.lock().unwrap().clone()
    }

    /// The payloads of the events called `name`.
    pub(crate) fn payloads(&self, name: &str) -> Vec<serde_json::Value> {
        self.all()
            .into_iter()
            .filter(|(n, _)| *n == name)
            .map(|(_, payload)| payload)
            .collect()
    }

    /// Waits for the first event called `name` and returns its payload.
    pub(crate) fn wait_for(&self, name: &str) -> serde_json::Value {
        wait_for(name, || self.payloads(name).into_iter().next())
    }
}

/// What a `FakeRenderer` was asked to do.
#[derive(Default)]
pub(crate) struct RendererLog {
    pub(crate) frames: Vec<[f64; 4]>,
    pub(crate) sizes: Vec<(u32, u32)>,
    pub(crate) visible: Vec<bool>,
    pub(crate) attached: bool,
    pub(crate) dropped: bool,
    pub(crate) first_frame: Option<Box<dyn FnOnce() + Send>>,
}

pub(crate) type SharedLog = Arc<Mutex<RendererLog>>;

/// A renderer that draws nothing and records each call.
pub(crate) struct FakeRenderer {
    log: SharedLog,
    attach_error: Option<String>,
}

impl FakeRenderer {
    /// A renderer whose `attach` works.
    pub(crate) fn working() -> (Box<dyn PlatformRenderer>, SharedLog) {
        Self::build(None)
    }

    /// A renderer whose `attach` fails with `error`.
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    pub(crate) fn failing(error: &str) -> (Box<dyn PlatformRenderer>, SharedLog) {
        Self::build(Some(error.to_string()))
    }

    fn build(attach_error: Option<String>) -> (Box<dyn PlatformRenderer>, SharedLog) {
        let log = SharedLog::default();
        let renderer = Self {
            log: log.clone(),
            attach_error,
        };
        (Box::new(renderer), log)
    }
}

impl PlatformRenderer for FakeRenderer {
    fn attach(&mut self, _mpv: &mut Mpv) -> Result<(), String> {
        if let Some(error) = &self.attach_error {
            return Err(error.clone());
        }
        self.log.lock().unwrap().attached = true;
        Ok(())
    }

    fn resize(&mut self, width: u32, height: u32) {
        self.log.lock().unwrap().sizes.push((width, height));
    }

    fn set_frame(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.log.lock().unwrap().frames.push([x, y, w, h]);
    }

    fn set_visible(&mut self, visible: bool) {
        self.log.lock().unwrap().visible.push(visible);
    }

    fn set_first_frame_callback(&mut self, cb: Box<dyn FnOnce() + Send>) {
        self.log.lock().unwrap().first_frame = Some(cb);
    }

    fn detach(&mut self) {}
}

impl Drop for FakeRenderer {
    fn drop(&mut self) {
        self.log.lock().unwrap().dropped = true;
    }
}

/// Loads `url` into `state` the way `MpvState::load` does, but through
/// `renderer` and with headless options for both the embedded player and
/// the fallback window.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn load_headless(
    state: &MpvState,
    app: &AppHandle<MockRuntime>,
    url: &str,
    start_pos: Option<f64>,
    renderer: Result<Box<dyn PlatformRenderer>, String>,
) -> Result<(), String> {
    let renderer = renderer.map(|r| (r, headless_options().to_vec()));
    state.load_with(true, || {
        state.load_embedded(url, start_pos, app, renderer, || {
            headless_options().to_vec()
        })
    })
}
