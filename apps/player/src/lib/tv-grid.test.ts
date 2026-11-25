// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { firstVisibleRow, nextIndex, rowsPerPress } from "./tv-grid";

describe("nextIndex", () => {
	it("moves up and down a list and stops at its ends", () => {
		expect(nextIndex(1, 3, 1, "down")).toBe(2);
		expect(nextIndex(2, 3, 1, "down")).toBeNull();
		expect(nextIndex(1, 3, 1, "up")).toBe(0);
		expect(nextIndex(0, 3, 1, "up")).toBeNull();
	});

	it("leaves a list sideways", () => {
		expect(nextIndex(1, 3, 1, "left")).toBeNull();
		expect(nextIndex(1, 3, 1, "right")).toBeNull();
	});

	it("moves across a grid row and stops at its sides", () => {
		expect(nextIndex(1, 9, 3, "right")).toBe(2);
		expect(nextIndex(2, 9, 3, "right")).toBeNull();
		expect(nextIndex(4, 9, 3, "left")).toBe(3);
		expect(nextIndex(3, 9, 3, "left")).toBeNull();
	});

	it("moves between grid rows and keeps the column", () => {
		expect(nextIndex(4, 9, 3, "down")).toBe(7);
		expect(nextIndex(4, 9, 3, "up")).toBe(1);
		expect(nextIndex(3, 9, 3, "up")).toBe(0);
		expect(nextIndex(2, 9, 3, "up")).toBeNull();
	});

	it("lands on the last item of a short last row", () => {
		expect(nextIndex(2, 7, 3, "down")).toBe(5);
		expect(nextIndex(5, 7, 3, "down")).toBe(6);
		expect(nextIndex(6, 7, 3, "down")).toBeNull();
	});

	it("stops at the last item of a short last row", () => {
		expect(nextIndex(6, 7, 3, "right")).toBeNull();
		expect(nextIndex(5, 7, 3, "right")).toBeNull();
	});
});

describe("rowsPerPress", () => {
	it("moves one row for a press and the first seconds of holding it", () => {
		expect(rowsPerPress(0)).toBe(1);
		expect(rowsPerPress(29)).toBe(1);
	});

	it("speeds up, and then speeds up again", () => {
		expect(rowsPerPress(30)).toBe(5);
		expect(rowsPerPress(89)).toBe(5);
		expect(rowsPerPress(90)).toBe(25);
		expect(rowsPerPress(1000)).toBe(25);
	});
});

describe("firstVisibleRow", () => {
	it("stays at the top until the cursor reaches the middle row", () => {
		expect(firstVisibleRow(0, 100, 9)).toBe(0);
		expect(firstVisibleRow(4, 100, 9)).toBe(0);
	});

	it("moves the rows under the cursor after that", () => {
		expect(firstVisibleRow(5, 100, 9)).toBe(1);
		expect(firstVisibleRow(50, 100, 9)).toBe(46);
	});

	it("stops with the last row at the bottom", () => {
		expect(firstVisibleRow(95, 100, 9)).toBe(91);
		expect(firstVisibleRow(99, 100, 9)).toBe(91);
	});

	it("keeps a list shorter than the screen at the top", () => {
		expect(firstVisibleRow(2, 3, 9)).toBe(0);
	});

	it("rounds the middle down for an even number of rows", () => {
		expect(firstVisibleRow(5, 100, 8)).toBe(1);
		expect(firstVisibleRow(4, 100, 8)).toBe(0);
	});
});
