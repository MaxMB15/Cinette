// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel } from "@/lib/types";
import { TvGroupList } from "./TvGroups";
import { TvList } from "./TvList";
import { COLUMN_HEIGHT, TvChannelRow } from "./ui";

const ITEM_ROW = 3.4;

/** Items of one kind, such as the live channels or the movies. */
export interface TvKind {
	name: string;
	items: readonly Channel[];
}

/** Where the cursor is: the kind, the item in it, and whether the focus was on the kinds. */
export interface TvKindsPlace {
	kind: number;
	item: number;
	inKinds: boolean;
}

/** The first item of the first kind. */
export const KINDS_START: TvKindsPlace = { kind: 0, item: 0, inKinds: false };

/**
 * The kinds, each with how many items it has, beside the items of the kind
 * the cursor is on. Every kind has at least one item. `start` puts the
 * screen's start here, on the column the focus was last in.
 */
export const TvKinds = ({
	kinds,
	place,
	onPlaceChange,
	onOpen,
	itemsClassName,
	start = true,
}: {
	kinds: readonly TvKind[];
	place: TvKindsPlace;
	onPlaceChange: (place: TvKindsPlace) => void;
	onOpen: (item: Channel, list: readonly Channel[]) => void;
	itemsClassName: string;
	start?: boolean;
}) => {
	const kind = kinds[Math.min(place.kind, kinds.length - 1)];
	return (
		<>
			<TvGroupList
				label="Kinds"
				groups={kinds.map((k) => ({
					id: k.name,
					name: k.name,
					channelCount: k.items.length,
				}))}
				active={place.kind}
				onActiveChange={(i) => onPlaceChange({ kind: i, item: 0, inKinds: true })}
				start={start && place.inKinds}
			/>
			<TvList
				className={itemsClassName}
				items={kind.items}
				label={kind.name}
				itemKey={(item) => item.id}
				active={place.item}
				onActiveChange={(i) => onPlaceChange({ ...place, item: i, inKinds: false })}
				onSelect={(item) => onOpen(item, kind.items)}
				rowHeight={ITEM_ROW}
				height={COLUMN_HEIGHT}
				start={start && !place.inKinds}
				itemClassName="rounded-[0.5rem]"
				renderItem={(item) => <TvChannelRow channel={item} />}
			/>
		</>
	);
};
