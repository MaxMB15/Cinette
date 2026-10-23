// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! What the app needs to know from Android: whether this is a TV, told to
//! the page before any page script runs, the device type and name remote
//! control advertises, and the store the build is for. Also the Wi-Fi
//! multicast lock that DNS-SD needs.

use crate::remote::device::{AndroidFacts, TV_FEATURES};
use crate::remote::held::Held;
use jni::objects::{Global, JObject, JString, JValue};
use jni::{jni_sig, jni_str};
use mvp_core::remote::message::DeviceType;
use std::sync::{Mutex, OnceLock};

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

/// Asks the package manager which of the TV features the device has, and
/// the configuration for its smallest screen width.
fn read_facts() -> jni::errors::Result<AndroidFacts> {
    with_context(|env, context| {
        let packages = env
            .call_method(
                context,
                jni_str!("getPackageManager"),
                jni_sig!(() -> android.content.pm.PackageManager),
                &[],
            )?
            .l()?;
        let mut present = Vec::new();
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
                present.push(feature);
            }
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
        let width = env
            .get_field(
                &configuration,
                jni_str!("smallestScreenWidthDp"),
                jni_sig!(jint),
            )?
            .i()?;
        Ok(AndroidFacts::new(|f| present.contains(&f), width))
    })
}

/// What Android says about the device. It doesn't change while the app runs,
/// so it's read once.
fn facts() -> AndroidFacts {
    static FACTS: OnceLock<AndroidFacts> = OnceLock::new();
    *FACTS.get_or_init(|| {
        read_facts().unwrap_or_else(|e| {
            tracing::warn!("Couldn't tell what kind of device this is: {e}");
            AndroidFacts::default()
        })
    })
}

/// The manifest's `app.cinette.STORE`, which `app/build.gradle.kts` sets
/// from its `store` property: `google` or `amazon`.
fn read_store() -> jni::errors::Result<String> {
    with_context(|env, context| {
        let packages = env
            .call_method(
                context,
                jni_str!("getPackageManager"),
                jni_sig!(() -> android.content.pm.PackageManager),
                &[],
            )?
            .l()?;
        let name = env
            .call_method(
                context,
                jni_str!("getPackageName"),
                jni_sig!(() -> java.lang.String),
                &[],
            )?
            .l()?;
        // PackageManager.GET_META_DATA
        const GET_META_DATA: i32 = 128;
        let info = env
            .call_method(
                &packages,
                jni_str!("getApplicationInfo"),
                jni_sig!((java.lang.String, jint) -> android.content.pm.ApplicationInfo),
                &[JValue::from(&name), JValue::Int(GET_META_DATA)],
            )?
            .l()?;
        let meta = env
            .get_field(&info, jni_str!("metaData"), jni_sig!(android.os.Bundle))?
            .l()?;
        let key = env.new_string("app.cinette.STORE")?;
        let value = env
            .call_method(
                &meta,
                jni_str!("getString"),
                jni_sig!((java.lang.String) -> java.lang.String),
                &[JValue::from(&key)],
            )?
            .l()?;
        env.cast_local::<JString>(value)?.try_to_string(env)
    })
}

/// The type remote control advertises.
pub fn device_type() -> DeviceType {
    facts().device_type()
}

/// `Settings.Global`'s `device_name`: the name the user gave the device, as
/// a Fire TV's Settings, My Fire TV, About shows it. Null where none was set.
fn read_device_name() -> jni::errors::Result<Option<String>> {
    with_context(|env, context| {
        let resolver = env
            .call_method(
                context,
                jni_str!("getContentResolver"),
                jni_sig!(() -> android.content.ContentResolver),
                &[],
            )?
            .l()?;
        let key = env.new_string("device_name")?;
        let value = env
            .call_static_method(
                jni_str!("android/provider/Settings$Global"),
                jni_str!("getString"),
                jni_sig!("(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;"),
                &[JValue::from(&resolver), JValue::from(&key)],
            )?
            .l()?;
        if value.is_null() {
            return Ok(None);
        }
        env.cast_local::<JString>(value)?
            .try_to_string(env)
            .map(Some)
    })
}

/// The name the user gave the device in Android's settings, if any.
pub fn device_name() -> Option<String> {
    read_device_name().unwrap_or_else(|e| {
        tracing::warn!("Couldn't read the device's name: {e}");
        None
    })
}

/// The multicast lock while it's held. Held as `None` on a device with no
/// Wi-Fi, which has nothing to lock.
static MULTICAST: Mutex<Held<Option<Global<JObject<'static>>>>> = Mutex::new(Held::new());

/// Takes or lets go of a Wi-Fi multicast lock. Without one, many Wi-Fi
/// drivers drop the multicast packets DNS-SD runs on, so the device can't
/// find others or answer their queries. It costs battery, so it's only held
/// while the app is in the foreground and remote control runs.
pub fn hold_multicast(hold: bool) {
    let mut slot = MULTICAST.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = slot.set(hold, acquire_multicast, release_multicast) {
        tracing::warn!("Couldn't change the Wi-Fi multicast lock: {e}");
    }
}

/// A new multicast lock, taken. Without Wi-Fi, as on a TV with only
/// Ethernet, which doesn't filter multicast, there's none to take.
fn acquire_multicast() -> jni::errors::Result<Option<Global<JObject<'static>>>> {
    with_context(|env, context| {
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
            return Ok(None);
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
        env.new_global_ref(&lock).map(Some)
    })
}

fn release_multicast(lock: Option<Global<JObject<'static>>>) -> jni::errors::Result<()> {
    let Some(lock) = lock else {
        return Ok(());
    };
    with_context(|env, _| {
        env.call_method(
            lock.as_obj(),
            jni_str!("release"),
            jni_sig!(() -> void),
            &[],
        )?;
        Ok(())
    })
}

/// A plugin whose init script sets `window.__CINETTE_TV__` on a TV, which
/// `getPlatform` in `lib/platform.ts` reads.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let tv = facts().tv;
    tracing::info!("Android device is a TV: {tv}");
    match read_store() {
        Ok(store) => tracing::info!("Built for the {store} store"),
        Err(e) => tracing::warn!("Couldn't read the store from the manifest: {e}"),
    }
    tauri::plugin::Builder::new("android-device")
        .js_init_script(format!("window.__CINETTE_TV__ = {tv};"))
        .build()
}
