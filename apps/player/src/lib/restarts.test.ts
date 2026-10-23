// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { createRestarts, RESTART_DELAYS_MS, STEADY_MS } from "./restarts";

const clock = () => {
	const time = { now: 0 };
	return { time, restarts: createRestarts(() => time.now) };
};

describe("createRestarts", () => {
	it("waits longer before each try, then runs out", () => {
		const { restarts } = clock();
		const delays = RESTART_DELAYS_MS.map(() => restarts.nextDelay());
		expect(delays).toEqual([0, 1_000, 2_000, 4_000, 8_000]);
		expect(restarts.nextDelay()).toBeNull();
		expect(STEADY_MS).toBe(60_000);
	});

	it("starts again once the stream has played steadily", () => {
		const { time, restarts } = clock();
		restarts.nextDelay();
		restarts.nextDelay();
		restarts.sent();
		restarts.playing();
		// Not long enough yet.
		time.now = STEADY_MS - 1;
		expect(restarts.nextDelay()).toBe(2_000);
		restarts.sent();
		restarts.playing();
		time.now += STEADY_MS;
		expect(restarts.nextDelay()).toBe(0);
	});

	it("counts from when it was first seen playing since it was sent", () => {
		const { time, restarts } = clock();
		restarts.nextDelay();
		restarts.playing();
		time.now = STEADY_MS / 2;
		// Seen again later: still from the first time.
		restarts.playing();
		time.now = STEADY_MS;
		expect(restarts.nextDelay()).toBe(0);
		// Sent again, it hasn't played since.
		restarts.sent();
		time.now = STEADY_MS * 3;
		expect(restarts.nextDelay()).toBe(1_000);
	});

	it("forgets the tries on a reset", () => {
		const { restarts } = clock();
		RESTART_DELAYS_MS.forEach(() => restarts.nextDelay());
		restarts.reset();
		expect(restarts.nextDelay()).toBe(0);
	});
});
