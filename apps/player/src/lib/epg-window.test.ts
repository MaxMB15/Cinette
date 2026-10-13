// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { coversWindow, formatHHMM, getGridMarks, guideRangeFor, toPct } from "./epg-window";

describe("formatHHMM", () => {
	it("matches the locale's two digit hour and minute format", () => {
		const unix = Date.UTC(2026, 9, 12, 14, 5) / 1000;
		const expected = new Date(unix * 1000).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		expect(formatHHMM(unix)).toBe(expected);
	});
});

describe("getGridMarks", () => {
	it("lists each half hour boundary from the first one after the start", () => {
		expect(getGridMarks(1000, 6000)).toEqual([1800, 3600, 5400]);
	});

	it("includes the start when it falls on a boundary", () => {
		expect(getGridMarks(3600, 5400)).toEqual([3600]);
	});

	it("leaves out a boundary equal to the end", () => {
		expect(getGridMarks(0, 1800)).toEqual([0]);
	});

	it("returns no marks for an empty window", () => {
		expect(getGridMarks(100, 100)).toEqual([]);
	});
});

describe("toPct", () => {
	it("maps a time inside the window to its share of the window", () => {
		expect(toPct(1500, 1000, 2000)).toBe(25);
	});

	it("clamps times before the window to 0", () => {
		expect(toPct(500, 1000, 2000)).toBe(0);
	});

	it("clamps times after the window to 100", () => {
		expect(toPct(5000, 1000, 2000)).toBe(100);
	});
});

const at = (hours: number, minutes = 0) => hours * 3600 + minutes * 60;

describe("guideRangeFor", () => {
	it("loads 2 hours back and 4 ahead in whole hours, then an hour more", () => {
		const now = at(10, 20);
		expect(guideRangeFor(now, at(9, 20), at(12, 20))).toEqual({ from: at(8), to: at(16) });
	});

	it("starts and ends on the hour when now is on one", () => {
		expect(guideRangeFor(at(10), at(9), at(12))).toEqual({ from: at(8), to: at(15) });
	});

	it("covers all of a window that reaches further", () => {
		const now = at(10, 20);
		expect(guideRangeFor(now, at(6, 50), at(17, 40))).toEqual({ from: at(6), to: at(19) });
	});
});

describe("coversWindow", () => {
	const range = { from: at(8), to: at(15) };

	it("covers a window inside the range, edges included", () => {
		expect(coversWindow(range, at(9), at(12))).toBe(true);
		expect(coversWindow(range, at(8), at(15))).toBe(true);
	});

	it("doesn't cover a window that starts before the range", () => {
		expect(coversWindow(range, at(7, 59), at(12))).toBe(false);
	});

	it("doesn't cover a window that ends after the range", () => {
		expect(coversWindow(range, at(9), at(15, 1))).toBe(false);
	});
});
