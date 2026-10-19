// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { historyKey, watchHistoryQuery } from "@/lib/queries";
import type { WatchHistoryEntry } from "@/lib/types";

const NO_ENTRIES: WatchHistoryEntry[] = [];

/**
 * The newest `limit` watch history entries, of one content type or of all,
 * from the cache. `logPrefix` starts the line logged when they can't load.
 */
export const useWatchHistory = (
	limit: number,
	contentType: string | undefined,
	logPrefix: string
) => {
	const queryClient = useQueryClient();
	const result = useQuery(watchHistoryQuery(limit, contentType));

	useEffect(() => {
		if (result.error) console.error(logPrefix, result.error);
	}, [result.error, logPrefix]);

	/**
	 * Shows a change the backend has already made in every history list now,
	 * without loading this one again. `edit` gets each list, so it must only
	 * take out what the backend took out. A list may then hold fewer entries
	 * than it would load, so each loads again the next time it shows.
	 */
	const change = (edit: (entries: WatchHistoryEntry[]) => WatchHistoryEntry[]) => {
		queryClient.setQueriesData<WatchHistoryEntry[]>(
			{ queryKey: historyKey() },
			(prev) => prev && edit(prev)
		);
		// After the edit, which would mark them fresh again.
		void queryClient.invalidateQueries({ queryKey: historyKey(), refetchType: "none" });
	};

	return { entries: result.data ?? NO_ENTRIES, loading: result.isPending, change };
};

/**
 * Marks the watch history stale when the channel list closes, since the
 * player and Settings, which open in its place, change it. Each history list
 * then loads once when the channel list opens again, and switching tabs reads
 * the cache.
 */
export const useHistoryStaleOnLeave = () => {
	const queryClient = useQueryClient();
	useEffect(
		() => () => {
			void queryClient.invalidateQueries({ queryKey: historyKey(), refetchType: "none" });
		},
		[queryClient]
	);
};
