// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { pinGroup as pinGroupApi, unpinGroup as unpinGroupApi } from "@/lib/tauri";
import { groupHierarchyQuery, pinnedGroupsQuery } from "@/lib/queries";
import { superCategoryNames } from "@/lib/group-hierarchy";
import type { GroupHierarchyEntry, PinnedGroup } from "@/lib/types";

// The lists before they load, or when they fail to, kept the same between renders.
const NO_ENTRIES: GroupHierarchyEntry[] = [];
const NO_PINNED: PinnedGroup[] = [];

export const useGroupHierarchy = (providerId: string | null, contentType: string) => {
	const queryClient = useQueryClient();
	// No provider is chosen yet, so nothing loads. The key is never fetched.
	// Stryker disable next-line StringLiteral: no query loads without a provider, so its placeholder id is never seen.
	const id = providerId ?? "";
	const hierarchyResult = useQuery({
		...groupHierarchyQuery(id, contentType),
		enabled: providerId !== null,
	});
	const pinnedResult = useQuery({
		...pinnedGroupsQuery(id, contentType),
		enabled: providerId !== null,
	});
	const entries = hierarchyResult.data ?? NO_ENTRIES;
	const pinnedGroups = pinnedResult.data ?? NO_PINNED;
	// A list that failed to load counts as loaded, with no groups. Without a
	// provider both stay pending, so nothing counts as loaded.
	const loaded = !hierarchyResult.isPending && !pinnedResult.isPending;

	const failure = hierarchyResult.error ?? pinnedResult.error;
	useEffect(() => {
		if (failure) console.error("Failed to load group hierarchy:", failure);
	}, [failure]);

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

	// Pinning only changes the pinned list, so only that loads again.
	const reloadPinned = useCallback(
		(id: string) =>
			queryClient.invalidateQueries({
				queryKey: pinnedGroupsQuery(id, contentType).queryKey,
			}),
		[queryClient, contentType]
	);

	const pinGroup = useCallback(
		async (groupName: string) => {
			if (!providerId) return;
			const nextOrder =
				pinnedGroups.length > 0 ? pinnedGroups[pinnedGroups.length - 1].sortOrder + 100 : 0;
			await pinGroupApi(providerId, contentType, groupName, nextOrder);
			await reloadPinned(providerId);
		},
		[providerId, contentType, pinnedGroups, reloadPinned]
	);

	const unpinGroup = useCallback(
		async (groupName: string) => {
			if (!providerId) return;
			await unpinGroupApi(providerId, contentType, groupName);
			await reloadPinned(providerId);
		},
		[providerId, contentType, reloadPinned]
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
	};
};
