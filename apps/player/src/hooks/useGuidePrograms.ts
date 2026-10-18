// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useMemo } from "react";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { TimeRange } from "@/lib/epg-window";
import { channelGuideQuery, guideQuery } from "@/lib/queries";
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
	const prefix = channelGuideQuery(range, version, "").queryKey.slice(0, -1);
	const found = client
		.getQueriesData<EpgProgram[]>({ queryKey: prefix })
		.flatMap(([, data]) => data ?? []);
	return found.length > 0 ? found : undefined;
};

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
 * they had while the guide loads again.
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
	const at = range ?? NO_RANGE;

	// Read on the Favorites tab too, without loading, since every channel's
	// programs cover the favorites'.
	const all = useQuery({
		...guideQuery(at, version),
		enabled: range !== null && key === "all",
		select: byChannel,
		// While it loads, the last range's programs, or else the single
		// channels' already loaded for this one, keep the rows filled.
		placeholderData: (previous) => previous ?? channelsLoaded(queryClient, at, version),
	});
	const allLoaded = all.isSuccess && !all.isPlaceholderData;

	const perChannel = useQueries({
		queries: ids.map((id) => ({
			...channelGuideQuery(at, version, id),
			enabled: range !== null && !allLoaded,
			placeholderData: (previous: EpgProgram[] | undefined) => previous,
		})),
		combine: (results) => {
			const programs = new Map<string, EpgProgram[]>();
			const waiting = new Set<string>();
			results.forEach((r, i) => {
				if (r.data && r.data.length > 0) programs.set(ids[i], r.data);
				if (r.isPending || r.isPlaceholderData) waiting.add(ids[i]);
			});
			return { programs, waiting };
		},
	});

	if (key === null) return { programs: all.data ?? EMPTY, isPending: () => false };
	if (key === "all" || allLoaded) {
		const waiting = key === "all" && !allLoaded && !all.isError;
		return {
			programs: all.data ?? EMPTY,
			isPending: () => waiting,
		};
	}
	return {
		programs: perChannel.programs,
		isPending: (id) => perChannel.waiting.has(id),
	};
};
