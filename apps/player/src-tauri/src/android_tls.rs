// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Lets rustls check certificates with Android's own verifier.
//!
//! On Android, reqwest uses rustls with rustls-platform-verifier, which calls
//! the Kotlin class that the `rustls-platform-verifier-android` crate ships.
//! The verifier needs the JVM and the app's context before the first HTTPS
//! request, and fails every request without them.

use jni::objects::JObject;

/// Hands the JVM and the application context, which tao stores in
/// `ndk_context` when the activity starts, to rustls-platform-verifier.
pub fn init() {
    let android = ndk_context::android_context();
    // SAFETY: tao sets both pointers from the running JVM and a global
    // reference to the application context, and neither is ever released.
    let vm = unsafe { jni::JavaVM::from_raw(android.vm().cast()) };
    let result = vm.attach_current_thread(|env| {
        // SAFETY: the pointer is the global reference described above, which
        // outlives this call, and the `JObject` doesn't release it.
        let context = unsafe { JObject::from_raw(env, android.context().cast()) };
        rustls_platform_verifier::android::init_with_env(env, context)
    });
    if let Err(e) = result {
        tracing::error!("HTTPS can't check certificates: {e}");
    }
}
