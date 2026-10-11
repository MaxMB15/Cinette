// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel, GroupHierarchyEntry } from "./types";

/** Each category once, in the order its first group appears, which is the order they are shown in. */
export const superCategoryNames = (entries: GroupHierarchyEntry[]): string[] => {
	const names = new Set<string>();
	for (const entry of entries) {
		if (entry.superCategory) names.add(entry.superCategory);
	}
	return [...names];
};

/** The provider's own groups for one content type, in channel order. */
export const groupTitles = (channels: Channel[], contentType: string): string[] => [
	...new Set(channels.filter((c) => c.contentType === contentType).map((c) => c.groupTitle)),
];

/**
 * Pairs each group with the names of its first few channels, so the AI can
 * judge a group by what it holds and not only by its title. Only channels of
 * the given content type count, since a provider can reuse a group title
 * across live, movies and series.
 */
export const groupSamples = (
	channels: Channel[],
	groupNames: string[],
	contentType: string,
	perGroup: number
): [string, string[]][] => {
	const samples = new Map<string, string[]>(groupNames.map((g) => [g, []]));
	for (const c of channels) {
		if (c.contentType !== contentType) continue;
		const names = samples.get(c.groupTitle);
		if (names && names.length < perGroup) names.push(c.name);
	}
	return groupNames.map((g) => [g, samples.get(g) ?? []]);
};
