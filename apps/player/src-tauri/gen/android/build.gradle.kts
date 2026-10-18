buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
        // The Kotlin half of rustls-platform-verifier, which checks HTTPS
        // certificates for the Rust code. Only that group comes from here.
        maven {
            url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/")
            content {
                includeGroup("org.rustls")
            }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

