// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { formatSkip, formatTime } from "./format";

describe("formatTime", () => {
	// ── Under one hour (M:SS) ─────────────────────────────────────────

	it("formats 0 seconds as 0:00", () => {
		expect(formatTime(0)).toBe("0:00");
	});

	it("formats seconds under a minute", () => {
		expect(formatTime(7)).toBe("0:07");
	});

	it("formats exactly 59 seconds", () => {
		expect(formatTime(59)).toBe("0:59");
	});

	it("formats exactly 1 minute", () => {
		expect(formatTime(60)).toBe("1:00");
	});

	it("formats minutes and seconds", () => {
		expect(formatTime(187)).toBe("3:07");
	});

	it("formats 59:59 (just under an hour)", () => {
		expect(formatTime(3599)).toBe("59:59");
	});

	// ── One hour and above (H:MM:SS) ──────────────────────────────────

	it("formats exactly 1 hour", () => {
		expect(formatTime(3600)).toBe("1:00:00");
	});

	it("formats 1 hour with minutes and seconds", () => {
		expect(formatTime(3787)).toBe("1:03:07");
	});

	it("formats multi-hour durations", () => {
		expect(formatTime(7384)).toBe("2:03:04");
	});

	it("pads minutes to 2 digits in hour format", () => {
		expect(formatTime(3605)).toBe("1:00:05");
	});

	it("pads seconds to 2 digits in hour format", () => {
		expect(formatTime(3660)).toBe("1:01:00");
	});

	// ── Fractional / edge cases ───────────────────────────────────────

	it("truncates fractional seconds (floors)", () => {
		expect(formatTime(62.9)).toBe("1:02");
	});

	it("handles very large values", () => {
		expect(formatTime(86400)).toBe("24:00:00");
	});
});

describe("formatSkip", () => {
	it("signs forward skips with a plus", () => {
		expect(formatSkip(10)).toBe("+10s");
	});

	it("signs back skips with a minus sign", () => {
		expect(formatSkip(-30)).toBe("−30s");
	});

	it("leaves a skip that went nowhere unsigned", () => {
		expect(formatSkip(0)).toBe("0s");
		expect(formatSkip(-0)).toBe("0s");
	});
});
