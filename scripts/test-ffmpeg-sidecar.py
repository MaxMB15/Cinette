#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

"""
Test the ffmpeg that the app runs for downloads and recordings.

`media` makes short test files with a full ffmpeg, one with the libx264,
libx265, libvpx-vp9, libopus and libmp3lame encoders. `test` makes a
throwaway certificate with the openssl command, and serves those files on
127.0.0.1 over HTTP, over HTTPS, from a server that only takes TLS 1.3 and
from one that only takes TLS 1.2. It runs the ffmpeg under test with the app's
own arguments and reads back what it wrote, with the ffmpeg that --reader
names, or else with the ffmpeg under test. No case uses a login, and ffmpeg
runs without the proxy settings. The only thing that may leave this machine is
a DNS query for a name ending in .invalid, which RFC 6761 reserves so that it
never exists.

Usage:
  python3 -I scripts/test-ffmpeg-sidecar.py media FULL_FFMPEG FOLDER
  python3 -I scripts/test-ffmpeg-sidecar.py test FFMPEG FOLDER [--reader FULL_FFMPEG]

.github/workflows/ffmpeg-build.yml runs both for the builds that
scripts/build-ffmpeg.sh makes.
"""
from __future__ import annotations

import argparse
import http.server
import os
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

# What build_ffmpeg_args("URL", "DEST", "mp4") in
# crates/core/src/downloads/ffmpeg.rs and ffmpeg_args("URL", "DEST", 60) in
# crates/core/src/downloads/recording.rs return. A test there fails when these
# lines no longer match.
DOWNLOAD_ARGS = "-hide_banner -loglevel error -reconnect 1 -reconnect_delay_max 30 -i URL -c copy -movflags +faststart -f mp4 -progress pipe:1 -nostats -y DEST"
RECORDING_ARGS = "-hide_banner -loglevel error -reconnect 1 -reconnect_delay_max 30 -rw_timeout 15000000 -reconnect_on_network_error 1 -stats_period 5 -i URL -c copy -f mpegts -progress pipe:1 -nostats -t 60 -y DEST"
# What converting a stream for a Cast receiver runs on Linux, from
# mvp_core::convert::args, copying the video and turning the audio into AAC. The app writes to pipe:1,
# and the test writes to a file in its place.
CONVERT_ARGS = "-hide_banner -nostdin -loglevel error -reconnect 1 -reconnect_delay_max 5 -rw_timeout 15000000 -i URL -map 0:v:0 -map 0:a:0? -sn -dn -c:v copy -c:a aac -b:a 256k -ac 2 -f matroska -live 1 -flush_packets 1 pipe:1"
# The same for AC-3, E-AC-3 and DTS, whose decoders mix down to stereo.
CONVERT_DOWNMIX_ARGS = "-hide_banner -nostdin -loglevel error -reconnect 1 -reconnect_delay_max 5 -rw_timeout 15000000 -downmix stereo -i URL -map 0:v:0 -map 0:a:0? -sn -dn -c:v copy -c:a aac -b:a 256k -ac 2 -f matroska -live 1 -flush_packets 1 pipe:1"

# muxer_for_container in crates/core/src/downloads/ffmpeg.rs.
MUXERS = {
    "mkv": "matroska",
    "mp4": "mp4",
    "mov": "mov",
    "ts": "mpegts",
    "webm": "webm",
    "avi": "avi",
}

# How long the test files and the live stream run, in seconds.
LENGTH = 4
LIVE_LENGTH = 30

CONTENT_TYPES = {
    ".aac": "audio/aac",
    ".avi": "video/x-msvideo",
    ".flac": "audio/flac",
    ".flv": "video/x-flv",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".m4s": "video/iso.segment",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ts": "video/mp2t",
    ".webm": "video/webm",
    ".wmv": "video/x-ms-wmv",
}

