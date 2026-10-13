// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The `loadfile` command in the form the loaded libmpv accepts.
//!
//! mpv 0.38, which has client API 2.3, added an `index` argument between the
//! flags and the per-file options. Older mpv rejects a `loadfile` with that
//! extra argument, so the options come right after the flags there. The .deb
//! uses the system libmpv, which is mpv 0.35 on Debian 12 and 0.37 on Ubuntu
//! 24.04.

use libmpv2::Mpv;
use std::ffi::c_ulong;
use std::sync::LazyLock;

/// The client API version of mpv 0.38, the first `loadfile` with an `index`.
const INDEX_ARG_API: c_ulong = client_api_version(2, 3);

/// The client API version of the libmpv the app loaded.
static LOADED_API: LazyLock<c_ulong> =
    // SAFETY: the function takes no arguments and returns a constant, and
    // libmpv allows calling it before any mpv handle exists.
    LazyLock::new(|| unsafe { libmpv2_sys::mpv_client_api_version() });

/// `MPV_MAKE_VERSION` from mpv's `client.h`.
const fn client_api_version(major: c_ulong, minor: c_ulong) -> c_ulong {
    (major << 16) | minor
}

/// The per-file option that resumes playback at `pos`, once playback has
/// passed the first second.
pub(crate) fn resume_option(pos: Option<f64>) -> Option<String> {
    pos.filter(|p| *p > 1.0).map(|p| format!("start=+{p:.3}"))
}

/// The arguments of a `loadfile` that replaces the current file with `url`.
///
/// `options` is a list of per-file options, such as `start=+12.000`. From
/// client API 2.3 it follows the `index`, which `replace` ignores. Before
/// that it follows the flags. Without options every version takes the URL
/// and the flags alone.
fn loadfile_args<'a>(url: &'a str, options: Option<&'a str>, api: c_ulong) -> Vec<&'a str> {
    match options {
        Some(options) if api >= INDEX_ARG_API => vec![url, "replace", "0", options],
        Some(options) => vec![url, "replace", options],
        None => vec![url, "replace"],
    }
}

/// Replaces the current file of `mpv` with `url`, with `options` as its
/// per-file options.
pub(crate) fn loadfile(mpv: &Mpv, url: &str, options: Option<&str>) -> libmpv2::Result<()> {
    mpv.command("loadfile", &loadfile_args(url, options, *LOADED_API))
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://example.test/movie/1.mkv";
    const RESUME: &str = "start=+12.000";

    /// Versions before mpv 0.38, from mpv 0.35's 2.0.
    const OLD_APIS: [c_ulong; 3] = [
        client_api_version(2, 0),
        client_api_version(2, 1),
        client_api_version(2, 2),
    ];

    /// Versions from mpv 0.38 up to mpv 0.40's 2.5.
    const NEW_APIS: [c_ulong; 3] = [
        client_api_version(2, 3),
        client_api_version(2, 4),
        client_api_version(2, 5),
    ];

    #[test]
    fn client_api_2_3_matches_mpv() {
        assert_eq!(INDEX_ARG_API, 0x0002_0003);
    }

    #[test]
    fn options_follow_the_flags_before_client_api_2_3() {
        for api in OLD_APIS {
            assert_eq!(
                loadfile_args(URL, Some(RESUME), api),
                [URL, "replace", RESUME]
            );
        }
    }

    #[test]
    fn options_follow_the_index_from_client_api_2_3() {
        for api in NEW_APIS {
            assert_eq!(
                loadfile_args(URL, Some(RESUME), api),
                [URL, "replace", "0", RESUME]
            );
        }
    }

    #[test]
    fn without_options_every_version_takes_the_url_and_flags() {
        for api in OLD_APIS.into_iter().chain(NEW_APIS) {
            assert_eq!(loadfile_args(URL, None, api), [URL, "replace"]);
        }
    }

    #[test]
    fn the_loaded_libmpv_has_client_api_2() {
        assert_eq!(*LOADED_API >> 16, 2);
    }

    #[test]
    fn resume_starts_after_the_first_second() {
        assert_eq!(resume_option(None), None);
        assert_eq!(resume_option(Some(1.0)), None);
        assert_eq!(resume_option(Some(1.5)).as_deref(), Some("start=+1.500"));
        assert_eq!(
            resume_option(Some(754.12345)).as_deref(),
            Some("start=+754.123")
        );
    }
}
