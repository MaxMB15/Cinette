// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cueAt, nextCueChange } from "./subtitle-timing";
import type { SubtitleCue } from "./types";

/**
 * The furthest the clock runs past the last position read, in seconds. The
 * player reads the position every second, so one that's older than this
 * means the readings have stopped.
 */
export const MAX_AHEAD_SECONDS = 1.5;

/**
 * The most a reading can be behind the clock, in seconds, and leave the clock
 * where it is. A reading arrives a little after mpv took it, so it's often a
 * few hundredths of a second behind. Going back for that would show a cue
 * that had just ended again for a moment.
 */
export const MAX_STEP_BACK_SECONDS = 0.15;

/** A position read from mpv. */
export interface Reading {
	/** Seconds into the video. */
	position: number;
	/** When it was read, in `performance.now()` milliseconds. */
	at: number;
	/** Whether the video plays on from it. */
	moving: boolean;
}

/** Where the video is between two readings. */
export interface SubtitleClock {
	/** The reading the clock follows. */
	reading: Reading;
	/** Seconds into the video at `at`. */
	position: number;
	/** In `performance.now()` milliseconds. */
	at: number;
	/** Whether the clock runs on from `position`. */
	moving: boolean;
	/** The furthest the clock runs, MAX_AHEAD_SECONDS past the reading. */
	limit: number;
}

/** A clock that starts at `reading`. */
export const startClock = (reading: Reading): SubtitleClock => ({
	reading,
	position: reading.position,
	at: reading.at,
	moving: reading.moving,
	limit: reading.position + MAX_AHEAD_SECONDS,
});

/**
 * The clock at `now`. A moving clock runs on in real time up to its limit,
 * since the app has no speed control. It never runs back, even for a `now`
 * before its own time.
 */
export const clockAt = (clock: SubtitleClock, now: number): SubtitleClock => {
	if (!clock.moving) return { ...clock, at: now };
	const ran = Math.max(0, now - clock.at) / 1000;
	return { ...clock, position: Math.min(clock.position + ran, clock.limit), at: now };
};

/**
 * Whether `position`, read at `at`, isn't the reading the clock follows. Two
 * readings can share a time, as a seek just after a load can.
 */
export const isNewReading = (clock: SubtitleClock, position: number, at: number): boolean =>
	clock.reading.at !== at || clock.reading.position !== position;

/**
 * The clock once `reading` arrives. It starts again from the reading, unless
 * both are moving and the reading is at most MAX_STEP_BACK_SECONDS behind
 * where the clock was when it was read. Then the clock goes on from there.
 */
export const followReading = (clock: SubtitleClock, reading: Reading): SubtitleClock => {
	const next = startClock(reading);
	if (!clock.moving || !reading.moving) return next;
	const { position } = clockAt(clock, reading.at);
	if (position - reading.position > MAX_STEP_BACK_SECONDS) return next;
	return { ...next, position: Math.max(position, reading.position) };
};

/**
 * Milliseconds until the clock should next move on, or null when nothing
 * changes until the next reading. `moving` is whether the video plays now,
 * and `delay` shows each cue later, as mpv's `sub-delay` does.
 *
 * The clock moves on at once when the video starts or stops, or when the cue
 * at the clock's position isn't the one for `now`, as after the cues or the
 * delay change. Otherwise it moves on just after the next cue starts or ends,
 * unless that's past its limit.
 */
export const nextTick = (
	clock: SubtitleClock,
	cues: SubtitleCue[],
	delay: number,
	moving: boolean,
	now: number
): number | null => {
	if (moving !== clock.moving) return 0;
	if (!moving) return null;
	const time = clockAt(clock, now).position;
	if (cueAt(cues, time - delay) !== cueAt(cues, clock.position - delay)) return 0;
	if (time >= clock.limit) return null;
	const wait = nextCueChange(cues, time - delay);
	if (wait === null || time + wait > clock.limit) return null;
	// A millisecond more puts the clock past the end of a cue.
	return Math.ceil(wait * 1000) + 1;
};
