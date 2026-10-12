// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import {
	clampSubtitlePosition,
	DEFAULT_SUBTITLE_POSITION,
	isSubtitleNudgeKey,
	nudgeSubtitle,
	SUBTITLE_NUDGE_STEP,
} from "./subtitle-position";

describe("clampSubtitlePosition", () => {
	it("leaves a position inside the player alone", () => {
		expect(clampSubtitlePosition({ x: 30, y: 60 })).toEqual({ x: 30, y: 60 });
	});

	it("keeps the text off each edge", () => {
		expect(clampSubtitlePosition({ x: -10, y: -10 })).toEqual({ x: 5, y: 3 });
		expect(clampSubtitlePosition({ x: 110, y: 110 })).toEqual({ x: 95, y: 97 });
	});
});

describe("nudgeSubtitle", () => {
	const { x, y } = DEFAULT_SUBTITLE_POSITION;

	it("moves one step the way each arrow points", () => {
		const step = SUBTITLE_NUDGE_STEP;
		expect(nudgeSubtitle({ x, y }, "ArrowLeft")).toEqual({ x: x - step, y });
		expect(nudgeSubtitle({ x, y }, "ArrowRight")).toEqual({ x: x + step, y });
		expect(nudgeSubtitle({ x, y }, "ArrowUp")).toEqual({ x, y: y - step });
		expect(nudgeSubtitle({ x, y }, "ArrowDown")).toEqual({ x, y: y + step });
	});

	it("stops at the edge", () => {
		expect(nudgeSubtitle({ x: 6, y: 96 }, "ArrowLeft")).toEqual({ x: 5, y: 96 });
		expect(nudgeSubtitle({ x: 6, y: 96 }, "ArrowDown")).toEqual({ x: 6, y: 97 });
	});

	it("leaves the position alone for other keys", () => {
		expect(nudgeSubtitle({ x, y }, "Enter")).toEqual({ x, y });
	});
});

describe("isSubtitleNudgeKey", () => {
	it("is true only for the arrow keys", () => {
		for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
			expect(isSubtitleNudgeKey(key)).toBe(true);
		}
		expect(isSubtitleNudgeKey("Enter")).toBe(false);
		expect(isSubtitleNudgeKey("constructor")).toBe(false);
	});
});
