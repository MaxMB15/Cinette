// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel } from "./types";
import { withSource } from "./sources";

/** What an episode is told apart by, in this device's list or another's. */
interface Numbered {
	id: string;
	season?: number;
	episode?: number;
}

/** Episodes ordered by season, then episode number. */
export const sortEpisodes = <T extends Numbered>(eps: T[]): T[] =>
	[...eps].sort((a, b) => {
		const sa = a.season ?? 0,
			sb = b.season ?? 0;
		if (sa !== sb) return sa - sb;
		return (a.episode ?? 0) - (b.episode ?? 0);
	});

/** Same season + episode (duplicate entries of one episode from different sources). */
export const isSameEpisode = (a: Numbered, b: Numbered): boolean =>
	a.season != null && a.episode != null && a.season === b.season && a.episode === b.episode;

/**
 * The episodes before and after the one at `index` in `sorted`, skipping
 * other copies of it, as from another source.
 */
export const episodeNeighbors = <T extends Numbered>(
	sorted: T[],
	index: number
): { prev: T | null; next: T | null } => {
	if (index < 0) return { prev: null, next: null };
	const current = sorted[index];
	const differs = (ep: T) => !isSameEpisode(ep, current) && ep.id !== current.id;
	return {
		prev: sorted.slice(0, index).reverse().find(differs) ?? null,
		next: sorted.slice(index + 1).find(differs) ?? null,
	};
};

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

/**
 * What follows the show and the S01E01 in an episode's name. Xtream servers often
 * repeat both in the title, as in "Show S01E03 Show - S01E03 - Title", so this
 * goes by the last code.
 */
const afterCode = (name: string): string =>
	name.replace(/^.*\bS\d{1,3}\s*E\d+[\s:._-]*/i, "").trim();

/** An episode's name without the show and the S01E01 before it. */
export const episodeTitle = (name: string): string => afterCode(name) || name;

/** The episode's own title, or "" when it has none past a name like "Episode 3". */
const ownTitle = (name: string): string => {
	const title = afterCode(name);
	return /^ep(isode)?\s*\d+$/i.test(title) ? "" : title;
};

/** An episode's row in a list: "3 Title", or "Episode 3" when it has no title of its own. */
export const episodeLabel = ({ name, episode }: Pick<Channel, "name" | "episode">): string => {
	if (episode == null) return afterCode(name) || name;
	const title = ownTitle(name);
	return title ? `${episode} ${title}` : `Episode ${episode}`;
};

/**
 * An episode's heading: "S2 E5 · Title", or "S2 E5" when it has no title of
 * its own. Without the numbers, it's the title, or the whole name.
 */
export const episodeHeading = (name: string, season?: number, episode?: number): string => {
	if (season == null || episode == null) return afterCode(name) || name;
	const title = ownTitle(name);
	const code = `S${season} E${episode}`;
	return title ? `${code} \u00b7 ${title}` : code;
};
