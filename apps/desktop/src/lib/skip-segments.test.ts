// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import {
	extendRun,
	MAX_PLAY_STEP,
	reachedAutoSkip,
	runsToEnd,
	segmentAt,
	segmentGroup,
	segmentKey,
	skipActionFor,
	skipLabel,
	skippedLabel,
} from "./skip-segments";
import { makeSegment } from "@/test/segments";

describe("segmentGroup", () => {
	it("puts intros and recaps at the opening, credits and previews at the end", () => {
		expect(segmentGroup("intro")).toBe("opening");
		expect(segmentGroup("recap")).toBe("opening");
		expect(segmentGroup("credits")).toBe("ending");
		expect(segmentGroup("preview")).toBe("ending");
	});
});

describe("segmentKey", () => {
	it("tells segments apart by kind, which stays the same when the times move", () => {
		const intro = makeSegment();
		expect(segmentKey(intro)).toBe(segmentKey(makeSegment({ start: 58, end: 118 })));
		expect(segmentKey(intro)).not.toBe(segmentKey(makeSegment({ kind: "recap" })));
	});
});

describe("segmentAt", () => {
	const recap = makeSegment({ kind: "recap", start: 0, end: 30 });
	const intro = makeSegment({ start: 60, end: 120 });

	it("finds the segment playing", () => {
		expect(segmentAt([recap, intro], 0)).toBe(recap);
		expect(segmentAt([recap, intro], 60)).toBe(intro);
		expect(segmentAt([recap, intro], 118.9)).toBe(intro);
	});

	it("finds nothing between segments or in a segment's last second", () => {
		expect(segmentAt([recap, intro], 45)).toBeNull();
		expect(segmentAt([recap, intro], 119)).toBeNull();
		expect(segmentAt([recap, intro], 120)).toBeNull();
		expect(segmentAt([], 60)).toBeNull();
	});
});

describe("runsToEnd", () => {
	it("counts a segment ending within 5 seconds of the end", () => {
		const credits = makeSegment({ kind: "credits", start: 2500, end: 2595 });
		expect(runsToEnd(credits, 2600)).toBe(true);
		expect(runsToEnd(credits, 2601)).toBe(false);
	});

	it("is false while the length isn't known", () => {
		expect(runsToEnd(makeSegment({ end: 0 }), 0)).toBe(false);
	});
});

describe("skipActionFor", () => {
	const credits = makeSegment({ kind: "credits", start: 2500, end: 2600 });

	it("jumps to the end of a segment with more video after it", () => {
		expect(skipActionFor(makeSegment(), 2600, false)).toEqual({ type: "seek", to: 120 });
		expect(skipActionFor(credits, 2700, true)).toEqual({ type: "seek", to: 2600 });
	});

	it("moves on to the next episode from a segment that runs to the end", () => {
		expect(skipActionFor(credits, 2600, true)).toEqual({ type: "next" });
	});

	it("has nothing to skip to at the end of a movie or the last episode", () => {
		expect(skipActionFor(credits, 2600, false)).toBeNull();
	});
});

describe("labels", () => {
	it("names the segment or the next episode", () => {
		expect(skipLabel("intro", { type: "seek", to: 120 })).toBe("Skip intro");
		expect(skipLabel("credits", { type: "seek", to: 120 })).toBe("Skip credits");
		expect(skipLabel("credits", { type: "next" })).toBe("Next episode");
		expect(skippedLabel("recap")).toBe("Skipped recap");
	});
});

describe("extendRun", () => {
	it("starts a stretch at the first position", () => {
		expect(extendRun(null, 42)).toEqual({ start: 42, last: 42 });
	});

	it("keeps going through steps of normal playback and pauses", () => {
		let run = extendRun(null, 10);
		run = extendRun(run, 11);
		run = extendRun(run, 11);
		run = extendRun(run, 11 + MAX_PLAY_STEP);
		expect(run).toEqual({ start: 10, last: 11 + MAX_PLAY_STEP });
	});

	it("starts again after a seek either way", () => {
		const run = extendRun(extendRun(null, 10), 11);
		expect(extendRun(run, 5)).toEqual({ start: 5, last: 5 });
		expect(extendRun(run, 11 + MAX_PLAY_STEP + 0.1)).toEqual({
			start: 11 + MAX_PLAY_STEP + 0.1,
			last: 11 + MAX_PLAY_STEP + 0.1,
		});
	});
});

describe("reachedAutoSkip", () => {
	const intro = makeSegment({ start: 60, end: 120, autoFrom: 62 });

	it("is true once playback has run into the point it may skip from", () => {
		expect(reachedAutoSkip(intro, { start: 0, last: 62 }, 62)).toBe(true);
		expect(reachedAutoSkip(intro, { start: 59, last: 63 }, 63)).toBe(true);
	});

	it("is false before that point", () => {
		expect(reachedAutoSkip(intro, { start: 0, last: 61 }, 61)).toBe(false);
	});

	it("is false after a seek into the segment, even before that point", () => {
		expect(reachedAutoSkip(intro, { start: 60, last: 63 }, 63)).toBe(false);
		expect(reachedAutoSkip(intro, { start: 61, last: 63 }, 63)).toBe(false);
		expect(reachedAutoSkip(intro, { start: 70, last: 71 }, 71)).toBe(false);
	});

	it("counts playback begun in the first seconds as before a segment at the start", () => {
		const recap = makeSegment({ kind: "recap", start: 0, end: 30, autoFrom: 2, autoTo: 28 });
		expect(reachedAutoSkip(recap, { start: 0, last: 2 }, 2)).toBe(true);
		expect(reachedAutoSkip(recap, { start: MAX_PLAY_STEP - 1, last: 4 }, 4)).toBe(true);
		expect(reachedAutoSkip(recap, { start: MAX_PLAY_STEP, last: 5 }, 5)).toBe(false);
	});

	it("is false for times only good enough for a button", () => {
		const unchecked = makeSegment({ fit: "unchecked", autoFrom: null, autoTo: null });
		expect(reachedAutoSkip(unchecked, { start: 0, last: 65 }, 65)).toBe(false);
	});
});
