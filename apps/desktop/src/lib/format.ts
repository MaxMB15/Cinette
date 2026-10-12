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

/** A time of day such as "20:00", in local time and the user's clock format. */
export const formatClock = (unix: number): string =>
	new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A file size such as "350 MB" or "1.2 GB". */
export const formatBytes = (bytes: number): string =>
	bytes >= 1_000_000_000
		? `${(bytes / 1_000_000_000).toFixed(1)} GB`
		: `${Math.round(bytes / 1_000_000)} MB`;
