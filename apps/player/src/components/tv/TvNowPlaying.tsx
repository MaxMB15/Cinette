// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { RatingsRow } from "@/components/ui/ratings-row";
import { useNowNext } from "@/hooks/useNowNext";
import { formatHHMM, getGridMarks, toPct } from "@/lib/epg-window";
import { mediaFacts } from "@/lib/media-facts";
import { blockStyle } from "@/lib/tv-guide";
import type { Channel, EpgProgram, OmdbData, WhatsonData } from "@/lib/types";
import { Facts, Poster } from "./TvDetails";
import { timeSpan } from "./TvLive";
import { TvLogo } from "./ui";

/** How much of the guide strip lies before now, and how much it covers, in seconds. */
const STRIP_BEFORE = 150 * 60;
const STRIP_SPAN = 240 * 60;

/** The red chip that says a channel is live. */
export const LiveChip = ({ live = true }: { live?: boolean }) => (
	<span
		className={`flex shrink-0 items-center gap-[0.3rem] rounded-[0.3rem] px-[0.5rem] py-[0.15rem] text-[0.7rem] leading-[1rem] font-bold tracking-[0.06em] ${live ? "bg-[hsl(0_72%_51%)]" : "bg-white/16"}`}
	>
		<span
			aria-hidden
			className={`size-[0.35rem] rounded-full ${live ? "bg-white" : "bg-white/70"}`}
		/>
		{live ? "LIVE" : "GO LIVE"}
	</span>
);

/** What a movie or episode is, above the player's controls. */
export const TvVideoDetails = ({
	eyebrow,
	title,
	logoUrl,
	omdbData,
	whatsonData,
	upNext,
}: {
	/** The show an episode belongs to. */
	eyebrow?: string;
	title: string;
	logoUrl?: string;
	omdbData?: OmdbData | null;
	whatsonData?: WhatsonData | null;
	upNext?: string;
}) => {
	const facts = mediaFacts(omdbData, whatsonData, logoUrl);
	return (
		<div className="flex items-end gap-[2.4rem]">
			<div className="flex min-w-0 flex-1 items-end gap-[1.5rem]">
				<Poster url={facts.poster} name={eyebrow || title} className="w-[6.5rem]" />
				<div className="flex min-w-0 max-w-[39rem] flex-col gap-[0.3rem]">
					{eyebrow && (
						<p className="truncate text-[0.8rem] leading-[1rem] font-semibold tracking-[0.12em] uppercase opacity-70">
							{eyebrow}
						</p>
					)}
					<h2 className="line-clamp-2 text-[1.8rem] leading-[2.2rem] font-semibold">
						{title}
					</h2>
					<Facts
						values={[facts.year, facts.runtime, facts.rated, facts.genre]}
						className="mt-0 text-[0.9rem] leading-[1.2rem]"
					/>
					<RatingsRow omdbData={omdbData} whatsonData={whatsonData} />
					{facts.plot && (
						<p className="mt-[0.2rem] line-clamp-2 text-[0.9rem] leading-[1.3rem] opacity-85">
							{facts.plot}
						</p>
					)}
				</div>
			</div>
			{upNext && (
				<div className="max-w-[18rem] shrink-0 text-right">
					<p className="text-[0.7rem] leading-[0.9rem] font-semibold tracking-[0.12em] opacity-60">
						UP NEXT
					</p>
					<p className="truncate text-[0.9rem] leading-[1.2rem] font-medium">{upNext}</p>
				</div>
			)}
		</div>
	);
};

