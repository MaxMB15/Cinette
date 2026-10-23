// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What kind of device this is, and its name until the user gives one, as
//! other devices see them.

use mvp_core::remote::message::DeviceType;
use mvp_core::remote::settings::{self, clean_name};
use std::sync::OnceLock;

/// The smallest screen width, in dp, that Android calls a tablet's.
#[cfg(any(target_os = "android", test))]
const TABLET_MIN_DP: i32 = 600;

/// The system features that make an Android device a TV. Android TV and
/// Google TV have the first, Fire TV has the last, and older TVs only the
/// second.
#[cfg(any(target_os = "android", test))]
pub(crate) const TV_FEATURES: [&str; 3] = [
    "android.software.leanback",
    "android.hardware.type.television",
    FIRE_TV_FEATURE,
];
#[cfg(any(target_os = "android", test))]
const FIRE_TV_FEATURE: &str = "amazon.hardware.fire_tv";

/// What Android says about the device.
#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AndroidFacts {
    pub tv: bool,
    pub fire_tv: bool,
    pub smallest_width_dp: i32,
}

#[cfg(any(target_os = "android", test))]
impl AndroidFacts {
    /// The facts from which of [`TV_FEATURES`] the device `has`, and its
    /// smallest screen width.
    pub(crate) fn new(has: impl Fn(&str) -> bool, smallest_width_dp: i32) -> Self {
        Self {
            tv: TV_FEATURES.iter().any(|f| has(f)),
            fire_tv: has(FIRE_TV_FEATURE),
            smallest_width_dp,
        }
    }

    /// The device's type: a Fire TV, another TV, or else a tablet or a
    /// phone by its smallest screen width.
    pub(crate) fn device_type(self) -> DeviceType {
        android_type(self.fire_tv, self.tv, self.smallest_width_dp)
    }
}

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

/// This device's name until the user gives it one: the name the system has
/// for it, or else its type. It's read once, when first asked for.
pub fn default_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        system_name()
            .as_deref()
            .and_then(clean_name)
            .unwrap_or_else(|| settings::default_name(device_type()).to_owned())
    })
}

/// The name the system's settings give this device, where it has one.
fn system_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    return computer_name();
    #[cfg(target_os = "linux")]
    return linux_name(
        std::fs::read_to_string("/etc/machine-info").ok().as_deref(),
        std::fs::read_to_string("/proc/sys/kernel/hostname")
            .ok()
            .as_deref(),
    );
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    None
}

// mutants: skip FnValue, UnaryOperator: It only builds for macOS, and mutation runs build on Linux.
/// The Mac's computer name, as System Settings, General, About shows it.
#[cfg(target_os = "macos")]
fn computer_name() -> Option<String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "SystemConfiguration", kind = "framework")]
    unsafe extern "C" {
        fn SCDynamicStoreCopyComputerName(
            store: *const std::ffi::c_void,
            encoding: *mut u32,
        ) -> CFStringRef;
    }
    // SAFETY: a null store asks the system's own, and a null encoding isn't
    // written. The name comes back as a new reference, or null.
    let name = unsafe { SCDynamicStoreCopyComputerName(std::ptr::null(), std::ptr::null_mut()) };
    // SAFETY: a non-null name is a CFString this call created, which the
    // wrapper releases.
    (!name.is_null()).then(|| unsafe { CFString::wrap_under_create_rule(name) }.to_string())
}

/// The pretty hostname in `machine_info`, the name a Linux desktop's
/// settings show, or else `hostname`.
#[cfg(any(target_os = "linux", test))]
fn linux_name(machine_info: Option<&str>, hostname: Option<&str>) -> Option<String> {
    machine_info.and_then(pretty_hostname).or_else(|| {
        hostname
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .map(str::to_owned)
    })
}

