// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { formatHHMM } from "@/lib/epg-window";

const DAY_MS = 86_400_000;

/** Total watch time, such as 45s, 12m or 2h 5m. */
export const formatDuration = (seconds: number): string => {
	if (seconds < 60) return `${seconds}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h === 0) return `${m}m`;
	return `${h}h ${m}m`;
};

/**
 * When an entry was last watched. Today shows the time, yesterday says so,
 * and anything older shows the month and day.
 */
export const formatRelativeDate = (unixSeconds: number): string => {
	const date = new Date(unixSeconds * 1000);
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - DAY_MS);
	const entryDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	if (entryDay.getTime() === today.getTime()) return `Today ${formatHHMM(unixSeconds)}`;
	if (entryDay.getTime() === yesterday.getTime()) return "Yesterday";
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
};
