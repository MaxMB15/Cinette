// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { formatBehind, liveBehind, liveEdge, nextAnchor } from "./live-seek";

const ANCHOR = { position: 100, at: 5000 };

describe("liveEdge", () => {
	it("moves on with the time since the anchor", () => {
		expect(liveEdge(ANCHOR, 7500)).toBe(102.5);
	});
});

describe("nextAnchor", () => {
	it("starts from the first sample", () => {
		const sample = { position: 40, at: 1000 };
		expect(nextAnchor(null, sample)).toBe(sample);
	});

	it("keeps the anchor while the position trails the live edge", () => {
		expect(nextAnchor(ANCHOR, { position: 90, at: 8000 })).toBe(ANCHOR);
	});

	it("keeps the anchor when the position is right on the live edge", () => {
		expect(nextAnchor(ANCHOR, { position: 103, at: 8000 })).toBe(ANCHOR);
	});

	it("moves to a position past where the live edge was thought to be", () => {
		const sample = { position: 104, at: 8000 };
		expect(nextAnchor(ANCHOR, sample)).toBe(sample);
	});
});

describe("liveBehind", () => {
	it("is nothing before there's an anchor", () => {
		expect(liveBehind(null, 10, 1000)).toBe(0);
	});

	it("counts the seconds from the position to the live edge", () => {
		expect(liveBehind(ANCHOR, 80, 9000)).toBe(24);
	});

	it("is never less than nothing", () => {
		expect(liveBehind(ANCHOR, 110, 5000)).toBe(0);
	});
});

describe("formatBehind", () => {
	it("puts a minus sign before the time", () => {
		expect(formatBehind(40)).toBe("−0:40");
	});
});
