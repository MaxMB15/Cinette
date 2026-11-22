// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { nextSkip, SKIP_RUN_MS, videoBounds } from "./skip";

const MOVIE = videoBounds(600);

describe("nextSkip", () => {
	it("skips from the position when no run is going", () => {
		expect(nextSkip(null, 100, MOVIE, 10, 0)).toEqual({
			direction: 1,
			origin: 100,
			target: 110,
			at: 0,
			total: 10,
		});
	});

	it("adds a skip soon after another in the same direction to the run", () => {
		const first = nextSkip(null, 100, MOVIE, 10, 0);
		// The polled position hasn't caught up with the first seek yet.
		const second = nextSkip(first, 100, MOVIE, 10, 500);
		expect(second.target).toBe(120);
		expect(second.total).toBe(20);
	});

	it("starts a new run after a pause or a change of direction", () => {
		const first = nextSkip(null, 100, MOVIE, 10, 0);
		expect(nextSkip(first, 110, MOVIE, 10, SKIP_RUN_MS).total).toBe(10);
		const back = nextSkip(first, 110, MOVIE, -10, 500);
		expect(back.target).toBe(100);
		expect(back.total).toBe(-10);
	});

	it("counts only the distance moved when a skip hits the start", () => {
		const first = nextSkip(null, 14.6, MOVIE, -10, 0);
		expect(first.total).toBe(-10);
		const second = nextSkip(first, 14.6, MOVIE, -10, 500);
		expect(second.target).toBe(0);
		expect(second.total).toBe(-15);
	});

	it("stops a second before the end and counts only the distance moved", () => {
		const skip = nextSkip(null, 590, MOVIE, 30, 0);
		expect(skip.target).toBe(599);
		expect(skip.total).toBe(9);
		expect(nextSkip(skip, 590, MOVIE, 30, 500).total).toBe(9);
	});

	it("never turns a forward skip into a step back", () => {
		const skip = nextSkip(null, 599.5, MOVIE, 10, 0);
		expect(skip.target).toBe(599.5);
		expect(skip.total).toBe(0);
	});

	it("has no end to stop at when the duration is unknown", () => {
		expect(nextSkip(null, 100, videoBounds(0), 30, 0).target).toBe(130);
	});

	it("stops at a start other than zero", () => {
		expect(nextSkip(null, 105, { start: 100, end: 200 }, -10, 0).target).toBe(100);
	});

	it("never turns a back skip into a step forward", () => {
		const skip = nextSkip(null, 95, { start: 100, end: 200 }, -10, 0);
		expect(skip.target).toBe(95);
		expect(skip.total).toBe(0);
	});
});

describe("videoBounds", () => {
	it("runs from the start to a second before the end", () => {
		expect(videoBounds(600)).toEqual({ start: 0, end: 599 });
	});

	it("has no end when the duration is unknown", () => {
		expect(videoBounds(0).end).toBe(Infinity);
	});
});
