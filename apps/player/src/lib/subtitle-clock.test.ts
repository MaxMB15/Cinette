// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import {
	clockAt,
	followReading,
	isNewReading,
	MAX_AHEAD_SECONDS,
	MAX_STEP_BACK_SECONDS,
	nextTick,
	startClock,
	type Reading,
} from "./subtitle-clock";
import type { SubtitleCue } from "./types";

const first: SubtitleCue = { start: 10, end: 12, text: "Where are you going?" };
const cues = [first];

/** A clock started from `position`, read at `at`, while the video plays. */
const running = (position: number, at = 0) => startClock({ position, at, moving: true });

describe("startClock", () => {
	it("starts at the reading and runs at most 1.5 s past it", () => {
		const reading: Reading = { position: 10, at: 500, moving: true };
		expect(startClock(reading)).toEqual({
			reading,
			position: 10,
			at: 500,
			moving: true,
			limit: 11.5,
		});
		expect(MAX_AHEAD_SECONDS).toBe(1.5);
	});
});

describe("isNewReading", () => {
	const clock = running(10, 500);

	it("knows the reading it follows", () => {
		expect(isNewReading(clock, 10, 500)).toBe(false);
	});

	it("takes the same position read later as a new reading", () => {
		expect(isNewReading(clock, 10, 1500)).toBe(true);
	});

	it("takes a new position read at the same time as a new reading", () => {
		expect(isNewReading(clock, 12, 500)).toBe(true);
	});
});

describe("clockAt", () => {
	it("runs a moving clock on in real time", () => {
		const clock = running(10, 500);
		expect(clockAt(clock, 1250)).toEqual({ ...clock, position: 10.75, at: 1250 });
	});

	it("stops a moving clock at its limit", () => {
		const clock = running(10, 500);
		expect(clockAt(clock, 4500)).toEqual({ ...clock, position: 11.5, at: 4500 });
	});

	it("never runs a clock back", () => {
		const clock = running(10, 500);
		expect(clockAt(clock, 400)).toEqual({ ...clock, at: 400 });
	});

	it("holds a stopped clock", () => {
		const clock = startClock({ position: 10, at: 500, moving: false });
		expect(clockAt(clock, 2000)).toEqual({ ...clock, at: 2000 });
	});
});

describe("followReading", () => {
	it("goes on from where it was for a reading a little behind it", () => {
		const reading: Reading = { position: 10.4, at: 500, moving: true };
		// The clock is at 10.5 when the reading is taken.
		expect(followReading(running(10), reading)).toEqual({
			...startClock(reading),
			position: 10.5,
		});
	});

	it("goes on from where it was for a reading MAX_STEP_BACK_SECONDS behind", () => {
		const reading: Reading = { position: 0, at: 0, moving: true };
		expect(MAX_STEP_BACK_SECONDS).toBe(0.15);
		expect(followReading(running(0.15), reading)).toEqual({
			...startClock(reading),
			position: 0.15,
		});
	});

	it("starts again from a reading further behind, as after a seek back", () => {
		const reading: Reading = { position: 10.3, at: 0, moving: true };
		expect(followReading(running(10.5), reading)).toEqual(startClock(reading));
	});

	it("jumps to a reading ahead of it", () => {
		const reading: Reading = { position: 11, at: 500, moving: true };
		expect(followReading(running(10), reading)).toEqual(startClock(reading));
	});

	it("starts again from a moving reading when it was stopped", () => {
		const clock = startClock({ position: 10.5, at: 0, moving: false });
		const reading: Reading = { position: 10.45, at: 500, moving: true };
		expect(followReading(clock, reading)).toEqual(startClock(reading));
	});

	it("stops at a reading that doesn't move", () => {
		const reading: Reading = { position: 10.45, at: 500, moving: false };
		expect(followReading(running(10), reading)).toEqual(startClock(reading));
	});
});

describe("nextTick", () => {
	it("moves on at once when the video starts or stops", () => {
		expect(nextTick(running(11), cues, 0, false, 0)).toBe(0);
		const stopped = startClock({ position: 11, at: 0, moving: false });
		expect(nextTick(stopped, cues, 0, true, 0)).toBe(0);
	});

	it("waits for nothing while the video doesn't move", () => {
		const stopped = startClock({ position: 9.5, at: 0, moving: false });
		expect(nextTick(stopped, cues, 0, false, 0)).toBeNull();
	});

	it("moves on a millisecond after the next cue starts", () => {
		expect(nextTick(running(9.5), cues, 0, true, 0)).toBe(501);
	});

	it("moves on a millisecond after the cue ends", () => {
		expect(nextTick(running(11.5), cues, 0, true, 0)).toBe(501);
	});

	it("counts the time since the clock last moved on", () => {
		expect(nextTick(running(9.5, 1000), cues, 0, true, 1250)).toBe(251);
	});

	it("rounds up to a whole millisecond", () => {
		expect(nextTick(running(9.9995), cues, 0, true, 0)).toBe(2);
	});

	it("moves on at once when the cue shown is out of date", () => {
		// The cues loaded, or the timer ran late.
		expect(nextTick(running(9.5), cues, 0, true, 750)).toBe(0);
		expect(nextTick(running(11.5), cues, 0, true, 750)).toBe(0);
	});

	it("shows each cue later for a positive delay", () => {
		expect(nextTick(running(11), cues, 2, true, 0)).toBe(1001);
		// The cue at 10.1 is out of date at 12.1 with a delay of 2.
		expect(nextTick(running(11.9), cues, 2, true, 200)).toBe(0);
	});

	it("waits for nothing when the next change is past the limit", () => {
		const late: SubtitleCue = { start: 10.6, end: 12, text: "Still there?" };
		expect(nextTick(running(9), [late], 0, true, 0)).toBeNull();
		// With a delay, the cue shown at 10 lasts past the limit at 13.5.
		expect(nextTick(running(12), cues, 2, true, 500)).toBeNull();
	});

	it("moves on for a cue that starts right at the limit", () => {
		expect(nextTick(running(8.5), cues, 0, true, 0)).toBe(1501);
	});

	it("waits for nothing once the clock is at its limit", () => {
		const ending: SubtitleCue = { start: 9, end: 10, text: "Hey." };
		const atLimit = clockAt(running(8.5), 1500);
		expect(atLimit.position).toBe(10);
		expect(nextTick(atLimit, [ending], 0, true, 1500)).toBeNull();
	});

	it("waits for nothing when no cue comes", () => {
		expect(nextTick(running(9), [], 0, true, 0)).toBeNull();
		expect(nextTick(running(13), cues, 0, true, 0)).toBeNull();
	});
});
