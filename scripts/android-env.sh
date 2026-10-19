# shellcheck shell=bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Sets what cargo needs to build the workspace for Android outside
# `pnpm tauri android build`, and what bindgen needs for armv7 in either.
# Source it: `. scripts/android-env.sh`. NDK_HOME must name the NDK.
#
# - CC and AR for each target, for crates that bundle C code, such as SQLite
#   and aws-lc. The Tauri CLI sets these itself.
# - LIBCLANG_PATH, CLANG_PATH and BINDGEN_EXTRA_CLANG_ARGS for armv7, where
#   libmpv2-sys generates its bindings with the NDK's libclang. bindgen asks
#   the clang in CLANG_PATH, or else the first one on PATH, for the system
#   headers. A build machine's own clang names its own, and glibc's stdint.h
#   then hides Android's.

if [ -z "${NDK_HOME:-}" ]; then
  echo "Set NDK_HOME to the NDK, such as \$ANDROID_HOME/ndk/30.0.16248370" >&2
  # shellcheck disable=SC2317 # exit only runs when the file isn't sourced
  return 1 2>/dev/null || exit 1
fi

case "$(uname -s)" in
  Darwin) _cinette_host=darwin-x86_64 ;;
  *) _cinette_host=linux-x86_64 ;;
esac
_cinette_tc="$NDK_HOME/toolchains/llvm/prebuilt/$_cinette_host"
# The app's minSdk, in gen/android/app/build.gradle.kts.
_cinette_api=28

export CC_aarch64_linux_android="$_cinette_tc/bin/aarch64-linux-android$_cinette_api-clang"
export CC_armv7_linux_androideabi="$_cinette_tc/bin/armv7a-linux-androideabi$_cinette_api-clang"
export AR_aarch64_linux_android="$_cinette_tc/bin/llvm-ar"
export AR_armv7_linux_androideabi="$_cinette_tc/bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$CC_armv7_linux_androideabi"

export LIBCLANG_PATH="$_cinette_tc/lib"
export CLANG_PATH="$_cinette_tc/bin/clang"
_cinette_resources="$("$_cinette_tc/bin/clang" -print-resource-dir)"
export BINDGEN_EXTRA_CLANG_ARGS_armv7_linux_androideabi="--target=armv7a-linux-androideabi$_cinette_api --sysroot=$_cinette_tc/sysroot -isystem $_cinette_resources/include"

unset _cinette_host _cinette_tc _cinette_api _cinette_resources
