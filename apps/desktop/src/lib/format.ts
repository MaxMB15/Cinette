// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * Format seconds into a human-readable time string.
 * - Under 1 hour: "M:SS" (e.g. "3:07")
 * - 1 hour or more: "H:MM:SS" (e.g. "1:03:07")
 */
export const formatTime = (seconds: number): string => {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) {
		return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	}
	return `${m}:${String(s).padStart(2, "0")}`;
};

/** A count and its noun, like "1 episode" or "1,200 episodes". */
export const formatCount = (count: number, noun: string, plural = `${noun}s`): string =>
	`${count.toLocaleString()} ${count === 1 ? noun : plural}`;

/** A skip as the player shows it, like "+10s" or "−30s". The minus is U+2212, not a hyphen. */
export const formatSkip = (seconds: number): string =>
	seconds === 0 ? "0s" : `${seconds > 0 ? "+" : "−"}${Math.abs(seconds)}s`;
