// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! mpv options that the macOS and Linux option sets share.

/// FFmpeg reconnect settings handed to the demuxer through `stream-lavf-o`.
///
/// FFmpeg doesn't reconnect HTTP streams by default, so a short network drop
/// ends the stream and mpv sits on the last frame. With these set FFmpeg
/// retries the read itself, and `reconnect.rs` only has to handle the
/// failures that get past it.
///
/// `reconnect_streamed` covers live streams that can't seek, and
/// `reconnect_on_network_error` covers socket errors as well as HTTP ones.
/// `reconnect_delay_max` caps the backoff at 5 seconds so playback comes
/// back soon after the network does.
const LAVF_RECONNECT_OPTS: &str =
    "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5";

/// Cache, network and end of file options for every desktop option set.
///
/// Each platform puts its own video and audio options in front and its
/// `msg-level` after.
pub(crate) fn shared_options() -> [(&'static str, &'static str); 9] {
    [
        ("cache", "yes"),
        ("cache-secs", "30"),
        ("demuxer-max-bytes", "150MiB"),
        ("demuxer-max-back-bytes", "75MiB"),
        ("stream-lavf-o", LAVF_RECONNECT_OPTS),
        ("network-timeout", "30"),
        // Hold the last frame at the end instead of going idle. The end the
        // frontend sees (`reached_end`) and `reconnect.rs` both read
        // `eof-reached`, which mpv only leaves set while the file stays open.
        ("keep-open", "yes"),
        // mpv's ytdl_hook hands a stream that fails to open to yt-dlp, login
        // and all, when yt-dlp is installed. A libmpv without Lua has no
        // ytdl_hook and no `ytdl` option, so `MpvEngine::create` skips it.
        ("ytdl", "no"),
        ("terminal", "yes"),
    ]
}

/// What the fallback window needs, since the app has no controls over it.
/// libmpv turns off mpv's on-screen controller, its key bindings and the
/// window's keyboard input. With them on, the mouse and keys control
/// playback, and closing the window or pressing `q` quits mpv, which
/// `reconnect.rs` reports to the frontend. The macOS libmpv and MPVKit are
/// built without Lua, so they have no on-screen controller and no `osc`
/// option, and `MpvEngine::create` skips it there.
pub(crate) fn window_controls() -> [(&'static str, &'static str); 3] {
    [
        ("osc", "yes"),
        ("input-default-bindings", "yes"),
        ("input-vo-keyboard", "yes"),
    ]
}

// These pin the exact options each platform passes to mpv, in order, so a
// change to the shared list shows up here.
#[cfg(test)]
mod tests {
    const LAVF: &str =
        "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5";

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_option_sets_are_pinned() {
        assert_eq!(
            crate::macos::embedded_options(),
            vec![
                ("vo", "libmpv"),
                ("hwdec", "videotoolbox"),
                ("ao", "coreaudio"),
                ("video-sync", "display-resample"),
                ("cache", "yes"),
                ("cache-secs", "30"),
                ("demuxer-max-bytes", "150MiB"),
                ("demuxer-max-back-bytes", "75MiB"),
                ("stream-lavf-o", LAVF),
                ("network-timeout", "30"),
                ("keep-open", "yes"),
                ("ytdl", "no"),
                ("terminal", "yes"),
                ("msg-level", "all=status"),
            ]
        );
        assert_eq!(
            crate::macos::fallback_options(),
            vec![
                ("hwdec", "videotoolbox"),
                ("ao", "coreaudio"),
                ("video-sync", "display-resample"),
                ("cache", "yes"),
                ("cache-secs", "30"),
                ("demuxer-max-bytes", "150MiB"),
                ("demuxer-max-back-bytes", "75MiB"),
                ("stream-lavf-o", LAVF),
                ("network-timeout", "30"),
                ("keep-open", "yes"),
                ("ytdl", "no"),
                ("terminal", "yes"),
                ("osc", "yes"),
                ("input-default-bindings", "yes"),
                ("input-vo-keyboard", "yes"),
                ("msg-level", "all=status"),
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_option_sets_are_pinned() {
        assert_eq!(
            crate::linux::embedded_options(false),
            vec![
                ("vo", "libmpv"),
                ("hwdec", "auto-copy-safe"),
                ("gpu-hwdec-interop", "no"),
                ("ao", "pulse,pipewire,alsa,"),
                ("config", "no"),
                ("video-sync", "audio"),
                ("cache", "yes"),
                ("cache-secs", "30"),
                ("demuxer-max-bytes", "150MiB"),
                ("demuxer-max-back-bytes", "75MiB"),
                ("stream-lavf-o", LAVF),
                ("network-timeout", "30"),
                ("keep-open", "yes"),
                ("ytdl", "no"),
                ("terminal", "yes"),
                ("msg-level", "all=info"),
            ]
        );
        assert_eq!(
            crate::linux::fallback_options(true),
            vec![
                ("hwdec", "auto-copy-safe"),
                ("ao", "pulse,pipewire,alsa,"),
                ("config", "no"),
                ("video-sync", "display-resample"),
                ("cache", "yes"),
                ("cache-secs", "30"),
                ("demuxer-max-bytes", "150MiB"),
                ("demuxer-max-back-bytes", "75MiB"),
                ("stream-lavf-o", LAVF),
                ("network-timeout", "30"),
                ("keep-open", "yes"),
                ("ytdl", "no"),
                ("terminal", "yes"),
                ("osc", "yes"),
                ("input-default-bindings", "yes"),
                ("input-vo-keyboard", "yes"),
                ("msg-level", "all=info"),
            ]
        );
        // A software renderer adds cheaper scaling and turns off dithering
        // and HDR peak detection, in front of the shared options.
        let mut software = crate::linux::embedded_options(false);
        software.splice(
            6..6,
            [
                ("scale", "bilinear"),
                ("dscale", "bilinear"),
                ("dither", "no"),
                ("correct-downscaling", "no"),
                ("linear-downscaling", "no"),
                ("sigmoid-upscaling", "no"),
                ("hdr-compute-peak", "no"),
            ],
        );
        assert_eq!(crate::linux::embedded_options(true), software);
        // On X11 only the decoding mode differs.
        let mut x11 = crate::linux::fallback_options(true);
        x11[0] = ("hwdec", "auto");
        assert_eq!(crate::linux::fallback_options(false), x11);
    }
}
