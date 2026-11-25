// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, type KeyboardEvent } from "react";
import { Dialog } from "@/components/ui/dialog";
import { useNow } from "@/hooks/useNow";
import { useNowNext } from "@/hooks/useNowNext";
import { formatHHMM, getGridMarks, toPct } from "@/lib/epg-window";
import { directionForKey } from "@/lib/spatial-nav";
import {
	blockStyle,
	GUIDE_AHEAD,
	GUIDE_SPAN,
	guideSlots,
	halfHourOf,
	slotIndexAt,
	stepSlot,
	windowFor,
} from "@/lib/tv-guide";
import type { Channel, EpgProgram } from "@/lib/types";
import { cn } from "@/lib/utils";
import { timeLeft } from "./TvControls";
import { TvGroupList, useGroupedChannels } from "./TvGroups";
import { TvList } from "./TvList";
import { timeSpan } from "./TvLive";
import { TvHeader } from "./ui";

const ROW_HEIGHT = 3.25;
/** Where the programs start in a row, past the channel's name, in rem. */
const PROGRAMS_LEFT = 10.5;
/** The details over the grid and the times above it, in rem. */
const DETAILS_HEIGHT = 7.5;
const RULER_HEIGHT = 1.6;

/** One channel's programs on the grid, from `from` over the time the grid shows. */
const GuideRow = ({
	channel,
	programs,
	from,
	at,
	now,
}: {
	channel: Channel;
	programs: readonly EpgProgram[];
	from: number;
	/** The cursor's time, on the row that has it. */
	at: number | null;
	now: number;
}) => (
	<div className="flex h-full items-stretch py-[0.1rem]">
		<div
			className="flex shrink-0 items-center pr-[0.5rem]"
			style={{ width: `${PROGRAMS_LEFT}rem` }}
		>
			<span className="tv-name min-w-0 truncate text-base font-medium">{channel.name}</span>
		</div>
		<div className="relative min-w-0 flex-1">
			{guideSlots(programs, from, from + GUIDE_SPAN).map((slot) => (
				<div
					key={slot.start}
					className={cn(
						"absolute inset-y-0 flex items-center overflow-clip rounded-[0.4rem] px-[0.6rem]",
						slot.program ? "bg-white/10" : "bg-white/[0.025]",
						slot.end <= now && "opacity-50",
						at !== null && slot.start <= at && at < slot.end && "tv-guide-focus"
					)}
					style={blockStyle(slot.start, slot.end, from, GUIDE_SPAN)}
				>
					<span
						className={cn(
							"truncate text-[0.9rem] leading-[1.2rem]",
							slot.program ? "font-medium" : "opacity-60"
						)}
					>
						{slot.program?.title ??
							(programs.length === 0 && "No schedule information")}
					</span>
				</div>
			))}
		</div>
	</div>
);

/** The program under the cursor, or what the guide lacks there. */
const GuideDetails = ({
	channel,
	program,
	hasPrograms,
	now,
}: {
	channel: Channel;
	program: EpgProgram | null;
	hasPrograms: boolean;
	now: number;
}) => (
	<div className="max-w-[40rem] shrink-0" style={{ height: `${DETAILS_HEIGHT}rem` }}>
		<p className="truncate text-[1.6rem] leading-[2rem] font-semibold">
			{program ? program.title : channel.name}
		</p>
		<p className="truncate text-[0.9rem] leading-[1.3rem] tabular-nums opacity-80">
			{program
				? [
						channel.name,
						timeSpan(program),
						program.startTime <= now ? timeLeft(program.endTime - now) : null,
					]
						.filter(Boolean)
						.join(", ")
				: hasPrograms
					? "No schedule information for this time"
					: "No schedule information for this channel"}
		</p>
		{program?.description && (
			<p className="mt-[0.4rem] line-clamp-2 text-[0.9rem] leading-[1.3rem] opacity-70">
				{program.description}
			</p>
		)}
	</div>
);

/**
 * The guide as a grid: channels down, two hours across, with the program
 * under the cursor described above it. Up and Down change channel and keep
 * the time. Left and Right move through the channel's programs, and the
 * grid moves along to keep the cursor in view. Left stops at the program on
 * now, and the key goes on to the column to the left. OK plays the channel.
 */
