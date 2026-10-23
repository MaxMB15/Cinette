// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * How long a converted stream waits before each try to start it again,
 * after the converter stopped by itself: at once, then longer each time.
 * After the last try the receiver says the stream stopped.
 */
export const RESTART_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000];

/** How long a stream that started again has to play before its next stop
 *  counts as a first one again. */
export const STEADY_MS = 60_000;

/** The tries to start a converted stream again, for one receiver. Cast and
 *  AirPlay each schedule their tries and say when the stream plays. */
export interface Restarts {
	/** How long to wait before the next try, or `null` once the tries have
	 *  run out. A stream that played steadily since the last try starts the
	 *  count again. */
	nextDelay: () => number | null;
	/** The stream was seen playing. */
	playing: () => void;
	/** The stream was sent again, so it hasn't played since. */
	sent: () => void;
	/** Forgets the tries, for a load, a seek, a stop or a release the user
	 *  asked for. */
	reset: () => void;
}

export const createRestarts = (now: () => number): Restarts => {
	let tries = 0;
	/** When the stream was first seen playing since it was last sent. */
	let playingSince: number | null = null;
	return {
		nextDelay: () => {
			if (playingSince !== null && now() - playingSince >= STEADY_MS) tries = 0;
			if (tries >= RESTART_DELAYS_MS.length) return null;
			const delay = RESTART_DELAYS_MS[tries];
			tries += 1;
			return delay;
		},
		playing: () => {
			playingSince ??= now();
		},
		sent: () => {
			playingSince = null;
		},
		reset: () => {
			tries = 0;
		},
	};
};
