// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** Tells which polled values a local change has made out of date. See `createChangeTracker`. */
export interface ChangeTracker {
	/** Call when a change starts, such as a seek. Call the returned function when it ends. */
	begin: () => () => void;
	/** Take before sending a poll, and pass to `isStale` when it returns. */
	mark: () => number;
	/** True when a change started after `mark` was taken, or one is still running. */
	isStale: (mark: number) => boolean;
}

/**
 * Tracks the app's own changes to one value that is also polled, such as the
 * playback position.
 *
 * The player asks mpv for its state once a second. A poll sent before a seek
 * can come back after it, and one that lands while the seek runs can too. Both
 * report the old position, and taking it would make the seek bar jump back
 * until the next poll. Keep the local value while `isStale` is true.
 */
export const createChangeTracker = (): ChangeTracker => {
	let generation = 0;
	let running = 0;
	return {
		begin: () => {
			generation++;
			running++;
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				running--;
				// A poll sent while the change ran may still be on its way.
				generation++;
			};
		},
		mark: () => generation,
		isStale: (mark) => running > 0 || mark !== generation,
	};
};
