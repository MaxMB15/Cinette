// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** Where a D-pad press moves focus. */
export type Direction = "up" | "down" | "left" | "right";

/** A box on screen, in CSS pixels, as `getBoundingClientRect` gives it. */
export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

const DIRECTIONS = new Map<string, Direction>([
	["ArrowUp", "up"],
	["ArrowDown", "down"],
	["ArrowLeft", "left"],
	["ArrowRight", "right"],
]);

/** The direction an arrow key moves focus in, or null for any other key. */
export const directionForKey = (key: string): Direction | null => DIRECTIONS.get(key) ?? null;

/**
 * How far a box may reach back past the edge it's moving from and still
 * count as ahead. Neighbors in a list or grid often overlap by a border.
 */
const OVERLAP = 2;

/**
 * Sideways distance counts this many times as much as distance ahead, so a
 * press moves to what's in line with the focus before what's nearer at an
 * angle.
 */
const SIDEWAYS_WEIGHT = 3;

/** The gap between `[a1, a2]` and `[b1, b2]`, or 0 where they overlap. */
const gap = (a1: number, a2: number, b1: number, b2: number): number =>
	Math.max(0, b1 - a2, a1 - b2);

/**
 * How far `to` is from `from` in `direction`, or null when it isn't in that
 * direction. Smaller is nearer. Distance ahead is from the edge `from`
 * moves away from to the near edge of `to`. Sideways distance is 0 when the
 * two boxes overlap across the direction, so a box in the same row or
 * column always wins over one beside it.
 */
export const distanceIn = (from: Box, to: Box, direction: Direction): number | null => {
	let ahead: number;
	let sideways: number;
	switch (direction) {
		case "right":
			ahead = to.left - from.right;
			sideways = gap(from.top, from.bottom, to.top, to.bottom);
			break;
		case "left":
			ahead = from.left - to.right;
			sideways = gap(from.top, from.bottom, to.top, to.bottom);
			break;
		case "down":
			ahead = to.top - from.bottom;
			sideways = gap(from.left, from.right, to.left, to.right);
			break;
		case "up":
			ahead = from.top - to.bottom;
			sideways = gap(from.left, from.right, to.left, to.right);
			break;
	}
	if (ahead < -OVERLAP) return null;
	return Math.max(0, ahead) + SIDEWAYS_WEIGHT * sideways;
};

/**
 * The edge of `box` that focus enters it from when moving in `direction`,
 * as a box with no depth: its top edge for a move down, its bottom edge for
 * a move up, and so on. Moving from it reaches the first thing inside.
 */
export const entryEdge = (box: Box, direction: Direction): Box => {
	switch (direction) {
		case "down":
			return { ...box, bottom: box.top };
		case "up":
			return { ...box, top: box.bottom };
		case "right":
			return { ...box, right: box.left };
		case "left":
			return { ...box, left: box.right };
	}
};

/**
 * The candidate nearest to `from` in `direction`, or null when none is in
 * that direction. Of two at the same distance, the first wins, so callers
 * pass candidates in document order.
 */
export const pickNext = <T>(
	from: Box,
	candidates: readonly { item: T; box: Box }[],
	direction: Direction
): T | null => {
	let best: T | null = null;
	let bestDistance = Infinity;
	for (const { item, box } of candidates) {
		const distance = distanceIn(from, box, direction);
		if (distance !== null && distance < bestDistance) {
			best = item;
			bestDistance = distance;
		}
	}
	return best;
};
