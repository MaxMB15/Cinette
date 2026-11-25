// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { nowSeconds, parseDateMs, timeAgo } from "./date";

describe("nowSeconds", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("drops the milliseconds from the current time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_760_000_000_999);
		expect(nowSeconds()).toBe(1_760_000_000);
	});
});

describe("parseDateMs", () => {
	it("parses a valid ISO string", () => {
		const ms = parseDateMs("2024-01-15T10:00:00Z");
		expect(ms).toBe(new Date("2024-01-15T10:00:00Z").getTime());
	});

	it("returns 0 for null", () => {
		expect(parseDateMs(null)).toBe(0);
	});

	it("returns 0 for undefined", () => {
		expect(parseDateMs(undefined)).toBe(0);
	});

	it("returns 0 for empty string", () => {
		expect(parseDateMs("")).toBe(0);
	});

	it("returns 0 for garbage string", () => {
		expect(parseDateMs("not-a-date")).toBe(0);
	});

	it("returns 0 for NaN-producing input", () => {
		expect(parseDateMs("NaN")).toBe(0);
	});
});

describe("timeAgo", () => {
	const NOW = 1_760_000_000_000;
	const MIN = 60_000;

	it.each([
		[0, "just now"],
		[MIN - 1, "just now"],
		[MIN, "1 min ago"],
		[59 * MIN, "59 min ago"],
		[60 * MIN, "1 h ago"],
		[24 * 60 * MIN - 1, "23 h ago"],
		[24 * 60 * MIN, "yesterday"],
		[48 * 60 * MIN - 1, "yesterday"],
		[48 * 60 * MIN, "2 days ago"],
	])("says %i ms ago is %s", (ago, text) => {
		expect(timeAgo(NOW - ago, NOW)).toBe(text);
	});
});