# ffmpeg sends HTTP through the proxy that these name, and the cases only
# reach 127.0.0.1.
PROXIES = {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
CHILD_ENV = {name: value for name, value in os.environ.items() if name.lower() not in PROXIES}

# What the build must have for the links the app plays and records, beyond
# what the cases below use.
PROTOCOLS = {"file", "http", "https", "pipe", "rtmp", "rtmps", "rtp", "tcp", "tls", "udp"}
DEMUXERS = {"hls", "live_flv", "rtp", "rtsp", "sdp"}


def make_media(ffmpeg: str, folder: Path) -> None:
    www = folder / "www"
    for path in (www, www / "hls", www / "hls-fmp4", www / "hls-aes", www / "hls-eac3"):
        path.mkdir(parents=True, exist_ok=True)

    def run(*args: object) -> None:
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *map(str, args)],
            check=True,
            stdin=subprocess.DEVNULL,
        )

    def picture(seconds: int) -> list[str]:
        return ["-f", "lavfi", "-i", f"testsrc2=size=320x240:rate=25:duration={seconds}"]

    def sound(seconds: int) -> list[str]:
        return ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]

    av = [*picture(LENGTH), *sound(LENGTH)]
    h264 = ["-c:v", "libx264", "-preset", "veryfast", "-g", "25", "-pix_fmt", "yuv420p"]
    aac = ["-c:a", "aac", "-b:a", "96k"]
    run(*av, *h264, *aac, "-movflags", "+faststart", www / "av.mp4")
    for name in ("av.mov", "av.ts", "av.flv"):
        run(*av, *h264, *aac, www / name)
    subtitles = folder / "subtitles.srt"
    subtitles.write_text(
        "1\n00:00:00,500 --> 00:00:02,000\nOne\n\n2\n00:00:02,500 --> 00:00:03,500\nTwo\n"
    )
    run(*av, "-i", subtitles, "-map", "0", "-map", "1", "-map", "2", *h264, *aac,
        "-c:s", "srt", www / "av.mkv")
    run(*av, "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error",
        "-c:a", "ac3", www / "hevc.ts")
    run(*av, "-c:v", "mpeg2video", "-c:a", "mp2", www / "mpeg2.ts")
    # ffmpeg's own DTS encoder is marked experimental.
    run(*av, *h264, "-c:a", "dca", "-strict", "-2", www / "dts.mkv")
    run(*av, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
        "-c:a", "libopus", www / "vp9.webm")
    run(*av, "-c:v", "mpeg4", "-c:a", "libmp3lame", www / "mpeg4.avi")
    run(*av, "-c:v", "wmv2", "-c:a", "wmav2", www / "av.wmv")
    run(*sound(LENGTH), "-c:a", "libmp3lame", www / "radio.mp3")
    run(*sound(LENGTH), "-c:a", "aac", "-f", "adts", www / "radio.aac")
    run(*sound(LENGTH), "-c:a", "flac", www / "sound.flac")
    # Like the WAV that the app's own download tests serve.
    run(*sound(LENGTH), "-c:a", "pcm_u8", "-ar", "8000", "-ac", "1", www / "sound.wav")
    run(*picture(LIVE_LENGTH), *sound(LIVE_LENGTH), *h264, *aac, www / "live.ts")

    hls = ["-c", "copy", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod"]
    run("-i", www / "av.ts", *hls, "-hls_segment_filename", www / "hls" / "seg%d.ts",
        www / "hls" / "index.m3u8")
    run("-i", www / "av.mp4", *hls, "-hls_segment_type", "fmp4",
        "-hls_segment_filename", www / "hls-fmp4" / "seg%d.m4s", www / "hls-fmp4" / "index.m3u8")
    run(*av, *h264, "-c:a", "eac3", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
        "-hls_segment_filename", www / "hls-eac3" / "seg%d.ts", www / "hls-eac3" / "index.m3u8")
    key = www / "hls-aes" / "key.bin"
    key.write_bytes(os.urandom(16))
    key_info = folder / "key-info.txt"
    key_info.write_text(f"key.bin\n{key}\n")
    run("-i", www / "av.ts", *hls, "-hls_key_info_file", key_info,
        "-hls_segment_filename", www / "hls-aes" / "seg%d.ts", www / "hls-aes" / "index.m3u8")
    (www / "master.m3u8").write_text(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x240\nhls/index.m3u8\n"
    )


def make_certificate(folder: Path) -> None:
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-subj", "/CN=localhost", "-keyout", str(folder / "key.pem"),
         "-out", str(folder / "cert.pem")],
        check=True,
        capture_output=True,
        stdin=subprocess.DEVNULL,
    )


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root: Path, tls: Path | None, tls_version: ssl.TLSVersion | None = None) -> None:
        super().__init__(("127.0.0.1", 0), Handler)
        self.root = root.resolve()
        self.stop = threading.Event()
        self.context = None
        if tls is not None:
            self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            self.context.load_cert_chain(tls / "cert.pem", tls / "key.pem")
            if tls_version is not None:
                self.context.minimum_version = tls_version
                self.context.maximum_version = tls_version
        scheme = "https" if tls is not None else "http"
        self.url = f"{scheme}://127.0.0.1:{self.server_address[1]}"
        threading.Thread(target=self.serve_forever, daemon=True).start()

    def finish_request(self, request, client_address) -> None:
        # The TLS handshake runs on the connection's own thread.
        if self.context is not None:
            try:
                request = self.context.wrap_socket(request, server_side=True)
            except OSError:
                return
        super().finish_request(request, client_address)

    def handle_error(self, request, client_address) -> None:
        pass


