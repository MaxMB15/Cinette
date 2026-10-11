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
pub(crate) fn shared_options() -> [(&'static str, &'static str); 8] {
    [
        ("cache", "yes"),
        ("cache-secs", "30"),
        ("demuxer-max-bytes", "150MiB"),
        ("demuxer-max-back-bytes", "75MiB"),
        ("stream-lavf-o", LAVF_RECONNECT_OPTS),
        ("network-timeout", "30"),
        // Hold the last frame at the end instead of going idle. The frontend
        // reads the end of a stream from the position, and `reconnect.rs`
        // watches `eof-reached`, which mpv only leaves set while the file
        // stays open.
        ("keep-open", "yes"),
        ("terminal", "yes"),
    ]
}

#[cfg(test)]
mod tests {
    const LAVF: &str =
        "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5";

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_option_sets_are_unchanged() {
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
                ("terminal", "yes"),
                ("msg-level", "all=status"),
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_option_sets_are_unchanged() {
        assert_eq!(
            crate::linux::embedded_options(),
            vec![
                ("vo", "libmpv"),
                ("hwdec", "auto-copy"),
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
                ("terminal", "yes"),
                ("msg-level", "all=info"),
            ]
        );
        assert_eq!(
            crate::linux::fallback_options(),
            vec![
                ("hwdec", "auto"),
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
                ("terminal", "yes"),
                ("msg-level", "all=info"),
            ]
        );
    }
}
