// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TimeRange } from "@/lib/epg-window";
import type { EpgProgram } from "@/lib/types";
import { deferred } from "@/test/deferred";
import { answerFrom } from "@/test/guide-answers";
import { wrapperFor } from "@/test/query";

vi.mock("@/lib/tauri", () => ({ getEpgForLiveChannels: vi.fn() }));

import { getEpgForLiveChannels } from "@/lib/tauri";
import { useGuidePrograms, type GuideChannels } from "./useGuidePrograms";

const mockLoad = vi.mocked(getEpgForLiveChannels);

const morning: TimeRange = { from: 1000, to: 8000 };
const evening: TimeRange = { from: 5000, to: 12000 };

const program = (channelId: string, title: string, startTime = 1000): EpgProgram => ({
	channelId,
	title,
	startTime,
	endTime: startTime + 1800,
});

/** One program on each of these guide ids. */
const guide = [
	program("arts.tv", "Gallery Hour"),
	program("news.tv", "Noon News"),
	program("news.tv", "Weather", 2800),
	program("sport.tv", "Match Day"),
];

interface Props {
	range: TimeRange | null;
	channels: GuideChannels | null;
	resetKey: number;
}

const renderGuide = (initial: Props) =>
	renderHook((props: Props) => useGuidePrograms(props.range, props.channels, props.resetKey), {
		initialProps: initial,
		wrapper: wrapperFor(),
	});

/** Lets pending loads reach the hook. */
const flush = () => act(async () => {});

/** Each channel's program titles, to compare maps at a glance. */
const titles = (map: ReadonlyMap<string, EpgProgram[]>) =>
	Object.fromEntries([...map].map(([id, list]) => [id, list.map((p) => p.title)]));

beforeEach(() => {
	mockLoad.mockReset();
	mockLoad.mockImplementation(answerFrom(guide));
});

