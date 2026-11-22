// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { guideRangeFor, type TimeRange } from "@/lib/epg-window";
import { makeChannel } from "@/test/channel-fixtures";
import type { Channel, EpgProgram } from "@/lib/types";

const state = vi.hoisted(() => ({
	channels: [] as Channel[],
	guideVersion: 0,
	now: 0,
	programs: new Map<string, EpgProgram[]>(),
}));

vi.mock("@/hooks/useChannels", () => ({
	useChannels: () => ({ channels: state.channels, guideVersion: state.guideVersion }),
}));
vi.mock("@/hooks/useNow", () => ({ useNow: () => state.now }));
vi.mock("@/hooks/useGuidePrograms", () => ({
	useGuidePrograms: vi.fn(() => ({ programs: state.programs, isPending: () => false })),
}));

import { useGuidePrograms } from "@/hooks/useGuidePrograms";
import { nowAndNext, programProgress, useNowNext } from "./useNowNext";

const program = (title: string, startTime: number, endTime: number): EpgProgram => ({
	channelId: "news.tv",
	title,
	startTime,
	endTime,
});

const morning = program("Morning", 100, 200);
const noon = program("Noon", 200, 300);
const evening = program("Evening", 400, 500);
const day = [morning, noon, evening];

describe("nowAndNext", () => {
	it("finds the program on and the one after it", () => {
		expect(nowAndNext(day, 150)).toEqual({ now: morning, next: noon });
		expect(nowAndNext(day, 250)).toEqual({ now: noon, next: evening });
	});

	it("counts a program as on from its first moment and off at its end", () => {
		expect(nowAndNext(day, 100).now).toBe(morning);
		expect(nowAndNext(day, 200).now).toBe(noon);
	});

	it("has nothing next during the last program", () => {
		expect(nowAndNext(day, 450)).toEqual({ now: evening, next: null });
	});

	it("gives the next program in a gap, with nothing on", () => {
		expect(nowAndNext(day, 350)).toEqual({ now: null, next: evening });
		expect(nowAndNext(day, 50)).toEqual({ now: null, next: morning });
	});

	it("gives nothing after the last program or with no programs", () => {
		expect(nowAndNext(day, 500)).toEqual({ now: null, next: null });
		expect(nowAndNext([], 100)).toEqual({ now: null, next: null });
	});

	it("doesn't call a program that starts and ends this moment next", () => {
		expect(nowAndNext([program("Blip", 100, 100), noon], 100)).toEqual({
			now: null,
			next: noon,
		});
	});
});

describe("programProgress", () => {
	it("gives how far through its time a program is", () => {
		expect(programProgress(morning, 100)).toBe(0);
		expect(programProgress(morning, 125)).toBe(0.25);
		expect(programProgress(morning, 200)).toBe(1);
	});

	it("stays between 0 and 1 outside the program's time", () => {
		expect(programProgress(morning, 50)).toBe(0);
		expect(programProgress(morning, 250)).toBe(1);
	});
});

describe("useNowNext", () => {
	const NOW = 1_000_000;
	const news = makeChannel({ id: "news", tvgId: "news.tv" });

	/** The range of the guide's last load. */
	const loadedRange = () => vi.mocked(useGuidePrograms).mock.lastCall?.[0] as TimeRange;

	beforeEach(() => {
		vi.mocked(useGuidePrograms).mockClear();
		state.channels = [news];
		state.guideVersion = 7;
		state.now = NOW;
		state.programs = new Map([
			[
				"news.tv",
				[
					program("Ended", NOW - 200, NOW - 100),
					program("Just ended", NOW - 100, NOW),
					program("On now", NOW, NOW + 100),
					program("After", NOW + 100, NOW + 200),
				],
			],
		]);
	});

	it("loads every channel's guide around now, again as the channels or guide change", () => {
		state.channels = [news, makeChannel({ id: "sport" })];
		renderHook(() => useNowNext());
		expect(useGuidePrograms).toHaveBeenLastCalledWith(
			guideRangeFor(NOW, NOW, NOW),
			"all",
			"2:7"
		);
	});

	it("loads nothing while there are no channels", () => {
		state.channels = [];
		renderHook(() => useNowNext());
		expect(useGuidePrograms).toHaveBeenLastCalledWith(
			guideRangeFor(NOW, NOW, NOW),
			null,
			"0:7"
		);
	});

	it("keeps its range as the clock moves inside it, and moves on past its end", () => {
		const { rerender } = renderHook(() => useNowNext());
		const first = loadedRange();

		state.now = NOW + 60;
		rerender();
		expect(loadedRange()).toBe(first);

		state.now = first.to + 1;
		rerender();
		expect(loadedRange()).toEqual(guideRangeFor(state.now, state.now, state.now));
	});

	it("loads on to the time asked for, and further as that moves past the range", () => {
		const later = NOW + 10 * 3600;
		let until = later;
		const { rerender } = renderHook(() => useNowNext(until));
		const first = loadedRange();
		expect(first).toEqual(guideRangeFor(NOW, NOW, later));

		until = later + 60;
		rerender();
		expect(loadedRange()).toBe(first);

		until = first.to + 1;
		rerender();
		expect(loadedRange()).toEqual(guideRangeFor(NOW, NOW, until));
	});

	it("gives the current time", () => {
		const { result } = renderHook(() => useNowNext());
		expect(result.current.now).toBe(NOW);
	});

	it("says what's on a channel now and next", () => {
		const { result } = renderHook(() => useNowNext());
		const { now, next } = result.current.nowNextOf(news);
		expect(now?.title).toBe("On now");
		expect(next?.title).toBe("After");
	});

	it("lists a channel's programs that haven't ended", () => {
		const { result } = renderHook(() => useNowNext());
		expect(result.current.scheduleOf(news).map((p) => p.title)).toEqual(["On now", "After"]);
	});

	it("lists all of a channel's loaded programs, the ended ones too", () => {
		const { result } = renderHook(() => useNowNext());
		expect(result.current.programsOf(news).map((p) => p.title)).toEqual([
			"Ended",
			"Just ended",
			"On now",
			"After",
		]);
	});

	it("has nothing for a channel without a guide id, or one the guide doesn't know", () => {
		const { result } = renderHook(() => useNowNext());
		for (const channel of [makeChannel(), makeChannel({ tvgId: "unknown.tv" })]) {
			expect(result.current.programsOf(channel)).toEqual([]);
			expect(result.current.nowNextOf(channel)).toEqual({ now: null, next: null });
			expect(result.current.scheduleOf(channel)).toEqual([]);
		}
	});
});
