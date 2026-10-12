// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

const HALF_HOUR = 1800;

/** A Unix time in seconds as a local clock time, such as 14:30. */
export const formatHHMM = (unix: number): string =>
	new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Unix times in seconds of every half hour boundary from windowStart up to, but not including, windowEnd. */
export const getGridMarks = (windowStart: number, windowEnd: number): number[] => {
	const marks: number[] = [];
	const first = Math.ceil(windowStart / HALF_HOUR) * HALF_HOUR;
	for (let t = first; t < windowEnd; t += HALF_HOUR) marks.push(t);
	return marks;
};

/** Where t falls in the window as a percentage, clamped to 0 through 100. */
export const toPct = (t: number, windowStart: number, windowTotal: number): number =>
	Math.max(0, Math.min(100, ((t - windowStart) / windowTotal) * 100));
