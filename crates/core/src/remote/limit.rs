// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A token bucket, for limits on how often something may happen.

use std::time::Instant;

/// Holds up to `burst` tokens and gains `rate` of them a second. Each thing
/// that happens takes one.
#[derive(Debug, Clone)]
pub(crate) struct TokenBucket {
    rate: f64,
    burst: f64,
    tokens: f64,
    /// When the tokens were last counted. `None` until the first take, so a
    /// bucket can be made before there's a time to give it.
    at: Option<Instant>,
}

impl TokenBucket {
    /// A full bucket.
    pub(crate) fn new(rate: f64, burst: f64) -> Self {
        Self {
            rate,
            burst,
            tokens: burst,
            at: None,
        }
    }

    /// Takes a token. False when there's none left.
    pub(crate) fn take(&mut self, now: Instant) -> bool {
        if let Some(at) = self.at {
            // `saturating_duration_since` is 0 for a time before `at`, so a
            // clock that steps back adds nothing.
            let elapsed = now.saturating_duration_since(at).as_secs_f64();
            self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
        }
        self.at = Some(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests;
