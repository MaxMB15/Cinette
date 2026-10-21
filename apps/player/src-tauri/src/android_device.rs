// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What the app needs to know from Android: whether this is a TV, told to
//! the page before any page script runs, and the device type remote control
//! advertises. Also the Wi-Fi multicast lock that DNS-SD needs.

use jni::objects::{Global, JObject, JValue};
use jni::{jni_sig, jni_str};
use mvp_core::remote::message::DeviceType;
use std::sync::{Mutex, OnceLock};

/// Android TV and Google TV have the first, Fire TV has the last, and
/// older TVs only the second.
const TV_FEATURES: [&str; 3] = [
    "android.software.leanback",
    "android.hardware.type.television",
    FIRE_TV_FEATURE,
];
const FIRE_TV_FEATURE: &str = "amazon.hardware.fire_tv";

/// What the system says about this device. It doesn't change while the app
/// runs, so it's read once.
#[derive(Debug, Clone, Copy, Default)]
struct Facts {
    tv: bool,
    fire_tv: bool,
    smallest_width_dp: i32,
}

/// Runs `f` with the app's context on this thread's JNI environment.
fn with_context<T>(
    f: impl FnOnce(&mut jni::Env, &JObject) -> jni::errors::Result<T>,
) -> jni::errors::Result<T> {
    let android = ndk_context::android_context();
    // SAFETY: tao sets both pointers from the running JVM and a global
    // reference to the application context, and neither is ever released.
    let vm = unsafe { jni::JavaVM::from_raw(android.vm().cast()) };
    vm.attach_current_thread(|env| {
        // SAFETY: the pointer is the global reference described above, which
        // outlives this call, and the `JObject` doesn't release it.
        let context = unsafe { JObject::from_raw(env, android.context().cast()) };
        f(env, &context)
    })
}

/// Reads the system features the package manager reports, and the smallest
/// screen width.
fn read_facts() -> jni::errors::Result<Facts> {
    with_context(|env, context| {
        let packages = env
            .call_method(
                context,
                jni_str!("getPackageManager"),
                jni_sig!(() -> android.content.pm.PackageManager),
                &[],
            )?
            .l()?;
        let mut facts = Facts::default();
        for feature in TV_FEATURES {
            let name = env.new_string(feature)?;
            let has = env
                .call_method(
                    &packages,
                    jni_str!("hasSystemFeature"),
                    jni_sig!((java.lang.String) -> jboolean),
                    &[JValue::from(&name)],
                )?
                .z()?;
            facts.tv |= has;
            facts.fire_tv |= has && feature == FIRE_TV_FEATURE;
        }
        let resources = env
            .call_method(
                context,
                jni_str!("getResources"),
                jni_sig!(() -> android.content.res.Resources),
                &[],
            )?
            .l()?;
        let configuration = env
            .call_method(
                &resources,
                jni_str!("getConfiguration"),
                jni_sig!(() -> android.content.res.Configuration),
                &[],
            )?
            .l()?;
        facts.smallest_width_dp = env
            .get_field(
                &configuration,
                jni_str!("smallestScreenWidthDp"),
                jni_sig!(jint),
            )?
            .i()?;
        Ok(facts)
    })
}

fn facts() -> Facts {
    static FACTS: OnceLock<Facts> = OnceLock::new();
    *FACTS.get_or_init(|| {
        read_facts().unwrap_or_else(|e| {
            tracing::warn!("Couldn't tell what kind of device this is: {e}");
            Facts::default()
        })
    })
}

/// Whether the device is a TV, by the system features its package manager
/// reports.
fn is_tv() -> bool {
    facts().tv
}

/// The type remote control advertises.
pub fn device_type() -> DeviceType {
    let f = facts();
    crate::remote::device::android_type(f.fire_tv, f.tv, f.smallest_width_dp)
}

/// The multicast lock while it's held.
static MULTICAST: Mutex<Option<Global<JObject<'static>>>> = Mutex::new(None);

/// Takes or lets go of a Wi-Fi multicast lock. Without one, many Wi-Fi
/// drivers drop the multicast packets DNS-SD runs on, so the device can't
/// find others or answer their queries. It costs battery, so it's only held
/// while the app is in the foreground.
pub fn hold_multicast(hold: bool) {
    let mut slot = MULTICAST.lock().unwrap_or_else(|e| e.into_inner());
    if hold == slot.is_some() {
        return;
    }
    let result = match slot.take() {
        Some(lock) => with_context(|env, _| {
            env.call_method(lock.as_obj(), jni_str!("release"), jni_sig!(() -> void), &[])?;
            Ok(())
        }),
        None => with_context(|env, context| {
            let service = env.new_string("wifi")?;
            let wifi = env
                .call_method(
                    context,
                    jni_str!("getSystemService"),
                    jni_sig!((java.lang.String) -> java.lang.Object),
                    &[JValue::from(&service)],
                )?
                .l()?;
            if wifi.is_null() {
                // No Wi-Fi, as on a TV with only Ethernet, which doesn't
                // filter multicast.
                return Ok(());
            }
            let tag = env.new_string("cinette-discovery")?;
            let lock = env
                .call_method(
                    &wifi,
                    jni_str!("createMulticastLock"),
                    jni_sig!("(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;"),
                    &[JValue::from(&tag)],
                )?
                .l()?;
            env.call_method(
                &lock,
                jni_str!("setReferenceCounted"),
                jni_sig!((jboolean) -> void),
                &[JValue::Bool(false)],
            )?;
            env.call_method(&lock, jni_str!("acquire"), jni_sig!(() -> void), &[])?;
            *slot = Some(env.new_global_ref(&lock)?);
            Ok(())
        }),
    };
    if let Err(e) = result {
        tracing::warn!("Couldn't change the Wi-Fi multicast lock: {e}");
    }
}

/// A plugin whose init script sets `window.__CINETTE_TV__` on a TV, which
/// `getPlatform` in `lib/platform.ts` reads.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let tv = is_tv();
    tracing::info!("Android device is a TV: {tv}");
    tauri::plugin::Builder::new("android-device")
        .js_init_script(format!("window.__CINETTE_TV__ = {tv};"))
        .build()
}
