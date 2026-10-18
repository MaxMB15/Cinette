// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Lets rustls check certificates with Android's own verifier.
//!
//! On Android, reqwest uses rustls with rustls-platform-verifier, which calls
//! the Kotlin class that the `rustls-platform-verifier-android` crate ships.
//! The verifier needs the JVM and the app's context before the first HTTPS
//! request. Without them it panics in the middle of every TLS handshake, so a
//! request never returns and the command that made it never answers. That's
//! why the app stops at startup when [`init`] fails.

use jni::objects::JObject;

/// Hands the JVM and the application context, which tao stores in
/// `ndk_context` when the activity starts, to rustls-platform-verifier.
pub fn init() -> Result<(), jni::errors::Error> {
    let android = ndk_context::android_context();
    // SAFETY: tao sets both pointers from the running JVM and a global
    // reference to the application context, and neither is ever released.
    let vm = unsafe { jni::JavaVM::from_raw(android.vm().cast()) };
    vm.attach_current_thread(|env| {
        // SAFETY: the pointer is the global reference described above, which
        // outlives this call, and the `JObject` doesn't release it.
        let context = unsafe { JObject::from_raw(env, android.context().cast()) };
        rustls_platform_verifier::android::init_with_env(env, context)
    })
}