describe("useGuidePrograms", () => {
	it("loads nothing without channels or a range", async () => {
		const { result, rerender } = renderGuide({ range: morning, channels: null, resetKey: 1 });
		rerender({ range: null, channels: "all", resetKey: 1 });
		await flush();
		expect(mockLoad).not.toHaveBeenCalled();
		expect(result.current.programs.size).toBe(0);
	});

	it("loads every channel's programs and groups them by guide id", async () => {
		const { result } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		expect(mockLoad).toHaveBeenCalledExactlyOnceWith(1000, 8000);
		expect(titles(result.current.programs)).toEqual({
			"arts.tv": ["Gallery Hour"],
			"news.tv": ["Noon News", "Weather"],
			"sport.tv": ["Match Day"],
		});
	});

	it("says which channels' programs are on their way", async () => {
		const all = deferred<EpgProgram[]>();
		mockLoad.mockReturnValueOnce(all.promise);
		const { result, rerender } = renderGuide({ range: null, channels: "all", resetKey: 1 });
		expect(result.current.isPending("news.tv")).toBe(true);
		rerender({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		expect(result.current.isPending("news.tv")).toBe(true);

		await act(async () => all.resolve(guide));
		expect(result.current.isPending("news.tv")).toBe(false);
		// A list waits only for its own ids over a new range.
		const news = deferred<EpgProgram[]>();
		mockLoad.mockReturnValueOnce(news.promise);
		rerender({ range: evening, channels: ["news.tv"], resetKey: 1 });
		expect(result.current.isPending("news.tv")).toBe(true);
		expect(result.current.isPending("arts.tv")).toBe(false);
		await act(async () => news.resolve([]));
		expect(result.current.isPending("news.tv")).toBe(false);
		// Every channel's load waits for every channel, even one whose own
		// answer is in.
		rerender({ range: evening, channels: "all", resetKey: 1 });
		expect(result.current.isPending("news.tv")).toBe(true);
		expect(result.current.isPending("arts.tv")).toBe(true);
		await flush();
		expect(result.current.isPending("arts.tv")).toBe(false);
		rerender({ range: evening, channels: null, resetKey: 1 });
		expect(result.current.isPending("arts.tv")).toBe(false);
	});

	it("stops waiting when every channel's load fails, and asks again next time", async () => {
		mockLoad.mockRejectedValueOnce(new Error("offline"));
		const { result, rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		expect(result.current.isPending("news.tv")).toBe(false);
		expect(result.current.programs.size).toBe(0);

		rerender({ range: morning, channels: ["news.tv"], resetKey: 1 });
		await flush();
		rerender({ range: morning, channels: "all", resetKey: 1 });
		await flush();

		expect(mockLoad.mock.calls).toStrictEqual([
			[1000, 8000],
			[1000, 8000, ["news.tv"]],
			[1000, 8000],
		]);
		expect(result.current.programs.size).toBe(3);
	});

	it("asks for the ids asked for together in one call", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv"],
			resetKey: 1,
		});
		rerender({ range: morning, channels: ["news.tv", "sport.tv"], resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenCalledExactlyOnceWith(1000, 8000, ["news.tv", "sport.tv"]);
		expect(Object.keys(titles(result.current.programs))).toEqual(["news.tv", "sport.tv"]);
	});

	it("asks for each id once, in order, and not again for a new list of the same ids", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["sport.tv", "news.tv", "sport.tv"],
			resetKey: 1,
		});
		await flush();
		rerender({ range: morning, channels: ["news.tv", "sport.tv"], resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenCalledExactlyOnceWith(1000, 8000, ["news.tv", "sport.tv"]);
		expect(titles(result.current.programs)).toEqual({
			"news.tv": ["Noon News", "Weather"],
			"sport.tv": ["Match Day"],
		});
	});

	it("loads only a new id and adds its programs to the rest", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv"],
			resetKey: 1,
		});
		await flush();
		rerender({ range: morning, channels: ["news.tv", "arts.tv"], resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenCalledTimes(2);
		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000, ["arts.tv"]);
		expect(titles(result.current.programs)).toEqual({
			"news.tv": ["Noon News", "Weather"],
			"arts.tv": ["Gallery Hour"],
		});
	});

	it("asks only for a new id while a load is on its way, and keeps both answers", async () => {
		const first = deferred<EpgProgram[]>();
		mockLoad.mockReturnValueOnce(first.promise);
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv"],
			resetKey: 1,
		});
		await flush();
		rerender({ range: morning, channels: ["news.tv", "sport.tv"], resetKey: 1 });
		await flush();
		await act(async () => first.resolve([program("news.tv", "Noon News")]));

		expect(mockLoad.mock.calls).toStrictEqual([
			[1000, 8000, ["news.tv"]],
			[1000, 8000, ["sport.tv"]],
		]);
		expect(titles(result.current.programs)).toEqual({
			"news.tv": ["Noon News"],
			"sport.tv": ["Match Day"],
		});
	});

	it("loads nothing when an id goes and keeps what it has", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv", "sport.tv"],
			resetKey: 1,
		});
		await flush();
		rerender({ range: morning, channels: ["news.tv"], resetKey: 1 });
		await flush();
		// It still has sport.tv, so getting it back loads nothing either.
		rerender({ range: morning, channels: ["news.tv", "sport.tv"], resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenCalledOnce();
		expect(result.current.programs.get("sport.tv")).toHaveLength(1);
	});

	it("loads nothing for a list once every channel is loaded", async () => {
		const { rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		rerender({ range: morning, channels: ["news.tv"], resetKey: 1 });
		await flush();
		rerender({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		expect(mockLoad).toHaveBeenCalledOnce();
	});

	it("loads every channel after only some were loaded", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv"],
			resetKey: 1,
		});
		await flush();
		rerender({ range: morning, channels: "all", resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000);
		expect(result.current.programs.size).toBe(3);
	});

	it("keeps loading every channel once when a list comes and goes during that load", async () => {
		const all = deferred<EpgProgram[]>();
		mockLoad.mockReturnValueOnce(all.promise);
		const { result, rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		rerender({ range: morning, channels: ["news.tv"], resetKey: 1 });
		await flush();
		expect([...result.current.programs.keys()]).toEqual(["news.tv"]);
		rerender({ range: morning, channels: "all", resetKey: 1 });
		await act(async () => all.resolve(guide));

		expect(mockLoad.mock.calls).toStrictEqual([
			[1000, 8000],
			[1000, 8000, ["news.tv"]],
		]);
		expect(result.current.programs.size).toBe(3);
	});

	it("shows only the asked-for ids' programs when they load for a new range", async () => {
		const { result, rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		mockLoad.mockImplementation(answerFrom([program("news.tv", "Late News", 5000)]));
		rerender({ range: evening, channels: ["news.tv", "arts.tv"], resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenLastCalledWith(5000, 12000, ["arts.tv", "news.tv"]);
		// Only the asked-for ids, and none for one the answer found nothing for.
		expect(titles(result.current.programs)).toEqual({ "news.tv": ["Late News"] });
	});

	it("replaces every program with what every channel's load finds", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv", "sport.tv"],
			resetKey: 1,
		});
		await flush();
		mockLoad.mockImplementation(answerFrom([program("arts.tv", "Late Gallery", 5000)]));
		rerender({ range: evening, channels: "all", resetKey: 1 });
		await flush();

		expect(titles(result.current.programs)).toEqual({ "arts.tv": ["Late Gallery"] });
	});

	it("drops an answer for an older range that comes in last", async () => {
		const first = deferred<EpgProgram[]>();
		mockLoad.mockReturnValueOnce(first.promise);
		const { result, rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		rerender({ range: evening, channels: "all", resetKey: 1 });
		await flush();
		await act(async () => first.resolve([program("news.tv", "Old News")]));

		expect(mockLoad).toHaveBeenLastCalledWith(5000, 12000);
		expect(titles(result.current.programs)).toEqual({
			"arts.tv": ["Gallery Hour"],
			"news.tv": ["Noon News", "Weather"],
			"sport.tv": ["Match Day"],
		});
	});

	it("loads again from scratch when the reset key changes", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv", "sport.tv"],
			resetKey: 1,
		});
		await flush();
		mockLoad.mockImplementation(answerFrom([program("news.tv", "Late News")]));
		rerender({ range: morning, channels: ["news.tv", "sport.tv"], resetKey: 2 });
		await flush();

		expect(mockLoad).toHaveBeenCalledTimes(2);
		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000, ["news.tv", "sport.tv"]);
		expect(titles(result.current.programs)).toEqual({ "news.tv": ["Late News"] });
	});

	it("shows what it loaded again after a request for nothing, without a call", async () => {
		const { result, rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		rerender({ range: morning, channels: null, resetKey: 1 });
		rerender({ range: morning, channels: "all", resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenCalledOnce();
		expect(result.current.isPending("news.tv")).toBe(false);
		expect(result.current.programs.size).toBe(3);
	});

	it("drops an answer still on its way after a request for nothing", async () => {
		const first = deferred<EpgProgram[]>();
		mockLoad.mockReturnValueOnce(first.promise);
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv"],
			resetKey: 1,
		});
		rerender({ range: morning, channels: null, resetKey: 1 });
		await act(async () => first.resolve(guide));

		expect(result.current.programs.size).toBe(0);
	});

	it("keeps showing what it had through a request for nothing over a new range", async () => {
		const { result, rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		rerender({ range: evening, channels: null, resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenCalledOnce();
		expect(result.current.programs.size).toBe(3);
		expect(result.current.isPending("news.tv")).toBe(false);
	});

	it("keeps a load on its way through a request for nothing", async () => {
		const first = deferred<EpgProgram[]>();
		mockLoad.mockReturnValueOnce(first.promise);
		const { result, rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		rerender({ range: morning, channels: null, resetKey: 1 });
		rerender({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		expect(result.current.isPending("news.tv")).toBe(true);

		await act(async () => first.resolve(guide));
		expect(mockLoad).toHaveBeenCalledOnce();
		expect(result.current.isPending("news.tv")).toBe(false);
		expect(result.current.programs.size).toBe(3);
	});

	it("keeps its programs when a load fails, and asks for those ids again with the next guide", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv"],
			resetKey: 1,
		});
		await flush();
		mockLoad.mockRejectedValueOnce(new Error("offline"));
		rerender({ range: morning, channels: ["news.tv", "sport.tv"], resetKey: 1 });
		await flush();
		expect([...result.current.programs.keys()]).toEqual(["news.tv"]);
		expect(result.current.isPending("sport.tv")).toBe(false);

		// A new favorite loads only its own programs.
		rerender({ range: morning, channels: ["news.tv", "sport.tv", "arts.tv"], resetKey: 1 });
		await flush();
		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000, ["arts.tv"]);

		// The next guide asks for every id again.
		rerender({ range: morning, channels: ["news.tv", "sport.tv", "arts.tv"], resetKey: 2 });
		await flush();
		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000, ["arts.tv", "news.tv", "sport.tv"]);
		expect(result.current.programs.size).toBe(3);
	});
});
