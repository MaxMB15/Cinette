import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

// The store the build is for: google (the default) or amazon. Set it with
// -Pstore=amazon, or ORG_GRADLE_PROJECT_store=amazon around
// `pnpm tauri android build`. A property rather than a flavor dimension,
// because a second dimension renames the variant tasks that Tauri's
// RustPlugin.kt and CLI expect. Both stores get the same Rust library.
val stores = listOf("google", "amazon")
val store = (findProperty("store") as? String ?: "google").also {
    require(it in stores) { "store must be one of $stores, not \"$it\"" }
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// The upload key for release builds, from gen/android/keystore.properties,
// which .gitignore keeps out of the repo, as it does the key. See
// docs/amazon-appstore.md. Without the file, release builds come out
// unsigned.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "app.cinette"
    if (!keystoreProperties.isEmpty) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    defaultConfig {
        // Many IPTV servers only speak plain HTTP. res/xml/network_security_config.xml
        // allows it too, and that file wins on every Android version the app runs on.
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        // android_device.rs reads it from the manifest's app.cinette.STORE.
        manifestPlaceholders["store"] = store
        // The launcher activity's icon. Fire TV's launcher shows a sideloaded
        // app's square icon centered in a 16:9 tile, with grey on both sides,
        // and ignores android:banner, so the Amazon build gives it the wide
        // banner. Android TV and Google TV show the banner, and Google TV's
        // apps row the square icon.
        manifestPlaceholders["launcherIcon"] =
            if (store == "amazon") "@drawable/banner" else "@mipmap/ic_launcher"
        applicationId = "app.cinette"
        minSdk = 28
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
    // libmpv and FFmpeg from scripts/build-libmpv.sh android, one folder
    // per ABI.
    sourceSets {
        getByName("main") {
            jniLibs.srcDir("../../../../../../libs/android")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // The same version as rustls-platform-verifier-android in Cargo.lock,
    // which a test in the app crate checks.
    implementation("org.rustls:rustls-platform-verifier:0.2.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
