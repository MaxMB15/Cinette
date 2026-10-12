// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { memo } from "react";
import { Play, Tv2, Heart, Film } from "lucide-react";
import type { Channel, EpgProgram } from "@/lib/types";
import { EpgTimelineBar } from "./EpgTimelineBar";
import { useDownloads, aggregateForSeries } from "@/hooks/useDownloads";
import { useNow } from "@/hooks/useNow";
import { DownloadButton } from "@/components/downloads/DownloadButton";
import { DownloadProgressBar } from "@/components/downloads/DownloadProgressBar";
import { enqueueMovieDownload, stopDownload, removeDownload } from "@/lib/tauri";
import { cn, isFromInnerButton } from "@/lib/utils";
import { nowSeconds } from "@/lib/date";
import { aggregateIconState, downloadIconState, isDownloadActive } from "@/lib/download-status";
import { ChannelLogo, useImageFailed } from "./ChannelLogo";

/** Width (px) of the left channel-info column in RowCard — must match spacer in ChannelList header. */
export const ROW_CARD_LEFT_WIDTH = 180;

/** Height (px) of the phone's channel row. The list's virtualizer uses it. */
export const COMPACT_ROW_HEIGHT = 64;

/**
 * The heart toggle each card variant shows. It always sits beside the play
 * control, never inside it, and a clickable row leaves its click alone.
 */
const FavoriteButton = ({
	isFavorite,
	onToggle,
	className,
	iconClassName,
	idleIconClassName = "text-muted-foreground",
}: {
	isFavorite: boolean;
	onToggle: () => void;
	className: string;
	iconClassName: string;
	idleIconClassName?: string;
}) => (
	<button
		type="button"
		onClick={onToggle}
		className={cn(
			"flex items-center justify-center shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			className
		)}
		aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
	>
		<Heart
			className={cn(
				"transition-colors",
				iconClassName,
				isFavorite ? "fill-current text-red-500" : idleIconClassName
			)}
		/>
	</button>
);

interface ChannelCardProps {
	channel: Channel;
	onPlay: (channel: Channel) => void;
	/** "compact" is the phone's row, which shows what's on now instead of the timeline. */
	variant?: "row" | "compact" | "poster";
	onToggleFavorite?: (channel: Channel) => void;
	/** Programs in the EPG display window for this channel. */
	epgPrograms?: EpgProgram[];
	/** Dynamic window start (Unix seconds). Falls back to now − 1h. */
	windowStart?: number;
	/** Dynamic window end (Unix seconds). Falls back to now + 2h. */
	windowEnd?: number;
}

const RowCardView = ({
	channel,
	onPlay,
	onToggleFavorite,
	epgPrograms,
	windowStart,
	windowEnd,
}: {
	channel: Channel;
	onPlay: (ch: Channel) => void;
	onToggleFavorite?: (ch: Channel) => void;
	epgPrograms?: EpgProgram[];
	windowStart?: number;
	windowEnd?: number;
}) => {
	const now = nowSeconds();

	return (
		// The channel button on the left plays it, and sits beside the heart
		// rather than around it, so each control is reached on its own. A click
		// elsewhere on the row, such as on the timeline, plays the channel too.
		<div
			onClick={(e) => {
				if (!isFromInnerButton(e)) onPlay(channel);
			}}
			className="group flex items-center w-full rounded-lg hover:bg-accent/60 transition-colors cursor-pointer"
		>
			{/* Left: channel info, fixed width (must match ROW_CARD_LEFT_WIDTH) */}
			<button
				type="button"
				onClick={() => onPlay(channel)}
				className="flex items-center gap-2 px-2 py-1.5 shrink-0 min-w-0 text-left rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				style={{ width: `${ROW_CARD_LEFT_WIDTH}px` }}
			>
				<ChannelLogo
					url={channel.logoUrl}
					className="h-6 w-6 rounded"
					fallback={<Tv2 className="text-muted-foreground h-3 w-3" />}
				/>

				<div className="min-w-0 flex-1">
					<p className="text-xs leading-tight truncate">{channel.name}</p>
					{channel.groupTitle && (
						<p className="text-[10px] text-muted-foreground/70 truncate mt-0.5">
							{channel.groupTitle}
						</p>
					)}
				</div>
			</button>

			{/* Middle: EPG timeline — flex-1, takes the bulk of row width */}
			<div className="flex-1 min-w-0 py-1.5">
				{epgPrograms && epgPrograms.length > 0 ? (
					<EpgTimelineBar
						programmes={epgPrograms}
						now={now}
						windowStart={windowStart}
						windowEnd={windowEnd}
						height="h-9"
					/>
				) : (
					<div className="h-9 rounded-md border border-border/15 flex items-center justify-center bg-secondary/10">
						<span className="text-[8px] text-muted-foreground/25 select-none">
							no epg
						</span>
					</div>
				)}
			</div>

			{/* Right: LIVE badge + favourite */}
			<div className="flex items-center gap-1 px-2 shrink-0">
				<span className="flex items-center gap-0.5 text-[9px] font-semibold text-red-400 whitespace-nowrap">
					<span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
					LIVE
				</span>

				{onToggleFavorite && (
					<FavoriteButton
						isFavorite={channel.isFavorite}
						onToggle={() => onToggleFavorite(channel)}
						className="h-6 w-6 rounded hover:bg-accent"
						iconClassName="h-3 w-3"
					/>
				)}
			</div>
		</div>
	);
};

