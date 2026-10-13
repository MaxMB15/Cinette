// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TimeRange } from "@/lib/epg-window";
import type { EpgProgram } from "@/lib/types";
import { deferred } from "@/test/deferred";

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

/** Answers the way the backend does, with only the asked-for channels' programs. */
const answerFrom =
	(programs: EpgProgram[]) => (_from: number, _to: number, ids?: readonly string[]) =>
		Promise.resolve(programs.filter((p) => !ids || ids.includes(p.channelId)));

interface Props {
	range: TimeRange | null;
	channels: GuideChannels | null;
	resetKey: unknown;
}

const renderGuide = (initial: Props) =>
	renderHook((props: Props) => useGuidePrograms(props.range, props.channels, props.resetKey), {
		initialProps: initial,
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
		expect(result.current.size).toBe(0);
	});

	it("loads every channel's programs and groups them by guide id", async () => {
		const { result } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		expect(mockLoad).toHaveBeenCalledExactlyOnceWith(1000, 8000, undefined);
		expect(titles(result.current)).toEqual({
			"arts.tv": ["Gallery Hour"],
			"news.tv": ["Noon News", "Weather"],
			"sport.tv": ["Match Day"],
		});
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
		expect(titles(result.current)).toEqual({
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
		expect(titles(result.current)).toEqual({
			"news.tv": ["Noon News", "Weather"],
			"arts.tv": ["Gallery Hour"],
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
		expect(result.current.get("sport.tv")).toHaveLength(1);
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

		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000, undefined);
		expect(result.current.size).toBe(3);
	});

	it("loads the whole list again for a new range, and drops the old range's programs", async () => {
		const { result, rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		rerender({ range: evening, channels: ["news.tv"], resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenLastCalledWith(5000, 12000, ["news.tv"]);
		expect([...result.current.keys()]).toEqual(["news.tv"]);
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
		expect(titles(result.current)).toEqual({ "news.tv": ["Late News"] });
	});

	it("loads again after a request for nothing", async () => {
		const { rerender } = renderGuide({ range: morning, channels: "all", resetKey: 1 });
		await flush();
		rerender({ range: morning, channels: null, resetKey: 1 });
		await flush();
		rerender({ range: morning, channels: ["news.tv"], resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenCalledTimes(2);
		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000, ["news.tv"]);
	});

	it("drops an older load's answer and asks again for what it still needs", async () => {
		const first = deferred<EpgProgram[]>();
		mockLoad.mockReturnValueOnce(first.promise);
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv"],
			resetKey: 1,
		});
		rerender({ range: morning, channels: ["news.tv", "sport.tv"], resetKey: 1 });
		await flush();
		await act(async () => first.resolve([program("news.tv", "Old News")]));

		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000, ["news.tv", "sport.tv"]);
		expect(titles(result.current)).toEqual({
			"news.tv": ["Noon News", "Weather"],
			"sport.tv": ["Match Day"],
		});
	});

	it("keeps its programs when a load fails, and asks for those ids again next time", async () => {
		const { result, rerender } = renderGuide({
			range: morning,
			channels: ["news.tv"],
			resetKey: 1,
		});
		await flush();
		mockLoad.mockRejectedValueOnce(new Error("offline"));
		rerender({ range: morning, channels: ["news.tv", "sport.tv"], resetKey: 1 });
		await flush();
		expect([...result.current.keys()]).toEqual(["news.tv"]);

		rerender({ range: morning, channels: ["news.tv", "sport.tv", "arts.tv"], resetKey: 1 });
		await flush();

		expect(mockLoad).toHaveBeenLastCalledWith(1000, 8000, ["arts.tv", "sport.tv"]);
		expect(result.current.size).toBe(3);
	});
});
