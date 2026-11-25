// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Heart } from "lucide-react";
import { useChannels } from "@/hooks/useChannels";
import { programProgress, useNowNext } from "@/hooks/useNowNext";
import { formatHHMM } from "@/lib/epg-window";
import type { Channel, EpgProgram } from "@/lib/types";
import { TvGroupList, useTvGroups } from "./TvGroups";
import { TvList } from "./TvList";
import { COLUMN_HEIGHT, TvButton, TvChannelRow, TvHeader } from "./ui";
import { useRemembered } from "./tv-nav";

const CHANNEL_ROW = 3.4;
/** How many programs after the current one fit under it. */
const UPCOMING = 4;

/**
 * Live TV as three columns the D-pad walks across: groups, the group's
 * channels, and what's on the channel. OK on a channel plays it, so with the
 * focus starting in the channels, it takes one press to watch.
 */
export const TvLive = ({
	live,
	onPlay,
}: {
	live: readonly Channel[];
	onPlay: (channel: Channel, list: readonly Channel[]) => void;
}) => {
	const { toggleFavorite } = useChannels();
	const { now, nowNextOf, scheduleOf } = useNowNext();
	const [place, setPlace] = useRemembered("live", { group: 0, channel: 0, inGroups: false });
	const { groups, itemsOf } = useTvGroups(live, "All channels");

	const group = groups[Math.min(place.group, groups.length - 1)];
	const channels = itemsOf(group);
	const channel: Channel | undefined = channels[Math.min(place.channel, channels.length - 1)];

	return (
		<div className="flex h-full flex-col">
			<TvHeader title="Live TV" />
			<div className="flex gap-[1rem] px-[1.5rem]">
				<TvGroupList
					groups={groups}
					active={place.group}
					onActiveChange={(i) => setPlace({ group: i, channel: 0, inGroups: true })}
					start={place.inGroups}
				/>
				<TvList
					className="w-[24rem] shrink-0"
					items={channels}
					label={`Channels in ${group.name}`}
					itemKey={(ch) => ch.id}
					active={place.channel}
					onActiveChange={(i) => setPlace({ ...place, channel: i, inGroups: false })}
					onSelect={(ch) => onPlay(ch, channels)}
					rowHeight={CHANNEL_ROW}
					height={COLUMN_HEIGHT}
					start={!place.inGroups}
					itemClassName="rounded-[0.5rem]"
					renderItem={(ch) => (
						<TvChannelRow channel={ch} line={nowNextOf(ch).now?.title} />
					)}
				/>
				{channel && (
					<ChannelInfo
						channel={channel}
						schedule={scheduleOf(channel)}
						now={now}
						onToggleFavorite={() => void toggleFavorite(channel.id)}
					/>
				)}
			</div>
		</div>
	);
};

export const timeSpan = (program: EpgProgram): string =>
	`${formatHHMM(program.startTime)} to ${formatHHMM(program.endTime)}`;

/** What's on the channel the cursor is on and what comes after, with its one action. */
export const ChannelInfo = ({
	channel,
	schedule,
	now,
	height = COLUMN_HEIGHT,
	onToggleFavorite,
}: {
	channel: Channel;
	schedule: readonly EpgProgram[];
	now: number;
	height?: number;
	onToggleFavorite: () => void;
}) => {
	const current = schedule[0]?.startTime <= now ? schedule[0] : null;
	const upcoming = schedule.slice(current ? 1 : 0, (current ? 1 : 0) + UPCOMING);
	return (
		<aside className="flex min-w-0 flex-1 flex-col" style={{ height: `${height}rem` }}>
			<TvButton className="w-full shrink-0" onClick={onToggleFavorite}>
				<Heart
					aria-hidden
					className={
						channel.isFavorite ? "size-[1.25rem] fill-current" : "size-[1.25rem]"
					}
				/>
				{channel.isFavorite ? "Remove from favorites" : "Add to favorites"}
			</TvButton>
			{current ? (
				<div className="mt-[1rem]">
					<p className="text-[0.8rem] leading-[1.1rem] tabular-nums opacity-70">
						{timeSpan(current)}
					</p>
					<p className="line-clamp-2 text-[1.125rem] leading-[1.5rem] font-semibold">
						{current.title}
					</p>
					<div className="mt-[0.5rem] h-[0.25rem] overflow-clip rounded-full bg-white/15">
						<div
							className="h-full bg-primary"
							style={{ width: `${programProgress(current, now) * 100}%` }}
						/>
					</div>
					{current.description && (
						<p className="mt-[0.5rem] line-clamp-4 text-[0.8rem] leading-[1.15rem] opacity-70">
							{current.description}
						</p>
					)}
				</div>
			) : (
				<p className="mt-[1rem] text-[0.8rem] leading-[1.1rem] opacity-70">
					{schedule.length === 0 ? "No guide for this channel" : "Nothing on right now"}
				</p>
			)}
			{upcoming.length > 0 && (
				<ul className="mt-[1rem] flex min-h-0 flex-col gap-[0.5rem] overflow-clip">
					{upcoming.map((p) => (
						<li key={`${p.startTime}-${p.title}`} className="flex gap-[0.75rem]">
							<span className="shrink-0 text-[0.8rem] leading-[1.25rem] tabular-nums opacity-70">
								{formatHHMM(p.startTime)}
							</span>
							<span className="min-w-0 truncate text-[0.875rem] leading-[1.25rem] font-medium">
								{p.title}
							</span>
						</li>
					))}
				</ul>
			)}
		</aside>
	);
};
