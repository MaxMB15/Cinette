// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { historyKey, watchHistoryQuery } from "@/lib/queries";
import type { WatchHistoryEntry } from "@/lib/types";

const NO_ENTRIES: WatchHistoryEntry[] = [];

/**
 * The newest `limit` watch history entries, of one content type or of all,
 * from the cache. `failure` starts the line logged when they can't load.
 */
export const useWatchHistory = (
	limit: number,
	contentType: string | undefined,
	failure: string
) => {
	const queryClient = useQueryClient();
	const query = watchHistoryQuery(limit, contentType);
	const result = useQuery(query);

	useEffect(() => {
		if (result.error) console.error(failure, result.error);
	}, [result.error, failure]);

	/**
	 * Shows a change the backend has already made: in this list now, without
	 * loading it again, and in the other history lists when they next show.
	 */
	const change = (edit: (entries: WatchHistoryEntry[]) => WatchHistoryEntry[]) => {
		void queryClient.invalidateQueries({ queryKey: historyKey(), refetchType: "none" });
		queryClient.setQueryData(query.queryKey, (prev) => prev && edit(prev));
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