const RowCard = memo(RowCardView);
RowCard.displayName = "RowCard";

/** The phone's channel row. A phone is too narrow for the timeline, so it
 *  shows the programme on now and how far into it the channel is. */
const CompactRowCard = ({
	channel,
	onPlay,
	onToggleFavorite,
	epgPrograms,
}: {
	channel: Channel;
	onPlay: (ch: Channel) => void;
	onToggleFavorite?: (ch: Channel) => void;
	epgPrograms?: EpgProgram[];
}) => {
	const now = useNow();
	const current = epgPrograms?.find((p) => p.startTime <= now && now < p.endTime);
	const progress = current
		? ((now - current.startTime) / (current.endTime - current.startTime)) * 100
		: 0;

	return (
		// The play and favorite buttons sit side by side rather than one inside
		// the other, so VoiceOver reads and activates each one on its own.
		<div
			className="flex items-center w-full px-2 rounded-lg active:bg-accent/60 transition-colors"
			style={{ height: `${COMPACT_ROW_HEIGHT}px` }}
		>
			<button
				type="button"
				onClick={() => onPlay(channel)}
				className="flex items-center gap-3 flex-1 min-w-0 h-full text-left rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				<ChannelLogo
					url={channel.logoUrl}
					className="h-10 w-10 rounded-md"
					fallback={<Tv2 className="text-muted-foreground h-4 w-4" />}
				/>

				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium leading-tight truncate">{channel.name}</p>
					{current ? (
						<>
							<p className="text-xs text-muted-foreground truncate mt-0.5">
								{current.title}
							</p>
							<div className="h-0.5 mt-1.5 rounded-full bg-secondary overflow-hidden">
								<div
									className="h-full bg-red-400/80"
									style={{ width: `${progress.toFixed(1)}%` }}
								/>
							</div>
						</>
					) : (
						channel.groupTitle && (
							<p className="text-xs text-muted-foreground/70 truncate mt-0.5">
								{channel.groupTitle}
							</p>
						)
					)}
				</div>
			</button>

			{onToggleFavorite && (
				<FavoriteButton
					isFavorite={channel.isFavorite}
					onToggle={() => onToggleFavorite(channel)}
					className="h-11 w-11 -mr-2 rounded-full"
					iconClassName="h-4 w-4"
				/>
			)}
		</div>
	);
};

