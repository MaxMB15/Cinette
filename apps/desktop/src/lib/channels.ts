// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Category, Channel } from "@/lib/types";

/**
 * Categories in the order their groups first appear, with ids cat-0, cat-1
 * and so on. This is the list useChannels exposes.
 */
export const deriveCategories = (channels: Channel[]): Category[] => {
	const counts = new Map<string, number>();
	for (const ch of channels) {
		counts.set(ch.groupTitle, (counts.get(ch.groupTitle) ?? 0) + 1);
	}
	return Array.from(counts.entries()).map(([name, channelCount], i) => ({
		id: `cat-${i}`,
		name,
		channelCount,
	}));
};

/**
 * The channel list's categories. Each id is the group name, a channel with
 * no group counts under "", and the largest group comes first.
 */
export const categoriesByCount = (channels: Channel[]): Category[] => {
	const counts: Record<string, number> = {};
	for (const ch of channels) {
		const key = ch.groupTitle || "";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.entries(counts)
		.map(([name, channelCount]) => ({ id: name, name, channelCount }))
		.sort((a, b) => b.channelCount - a.channelCount);
};

/** How many channels the named group holds, or 0 when it is not listed. */
export const channelCountFor = (categories: Category[], groupName: string): number =>
	categories.find((c) => c.name === groupName)?.channelCount ?? 0;

/**
 * Merges movies that share a title, so a film offered by several providers
 * shows once with the other streams as alternate sources.
 */
export const dedupeByTitle = (channels: Channel[]): Channel[] => {
	const seen = new Map<string, Channel>();
	for (const ch of channels) {
		const existing = seen.get(ch.name);
		if (!existing) {
			seen.set(ch.name, { ...ch, sources: [...ch.sources] });
		} else {
			existing.sources.push(ch.url);
			existing.sources.push(...ch.sources);
			if (!existing.logoUrl && ch.logoUrl) existing.logoUrl = ch.logoUrl;
		}
	}
	return Array.from(seen.values());
};