/** The live channel, what's on it, and a strip of its guide, above the player's controls. */
export const TvLiveDetails = ({ channel }: { channel: Channel }) => {
	const { now, programsOf, nowNextOf } = useNowNext();
	const program = nowNextOf(channel).now;
	return (
		<div className="flex flex-col">
			<div className="flex items-center gap-[0.8rem]">
				<TvLogo
					url={channel.logoUrl}
					name={channel.name}
					className="size-[3.2rem] shrink-0 rounded-[0.6rem]"
				/>
				<div className="min-w-0">
					<div className="flex items-center gap-[0.5rem]">
						<LiveChip />
						<h2 className="truncate text-[1.1rem] leading-[1.4rem] font-semibold">
							{channel.name}
						</h2>
					</div>
					{channel.groupTitle && (
						<p className="truncate text-[0.8rem] leading-[1.1rem] opacity-65">
							{channel.groupTitle}
						</p>
					)}
				</div>
			</div>
			{program ? (
				<div className="mt-[1rem] max-w-[45rem]">
					<p className="text-[0.7rem] leading-[0.9rem] font-bold tracking-[0.14em] text-[hsl(214_91%_72%)]">
						ON AIR
					</p>
					<p className="mt-[0.1rem] truncate text-[1.6rem] leading-[2rem] font-semibold">
						{program.title}
					</p>
					<p className="text-[0.9rem] leading-[1.2rem] tabular-nums opacity-75">
						{[timeSpan(program), program.category].filter(Boolean).join(" · ")}
					</p>
					{program.description && (
						<p className="mt-[0.2rem] truncate text-[0.9rem] leading-[1.3rem] opacity-85">
							{program.description}
						</p>
					)}
				</div>
			) : (
				<p className="mt-[1rem] text-[0.9rem] leading-[1.2rem] opacity-75">
					No schedule information for this channel
				</p>
			)}
			<GuideStrip programs={programsOf(channel)} now={now} />
		</div>
	);
};

/** The programs around now on a time line, with a red line at now. */
const GuideStrip = ({ programs, now }: { programs: readonly EpgProgram[]; now: number }) => {
	const start = now - STRIP_BEFORE;
	const end = start + STRIP_SPAN;
	const shown = programs.filter((p) => p.endTime > start && p.startTime < end);
	if (shown.length === 0) return null;
	const at = (t: number) => toPct(t, start, STRIP_SPAN);
	return (
		<div className="mt-[1.5rem]" aria-label="Guide" role="group">
			<div className="relative h-[0.9rem]">
				{getGridMarks(start, end).map((t) => (
					<span
						key={t}
						className="absolute -translate-x-1/2 text-[0.7rem] leading-[0.9rem] tabular-nums opacity-55"
						style={{ left: `${at(t)}%` }}
					>
						{formatHHMM(t)}
					</span>
				))}
			</div>
			<div className="relative mt-[0.3rem] h-[2.7rem]">
				{shown.map((p) => {
					const past = p.endTime <= now;
					const current = !past && p.startTime <= now;
					return (
						<div
							key={`${p.startTime}-${p.title}`}
							className={`absolute inset-y-0 flex flex-col justify-center overflow-clip rounded-[0.4rem] px-[0.6rem] ${
								past
									? "bg-white/13 text-white/55"
									: current
										? "bg-[hsl(214_72%_46%)]"
										: "border border-white/16 bg-white/4 text-white/85"
							}`}
							style={blockStyle(p.startTime, p.endTime, start, STRIP_SPAN)}
						>
							<span className="truncate text-[0.85rem] leading-[1.1rem] font-semibold">
								{p.title}
							</span>
							{!past && (
								<span className="text-[0.7rem] leading-[0.9rem] tabular-nums opacity-75">
									{formatHHMM(p.startTime)}
								</span>
							)}
						</div>
					);
				})}
				<div
					aria-hidden
					className="absolute -top-[0.4rem] -bottom-[0.2rem] w-[0.1rem] -translate-x-1/2 bg-[hsl(0_72%_51%)]"
					style={{ left: `${at(now)}%` }}
				>
					<span className="absolute -top-[0.2rem] left-1/2 size-[0.5rem] -translate-x-1/2 rounded-full bg-[hsl(0_72%_51%)]" />
				</div>
			</div>
		</div>
	);
};
