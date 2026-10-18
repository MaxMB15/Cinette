// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createTestQueryClient, wrapperFor } from "@/test/query";
import { makeHistoryEntry } from "@/test/channel-fixtures";

vi.mock("@/lib/tauri", () => ({ getWatchHistory: vi.fn() }));

import { getWatchHistory } from "@/lib/tauri";
import { useHistoryStaleOnLeave, useWatchHistory } from "./useWatchHistory";

const mockHistory = vi.mocked(getWatchHistory);
const news = makeHistoryEntry({ channelId: "news" });
const film = makeHistoryEntry({ channelId: "film", contentType: "movie" });

beforeEach(() => {
	vi.clearAllMocks();
	mockHistory.mockImplementation(async (_limit, type) =>
		[news, film].filter((e) => !type || e.contentType === type)
	);
});

describe("useWatchHistory", () => {
	it("loads the newest entries of one type, or of all", async () => {
		const wrapper = wrapperFor();
		const live = renderHook(() => useWatchHistory(50, "live", "failed:"), { wrapper });
		const all = renderHook(() => useWatchHistory(200, undefined, "failed:"), { wrapper });
		expect(live.result.current.loading).toBe(true);
		await waitFor(() => expect(all.result.current.loading).toBe(false));

		expect(live.result.current.entries).toEqual([news]);
		expect(all.result.current.entries).toEqual([news, film]);
		expect(mockHistory.mock.calls).toEqual([[50, "live"], [200]]);
	});

	it("reads the cache when it opens again, without a call", async () => {
		const wrapper = wrapperFor();
		const first = renderHook(() => useWatchHistory(50, "live", "failed:"), { wrapper });
		await waitFor(() => expect(first.result.current.loading).toBe(false));
		first.unmount();
		const again = renderHook(() => useWatchHistory(50, "live", "failed:"), { wrapper });

		expect(again.result.current.entries).toEqual([news]);
		expect(mockHistory).toHaveBeenCalledOnce();
	});

	it("logs a failed load and shows no entries", async () => {
		const failure = new Error("locked");
		mockHistory.mockRejectedValue(failure);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { result } = renderHook(() => useWatchHistory(50, "live", "[Row] failed:"), {
				wrapper: wrapperFor(),
			});
			await waitFor(() => expect(result.current.loading).toBe(false));
			expect(result.current.entries).toEqual([]);
			expect(logged).toHaveBeenCalledWith("[Row] failed:", failure);
		} finally {
			logged.mockRestore();
		}
	});

	it("shows a change in its own list now and loads the other lists again when they show", async () => {
		const wrapper = wrapperFor();
		const live = renderHook(() => useWatchHistory(50, "live", "failed:"), { wrapper });
		const all = renderHook(() => useWatchHistory(200, undefined, "failed:"), { wrapper });
		await waitFor(() => expect(all.result.current.loading).toBe(false));
		all.unmount();

		await act(async () => live.result.current.change(() => []));
		expect(live.result.current.entries).toEqual([]);
		expect(mockHistory).toHaveBeenCalledTimes(2);

		renderHook(() => useWatchHistory(200, undefined, "failed:"), { wrapper });
		await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(3));
		expect(mockHistory).toHaveBeenLastCalledWith(200);
	});
});

describe("useHistoryStaleOnLeave", () => {
	it("makes the history load again once the channel list closes and opens", async () => {
		const client = createTestQueryClient();
		const wrapper = wrapperFor(client);
		const list = renderHook(
			() => {
				useHistoryStaleOnLeave();
				return useWatchHistory(50, "live", "failed:");
			},
			{ wrapper }
		);
		await waitFor(() => expect(list.result.current.loading).toBe(false));
		expect(mockHistory).toHaveBeenCalledOnce();

		list.unmount();
		// Closing it loads nothing by itself.
		expect(mockHistory).toHaveBeenCalledOnce();
		renderHook(() => useWatchHistory(50, "live", "failed:"), { wrapper });
		await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2));
	});
});
