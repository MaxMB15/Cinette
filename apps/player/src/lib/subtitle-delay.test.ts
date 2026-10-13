// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { getDelayStep, getDelayInterval } from "./subtitle-delay";

describe("getDelayStep", () => {
	it("returns 0.1 for 0ms elapsed", () => {
		expect(getDelayStep(0)).toBeCloseTo(0.1);
	});
	it("returns 0.1 for 599ms elapsed", () => {
		expect(getDelayStep(599)).toBeCloseTo(0.1);
	});
	it("returns 0.5 for 600ms elapsed", () => {
		expect(getDelayStep(600)).toBeCloseTo(0.5);
	});
	it("returns 0.5 for 1499ms elapsed", () => {
		expect(getDelayStep(1499)).toBeCloseTo(0.5);
	});
	it("returns 1.0 for 1500ms elapsed", () => {
		expect(getDelayStep(1500)).toBeCloseTo(1.0);
	});
	it("returns 1.0 for 2999ms elapsed", () => {
		expect(getDelayStep(2999)).toBeCloseTo(1.0);
	});
	it("returns 5.0 for 3000ms elapsed", () => {
		expect(getDelayStep(3000)).toBeCloseTo(5.0);
	});
});

describe("getDelayInterval", () => {
	it("returns 200 for 0ms elapsed", () => {
		expect(getDelayInterval(0)).toBe(200);
	});
	it("returns 120 for 600ms elapsed", () => {
		expect(getDelayInterval(600)).toBe(120);
	});
	it("returns 80 for 1500ms elapsed", () => {
		expect(getDelayInterval(1500)).toBe(80);
	});
	it("returns 50 for 3000ms elapsed", () => {
		expect(getDelayInterval(3000)).toBe(50);
	});
});
