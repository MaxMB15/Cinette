// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatHHMM } from "./epg-window";
import { formatDuration, formatRelativeDate } from "./watch-history";

describe("formatDuration", () => {
	it("shows seconds under a minute", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(59)).toBe("59s");
	});

	it("shows whole minutes under an hour", () => {
		expect(formatDuration(60)).toBe("1m");
		expect(formatDuration(3599)).toBe("59m");
	});

	it("shows hours and minutes from an hour up", () => {
		expect(formatDuration(3600)).toBe("1h 0m");
		expect(formatDuration(2 * 3600 + 5 * 60 + 30)).toBe("2h 5m");
	});
});

describe("formatRelativeDate", () => {
	// Local times, so the test holds in any time zone.
	const at = (day: number, hour: number, minute = 0) =>
		new Date(2026, 9, day, hour, minute).getTime() / 1000;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 9, 12, 15, 0));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows the time for an entry from today", () => {
		const watched = at(12, 9, 30);
		expect(formatRelativeDate(watched)).toBe(`Today ${formatHHMM(watched)}`);
	});

	it("counts just after midnight as today", () => {
		const watched = at(12, 0, 1);
		expect(formatRelativeDate(watched)).toBe(`Today ${formatHHMM(watched)}`);
	});

	it("says yesterday for any time the day before", () => {
		expect(formatRelativeDate(at(11, 23, 59))).toBe("Yesterday");
		expect(formatRelativeDate(at(11, 0, 0))).toBe("Yesterday");
	});

	it("shows the month and day for older entries", () => {
		const watched = at(3, 20);
		const expected = new Date(watched * 1000).toLocaleDateString([], {
			month: "short",
			day: "numeric",
		});
		expect(formatRelativeDate(watched)).toBe(expected);
	});
});
