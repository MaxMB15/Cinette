// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { directionForKey, distanceIn, entryEdge, pickNext, type Box } from "./spatial-nav";

/** A box at `left`, `top` that is `width` by `height`. */
const box = (left: number, top: number, width = 100, height = 40): Box => ({
	left,
	top,
	right: left + width,
	bottom: top + height,
});

const candidates = (boxes: Record<string, Box>) =>
	Object.entries(boxes).map(([item, b]) => ({ item, box: b }));

describe("directionForKey", () => {
	it("maps each arrow key to its direction", () => {
		expect(directionForKey("ArrowUp")).toBe("up");
		expect(directionForKey("ArrowDown")).toBe("down");
		expect(directionForKey("ArrowLeft")).toBe("left");
		expect(directionForKey("ArrowRight")).toBe("right");
	});

	it("ignores other keys", () => {
		expect(directionForKey("Enter")).toBeNull();
		expect(directionForKey("toString")).toBeNull();
	});
});

describe("distanceIn", () => {
	const from = box(100, 100);

	it("measures from the edge it moves away from to the near edge ahead", () => {
		expect(distanceIn(from, box(250, 100), "right")).toBe(50);
		expect(distanceIn(from, box(0, 100, 60), "left")).toBe(40);
		expect(distanceIn(from, box(100, 160), "down")).toBe(20);
		expect(distanceIn(from, box(100, 40, 100, 30), "up")).toBe(30);
	});

	it("rejects boxes behind or level with the focus", () => {
		expect(distanceIn(from, box(0, 100), "right")).toBeNull();
		expect(distanceIn(from, box(250, 100), "left")).toBeNull();
		expect(distanceIn(from, box(100, 0), "down")).toBeNull();
		expect(distanceIn(from, box(100, 160), "up")).toBeNull();
	});

	it("allows two pixels of overlap and no more", () => {
		// The focus's right edge is 200.
		expect(distanceIn(from, box(198, 100), "right")).toBe(0);
		expect(distanceIn(from, box(197, 100), "right")).toBeNull();
		// Its bottom edge is 140.
		expect(distanceIn(from, box(100, 138), "down")).toBe(0);
		expect(distanceIn(from, box(100, 137), "down")).toBeNull();
		// Its left edge is 100.
		expect(distanceIn(from, box(0, 100, 102), "left")).toBe(0);
		expect(distanceIn(from, box(0, 100, 103), "left")).toBeNull();
		// Its top edge is 100.
		expect(distanceIn(from, box(100, 0, 100, 102), "up")).toBe(0);
		expect(distanceIn(from, box(100, 0, 100, 103), "up")).toBeNull();
	});

	it("counts sideways distance three times", () => {
		// 10 below and 30 ahead.
		expect(distanceIn(from, box(230, 150), "right")).toBe(30 + 3 * 10);
		// 10 above and 30 ahead.
		expect(distanceIn(from, box(0, 50, 70), "left")).toBe(30 + 3 * 10);
		// 20 right of it and 10 ahead.
		expect(distanceIn(from, box(220, 150), "down")).toBe(10 + 3 * 20);
		// 20 left of it and 10 ahead.
		expect(distanceIn(from, box(0, 50, 80), "up")).toBe(10 + 3 * 20);
	});

	it("counts no sideways distance for boxes that overlap across the direction", () => {
		expect(distanceIn(from, box(300, 130, 100, 100), "right")).toBe(100);
		expect(distanceIn(from, box(150, 200, 300), "down")).toBe(60);
	});
});

describe("pickNext", () => {
	it("moves down a list to the next row", () => {
		const rows = candidates({ a: box(0, 0), b: box(0, 50), c: box(0, 100) });
		expect(
			pickNext(
				box(0, 50),
				rows.filter((r) => r.item !== "b"),
				"down"
			)
		).toBe("c");
		expect(
			pickNext(
				box(0, 50),
				rows.filter((r) => r.item !== "b"),
				"up"
			)
		).toBe("a");
	});

	it("moves across a grid to the cell in the same row", () => {
		const grid = candidates({
			upRight: box(120, 0),
			right: box(120, 50),
			downRight: box(120, 100),
		});
		expect(pickNext(box(0, 50), grid, "right")).toBe("right");
	});

	it("prefers a box in line over a nearer one at an angle", () => {
		// The angled one is 10 ahead and 25 below, the one in line 70 ahead.
		const options = candidates({ angled: box(210, 165), inLine: box(270, 100) });
		expect(pickNext(box(100, 100), options, "right")).toBe("inLine");
	});

	it("goes from a sidebar item to the content beside it", () => {
		const page = candidates({ search: box(100, 0, 600), firstRow: box(100, 60, 600) });
		expect(pickNext(box(0, 50, 80, 60), page, "right")).toBe("firstRow");
	});

	it("keeps the first of two at the same distance", () => {
		const twins = candidates({ first: box(0, 100), second: box(0, 100) });
		expect(pickNext(box(0, 0), twins, "down")).toBe("first");
	});

	it("gives null when nothing is in that direction", () => {
		expect(pickNext(box(0, 0), candidates({ below: box(0, 100) }), "up")).toBeNull();
		expect(pickNext(box(0, 0), [], "down")).toBeNull();
	});
});

describe("entryEdge", () => {
	const outer = box(100, 100, 400, 200);

	it("is the edge a move comes in from", () => {
		expect(entryEdge(outer, "down")).toEqual({ left: 100, right: 500, top: 100, bottom: 100 });
		expect(entryEdge(outer, "up")).toEqual({ left: 100, right: 500, top: 300, bottom: 300 });
		expect(entryEdge(outer, "right")).toEqual({ left: 100, right: 100, top: 100, bottom: 300 });
		expect(entryEdge(outer, "left")).toEqual({ left: 500, right: 500, top: 100, bottom: 300 });
	});

	it("leads to the first thing inside in that direction", () => {
		const inside = candidates({ top: box(120, 120), bottom: box(120, 240) });
		expect(pickNext(entryEdge(outer, "down"), inside, "down")).toBe("top");
		expect(pickNext(entryEdge(outer, "up"), inside, "up")).toBe("bottom");
	});
});
