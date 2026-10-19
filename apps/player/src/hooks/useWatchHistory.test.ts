// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { createTestQueryClient, wrapperFor } from "@/test/query";
import { makeHistoryEntry } from "@/test/channel-fixtures";
import { pinnedGroupsQuery, watchHistoryQuery } from "@/lib/queries";
import { deferred } from "@/test/deferred";
import type { WatchHistoryEntry } from "@/lib/types";

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
		expect(mockHistory.mock.calls).toEqual([
			[50, "live"],
			[200, undefined],
		]);
	});

	it("logs nothing when the history loads", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { result } = renderHook(() => useWatchHistory(50, "live", "failed:"), {
				wrapper: wrapperFor(),
			});
			await waitFor(() => expect(result.current.loading).toBe(false));
			expect(logged).not.toHaveBeenCalled();
		} finally {
			logged.mockRestore();
		}
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
		expect(mockHistory).toHaveBeenLastCalledWith(200, undefined);
	});

	it("shows a change in the other lists too while they load again", async () => {
		const client = createTestQueryClient();
		const wrapper = wrapperFor(client);
		const live = renderHook(() => useWatchHistory(50, "live", "failed:"), { wrapper });
		const all = renderHook(() => useWatchHistory(200, undefined, "failed:"), { wrapper });
		await waitFor(() => expect(all.result.current.loading).toBe(false));
		all.unmount();
		const answer = deferred<WatchHistoryEntry[]>();
		mockHistory.mockReturnValue(answer.promise);

		await act(async () => live.result.current.change((list) => list.filter((e) => e !== news)));
		expect(live.result.current.entries).toEqual([]);
		// A list that never loaded stays that way.
		expect(client.getQueryData(watchHistoryQuery(50, "movie").queryKey)).toBeUndefined();

		const again = renderHook(() => useWatchHistory(200, undefined, "failed:"), { wrapper });
		expect(again.result.current.entries).toEqual([film]);
		await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(3));
		await act(async () => answer.resolve([film]));
		expect(again.result.current.entries).toEqual([film]);
	});

	it("leaves the lists outside the history alone", async () => {
		const client = createTestQueryClient();
		const pinned = pinnedGroupsQuery("p1", "live").queryKey;
		const group = { providerId: "p1", contentType: "live", groupName: "News", sortOrder: 0 };
		client.setQueryData(pinned, [group]);
		const live = renderHook(() => useWatchHistory(50, "live", "failed:"), {
			wrapper: wrapperFor(client),
		});
		await waitFor(() => expect(live.result.current.loading).toBe(false));

		await act(async () => live.result.current.change(() => []));
		expect(live.result.current.entries).toEqual([]);
		expect(client.getQueryData(pinned)).toEqual([group]);
	});

	it("loads the history again while the computer is offline", async () => {
		const wrapper = wrapperFor();
		// TanStack Query only hears the offline event while a client is mounted.
		renderHook(() => null, { wrapper });
		const first = renderHook(
			() => {
				useHistoryStaleOnLeave();
				return useWatchHistory(50, "live", "failed:");
			},
			{ wrapper }
		);
		await waitFor(() => expect(first.result.current.loading).toBe(false));
		first.unmount();
		act(() => {
			window.dispatchEvent(new Event("offline"));
		});
		try {
			const again = renderHook(() => useWatchHistory(50, "live", "failed:"), { wrapper });
			await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2));
			expect(again.result.current.entries).toEqual([news]);
		} finally {
			act(() => {
				window.dispatchEvent(new Event("online"));
			});
		}
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

	it("marks the history stale in the cache it used when the cache changes", async () => {
		const first = createTestQueryClient();
		await first.fetchQuery(watchHistoryQuery(50, "live"));
		const Leaves = () => {
			useHistoryStaleOnLeave();
			return null;
		};
		const view = render(
			createElement(QueryClientProvider, { client: first }, createElement(Leaves))
		);
		const second = createTestQueryClient();
		view.rerender(
			createElement(QueryClientProvider, { client: second }, createElement(Leaves))
		);

		expect(first.getQueryState(watchHistoryQuery(50, "live").queryKey)?.isInvalidated).toBe(
			true
		);
		view.unmount();
	});
});
