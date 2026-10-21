// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * Lets a history transfer save the open player's position before it reads
 * the history, so the other device resumes where this one is now. The
 * player registers how to save while it's mounted.
 */

/** Saves the player's position, and gives the id of the channel it has open. */
type Saver = () => Promise<string | null>;

let saver: Saver | null = null;

/** Registers the mounted player's saver. Returns how to take it back. */
export const setProgressSaver = (next: Saver): (() => void) => {
	saver = next;
	return () => {
		if (saver === next) saver = null;
	};
};

/** Saves the open player's position. Resolves with the channel it has open,
 *  or null with no player or when saving fails. */
export const saveProgressNow = async (): Promise<string | null> => {
	if (!saver) return null;
	try {
		return await saver();
	} catch {
		return null;
	}
};
