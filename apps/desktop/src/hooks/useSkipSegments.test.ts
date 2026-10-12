// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { makeSegment } from "@/test/segments";

vi.mock("@/lib/tauri", () => ({
	getSkipSegments: vi.fn(),
}));

import { getSkipSegments } from "@/lib/tauri";
import { NO_SEGMENTS, useSkipSegments } from "./useSkipSegments";

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
		await waitFor(() => expect(result.current).toEqual([intro, credits]));
		expect(mockGet).toHaveBeenCalledWith("tt0903747", 1, 2, 2820);
	});

	it("looks up a movie without a season or episode", async () => {
		render({ ...episode, contentType: "movie", season: 3, episode: 4 });
		await waitFor(() => expect(mockGet).toHaveBeenCalledWith("tt0903747", null, null, 2820));
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
		expect(result.current).toBe(NO_SEGMENTS);
		expect(mockGet).not.toHaveBeenCalled();
	});

	it("doesn't look up again when only the length changes", async () => {
		const { rerender } = render(episode);
		await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
		rerender({ ...episode, duration: 2821 });
		await Promise.resolve();
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it("drops the last stream's times as soon as a new one plays", async () => {
		mockGet.mockResolvedValueOnce([makeSegment()]).mockReturnValueOnce(new Promise(() => {}));
		const { result, rerender } = render(episode);
		await waitFor(() => expect(result.current).toHaveLength(1));
		rerender({ ...episode, episode: 3, url: "http://example.com/s01e03.mkv" });
		expect(result.current).toBe(NO_SEGMENTS);
		expect(mockGet).toHaveBeenLastCalledWith("tt0903747", 1, 3, 2820);
	});

	it("ignores an answer for a stream that's no longer playing", async () => {
		let answer: (segments: ReturnType<typeof makeSegment>[]) => void = () => {};
		mockGet.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		mockGet.mockResolvedValueOnce([]);
		const { result, rerender } = render(episode);
		rerender({ ...episode, url: "http://example.com/other.mkv" });
		await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
		answer([makeSegment()]);
		await Promise.resolve();
		expect(result.current).toEqual([]);
	});

	it("has nothing to skip when the lookup fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		onTestFinished(() => warn.mockRestore());
		mockGet.mockRejectedValue(new Error("offline"));
		const { result } = render(episode);
		await waitFor(() => expect(warn).toHaveBeenCalled());
		expect(result.current).toBe(NO_SEGMENTS);
	});
});
