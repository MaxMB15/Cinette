// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveCue } from "./useActiveCue";
import type { SubtitleCue } from "@/lib/types";

const first: SubtitleCue = { start: 10, end: 12, text: "Where are you going?" };
const short: SubtitleCue = { start: 9.2, end: 9.5, text: "Hey." };
const next: SubtitleCue = { start: 12.5, end: 14, text: "Home." };
const cues = [first];

interface Props {
	cues: SubtitleCue[];
	position: number;
	positionAt: number;
	delay: number;
	playing: boolean;
}

/** A reading of `position` taken now, while the video plays with no delay. */
const readingOf = (position: number, props: Partial<Omit<Props, "position">> = {}): Props => ({
	cues,
	position,
	positionAt: performance.now(),
	delay: 0,
	playing: true,
	...props,
});

const renderCue = (props: Props) =>
	renderHook((p: Props) => useActiveCue(p.cues, p.position, p.positionAt, p.delay, p.playing), {
		initialProps: props,
	});

/** Moves the clock on. React renders once at the end, so a step runs at most one cue change. */
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useActiveCue", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	});
	afterEach(() => vi.useRealTimers());

	it("shows the cue at the position and runs no timer while paused", () => {
		const { result } = renderCue(readingOf(11, { playing: false }));
		expect(result.current).toBe(first);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("starts a cue on time between two readings", () => {
		const { result } = renderCue(readingOf(9.5));
		expect(result.current).toBeUndefined();
		advance(498);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(first);
	});

	it("ends a cue on time between two readings", () => {
		const { result } = renderCue(readingOf(11.5));
		expect(result.current).toBe(first);
		advance(498);
		expect(result.current).toBe(first);
		advance(4);
		expect(result.current).toBeUndefined();
	});

	it("shows a cue shorter than the time between two readings", () => {
		const { result } = renderCue(readingOf(9, { cues: [short, first] }));
		advance(198);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(short);
		advance(296);
		expect(result.current).toBe(short);
		advance(4);
		expect(result.current).toBeUndefined();
		// Each change counts on from the one before, so the next cue is on time too.
		advance(494);
		expect(result.current).toBeUndefined();
		advance(8);
		expect(result.current).toBe(first);
	});

	it("starts again from a reading well behind the clock, as after a seek back", () => {
		const { result, rerender } = renderCue(readingOf(9, { cues: [short, first] }));
		advance(202);
		advance(300);
		expect(result.current).toBeUndefined();
		// The clock is at 9.5, so it goes back to 9.1 rather than on from there.
		rerender(readingOf(9.1, { cues: [short, first] }));
		expect(result.current).toBeUndefined();
		advance(98);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(short);
	});

	it("doesn't show a cue that just ended again for a reading a little behind", () => {
		const { result, rerender } = renderCue(readingOf(11.9));
		expect(result.current).toBe(first);
		advance(102);
		expect(result.current).toBeUndefined();
		// mpv took this reading before the cue ended, and it arrives after.
		rerender(readingOf(11.95));
		expect(result.current).toBeUndefined();
	});

	it("jumps to a reading ahead of the clock", () => {
		const { result, rerender } = renderCue(readingOf(9));
		advance(100);
		rerender(readingOf(10.5));
		expect(result.current).toBe(first);
	});

	it("follows a new position read at the same time as the last one", () => {
		const reading = readingOf(9, { playing: false });
		const { result, rerender } = renderCue(reading);
		expect(result.current).toBeUndefined();
		rerender({ ...reading, position: 11 });
		expect(result.current).toBe(first);
	});

	it("goes back to the same position when mpv reads it again later", () => {
		const { result, rerender } = renderCue(readingOf(11.9));
		advance(1000);
		expect(result.current).toBeUndefined();
		// The video didn't move on, as when the stream stalls before mpv says so.
		rerender(readingOf(11.9));
		expect(result.current).toBe(first);
	});

	it("stops counting 1.5 s past the last reading", () => {
		const late: SubtitleCue = { start: 10.6, end: 12, text: "Still there?" };
		const { result, rerender } = renderCue(readingOf(9, { cues: [late] }));
		expect(vi.getTimerCount()).toBe(0);
		advance(5000);
		expect(result.current).toBeUndefined();
		rerender(readingOf(10.7, { cues: [late] }));
		expect(result.current).toBe(late);
	});

	it("shows a cue that starts 1.5 s past the last reading", () => {
		const { result } = renderCue(readingOf(8.5));
		advance(1498);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(first);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("doesn't count past 1.5 s when a timer runs late", () => {
		const { result } = renderCue(readingOf(9, { cues: [short, first] }));
		// The page was busy, so the timer for 9.2 runs 3 s late.
		const now = performance.now.bind(performance);
		const late = vi.spyOn(performance, "now").mockImplementation(() => now() + 3000);
		advance(202);
		late.mockRestore();
		expect(result.current).toBe(first);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the time since the last reading when paused, and counts on from it", () => {
		const reading = readingOf(11.5, { cues: [first, next] });
		const { result, rerender } = renderCue(reading);
		advance(400);
		rerender({ ...reading, playing: false });
		advance(0);
		expect(vi.getTimerCount()).toBe(0);
		advance(5000);
		expect(result.current).toBe(first);
		// The clock stopped at 11.9, and the time spent paused doesn't count.
		rerender({ ...reading, playing: true });
		advance(0);
		advance(96);
		expect(result.current).toBe(first);
		advance(8);
		expect(result.current).toBeUndefined();
		advance(490);
		expect(result.current).toBeUndefined();
		advance(8);
		expect(result.current).toBe(next);
	});

	it("stops at a reading taken while the video waits for the stream", () => {
		const { result, rerender } = renderCue(readingOf(11.9));
		advance(50);
		rerender(readingOf(11.92, { playing: false }));
		expect(vi.getTimerCount()).toBe(0);
		advance(5000);
		expect(result.current).toBe(first);
	});

	it("shows each cue later for a positive delay", () => {
		const { result, rerender } = renderCue(readingOf(11, { delay: 1.5 }));
		expect(result.current).toBeUndefined();
		advance(498);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(first);
		rerender(readingOf(12, { delay: -2 }));
		expect(result.current).toBeUndefined();
	});

	it("times the next cue from a new delay", () => {
		const reading = readingOf(9.5);
		const { result, rerender } = renderCue(reading);
		// The cue now starts 0.4 s earlier, 100 ms from now.
		rerender({ ...reading, delay: -0.4 });
		advance(98);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(first);
	});

	it("shows the cue for a new delay at once", () => {
		const reading = readingOf(11);
		const { result, rerender } = renderCue(reading);
		expect(result.current).toBe(first);
		rerender({ ...reading, delay: 2 });
		expect(result.current).toBeUndefined();
	});

	it("catches up with cues that load while playing", () => {
		const reading = readingOf(9.5, { cues: [] });
		const { result, rerender } = renderCue(reading);
		expect(vi.getTimerCount()).toBe(0);
		advance(600);
		rerender({ ...reading, cues });
		advance(0);
		expect(result.current).toBe(first);
	});

	it("stops its timer when it unmounts", () => {
		const { unmount } = renderCue(readingOf(9.5));
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
