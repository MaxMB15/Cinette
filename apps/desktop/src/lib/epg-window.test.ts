// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { formatHHMM, getGridMarks, toPct } from "./epg-window";

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
