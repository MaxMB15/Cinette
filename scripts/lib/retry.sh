# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

# Sourced by the release scripts, not run on its own.

# Run a command until it succeeds, up to <attempts> times. Each wait is <delay>
# seconds longer than the last, so `retry 5 20` waits 20, 40, 60 and 80 seconds.
#
# Usage: retry <attempts> <delay> <command> [args...]
retry() {
  local attempts=$1 delay=$2 attempt wait
  shift 2
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if "$@"; then
      return 0
    fi
    if ((attempt < attempts)); then
      wait=$((attempt * delay))
      echo "'$*' failed, attempt $attempt of $attempts. Retrying in ${wait}s..." >&2
      sleep "$wait"
    fi
  done
  return 1
}
