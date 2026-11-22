# rustls-platform-verifier calls these through JNI, which ProGuard can't see.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }

# android_device.rs calls this through JNI to hand the GitHub build's update
# to Android's installer. The manifest only keeps the provider's constructor.
-keepclassmembers class androidx.core.content.FileProvider {
    public static android.net.Uri getUriForFile(android.content.Context, java.lang.String, java.io.File);
}

# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile