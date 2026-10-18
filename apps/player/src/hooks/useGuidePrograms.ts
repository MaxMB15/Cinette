// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useMemo } from "react";
import {
	useQueries,
	useQuery,
	useQueryClient,
	type QueryClient,
	type QueryKey,
} from "@tanstack/react-query";
import type { TimeRange } from "@/lib/epg-window";
import { channelGuideKey, channelGuideQuery, guideKey, guideQuery } from "@/lib/queries";
import type { EpgProgram } from "@/lib/types";

/** Every channel's programs, or only those of the channels with these guide ids. */
export type GuideChannels = "all" | readonly string[];

/** The guide's programs and which channels are still waiting for theirs. */
export interface GuidePrograms {
	/** The programs over the range by guide id. */
	programs: ReadonlyMap<string, EpgProgram[]>;
	/**
	 * This guide id's programs are asked for and haven't come in, so a channel
	 * with none may only be waiting for them.
	 */
	isPending: (id: string) => boolean;
}

/** The programs grouped by guide id, each channel's in the order they came. */
const byChannel = (programs: EpgProgram[]): Map<string, EpgProgram[]> => {
	const map = new Map<string, EpgProgram[]>();
	for (const p of programs) {
		const list = map.get(p.channelId);
		if (list) list.push(p);
		else map.set(p.channelId, [p]);
	}
	return map;
};

/**
 * What `channels` asks for as one string, with each id once and in order, so
 * a new list with the same ids is the same request.
 */
const requestKey = (channels: GuideChannels | null): string | null =>
	channels === null || channels === "all"
		? channels
		: JSON.stringify([...new Set(channels)].sort());

const NO_IDS: string[] = [];
const EMPTY: ReadonlyMap<string, EpgProgram[]> = new Map();
// A range that is never loaded, for the queries while there is no range.
// Stryker disable next-line ObjectLiteral: no query loads without a range, so its placeholder range is never seen.
const NO_RANGE: TimeRange = { from: 0, to: 0 };

/**
 * The programs already loaded for single channels over this range, which
 * stand in while every channel's programs load.
 */
const channelsLoaded = (
	client: QueryClient,
	range: TimeRange,
	version: string
): EpgProgram[] | undefined => {
	const found = client
		.getQueriesData<EpgProgram[]>({ queryKey: channelGuideKey(range, version) })
		.flatMap(([, data]) => data ?? []);
	// TanStack Query keeps showing a placeholder while the function that made
	// it stays the same, as it does compiled, so an empty one would hide the
	// programs that load later.
	// Stryker disable next-line ConditionalExpression,EqualityOperator: only compiled code keeps the placeholder, and Stryker's runs leave the compiler out.
	return found.length > 0 ? found : undefined;
};

/**
 * The programs of the guide query that loaded last among those whose key
 * `matches` picks. A query that never loaded has no update time, so it sorts
 * last.
 */
const newestLoaded = (
	client: QueryClient,
	matches: (key: QueryKey) => boolean
): EpgProgram[] | undefined => {
	const newest = client
		.getQueryCache()
		.findAll({ queryKey: guideKey() })
		.filter((q) => matches(q.queryKey))
		.sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0];
	return newest?.state.data as EpgProgram[] | undefined;
};

/**
 * The programs last loaded for one channel, over any range, which stand in
 * while its programs load for a new one, and stay when that load fails.
 */
const lastLoaded = (client: QueryClient, id: string): EpgProgram[] | undefined =>
	newestLoaded(client, (key) => key[key.length - 2] === "channel" && key[key.length - 1] === id);

// How long every channel's key is, which tells it from a single channel's.
const ALL_KEY_LENGTH = guideQuery(NO_RANGE, "").queryKey.length;

/**
 * What every channel's rows showed before a load for a new range or guide
 * failed: the programs every channel's load found last, over any range, or
 * else the single channels' already loaded for this one.
 */
const lastShown = (
	client: QueryClient,
	range: TimeRange,
	version: string
): EpgProgram[] | undefined =>
	newestLoaded(client, (key) => key.length === ALL_KEY_LENGTH && key[key.length - 1] === "all") ??
	channelsLoaded(client, range, version);

/**
 * The guide's programs over `range` by guide id, for `channels`. With null it
 * loads nothing.
 *
 * "all" loads every channel once for the range. A list of ids loads each id
 * that isn't cached for the range, in one call for the ids asked for together,
 * so a new favorite loads only its own programs. A list loads nothing when
 * every channel's programs are cached for the range, and while that load is
 * on its way a list still loads its own ids rather than wait for it.
 *
 * Answers are cached by range and `resetKey`, so coming back to a tab shows
 * them again without a call. A new range or `resetKey` loads again, and the
 * programs stay until its answer replaces them, so the rows keep showing what
 * they had while the guide loads again. When that load fails, they keep
 * showing it. TanStack Query only shows a placeholder while a query is
 * pending, so the hook finds those programs in the cache again.
 */
export const useGuidePrograms = (
	range: TimeRange | null,
	channels: GuideChannels | null,
	resetKey: string | number
): GuidePrograms => {
	const key = useMemo(() => requestKey(channels), [channels]);
	const ids = useMemo(
		() => (key === null || key === "all" ? NO_IDS : (JSON.parse(key) as string[])),
		[key]
	);
	const queryClient = useQueryClient();
	const version = String(resetKey);
	const guideRange = range ?? NO_RANGE;

	// Read on the Favorites tab too, without loading, since every channel's
	// programs cover the favorites'.
	const all = useQuery({
		...guideQuery(guideRange, version),
		enabled: range !== null && key === "all",
		// While it loads, the last range's programs, or else the single
		// channels' already loaded for this one, keep the rows filled.
		placeholderData: (previous) => previous ?? channelsLoaded(queryClient, guideRange, version),
	});
	const allLoaded = all.isSuccess && !all.isPlaceholderData;
	const allData =
		all.data ?? (all.isError ? lastShown(queryClient, guideRange, version) : undefined);
	// Grouped here rather than in the query's select, which runs again on each
	// read while a placeholder shows and would give a new map every time.
	const allPrograms = useMemo(() => (allData ? byChannel(allData) : EMPTY), [allData]);

	const perChannel = useQueries({
		queries: ids.map((id) => ({
			...channelGuideQuery(guideRange, version, id),
			enabled: range !== null && !allLoaded,
			placeholderData: () => lastLoaded(queryClient, id),
		})),
		combine: (results) => {
			const programs = new Map<string, EpgProgram[]>();
			const waiting = new Set<string>();
			results.forEach((r, i) => {
				const data = r.data ?? (r.isError ? lastLoaded(queryClient, ids[i]) : undefined);
				if (data && data.length > 0) programs.set(ids[i], data);
				if (r.isPending || r.isPlaceholderData) waiting.add(ids[i]);
			});
			return { programs, waiting };
		},
	});

	if (key === null) return { programs: allPrograms, isPending: () => false };
	if (key === "all" || allLoaded) {
		// Every channel's programs are loading, unless they're in or failed.
		const waiting = !allLoaded && !all.isError;
		return {
			programs: allPrograms,
			isPending: () => waiting,
		};
	}
	return {
		programs: perChannel.programs,
		isPending: (id) => perChannel.waiting.has(id),
	};
};
