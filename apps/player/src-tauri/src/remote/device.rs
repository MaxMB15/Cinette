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
    fn this_machine_has_its_desktop_type() {
        #[cfg(target_os = "linux")]
        assert_eq!(device_type(), DeviceType::LinuxPc);
        #[cfg(target_os = "macos")]
        assert_eq!(device_type(), DeviceType::Mac);
    }
}