export const TvGuide = ({
	channels,
	label,
	active,
	onActiveChange,
	onPlay,
	rows,
	start,
}: {
	channels: readonly Channel[];
	/** What a screen reader calls the channels. */
	label: string;
	active: number;
	onActiveChange: (index: number) => void;
	onPlay: (channel: Channel) => void;
	/** How many channels show at once. */
	rows: number;
	/** The cursor takes the focus when the screen opens. */
	start: boolean;
}) => {
	const now = useNow();
	const earliest = halfHourOf(now);
	const [time, setTime] = useState({ at: now, from: earliest });
	// The clock moves the cursor and the grid on as programs end.
	const at = Math.max(time.at, now);
	const from = windowFor(Math.max(time.from, earliest), at, earliest);
	const { programsOf } = useNowNext(from + GUIDE_SPAN);

	const channel: Channel | undefined = channels[Math.min(active, channels.length - 1)];
	const programs = channel ? programsOf(channel) : [];
	const slots = guideSlots(programs, earliest, earliest + GUIDE_AHEAD);
	const slot = slots[slotIndexAt(slots, at)];

	const onKeyDown = (e: KeyboardEvent) => {
		const direction = directionForKey(e.key);
		if (direction !== "left" && direction !== "right") return;
		const next = stepSlot(slots, at, direction === "right" ? 1 : -1, now);
		if (next === null) return;
		e.preventDefault();
		setTime({ at: next, from: windowFor(from, next, earliest) });
	};

	return (
		<div className="flex min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
			{channel && (
				<GuideDetails
					channel={channel}
					program={slot.program}
					hasPrograms={programs.length > 0}
					now={now}
				/>
			)}
			<div
				aria-hidden
				className="relative shrink-0 text-[0.9rem] tabular-nums opacity-75"
				style={{ marginLeft: `${PROGRAMS_LEFT}rem`, height: `${RULER_HEIGHT}rem` }}
			>
				{getGridMarks(from, from + GUIDE_SPAN).map((t) => (
					<span
						key={t}
						className="absolute top-0 leading-[1.2rem]"
						style={{ left: `${toPct(t, from, GUIDE_SPAN)}%` }}
					>
						{formatHHMM(t)}
					</span>
				))}
			</div>
			<div className="relative">
				<TvList
					items={channels}
					label={label}
					itemKey={(ch) => ch.id}
					active={active}
					onActiveChange={onActiveChange}
					onSelect={onPlay}
					rowHeight={ROW_HEIGHT}
					height={rows * ROW_HEIGHT}
					start={start}
					itemClassName="tv-guide-row"
					renderItem={(ch) => (
						<GuideRow
							channel={ch}
							programs={programsOf(ch)}
							from={from}
							at={ch === channel ? at : null}
							now={now}
						/>
					)}
				/>
				{from === earliest && (
					<div
						aria-hidden
						className="pointer-events-none absolute inset-y-0 right-0"
						style={{ left: `${PROGRAMS_LEFT}rem` }}
					>
						<div
							className="absolute inset-y-0 w-[0.1rem] bg-[hsl(214_91%_62%)]"
							style={{ left: `${toPct(now, from, GUIDE_SPAN)}%` }}
						/>
					</div>
				)}
			</div>
		</div>
	);
};

/**
 * The guide over the video, from the player's Menu key or its Guide button,
 * with the channel on screen under the cursor. The video keeps playing
 * behind it, darkened, since a TV can't draw it any smaller.
 */
export const TvGuidePanel = ({
	channels,
	currentId,
	onPlay,
	onClose,
}: {
	channels: readonly Channel[];
	currentId: string;
	onPlay: (channel: Channel) => void;
	onClose: () => void;
}) => {
	const [active, setActive] = useState(() =>
		Math.max(
			0,
			channels.findIndex((ch) => ch.id === currentId)
		)
	);
	return (
		<Dialog
			label="Guide"
			onClose={onClose}
			overlayClassName="bg-transparent"
			className="flex size-full flex-col bg-linear-to-b from-black/75 to-black/90 to-40% px-[2rem] pt-[1.4rem] text-white"
		>
			<TvGuide
				channels={channels}
				label="Channels"
				active={active}
				onActiveChange={setActive}
				onPlay={onPlay}
				rows={6}
				start
			/>
			<p className="pb-[1rem] text-[0.9rem] leading-[1.2rem] opacity-70">
				OK to watch. Left or Right to move through time. Back to close.
			</p>
		</Dialog>
	);
};

/** The rail's Guide page: the groups of live channels beside the grid of the group picked. */
export const TvGuidePage = ({
	live,
	onPlay,
}: {
	live: readonly Channel[];
	onPlay: (channel: Channel, list: readonly Channel[]) => void;
}) => {
	const { place, groups, group, channels, toGroup, toChannel } = useGroupedChannels(
		"guide",
		live
	);
	return (
		<div className="flex h-full flex-col">
			<TvHeader title="Guide" />
			<div className="flex gap-[1rem] px-[1.5rem]">
				<TvGroupList
					groups={groups}
					active={place.group}
					onActiveChange={toGroup}
					start={place.inGroups}
				/>
				<TvGuide
					channels={channels}
					label={`Channels in ${group.name}`}
					active={place.channel}
					onActiveChange={toChannel}
					onPlay={(ch) => onPlay(ch, channels)}
					rows={7}
					start={!place.inGroups}
				/>
			</div>
		</div>
	);
};
