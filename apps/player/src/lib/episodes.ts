// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel } from "./types";
import { withSource } from "./sources";

/** Episodes ordered by season, then episode number. */
export const sortEpisodes = (eps: Channel[]): Channel[] =>
	[...eps].sort((a, b) => {
		const sa = a.season ?? 0,
			sb = b.season ?? 0;
		if (sa !== sb) return sa - sb;
		return (a.episode ?? 0) - (b.episode ?? 0);
	});

/**
 * One entry per season + episode. Duplicate entries (the same episode from
 * other providers or categories) are folded into the first one's `sources`.
 */
export const dedupeEpisodes = (episodes: Channel[]): Channel[] => {
	const seen = new Map<string, { ch: Channel; extraSources: string[] }>();
	for (const ep of episodes) {
		const key = `${ep.season ?? 0}x${ep.episode ?? ep.name}`;
		if (!seen.has(key)) {
			seen.set(key, { ch: { ...ep }, extraSources: [...ep.sources] });
		} else {
			const entry = seen.get(key)!;
			entry.extraSources.push(ep.url, ...ep.sources);
			if (!entry.ch.logoUrl && ep.logoUrl) entry.ch.logoUrl = ep.logoUrl;
		}
	}
	return Array.from(seen.values()).map(({ ch, extraSources }) => ({
		...ch,
		sources: extraSources,
	}));
};

/**
 * Find a previously watched episode in a series' episode list, e.g. to replay
 * it from watch history. Matches by id first, then by the SxxEyy in `name`
 * (episode ids are index-based and can shift when the provider refreshes).
 * The result carries every source of that episode, set to the one watched
 * when it's still available. Returns null when the episode isn't in the list.
 */
export const findEpisode = (episodes: Channel[], id: string, name: string): Channel | null => {
	const exact = episodes.find((e) => e.id === id);
	const m = name.match(/S(\d{1,3})E(\d{1,3})/i);
	const season = exact?.season ?? (m ? parseInt(m[1], 10) : undefined);
	const episode = exact?.episode ?? (m ? parseInt(m[2], 10) : undefined);
	if (season == null || episode == null) return exact ?? null;
	const merged = dedupeEpisodes(episodes).find(
		(e) => e.season === season && e.episode === episode
	);
	if (!merged) return exact ?? null;
	return exact ? withSource(merged, exact.url) : merged;
};
