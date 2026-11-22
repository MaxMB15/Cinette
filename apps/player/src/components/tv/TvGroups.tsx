// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useMemo } from "react";
import { categoriesByCount } from "@/lib/channels";
import { moveFocus } from "@/lib/tv-focus";
import type { Channel } from "@/lib/types";
import { TvList } from "./TvList";
import { COLUMN_HEIGHT, TvTextRow } from "./ui";

// A channel with no group has the empty group title, so this can't be empty too.
const ALL = "\0all";
const ROW_HEIGHT = 2.75;

/** A group of channels, and how many it has. */
export interface TvGroup {
	id: string;
	name: string;
	channelCount: number;
}

/** The groups of `items`, largest first after one with all of them, and what's in a group. */
export const useTvGroups = (items: readonly Channel[], allLabel: string) =>
	useMemo(() => {
		const byGroup = new Map<string, Channel[]>();
		for (const ch of items) {
			const list = byGroup.get(ch.groupTitle);
			if (list) list.push(ch);
			else byGroup.set(ch.groupTitle, [ch]);
		}
		const groups: TvGroup[] = [
			{ id: ALL, name: allLabel, channelCount: items.length },
			...categoriesByCount([...items]).map((g) => ({
				id: g.name,
				name: g.name || "No group",
				channelCount: g.channelCount,
			})),
		];
		const itemsOf = (group: TvGroup): readonly Channel[] =>
			group.id === ALL ? items : (byGroup.get(group.id) ?? []);
		return { groups, itemsOf };
	}, [items, allLabel]);

/** The column of groups. What's in the group shows as the cursor reaches it, and OK goes there. */
export const TvGroupList = ({
	groups,
	active,
	onActiveChange,
	start,
	label = "Groups",
}: {
	groups: readonly TvGroup[];
	active: number;
	onActiveChange: (index: number) => void;
	start: boolean;
	label?: string;
}) => (
	<TvList
		className="w-[13rem] shrink-0"
		items={groups}
		label={label}
		itemKey={(g) => g.id}
		active={active}
		onActiveChange={onActiveChange}
		onSelect={() => moveFocus("right")}
		rowHeight={ROW_HEIGHT}
		height={COLUMN_HEIGHT}
		start={start}
		renderItem={(g) => <TvTextRow label={g.name} end={g.channelCount.toLocaleString()} />}
		itemClassName="rounded-[0.5rem]"
	/>
);
