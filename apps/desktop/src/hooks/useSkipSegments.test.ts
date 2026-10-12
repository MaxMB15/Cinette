// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { deferred } from "@/test/deferred";
import { makeSegment } from "@/test/segments";
import type { SkipSegment } from "@/lib/types";

vi.mock("@/lib/tauri", () => ({
	getSkipSegments: vi.fn(),
}));

import { getSkipSegments } from "@/lib/tauri";
import {
	LENGTH_DRIFT,
	MAX_LOOKUPS,
	NO_SEGMENTS,
	RETRY_MS,
	useSkipSegments,
} from "./useSkipSegments";

const mockGet = vi.mocked(getSkipSegments);

type Query = Parameters<typeof useSkipSegments>[0];

const episode: Query = {
	imdbId: "tt0903747",
	contentType: "series",
	season: 1,
	episode: 2,
	url: "http://example.com/s01e02.mkv",
	duration: 2820,
	enabled: true,
};

const render = (query: Query) =>
	renderHook((q: Query) => useSkipSegments(q), { initialProps: query });

/** Lets pending lookups settle and React render what they set. */
const settle = () => act(async () => {});

const quietWarnings = () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	onTestFinished(() => warn.mockRestore());
	return warn;
};

describe("useSkipSegments", () => {
	beforeEach(() => {
		mockGet.mockReset();
		mockGet.mockResolvedValue([]);
	});

	it("looks up an episode once its length is known, in order", async () => {
		const credits = makeSegment({ kind: "credits", start: 2700, end: 2820 });
		const intro = makeSegment();
		mockGet.mockResolvedValue([credits, intro]);
		const { result } = render(episode);
		await waitFor(() => expect(result.current.segments).toEqual([intro, credits]));
		expect(mockGet).toHaveBeenCalledWith("tt0903747", 1, 2, 2820);
	});

	it("looks up a movie without a season or episode", async () => {
		render({ ...episode, contentType: "movie", season: 3, episode: 4 });
		await waitFor(() => expect(mockGet).toHaveBeenCalledWith("tt0903747", null, null, 2820));
	});

	it("names the video, so the player can tell when a new one starts", () => {
		const { result, rerender } = render(episode);
		const first = result.current.video;
		expect(first).not.toBeNull();
		rerender({ ...episode, duration: 2900 });
		expect(result.current.video).toBe(first);
		rerender({ ...episode, episode: 3 });
		expect(result.current.video).not.toBe(first);
		rerender({ ...episode, url: "http://example.com/s01e02-hd.mkv" });
		expect(result.current.video).not.toBe(first);
	});

	it.each<[string, Partial<Query>]>([
		["skipping is off", { enabled: false }],
		["there's no IMDb ID", { imdbId: null }],
		["nothing is playing", { url: null }],
		["the length isn't known", { duration: 0 }],
		["it's a live channel", { contentType: "live" }],
		["an episode has no number", { episode: undefined }],
		["an episode has no season", { season: undefined }],
	])("looks nothing up when %s", (_, change) => {
		const { result } = render({ ...episode, ...change });
		expect(result.current.segments).toBe(NO_SEGMENTS);
		expect(mockGet).not.toHaveBeenCalled();
	});

	describe("when the length moves", () => {
		it("doesn't look up again for a small change", async () => {
			const { rerender } = render(episode);
			await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
			rerender({ ...episode, duration: 2820 + LENGTH_DRIFT });
			await settle();
			expect(mockGet).toHaveBeenCalledTimes(1);
		});

		it("looks up again once it moves further, keeping the last times meanwhile", async () => {
			const intro = makeSegment();
			const again = deferred<SkipSegment[]>();
			mockGet.mockResolvedValueOnce([intro]).mockReturnValueOnce(again.promise);
			const { result, rerender } = render(episode);
			await waitFor(() => expect(result.current.segments).toEqual([intro]));
			const longer = 2820 + LENGTH_DRIFT + 1;
			rerender({ ...episode, duration: longer });
			expect(mockGet).toHaveBeenLastCalledWith("tt0903747", 1, 2, longer);
			expect(result.current.segments).toEqual([intro]);
			const moved = makeSegment({ start: 61, end: 121 });
			again.resolve([moved]);
			await waitFor(() => expect(result.current.segments).toEqual([moved]));
		});

		it("measures from the length of the last lookup", async () => {
			const { rerender } = render(episode);
			await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
			rerender({ ...episode, duration: 2840 });
			await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
			rerender({ ...episode, duration: 2850 });
			await settle();
			expect(mockGet).toHaveBeenCalledTimes(2);
		});

		it(`stops after ${MAX_LOOKUPS} lookups`, async () => {
			const { rerender } = render(episode);
			for (let i = 1; i <= MAX_LOOKUPS + 2; i++) {
				rerender({ ...episode, duration: 2820 + i * (LENGTH_DRIFT + 1) });
				await settle();
			}
			expect(mockGet).toHaveBeenCalledTimes(MAX_LOOKUPS);
		});
	});

	it("keeps its times when the stream drops for a moment", async () => {
		mockGet.mockResolvedValue([makeSegment()]);
		const { result, rerender } = render(episode);
		await waitFor(() => expect(result.current.segments).toHaveLength(1));
		const segments = result.current.segments;
		rerender({ ...episode, duration: 0 });
		expect(result.current.segments).toBe(segments);
		rerender(episode);
		await settle();
		expect(result.current.segments).toBe(segments);
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it("drops the last stream's times as soon as a new one plays", async () => {
		mockGet.mockResolvedValueOnce([makeSegment()]).mockReturnValueOnce(new Promise(() => {}));
		const { result, rerender } = render(episode);
		await waitFor(() => expect(result.current.segments).toHaveLength(1));
		rerender({ ...episode, episode: 3, url: "http://example.com/s01e03.mkv" });
		expect(result.current.segments).toBe(NO_SEGMENTS);
		expect(mockGet).toHaveBeenLastCalledWith("tt0903747", 1, 3, 2820);
	});

	it("ignores an answer for a stream that's no longer playing", async () => {
		const first = deferred<SkipSegment[]>();
		const other = makeSegment({ start: 10, end: 40 });
		mockGet.mockReturnValueOnce(first.promise).mockResolvedValueOnce([other]);
		const { result, rerender } = render(episode);
		rerender({ ...episode, url: "http://example.com/other.mkv" });
		await waitFor(() => expect(result.current.segments).toEqual([other]));
		first.resolve([makeSegment()]);
		await settle();
		expect(result.current.segments).toEqual([other]);
	});

	it("ignores an older lookup's answer for the same video", async () => {
		const first = deferred<SkipSegment[]>();
		const moved = makeSegment({ start: 61, end: 121 });
		mockGet.mockReturnValueOnce(first.promise).mockResolvedValueOnce([moved]);
		const { result, rerender } = render(episode);
		rerender({ ...episode, duration: 2900 });
		await waitFor(() => expect(result.current.segments).toEqual([moved]));
		first.resolve([makeSegment()]);
		await settle();
		expect(result.current.segments).toEqual([moved]);
	});

	describe("when the lookup fails", () => {
		it("has nothing to skip", async () => {
			const warn = quietWarnings();
			mockGet.mockRejectedValue(new Error("offline"));
			const { result } = render(episode);
			await waitFor(() => expect(warn).toHaveBeenCalled());
			expect(result.current.segments).toBe(NO_SEGMENTS);
		});

		it(`tries again a while later, up to ${MAX_LOOKUPS} times`, async () => {
			vi.useFakeTimers();
			onTestFinished(() => void vi.useRealTimers());
			quietWarnings();
			mockGet.mockRejectedValue(new Error("offline"));
			render(episode);
			await settle();
			expect(mockGet).toHaveBeenCalledTimes(1);
			await act(async () => void vi.advanceTimersByTime(RETRY_MS - 1));
			expect(mockGet).toHaveBeenCalledTimes(1);
			for (let i = 2; i <= MAX_LOOKUPS + 1; i++) {
				await act(async () => void vi.advanceTimersByTime(RETRY_MS));
				await settle();
			}
			expect(mockGet).toHaveBeenCalledTimes(MAX_LOOKUPS);
		});

		it("doesn't try again early when the length moves", async () => {
			quietWarnings();
			mockGet.mockRejectedValueOnce(new Error("offline"));
			const { rerender } = render(episode);
			await settle();
			rerender({ ...episode, duration: 2900 });
			await settle();
			expect(mockGet).toHaveBeenCalledTimes(1);
		});

		it("stops trying once unmounted", async () => {
			vi.useFakeTimers();
			onTestFinished(() => void vi.useRealTimers());
			quietWarnings();
			mockGet.mockRejectedValue(new Error("offline"));
			const { unmount } = render(episode);
			await settle();
			unmount();
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});
