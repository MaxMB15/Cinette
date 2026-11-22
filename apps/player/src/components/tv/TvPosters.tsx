// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { ChannelLogo } from "@/components/channels/ChannelLogo";
import type { Channel } from "@/lib/types";
import { TvGroupList, useTvGroups } from "./TvGroups";
import { TvList } from "./TvList";
import { COLUMN_HEIGHT, TvHeader } from "./ui";
import { useRemembered } from "./tv-nav";

const POSTER_ROW = 12.75;
/** Eight fit the 56.5rem beside the rail, and six fit beside the groups. */
const POSTER_WIDTH = 7.0625;

/** A poster with its title under it. */
const PosterCell = ({ channel }: { channel: Channel }) => (
	<div className="flex h-full flex-col rounded-[0.375rem] p-[0.25rem]">
		<ChannelLogo
			url={channel.logoUrl}
			className="min-h-0 flex-1 rounded-[0.25rem] bg-[hsl(220_14%_14%)] text-white"
			imgClassName="object-cover"
			fallback={
				<span className="text-[2rem] font-semibold">
					{channel.name.charAt(0).toUpperCase()}
				</span>
			}
		/>
		<p className="tv-name mt-[0.25rem] truncate px-[0.125rem] text-[0.8rem] leading-[1.1rem] font-medium">
			{channel.name}
		</p>
	</div>
);

/**
 * Movies or shows as a list of groups beside a grid of posters. A provider
 * with one group or none skips the list, and the grid gets its room.
 */
export const TvPosters = ({
	title,
	memoryKey,
	items,
	onOpen,
}: {
	title: string;
	memoryKey: string;
	items: readonly Channel[];
	onOpen: (item: Channel) => void;
}) => {
	const [place, setPlace] = useRemembered(memoryKey, { group: 0, item: 0, inGroups: false });
	const { groups, itemsOf } = useTvGroups(items, "All");

	// "All" and one group show the same items.
	const showGroups = groups.length > 2;
	const group = groups[showGroups ? Math.min(place.group, groups.length - 1) : 0];

	return (
		<div className="flex h-full flex-col">
			<TvHeader title={title} />
			<div className="flex gap-[1rem] px-[1.5rem]">
				{showGroups && (
					<TvGroupList
						groups={groups}
						active={place.group}
						onActiveChange={(i) => setPlace({ group: i, item: 0, inGroups: true })}
						start={place.inGroups}
					/>
				)}
				<TvList
					className="min-w-0 flex-1"
					items={itemsOf(group)}
					label={title}
					itemKey={(ch) => ch.id}
					active={place.item}
					onActiveChange={(i) => setPlace({ ...place, item: i, inGroups: false })}
					onSelect={onOpen}
					rowHeight={POSTER_ROW}
					height={COLUMN_HEIGHT}
					columns={showGroups ? 6 : 8}
					columnWidth={POSTER_WIDTH}
					start={!place.inGroups}
					itemClassName="rounded-[0.375rem]"
					renderItem={(ch) => <PosterCell channel={ch} />}
				/>
			</div>
		</div>
	);
};
