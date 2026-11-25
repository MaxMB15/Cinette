// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Direction } from "./spatial-nav";

/**
 * Where a D-pad press moves the cursor in a list or grid of `count` items,
 * or null when it would leave the list, so the press can move focus to
 * whatever is beside it. A press down from the row above a short last row
 * lands on that row's last item.
 */
export const nextIndex = (
	index: number,
	count: number,
	columns: number,
	direction: Direction
): number | null => {
	const column = index % columns;
	switch (direction) {
		case "left":
			return column === 0 ? null : index - 1;
		case "right":
			return column === columns - 1 || index === count - 1 ? null : index + 1;
		case "up":
			return index < columns ? null : index - columns;
		case "down": {
			const lastRow = Math.floor((count - 1) / columns);
			if (Math.floor(index / columns) === lastRow) return null;
			return Math.min(index + columns, count - 1);
		}
	}
};

/**
 * How many rows a press moves a list, after `repeats` repeats of a held key. A
 * remote repeats about 20 times a second, so a list speeds up after about 2
 * seconds and again after about 5, and the end of a list of thousands is seconds away.
 */
export const rowsPerPress = (repeats: number): number => {
	if (repeats < 30) return 1;
	return repeats < 90 ? 5 : 25;
};

/**
 * The first row a list of `rowCount` rows shows, `visibleRows` at a time.
 * The cursor moves down to the middle row and then stays there while the
 * rows move under it, so it never hides at an edge. It needs no scroll
 * position to remember, so a list opened again looks as it did.
 */
export const firstVisibleRow = (
	activeRow: number,
	rowCount: number,
	visibleRows: number
): number => {
	const last = Math.max(0, rowCount - visibleRows);
	return Math.min(last, Math.max(0, activeRow - Math.floor(visibleRows / 2)));
};
