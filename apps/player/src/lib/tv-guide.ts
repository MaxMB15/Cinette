// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { toPct } from "./epg-window";
import type { EpgProgram } from "./types";

const HALF_HOUR = 1800;
/** How much time the TV guide's grid shows at once, in seconds. */
export const GUIDE_SPAN = 4 * HALF_HOUR;
/** How far past the current half hour the grid's rows run. */
export const GUIDE_AHEAD = 48 * HALF_HOUR;

/** A stretch of a channel's row in the grid: a program, or a gap with none. */
export interface GuideSlot {
	start: number;
	end: number;
	program: EpgProgram | null;
}

/** The start of the half hour that `t` falls in. */
export const halfHourOf = (t: number): number => Math.floor(t / HALF_HOUR) * HALF_HOUR;

/**
 * A channel's row from `from` to `to`: its programs in time order, cut to the
 * row, with gaps where the guide has nothing. A channel with no programs is
 * one gap. A program that starts before the one ahead of it ends starts at
 * that end instead.
 */
export const guideSlots = (
	programs: readonly EpgProgram[],
	from: number,
	to: number
): GuideSlot[] => {
	const slots: GuideSlot[] = [];
	let t = from;
	for (const program of programs) {
		if (program.startTime >= to) break;
		if (program.endTime <= t) continue;
		const start = Math.max(program.startTime, t);
		if (start > t) slots.push({ start: t, end: start, program: null });
		t = Math.min(program.endTime, to);
		slots.push({ start, end: t, program });
	}
	if (t < to) slots.push({ start: t, end: to, program: null });
	return slots;
};

/** Where in `slots` the time `at` falls. */
export const slotIndexAt = (slots: readonly GuideSlot[], at: number): number =>
	slots.findIndex((s) => s.start <= at && at < s.end);

/**
 * The time the cursor moves to when it steps `step` slots from the one at
 * `at`: the start of that slot, or now if it's on already. Null past the
 * row's ends and before now, since a program that's over can't be watched.
 */
export const stepSlot = (
	slots: readonly GuideSlot[],
	at: number,
	step: 1 | -1,
	now: number
): number | null => {
	const next = slots[slotIndexAt(slots, at) + step];
	if (!next || next.end <= now) return null;
	return Math.max(next.start, now);
};

/**
 * Where the grid starts so the cursor at `at` stays in view. It stays put
 * while the cursor is in its first three half hours. Otherwise it starts half
 * an hour before the cursor's half hour, so the cursor isn't on the edge, but
 * never before `earliest`.
 */
export const windowFor = (from: number, at: number, earliest: number): number => {
	if (at >= from && at < from + GUIDE_SPAN - HALF_HOUR) return from;
	return Math.max(earliest, halfHourOf(at) - HALF_HOUR);
};

/**
 * Where a block from `start` to `end` sits on a time line that shows `span`
 * seconds from `from`, with a small gap on each side.
 */
export const blockStyle = (start: number, end: number, from: number, span: number) => {
	const left = toPct(start, from, span);
	return {
		left: `calc(${left}% + 0.1rem)`,
		width: `calc(${toPct(end, from, span) - left}% - 0.2rem)`,
	};
};