class Handler(http.server.BaseHTTPRequestHandler):
    # HTTP/1.1, with a length on everything but a live stream.
    protocol_version = "HTTP/1.1"
    server: Server

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        kind, _, rest = self.path.lstrip("/").partition("/")
        try:
            if kind == "status":
                self.send_status(int(rest))
            elif kind in ("media", "drop"):
                self.send_file(rest, drop=kind == "drop")
            elif kind in ("live", "stall"):
                self.send_live(rest, stall=kind == "stall")
            else:
                self.send_status(404)
        except OSError:
            self.close_connection = True

    def find(self, rest: str) -> Path | None:
        path = (self.server.root / rest).resolve()
        if self.server.root in path.parents and path.is_file():
            return path
        return None

    def close_if_asked(self) -> None:
        # ffmpeg asks for "Connection: close", and real servers such as nginx
        # say so in their answer. Without it, ffmpeg may try to reuse the
        # connection after a seek and find it closed.
        if self.headers.get("Connection", "").lower() == "close":
            self.send_header("Connection", "close")

    def send_status(self, code: int) -> None:
        body = f"{code}\n".encode()
        self.send_response(code)
        self.close_if_asked()
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, rest: str, drop: bool) -> None:
        path = self.find(rest)
        if path is None:
            self.send_status(404)
            return
        data = path.read_bytes()
        start, end = 0, len(data)
        wanted = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        if wanted:
            start = int(wanted[1])
            if wanted[2]:
                end = min(end, int(wanted[2]) + 1)
            if start >= end:
                self.send_status(416)
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end - 1}/{len(data)}")
        else:
            self.send_response(200)
        # An answer for a /drop/ file that starts before the middle stops
        # there and closes the connection, though it didn't say it would.
        # ffmpeg counts that as a drop and reconnects from the middle. After
        # "Connection: close" it would take the early end for the end of the
        # file.
        middle = len(data) // 2
        cut = drop and start < middle < end
        if not cut:
            self.close_if_asked()
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(end - start))
        self.end_headers()
        if cut:
            self.wfile.write(data[start:middle])
            self.close_connection = True
            return
        self.wfile.write(data[start:end])

    def send_live(self, rest: str, stall: bool) -> None:
        path = self.find(rest)
        if path is None:
            self.send_status(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "video/mp2t")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if stall:
            # A few seconds of the stream, and then nothing.
            self.wfile.write(data[: len(data) // 8])
            self.server.stop.wait(120)
            return
        # The first tenth at once, so ffmpeg can read what the stream holds,
        # then the rest as fast as it plays, over and over.
        rate = len(data) / LIVE_LENGTH
        ahead = len(data) // 10
        chunk = 188 * 64
        sent = 0
        started = time.monotonic()
        while not self.server.stop.is_set():
            for offset in range(0, len(data), chunk):
                piece = data[offset : offset + chunk]
                self.wfile.write(piece)
                sent += len(piece)
                wait = (sent - ahead) / rate - (time.monotonic() - started)
                if wait > 0:
                    time.sleep(wait)


@dataclass
class Case:
    name: str
    # A path on the local server, or a whole link.
    path: str
    container: str
    # The codecs of the streams in the file written, for a case that works.
    codecs: list[str] = field(default_factory=list)
    # How long the file written runs, in seconds, when that's known.
    length: float | None = LENGTH
    # A pattern that one of ffmpeg's error lines must match, in lower case,
    # for a case that fails. StreamError::classify in
    # crates/core/src/downloads/recording.rs reads these lines.
    error: str = ""
    recording: bool = False
    # Run CONVERT_ARGS instead of a download's or a recording's, or
    # CONVERT_DOWNMIX_ARGS with downmix.
    converting: bool = False
    downmix: bool = False
    # "http", "https", or "tls13" or "tls12", a server that only takes that
    # TLS version.
    server: str = "http"
    # Write "q" to ffmpeg after this many seconds, as the app does to stop a
    # recording.
    quit_after: float | None = None
    timeout: float = 60


def closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def cases() -> list[Case]:
    av = ["aac", "h264"]
    return [
        # A download keeps the container that its link ends with.
        Case("MP4", "/media/av.mp4", "mp4", av),
        Case("MKV with subtitles", "/media/av.mkv", "mkv", [*av, "subrip"]),
        Case("MPEG-TS", "/media/av.ts", "ts", av),
        Case("MOV", "/media/av.mov", "mov", av),
        Case("WebM with VP9 and Opus", "/media/vp9.webm", "webm", ["opus", "vp9"]),
        Case("AVI with MPEG-4 and MP3", "/media/mpeg4.avi", "avi", ["mp3", "mpeg4"]),
        Case("HEVC and AC-3 in MPEG-TS", "/media/hevc.ts", "ts", ["ac3", "hevc"]),
        # Any other link goes into MKV.
        Case("HEVC and AC-3 into MKV", "/media/hevc.ts", "mkv", ["ac3", "hevc"]),
        Case("MPEG-2 and MP2 into MKV", "/media/mpeg2.ts", "mkv", ["mp2", "mpeg2video"]),
        Case("FLV into MKV", "/media/av.flv", "mkv", av),
        Case("WMV into MKV", "/media/av.wmv", "mkv", ["wmav2", "wmv2"]),
        Case("FLAC into MKV", "/media/sound.flac", "mkv", ["flac"]),
        Case("MPEG-TS into MP4", "/media/av.ts", "mp4", av),
        # The app's own download tests serve WAV.
        Case("WAV into MKV", "/media/sound.wav", "mkv", ["pcm_u8"]),
        Case("Converting MPEG-2 and MP2 for Cast", "/media/mpeg2.ts", "mkv",
             ["aac", "mpeg2video"], converting=True),
        Case("Converting HEVC and AC-3 for Cast", "/media/hevc.ts", "mkv", ["aac", "hevc"],
             converting=True, downmix=True),
        Case("Converting DTS for Cast", "/media/dts.mkv", "mkv", av, converting=True,
             downmix=True),
        Case("Converting Opus for Cast", "/media/vp9.webm", "mkv", ["aac", "vp9"],
             converting=True),
        Case("Converting E-AC-3 in HLS for Cast", "/media/hls-eac3/index.m3u8", "mkv", av,
             converting=True, downmix=True),
        Case("HLS", "/media/hls/index.m3u8", "mkv", av),
        Case("HLS with fMP4 segments", "/media/hls-fmp4/index.m3u8", "mkv", av),
        Case("HLS with AES-128", "/media/hls-aes/index.m3u8", "mkv", av),
        Case("HLS master playlist", "/media/master.m3u8", "mkv", av),
        Case("MP4 over HTTPS", "/media/av.mp4", "mp4", av, server="https"),
        Case("HLS with AES-128 over HTTPS", "/media/hls-aes/index.m3u8", "mkv", av, server="https"),
        Case("MP4 from a server that only takes TLS 1.3", "/media/av.mp4", "mp4", av,
             server="tls13"),
        Case("MP4 from a server that only takes TLS 1.2", "/media/av.mp4", "mp4", av,
             server="tls12"),
        # The long file, since ffmpeg reads most of a short one while it
        # opens it.
        Case("A connection that drops halfway", "/drop/live.ts", "ts", av, length=LIVE_LENGTH),
        # Recordings.
        Case("Recording a live stream, stopped with q", "/live/live.ts", "ts", av,
             length=None, recording=True, quit_after=3),
        Case("Recording HLS", "/media/hls/index.m3u8", "ts", av, recording=True),
        Case("Recording MP3 radio", "/media/radio.mp3", "ts", ["mp3"], recording=True),
        Case("Recording AAC radio", "/media/radio.aac", "ts", ["aac"], recording=True),
        # MPEG-TS has no PCM audio, so ffmpeg writes the samples as data.
        Case("Recording WAV", "/media/sound.wav", "ts", ["bin_data"], recording=True),
        # Errors.
        Case("401", "/status/401", "mkv", error="401 unauthorized"),
        Case("403", "/status/403", "mkv", error="403 forbidden"),
        Case("404", "/status/404", "mkv", error="404 not found"),
        # ffmpeg names 400, 401, 403, 404 and 429, and any other 4xx is a
        # "4XX Client Error".
        Case("410", "/status/410", "mkv", error="4xx client error"),
        Case("500", "/status/500", "mkv", error="5xx server error"),
        Case("Connection refused", f"http://127.0.0.1:{closed_port()}/live/a.ts", "ts",
             error="connection refused", recording=True),
        Case("Unknown host", "http://sidecar-test.invalid/live/a.ts", "ts",
             error="failed to resolve", recording=True),
        Case("A live stream that stops sending", "/stall/live.ts", "ts",
             error="timed out|input/output error", recording=True),
    ]


def app_args(case: Case, url: str, dest: Path) -> list[str]:
    if case.converting:
        args = (CONVERT_DOWNMIX_ARGS if case.downmix else CONVERT_ARGS).split()
        return [url if arg == "URL" else str(dest) if arg == "pipe:1" else arg for arg in args]
    args = (RECORDING_ARGS if case.recording else DOWNLOAD_ARGS).split()
    muxer = MUXERS[case.container]
    if muxer not in ("mp4", "mov") and "-movflags" in args:
        index = args.index("-movflags")
        del args[index : index + 2]
    args[args.index("-f") + 1] = muxer
    return [url if arg == "URL" else str(dest) if arg == "DEST" else arg for arg in args]


@dataclass
class Run:
    code: int | None
    stdout: str
    stderr: str


def run_ffmpeg(ffmpeg: str, args: list[str], timeout: float, quit_after: float | None) -> Run:
    # stdin stays open, as it does in the app.
    proc = subprocess.Popen(
        [ffmpeg, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=CHILD_ENV,
    )
    output: dict[str, bytes] = {}

    def drain(name: str, stream) -> None:
        output[name] = stream.read()

    readers = [
        threading.Thread(target=drain, args=("stdout", proc.stdout), daemon=True),
        threading.Thread(target=drain, args=("stderr", proc.stderr), daemon=True),
    ]
    for reader in readers:
        reader.start()
    if quit_after is not None:
        try:
            proc.wait(timeout=quit_after)
        except subprocess.TimeoutExpired:
            # ffmpeg may stop on its own just before this.
            try:
                proc.stdin.write(b"q")
                proc.stdin.flush()
            except BrokenPipeError:
                pass
    try:
        code: int | None = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        code = None
    for reader in readers:
        reader.join()
    try:
        proc.stdin.close()
    except BrokenPipeError:
        pass
    return Run(
        code,
        output.get("stdout", b"").decode(errors="replace"),
        output.get("stderr", b"").decode(errors="replace"),
    )


STREAM = re.compile(r"^\s*Stream #0:\d+\S*: (?:Video|Audio|Subtitle|Data): (\w+)", re.M)
DURATION = re.compile(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")


def read_back(reader: str, path: Path) -> tuple[list[str], float | None, str]:
    # Without an output, ffmpeg lists what the file holds and exits with an
    # error.
    result = subprocess.run(
        [reader, "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
        errors="replace",
        stdin=subprocess.DEVNULL,
        timeout=30,
    )
    duration = DURATION.search(result.stderr)
    seconds = None
    if duration:
        hours, minutes, rest = duration.groups()
        seconds = int(hours) * 3600 + int(minutes) * 60 + float(rest)
    return sorted(STREAM.findall(result.stderr)), seconds, result.stderr


def top_level_boxes(path: Path) -> list[str]:
    """The types of the boxes at the top level of an MP4 or MOV file, in order."""
    total = path.stat().st_size
    boxes = []
    offset = 0
    with path.open("rb") as file:
        while offset + 8 <= total:
            file.seek(offset)
            header = file.read(16)
            size = int.from_bytes(header[:4], "big")
            if size == 1:
                size = int.from_bytes(header[8:16], "big")
            elif size == 0:
                size = total - offset
            if size < 8:
                break
            boxes.append(header[4:8].decode("latin-1"))
            offset += size
    return boxes


def check(ffmpeg: str, reader: str, case: Case, urls: dict[str, str], out: Path) -> str:
    """What went wrong in `case`, or nothing."""
    url = case.path if "://" in case.path else urls[case.server] + case.path
    dest = out / f"{re.sub(r'[^a-z0-9]+', '-', case.name.lower())}.{case.container}.part"
    run = run_ffmpeg(ffmpeg, app_args(case, url, dest), case.timeout, case.quit_after)
    errors = run.stderr.strip()
    if run.code is None:
        return f"ffmpeg still ran after {case.timeout:g} seconds. It said: {errors or 'nothing'}"
    if case.error:
        if not re.search(case.error, errors.lower()):
            return f"no error line matched {case.error!r}. ffmpeg said: {errors or 'nothing'}"
        # The app counts a download as done when ffmpeg exits with 0. A
        # recording goes by when ffmpeg stopped and by its error lines, and
        # ffmpeg exits with 0 when a live stream stops sending.
        if run.code == 0 and not case.recording:
            return f"ffmpeg exited with 0. It said: {errors}"
        return ""
    if run.code != 0:
        return f"ffmpeg exited with {run.code}: {errors}"
    # A conversion writes no progress, since the app reads its output.
    if not case.converting and "progress=end" not in run.stdout:
        return "the progress never said progress=end"
    sizes = re.findall(r"^total_size=(\d+)$", run.stdout, re.M)
    if not case.converting and (not sizes or int(sizes[-1]) <= 0):
        return f"the progress gave no size above 0: {sizes}"
    if not dest.is_file() or dest.stat().st_size == 0:
        return "ffmpeg wrote nothing"
    if not case.recording and MUXERS[case.container] in ("mp4", "mov"):
        # The app asks for -movflags +faststart, which moves the index before
        # the media, so a player can start the file before it has all of it.
        boxes = top_level_boxes(dest)
        if "moov" not in boxes or "mdat" not in boxes or boxes.index("moov") > boxes.index("mdat"):
            return f"the moov box doesn't come before mdat: {boxes}"
    codecs, seconds, listing = read_back(reader, dest)
    if codecs != sorted(case.codecs):
        return f"the file holds {codecs}, not {sorted(case.codecs)}:\n{listing}"
    if case.length is not None and (seconds is None or abs(seconds - case.length) > 0.5):
        return f"the file runs {seconds} seconds, not {case.length}"
    return ""


def listing(ffmpeg: str, flag: str) -> str:
    return subprocess.run(
        [ffmpeg, "-hide_banner", flag],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=30,
    ).stdout


def check_build(ffmpeg: str) -> list[tuple[str, str]]:
    failures = []
    # The list starts with "Supported file protocols:", which names "file".
    protocols = listing(ffmpeg, "-protocols").partition("Input:")[2].split("Output:")[0].split()
    missing = sorted(PROTOCOLS - set(protocols))
    if missing:
        failures.append(("Protocols", f"missing {missing}"))
    demuxers = set()
    for line in listing(ffmpeg, "-demuxers").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("D"):
            demuxers.update(parts[1].split(","))
    missing = sorted(DEMUXERS - demuxers)
    if missing:
        failures.append(("Demuxers", f"missing {missing}"))
    license_text = " ".join(listing(ffmpeg, "-L").split())
    if "GNU Lesser General Public License" not in license_text or "version 3" not in license_text:
        failures.append(("License", f"not LGPL version 3: {license_text[:200]}"))
    return failures


def test(ffmpeg: str, folder: Path, reader: str) -> int:
    # macOS's own /usr/bin/python3 uses LibreSSL, which has no TLS 1.3.
    if not ssl.HAS_TLSv1_3:
        print(f"This Python's ssl module, {ssl.OPENSSL_VERSION}, has no TLS 1.3.", file=sys.stderr)
        print("Run the test with a Python built with OpenSSL, such as Homebrew's.", file=sys.stderr)
        return 2
    # The servers load the certificate and key as they start, so the key is
    # gone before any case runs.
    with tempfile.TemporaryDirectory() as tls:
        make_certificate(Path(tls))
        servers = {
            "http": Server(folder / "www", None),
            "https": Server(folder / "www", Path(tls)),
            "tls13": Server(folder / "www", Path(tls), ssl.TLSVersion.TLSv1_3),
            "tls12": Server(folder / "www", Path(tls), ssl.TLSVersion.TLSv1_2),
        }
    urls = {name: server.url for name, server in servers.items()}
    failures = check_build(ffmpeg)
    for name, why in failures:
        print(f"FAIL {name}: {why}")
    all_cases = cases()

    def timed(case: Case, out: Path) -> tuple[str, float]:
        started = time.monotonic()
        why = check(ffmpeg, reader, case, urls, out)
        return why, time.monotonic() - started

    # The cases run side by side, since a few wait half a minute on ffmpeg's
    # reconnects, and print in order.
    with tempfile.TemporaryDirectory() as out, ThreadPoolExecutor(max_workers=8) as pool:
        runs = [pool.submit(timed, case, Path(out)) for case in all_cases]
        for case, future in zip(all_cases, runs):
            why, took = future.result()
            if why:
                failures.append((case.name, why))
                print(f"FAIL {case.name} ({took:.1f} s): {why}")
            else:
                print(f"ok   {case.name} ({took:.1f} s)")
            sys.stdout.flush()
    for server in servers.values():
        server.stop.set()
        server.shutdown()
    print(f"{len(all_cases) + 3 - len(failures)} of {len(all_cases) + 3} checks passed")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("command", choices=("media", "test"))
    parser.add_argument("ffmpeg")
    parser.add_argument("folder", type=Path)
    parser.add_argument("--reader", help="a full ffmpeg that reads back what the test wrote")
    options = parser.parse_args()
    if options.command == "media":
        make_media(options.ffmpeg, options.folder)
        return 0
    return test(options.ffmpeg, options.folder, options.reader or options.ffmpeg)


if __name__ == "__main__":
    sys.exit(main())
