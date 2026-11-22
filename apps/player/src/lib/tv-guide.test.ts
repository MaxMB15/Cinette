// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import {
	blockStyle,
	GUIDE_AHEAD,
	GUIDE_SPAN,
	guideSlots,
	halfHourOf,
	slotIndexAt,
	stepSlot,
	windowFor,
	type GuideSlot,
} from "./tv-guide";
import type { EpgProgram } from "./types";

const HALF = 1800;
const NINE = 1_800_000_000 - (1_800_000_000 % HALF);

const program = (title: string, startTime: number, endTime: number): EpgProgram => ({
	channelId: "news.tv",
	title,
	startTime,
	endTime,
});

const news = program("News", NINE - HALF, NINE + HALF);
const film = program("Film", NINE + HALF, NINE + 4 * HALF);
const late = program("Late", NINE + 5 * HALF, NINE + 6 * HALF);

const gap = (start: number, end: number): GuideSlot => ({ start, end, program: null });

describe("the grid's size", () => {
	it("shows two hours at a time and runs a day ahead", () => {
		expect(GUIDE_SPAN).toBe(2 * 3600);
		expect(GUIDE_AHEAD).toBe(24 * 3600);
	});
});

describe("halfHourOf", () => {
	it("gives the start of the half hour", () => {
		expect(halfHourOf(NINE)).toBe(NINE);
		expect(halfHourOf(NINE + HALF - 1)).toBe(NINE);
		expect(halfHourOf(NINE + HALF)).toBe(NINE + HALF);
	});
});

describe("guideSlots", () => {
	it("cuts the programs to the row and fills the gaps between them", () => {
		expect(guideSlots([news, film, late], NINE, NINE + 8 * HALF)).toEqual([
			{ start: NINE, end: NINE + HALF, program: news },
			{ start: NINE + HALF, end: NINE + 4 * HALF, program: film },
			gap(NINE + 4 * HALF, NINE + 5 * HALF),
			{ start: NINE + 5 * HALF, end: NINE + 6 * HALF, program: late },
			gap(NINE + 6 * HALF, NINE + 8 * HALF),
		]);
	});

	it("starts with a gap before the first program and cuts the last one at the row's end", () => {
		expect(guideSlots([film], NINE, NINE + 2 * HALF)).toEqual([
			gap(NINE, NINE + HALF),
			{ start: NINE + HALF, end: NINE + 2 * HALF, program: film },
		]);
	});

	it("leaves out programs over before the row and starting at its end or later", () => {
		const early = program("Early", NINE - 2 * HALF, NINE);
		expect(guideSlots([early, news, film, late], NINE, NINE + HALF)).toEqual([
			{ start: NINE, end: NINE + HALF, program: news },
		]);
	});

	it("starts a program that overlaps the one before it where that one ends", () => {
		const overlap = program("Overlap", NINE, NINE + 2 * HALF);
		expect(guideSlots([news, overlap], NINE, NINE + 2 * HALF)).toEqual([
			{ start: NINE, end: NINE + HALF, program: news },
			{ start: NINE + HALF, end: NINE + 2 * HALF, program: overlap },
		]);
	});

	it("is one gap for a channel with no programs", () => {
		expect(guideSlots([], NINE, NINE + HALF)).toEqual([gap(NINE, NINE + HALF)]);
	});
});

describe("slotIndexAt", () => {
	const slots = guideSlots([news, film], NINE, NINE + 6 * HALF);

	it("finds the slot a time falls in, from its first moment to before its end", () => {
		expect(slotIndexAt(slots, NINE)).toBe(0);
		expect(slotIndexAt(slots, NINE + HALF - 1)).toBe(0);
		expect(slotIndexAt(slots, NINE + HALF)).toBe(1);
		expect(slotIndexAt(slots, NINE + 5 * HALF)).toBe(2);
	});

	it("finds no slot for a time outside the row", () => {
		expect(slotIndexAt(slots, NINE - 1)).toBe(-1);
		expect(slotIndexAt(slots, NINE + 6 * HALF)).toBe(-1);
	});
});

describe("stepSlot", () => {
	const slots = guideSlots([news, film, late], NINE, NINE + 8 * HALF);
	const now = NINE + 600;

	it("moves Right to the start of the next slot, gaps too", () => {
		expect(stepSlot(slots, now, 1, now)).toBe(NINE + HALF);
		expect(stepSlot(slots, NINE + HALF, 1, now)).toBe(NINE + 4 * HALF);
		expect(stepSlot(slots, NINE + 4 * HALF, 1, now)).toBe(NINE + 5 * HALF);
	});

	it("moves Left to the start of the slot before, or to now when that one is on", () => {
		expect(stepSlot(slots, NINE + 5 * HALF, -1, now)).toBe(NINE + 4 * HALF);
		expect(stepSlot(slots, NINE + HALF, -1, now)).toBe(now);
	});

	it("goes nowhere past the row's ends", () => {
		expect(stepSlot(slots, now, -1, now)).toBeNull();
		expect(stepSlot(slots, NINE + 7 * HALF, 1, now)).toBeNull();
	});

	it("goes nowhere back to a program that's over", () => {
		const later = NINE + HALF;
		expect(stepSlot(slots, later, -1, later)).toBeNull();
		expect(stepSlot(slots, later, -1, later - 1)).toBe(later - 1);
	});
});

describe("windowFor", () => {
	it("stays put while the cursor is in its first three half hours", () => {
		expect(windowFor(NINE, NINE, NINE)).toBe(NINE);
		expect(windowFor(NINE, NINE + 3 * HALF - 1, NINE)).toBe(NINE);
		expect(windowFor(NINE + 2 * HALF, NINE + 2 * HALF, NINE)).toBe(NINE + 2 * HALF);
	});

	it("moves on so the cursor's half hour is second when it reaches the last one", () => {
		expect(windowFor(NINE, NINE + 3 * HALF, NINE)).toBe(NINE + 2 * HALF);
		expect(windowFor(NINE, NINE + 9 * HALF + 60, NINE)).toBe(NINE + 8 * HALF);
	});

	it("moves back the same way when the cursor goes before it, but not before the earliest", () => {
		expect(windowFor(NINE + 4 * HALF, NINE + 3 * HALF, NINE)).toBe(NINE + 2 * HALF);
		expect(windowFor(NINE + 2 * HALF, NINE + HALF, NINE + HALF)).toBe(NINE + HALF);
		expect(windowFor(NINE + 2 * HALF, NINE + HALF, NINE)).toBe(NINE);
	});
});

describe("blockStyle", () => {
	it("places a block by its share of the span, with a gap on each side", () => {
		expect(blockStyle(NINE + HALF, NINE + 2 * HALF, NINE, GUIDE_SPAN)).toEqual({
			left: "calc(25% + 0.1rem)",
			width: "calc(25% - 0.2rem)",
		});
	});

	it("cuts a block to the time line", () => {
		expect(blockStyle(NINE - HALF, NINE + 8 * HALF, NINE, GUIDE_SPAN)).toEqual({
			left: "calc(0% + 0.1rem)",
			width: "calc(100% - 0.2rem)",
		});
	});
});