const PosterCard = ({
	channel,
	onPlay,
	onToggleFavorite,
}: {
	channel: Channel;
	onPlay: (ch: Channel) => void;
	onToggleFavorite?: (ch: Channel) => void;
}) => {
	const hasSources = channel.sources.length > 0;
	const [imgError, markImgFailed] = useImageFailed(channel.logoUrl);
	const showFallback = !channel.logoUrl || imgError;

	const { byChannel, bySeries } = useDownloads();
	const isSeries = channel.contentType === "series";
	const dl = byChannel.get(channel.id);
	const seriesEps = isSeries ? (bySeries.get(channel.id) ?? []) : [];

	const iconState = isSeries
		? // totalEpisodes is unknown at the card level (resolved in the drawer),
			// so pass 0 → aggregateForSeries never returns "complete" here.
			aggregateIconState(aggregateForSeries(seriesEps, 0))
		: downloadIconState(dl);

	return (
		<div className="group flex flex-col text-left relative">
			<button
				onClick={() => onPlay(channel)}
				className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-lg w-full"
			>
				<div className="relative w-full aspect-[2/1] rounded-lg overflow-hidden mb-1.5 border border-border/40">
					{!showFallback ? (
						<img
							src={channel.logoUrl}
							alt=""
							className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
							loading="lazy"
							onError={markImgFailed}
						/>
					) : (
						<div className="h-full w-full bg-gradient-to-br from-secondary via-secondary/80 to-secondary/50 flex flex-col items-center justify-center gap-1">
							<Film className="h-5 w-5 text-muted-foreground/25" />
							<span className="text-[9px] font-medium text-muted-foreground/30 uppercase tracking-wider">
								No poster
							</span>
						</div>
					)}
					<div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
						<div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 transition-all duration-150">
							<Play className="h-4 w-4 text-white ml-0.5" />
						</div>
					</div>
					{hasSources && (
						<div className="absolute top-1.5 right-1.5 bg-black/70 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full">
							{channel.sources.length + 1}
						</div>
					)}
				</div>
				<p className="text-xs leading-snug line-clamp-2 text-foreground/85 group-hover:text-foreground transition-colors px-0.5">
					{channel.name}
				</p>
			</button>
			{/* Siblings of the play button, since screen readers can't reach a
			    control or a progress bar nested inside a button on its own. The
			    extra pixel keeps each one inside the poster's border. */}
			{!isSeries && dl && isDownloadActive(dl) && (
				<div className="pointer-events-none absolute inset-x-0 top-0 aspect-[2/1] flex items-end p-px rounded-lg overflow-hidden">
					<div className="w-full px-1.5 pb-1 pt-3 bg-gradient-to-t from-black/90 to-transparent">
						<DownloadProgressBar download={dl} />
					</div>
				</div>
			)}
			{onToggleFavorite && (
				<FavoriteButton
					isFavorite={channel.isFavorite}
					onToggle={() => onToggleFavorite(channel)}
					className="absolute top-[5px] left-[5px] z-10 h-7 w-7 rounded-full bg-black/50 hover:bg-black/70 transition-colors cursor-pointer"
					iconClassName="h-3.5 w-3.5"
					idleIconClassName="text-white"
				/>
			)}
			<DownloadButton
				state={iconState}
				onStart={() => {
					if (!isSeries) enqueueMovieDownload(channel.id);
					// Whole-series enqueue is driven from the series detail drawer
					// (it needs the resolved episode list); no-op from the card.
				}}
				onStop={() => {
					if (!isSeries && dl) stopDownload(dl.id);
				}}
				onRemove={() => (!isSeries && dl ? removeDownload(dl.id) : undefined)}
				className="absolute top-1 left-9 z-10 h-7 w-7 justify-center rounded-full bg-black/50 hover:bg-black/70"
			/>
		</div>
	);
};

const ChannelCardView = ({
	channel,
	onPlay,
	variant = "row",
	onToggleFavorite,
	epgPrograms,
	windowStart,
	windowEnd,
}: ChannelCardProps) => {
	if (variant === "compact") {
		return (
			<CompactRowCard
				channel={channel}
				onPlay={onPlay}
				onToggleFavorite={onToggleFavorite}
				epgPrograms={epgPrograms}
			/>
		);
	}
	return variant === "poster" ? (
		<PosterCard channel={channel} onPlay={onPlay} onToggleFavorite={onToggleFavorite} />
	) : (
		<RowCard
			channel={channel}
			onPlay={onPlay}
			onToggleFavorite={onToggleFavorite}
			epgPrograms={epgPrograms}
			windowStart={windowStart}
			windowEnd={windowEnd}
		/>
	);
};

export const ChannelCard = memo(ChannelCardView);
ChannelCard.displayName = "ChannelCard";