/// `PRETTY_HOSTNAME` from `/etc/machine-info`, which holds `KEY=value` lines
/// with values quoted as in a shell when they need it.
#[cfg(any(target_os = "linux", test))]
fn pretty_hostname(machine_info: &str) -> Option<String> {
    let value = machine_info
        .lines()
        .find_map(|line| line.trim().strip_prefix("PRETTY_HOSTNAME="))?;
    let unquoted = match value.as_bytes().first() {
        Some(&q @ (b'"' | b'\'')) => value[1..].strip_suffix(char::from(q))?,
        _ => value,
    };
    let mut name = String::with_capacity(unquoted.len());
    let mut chars = unquoted.chars();
    while let Some(c) = chars.next() {
        name.push(if c == '\\' { chars.next()? } else { c });
    }
    (!name.trim().is_empty()).then_some(name)
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

/// See [`AndroidFacts::device_type`].
#[cfg(any(target_os = "android", test))]
fn android_type(fire_tv: bool, tv: bool, smallest_width_dp: i32) -> DeviceType {
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
    fn the_fire_tv_feature_alone_makes_a_fire_tv_and_a_tv() {
        let facts = AndroidFacts::new(|f| f == "amazon.hardware.fire_tv", 540);
        assert!(facts.tv && facts.fire_tv);
        assert_eq!(facts.device_type(), DeviceType::FireTv);
    }

    #[test]
    fn leanback_or_television_makes_only_a_tv() {
        for feature in [
            "android.software.leanback",
            "android.hardware.type.television",
        ] {
            let facts = AndroidFacts::new(|f| f == feature, 540);
            assert_eq!(
                facts,
                AndroidFacts {
                    tv: true,
                    fire_tv: false,
                    smallest_width_dp: 540
                }
            );
            assert_eq!(facts.device_type(), DeviceType::AndroidTv);
        }
    }

    #[test]
    fn no_tv_feature_leaves_a_phone_or_tablet_by_width() {
        let facts = AndroidFacts::new(|_| false, 600);
        assert!(!facts.tv && !facts.fire_tv);
        assert_eq!(facts.device_type(), DeviceType::AndroidTablet);
        assert_eq!(
            AndroidFacts::new(|f| f == "android.hardware.touchscreen", 411).device_type(),
            DeviceType::AndroidPhone
        );
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
    fn linux_takes_the_pretty_hostname_then_the_hostname() {
        let info = "ICON_NAME=computer-laptop\nPRETTY_HOSTNAME=\"Max's \\\"Den\\\" PC\"\n";
        assert_eq!(
            linux_name(Some(info), Some("den-pc\n")),
            Some("Max's \"Den\" PC".into())
        );
        assert_eq!(
            linux_name(Some("PRETTY_HOSTNAME='Den PC'"), None),
            Some("Den PC".into())
        );
        assert_eq!(
            linux_name(Some("PRETTY_HOSTNAME=DenPC"), None),
            Some("DenPC".into())
        );
        // Nothing, an empty value or a broken quote falls back.
        for info in [
            "",
            "PRETTY_HOSTNAME=",
            "PRETTY_HOSTNAME=\"  \"",
            "PRETTY_HOSTNAME=\"Den",
        ] {
            assert_eq!(
                linux_name(Some(info), Some("den-pc\n")),
                Some("den-pc".into()),
                "{info}"
            );
        }
        assert_eq!(linux_name(None, Some(" \n")), None);
        assert_eq!(linux_name(None, None), None);
    }

    /// The system's name for this machine, read here as the app reads it.
    #[cfg(target_os = "linux")]
    fn this_machines_name() -> Option<String> {
        linux_name(
            std::fs::read_to_string("/etc/machine-info").ok().as_deref(),
            std::fs::read_to_string("/proc/sys/kernel/hostname")
                .ok()
                .as_deref(),
        )
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_reads_this_machines_name() {
        assert_eq!(system_name(), this_machines_name());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_default_name_is_this_machines_cleaned_or_its_type() {
        let expected = this_machines_name()
            .as_deref()
            .and_then(clean_name)
            .unwrap_or_else(|| settings::default_name(device_type()).to_owned());
        assert_eq!(default_name(), expected);
        // It's read once.
        assert!(std::ptr::eq(default_name(), default_name()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_mac_reads_its_computer_name() {
        let scutil = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
            .unwrap();
        let expected = String::from_utf8(scutil.stdout).unwrap();
        assert_eq!(
            computer_name().as_deref(),
            Some(expected.trim_end_matches('\n'))
        );
    }

    #[test]
    fn this_machine_has_its_desktop_type() {
        #[cfg(target_os = "linux")]
        assert_eq!(device_type(), DeviceType::LinuxPc);
        #[cfg(target_os = "macos")]
        assert_eq!(device_type(), DeviceType::Mac);
    }
}
