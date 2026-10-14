// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { cueAt, nextCueChange } from "./subtitle-timing";
import type { SubtitleCue } from "./types";

const first: SubtitleCue = { start: 10, end: 12, text: "Where are you going?" };
const second: SubtitleCue = { start: 15, end: 18, text: "Home." };
const cues = [first, second];

describe("cueAt", () => {
	it("finds the cue that covers the time, from its start to its end", () => {
		expect(cueAt(cues, 10)).toBe(first);
		expect(cueAt(cues, 11)).toBe(first);
		expect(cueAt(cues, 12)).toBe(first);
		expect(cueAt(cues, 16)).toBe(second);
	});

	it("finds none before, between or after the cues", () => {
		expect(cueAt(cues, 9.9)).toBeUndefined();
		expect(cueAt(cues, 12.1)).toBeUndefined();
		expect(cueAt(cues, 18.1)).toBeUndefined();
		expect(cueAt([], 11)).toBeUndefined();
	});

	it("shows the first of two cues that overlap", () => {
		const overlap: SubtitleCue = { start: 11, end: 14, text: "Wait." };
		expect(cueAt([first, overlap], 11.5)).toBe(first);
		expect(cueAt([first, overlap], 13)).toBe(overlap);
	});
});

describe("nextCueChange", () => {
	it("counts to the next start before the cues and between them", () => {
		expect(nextCueChange(cues, 4)).toBe(6);
		expect(nextCueChange(cues, 13)).toBe(2);
	});

	it("counts to the end of the cue that's showing", () => {
		expect(nextCueChange(cues, 10)).toBe(2);
		expect(nextCueChange(cues, 11.5)).toBe(0.5);
		expect(nextCueChange(cues, 12)).toBe(0);
	});

	it("takes the nearest change, wherever the cue is in the list", () => {
		expect(nextCueChange([second, first], 4)).toBe(6);
		const overlap: SubtitleCue = { start: 11, end: 14, text: "Wait." };
		expect(nextCueChange([overlap, first], 10.5)).toBe(0.5);
		expect(nextCueChange([first, overlap], 11.5)).toBe(0.5);
		expect(nextCueChange([overlap, first], 12.5)).toBe(1.5);
	});

	it("gives null after the last cue and with no cues", () => {
		expect(nextCueChange(cues, 18.5)).toBeNull();
		expect(nextCueChange([], 0)).toBeNull();
	});
});
