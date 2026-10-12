// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** A skip this soon after the last one in the same direction adds to it. */
export const SKIP_RUN_MS = 1500;

/** Skips in a row in one direction, which add up. */
export interface SkipRun {
	/** 1 for forward, -1 for back. */
	direction: number;
	/** The position the first skip of the run started from, in seconds. */
	origin: number;
	/** Where the latest skip is headed, in seconds. */
	target: number;
	/** When the latest skip happened, in milliseconds. */
	at: number;
	/** How far the run has moved, in whole seconds. */
	total: number;
}

/**
 * Works out where a skip lands. The position is only polled once a second and
 * lags behind a seek, so a skip soon after another one in the same direction
 * starts from where that one was going. A skip stops at the start, or a second
 * before the end when the duration is known, and the run's total counts only
 * the distance it really moved.
 */
export const nextSkip = (
	last: SkipRun | null,
	position: number,
	duration: number,
	seconds: number,
	now: number
): SkipRun => {
	const direction = Math.sign(seconds);
	const run = last && now - last.at < SKIP_RUN_MS && last.direction === direction ? last : null;
	const origin = run ? run.origin : position;
	const from = run ? run.target : position;
	const end = duration > 0 ? duration - 1 : Infinity;
	// Clamping only ever shortens a skip. It never turns a forward skip from
	// past the end into a step back.
	const target =
		seconds < 0 ? Math.max(0, from + seconds) : Math.max(from, Math.min(from + seconds, end));
	return { direction, origin, target, at: now, total: Math.round(target - origin) };
};
