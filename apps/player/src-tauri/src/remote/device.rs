// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What kind of device this is, as other devices see it.

use mvp_core::remote::message::DeviceType;

/// The smallest screen width, in dp, that Android calls a tablet's.
#[cfg(any(target_os = "android", test))]
const TABLET_MIN_DP: i32 = 600;

/// This device's type.
pub fn device_type() -> DeviceType {
    #[cfg(target_os = "macos")]
    return DeviceType::Mac;
    #[cfg(target_os = "linux")]
    return DeviceType::LinuxPc;
    #[cfg(target_os = "android")]
    return crate::android_device::device_type();
    #[cfg(target_os = "ios")]
    return ios_type(
        &model_identifier(),
        std::env::var("SIMULATOR_MODEL_IDENTIFIER").ok().as_deref(),
    );
}

/// The model identifier, such as `iPhone17,1` or `iPad16,3`. The simulator
/// gives the Mac's architecture instead.
#[cfg(target_os = "ios")]
fn model_identifier() -> String {
    let mut buf = [0u8; 64];
    let mut len = buf.len();
    // SAFETY: the name is a NUL-terminated string, and `buf` has room for
    // `len` bytes, which sysctlbyname writes back as the length it used.
    let ok = unsafe {
        libc::sysctlbyname(
            c"hw.machine".as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    if !ok {
        return String::new();
    }
    let name = buf.get(..len).unwrap_or_default();
    String::from_utf8_lossy(name)
        .trim_end_matches('\0')
        .to_owned()
}

/// An iPhone's or iPad's type from its model identifier. In the simulator
/// the simulated model is in `simulated`.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn ios_type(model: &str, simulated: Option<&str>) -> DeviceType {
    if simulated.unwrap_or(model).starts_with("iPad") {
        DeviceType::Ipad
    } else {
        DeviceType::Iphone
    }
}

/// An Android device's type: a Fire TV, another TV, or else a tablet or a
/// phone by its smallest screen width.
#[cfg(any(target_os = "android", test))]
pub(crate) fn android_type(fire_tv: bool, tv: bool, smallest_width_dp: i32) -> DeviceType {
    if fire_tv {
        DeviceType::FireTv
    } else if tv {
        DeviceType::AndroidTv
    } else if smallest_width_dp >= TABLET_MIN_DP {
        DeviceType::AndroidTablet
    } else {
        DeviceType::AndroidPhone
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fire_tv_is_one_even_though_it_is_also_a_tv() {
        assert_eq!(android_type(true, true, 540), DeviceType::FireTv);
        assert_eq!(android_type(true, false, 540), DeviceType::FireTv);
    }

    #[test]
    fn other_tvs_are_android_tvs_whatever_their_width() {
        assert_eq!(android_type(false, true, 540), DeviceType::AndroidTv);
        assert_eq!(android_type(false, true, 960), DeviceType::AndroidTv);
    }

    #[test]
    fn a_tablet_starts_at_600_dp() {
        assert_eq!(android_type(false, false, 599), DeviceType::AndroidPhone);
        assert_eq!(android_type(false, false, 600), DeviceType::AndroidTablet);
        assert_eq!(android_type(false, false, 800), DeviceType::AndroidTablet);
    }

    #[test]
    fn an_ipad_is_told_from_an_iphone_by_its_model() {
        assert_eq!(ios_type("iPad16,3", None), DeviceType::Ipad);
        assert_eq!(ios_type("iPhone17,1", None), DeviceType::Iphone);
        // An iPod touch is closest to an iPhone.
        assert_eq!(ios_type("iPod9,1", None), DeviceType::Iphone);
    }

    #[test]
    fn the_simulator_names_the_model_it_simulates() {
        assert_eq!(ios_type("arm64", Some("iPad16,3")), DeviceType::Ipad);
        assert_eq!(ios_type("arm64", Some("iPhone17,1")), DeviceType::Iphone);
    }

    #[test]
    fn this_machine_has_its_desktop_type() {
        #[cfg(target_os = "linux")]
        assert_eq!(device_type(), DeviceType::LinuxPc);
        #[cfg(target_os = "macos")]
        assert_eq!(device_type(), DeviceType::Mac);
    }
}
