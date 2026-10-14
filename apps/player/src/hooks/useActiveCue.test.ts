// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveCue } from "./useActiveCue";
import type { SubtitleCue } from "@/lib/types";

const first: SubtitleCue = { start: 10, end: 12, text: "Where are you going?" };
const cues = [first];

interface Props {
	cues: SubtitleCue[];
	position: number;
	delay: number;
	playing: boolean;
}

const renderCue = (props: Props) =>
	renderHook((p: Props) => useActiveCue(p.cues, p.position, p.delay, p.playing), {
		initialProps: props,
	});

/** Moves the clock on. React renders once at the end, so a step runs at most one cue change. */
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useActiveCue", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	it("shows the cue at the position and runs no timer while paused", () => {
		const { result } = renderCue({ cues, position: 11, delay: 0, playing: false });
		expect(result.current).toBe(first);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("starts a cue on time between two positions", () => {
		const { result } = renderCue({ cues, position: 9.5, delay: 0, playing: true });
		expect(result.current).toBeUndefined();
		advance(498);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(first);
	});

	it("ends a cue on time between two positions", () => {
		const { result } = renderCue({ cues, position: 11.5, delay: 0, playing: true });
		expect(result.current).toBe(first);
		advance(498);
		expect(result.current).toBe(first);
		advance(4);
		expect(result.current).toBeUndefined();
	});

	it("shows a cue shorter than the time between two positions", () => {
		const short: SubtitleCue = { start: 9.2, end: 9.5, text: "Hey." };
		const { result } = renderCue({
			cues: [short, first],
			position: 9,
			delay: 0,
			playing: true,
		});
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

	it("counts from each new position", () => {
		const short: SubtitleCue = { start: 9.2, end: 9.5, text: "Hey." };
		const { result, rerender } = renderCue({
			cues: [short, first],
			position: 9,
			delay: 0,
			playing: true,
		});
		advance(202);
		advance(300);
		expect(result.current).toBeUndefined();
		// Seeking back puts the clock on the new position, not 0.5 s past it.
		rerender({ cues: [short, first], position: 9.1, delay: 0, playing: true });
		expect(result.current).toBeUndefined();
		advance(98);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(short);
	});

	it("stops counting 1.5 s past the last position", () => {
		const late: SubtitleCue = { start: 10.6, end: 12, text: "Still there?" };
		const { result, rerender } = renderCue({
			cues: [late],
			position: 9,
			delay: 0,
			playing: true,
		});
		expect(vi.getTimerCount()).toBe(0);
		advance(5000);
		expect(result.current).toBeUndefined();
		rerender({ cues: [late], position: 10.7, delay: 0, playing: true });
		expect(result.current).toBe(late);
	});

	it("shows a cue that starts 1.5 s past the last position", () => {
		const { result } = renderCue({ cues, position: 8.5, delay: 0, playing: true });
		advance(1498);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(first);
	});

	it("doesn't count past 1.5 s when a timer runs late", () => {
		const short: SubtitleCue = { start: 9.2, end: 9.5, text: "Hey." };
		const { result } = renderCue({
			cues: [short, first],
			position: 9,
			delay: 0,
			playing: true,
		});
		// The page was busy, so the timer for 9.2 runs 3 s late.
		const now = performance.now.bind(performance);
		const late = vi.spyOn(performance, "now").mockImplementation(() => now() + 3000);
		advance(202);
		late.mockRestore();
		expect(result.current).toBe(first);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("holds the cue while paused and counts on once playing again", () => {
		const next: SubtitleCue = { start: 12.5, end: 14, text: "Home." };
		const both = [first, next];
		const { result, rerender } = renderCue({
			cues: both,
			position: 11.5,
			delay: 0,
			playing: true,
		});
		rerender({ cues: both, position: 11.5, delay: 0, playing: false });
		expect(vi.getTimerCount()).toBe(0);
		advance(5000);
		expect(result.current).toBe(first);
		// The time spent paused doesn't count.
		rerender({ cues: both, position: 11.5, delay: 0, playing: true });
		advance(498);
		expect(result.current).toBe(first);
		advance(4);
		expect(result.current).toBeUndefined();
		advance(494);
		expect(result.current).toBeUndefined();
		advance(8);
		expect(result.current).toBe(next);
	});

	it("shows each cue later for a positive delay", () => {
		const { result, rerender } = renderCue({ cues, position: 11, delay: 2, playing: true });
		advance(998);
		expect(result.current).toBeUndefined();
		advance(4);
		expect(result.current).toBe(first);
		rerender({ cues, position: 12, delay: -2, playing: true });
		expect(result.current).toBeUndefined();
	});

	it("waits for cues that load while playing", () => {
		const { result, rerender } = renderCue({
			cues: [],
			position: 9.5,
			delay: 0,
			playing: true,
		});
		expect(vi.getTimerCount()).toBe(0);
		rerender({ cues, position: 9.5, delay: 0, playing: true });
		advance(502);
		expect(result.current).toBe(first);
	});

	it("stops its timer when it unmounts", () => {
		const { unmount } = renderCue({ cues, position: 9.5, delay: 0, playing: true });
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
