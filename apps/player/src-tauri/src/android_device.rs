// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Tells the page whether the app runs on a TV, before any page script runs.

use jni::objects::{JObject, JValue};
use jni::{jni_sig, jni_str};

/// Android TV and Google TV have the first, Fire TV has the last, and
/// older TVs only the second.
const TV_FEATURES: [&str; 3] = [
    "android.software.leanback",
    "android.hardware.type.television",
    "amazon.hardware.fire_tv",
];

/// Whether the device is a TV, by the system features its package manager
/// reports.
fn is_tv() -> bool {
    let android = ndk_context::android_context();
    // SAFETY: tao sets both pointers from the running JVM and a global
    // reference to the application context, and neither is ever released.
    let vm = unsafe { jni::JavaVM::from_raw(android.vm().cast()) };
    let result = vm.attach_current_thread(|env| -> jni::errors::Result<bool> {
        // SAFETY: the pointer is the global reference described above, which
        // outlives this call, and the `JObject` doesn't release it.
        let context = unsafe { JObject::from_raw(env, android.context().cast()) };
        let packages = env
            .call_method(
                &context,
                jni_str!("getPackageManager"),
                jni_sig!(() -> android.content.pm.PackageManager),
                &[],
            )?
            .l()?;
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
            if has {
                return Ok(true);
            }
        }
        Ok(false)
    });
    result.unwrap_or_else(|e| {
        tracing::warn!("Couldn't tell whether this is a TV: {e}");
        false
    })
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
