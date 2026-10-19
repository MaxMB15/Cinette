// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** Counts by name, such as renders per component or calls per command. */
export interface Tally {
	add: (name: string) => void;
	/** The counts so far, largest first, then by name. */
	entries: () => [string, number][];
	reset: () => void;
}

export const createTally = (): Tally => {
	const counts = new Map<string, number>();
	return {
		add: (name) => counts.set(name, (counts.get(name) ?? 0) + 1),
		entries: () => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
		reset: () => counts.clear(),
	};
};
