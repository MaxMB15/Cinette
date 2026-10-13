// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useCallback, useMemo } from "react";
import {
	getGroupHierarchy,
	getPinnedGroups,
	pinGroup as pinGroupApi,
	unpinGroup as unpinGroupApi,
} from "@/lib/tauri";
import { superCategoryNames } from "@/lib/group-hierarchy";
import type { GroupHierarchyEntry, PinnedGroup } from "@/lib/types";

export const useGroupHierarchy = (providerId: string | null, contentType: string) => {
	const [entries, setEntries] = useState<GroupHierarchyEntry[]>([]);
	const [pinnedGroups, setPinnedGroups] = useState<PinnedGroup[]>([]);
	const [loaded, setLoaded] = useState(false);

	const load = useCallback(async () => {
		if (!providerId) return;
		return Promise.all([
			getGroupHierarchy(providerId, contentType),
			getPinnedGroups(providerId, contentType),
		])
			.then(([h, p]) => {
				setEntries(h);
				setPinnedGroups(p);
			})
			.catch((err) => console.error("Failed to load group hierarchy:", err))
			.finally(() => setLoaded(true));
	}, [providerId, contentType]);

	useEffect(() => {
		load();
	}, [load]);

	const superCategories = useMemo(() => superCategoryNames(entries), [entries]);

	const topLevelGroups = useMemo(
		() => entries.filter((e) => !e.superCategory).map((e) => e.groupName),
		[entries]
	);

	const getGroupsForCategory = useCallback(
		(category: string) =>
			entries.filter((e) => e.superCategory === category).map((e) => e.groupName),
		[entries]
	);

	const hasHierarchy = superCategories.length > 0;

	const pinGroup = useCallback(
		async (groupName: string) => {
			if (!providerId) return;
			const nextOrder =
				pinnedGroups.length > 0 ? pinnedGroups[pinnedGroups.length - 1].sortOrder + 100 : 0;
			await pinGroupApi(providerId, contentType, groupName, nextOrder);
			await load();
		},
		[providerId, contentType, pinnedGroups, load]
	);

	const unpinGroup = useCallback(
		async (groupName: string) => {
			if (!providerId) return;
			await unpinGroupApi(providerId, contentType, groupName);
			await load();
		},
		[providerId, contentType, load]
	);

	const isPinned = useCallback(
		(groupName: string) => pinnedGroups.some((p) => p.groupName === groupName),
		[pinnedGroups]
	);

	return {
		entries,
		pinnedGroups,
		loaded,
		superCategories,
		topLevelGroups,
		hasHierarchy,
		getGroupsForCategory,
		pinGroup,
		unpinGroup,
		isPinned,
		reload: load,
	};
};
