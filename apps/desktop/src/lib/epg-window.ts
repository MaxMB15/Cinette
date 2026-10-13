// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

const HALF_HOUR = 1800;
const HOUR = 3600;

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

/** Unix times in seconds from `from` up to `to`. */
export interface TimeRange {
	from: number;
	to: number;
}

/**
 * The part of the guide to load for a window. It runs from at least 2 hours
 * before now to at least 4 hours after, and over all of the window, in whole
 * hours, and then one hour further. That last hour keeps the window inside
 * the range for a while as the clock moves it along.
 */
export const guideRangeFor = (now: number, windowStart: number, windowEnd: number): TimeRange => ({
	from: Math.floor(Math.min(windowStart, now - 2 * HOUR) / HOUR) * HOUR,
	to: (Math.ceil(Math.max(windowEnd, now + 4 * HOUR) / HOUR) + 1) * HOUR,
});

/** Whether all of the window lies inside the range. */
export const coversWindow = (range: TimeRange, windowStart: number, windowEnd: number): boolean =>
	range.from <= windowStart && windowEnd <= range.to;
