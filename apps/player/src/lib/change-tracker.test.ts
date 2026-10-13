// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { createChangeTracker } from "./change-tracker";

describe("createChangeTracker", () => {
	it("trusts a poll when nothing changed", () => {
		const tracker = createChangeTracker();
		expect(tracker.isStale(tracker.mark())).toBe(false);
	});

	it("distrusts a poll sent before a change", () => {
		const tracker = createChangeTracker();
		const mark = tracker.mark();
		tracker.begin()();
		expect(tracker.isStale(mark)).toBe(true);
	});

	it("distrusts every poll while a change runs", () => {
		const tracker = createChangeTracker();
		const done = tracker.begin();
		expect(tracker.isStale(tracker.mark())).toBe(true);
		done();
	});

	it("distrusts a poll sent while the change ran, even after it ends", () => {
		const tracker = createChangeTracker();
		const done = tracker.begin();
		const mark = tracker.mark();
		done();
		expect(tracker.isStale(mark)).toBe(true);
	});

	it("trusts a poll sent after the change ended", () => {
		const tracker = createChangeTracker();
		tracker.begin()();
		expect(tracker.isStale(tracker.mark())).toBe(false);
	});

	it("waits for overlapping changes to all end", () => {
		const tracker = createChangeTracker();
		const first = tracker.begin();
		const second = tracker.begin();
		first();
		expect(tracker.isStale(tracker.mark())).toBe(true);
		second();
		expect(tracker.isStale(tracker.mark())).toBe(false);
	});

	it("counts a change as ended once, however often it's ended", () => {
		const tracker = createChangeTracker();
		const first = tracker.begin();
		const second = tracker.begin();
		first();
		first();
		expect(tracker.isStale(tracker.mark())).toBe(true);
		second();
		expect(tracker.isStale(tracker.mark())).toBe(false);
	});
});
