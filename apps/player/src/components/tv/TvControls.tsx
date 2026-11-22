// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useNow } from "@/hooks/useNow";
import { useNowNext } from "@/hooks/useNowNext";
import type { TvView } from "@/hooks/useTvPlayer";
import { formatHHMM, toPct } from "@/lib/epg-window";
import { formatTime } from "@/lib/format";
import { formatBehind, LIVE_SLACK } from "@/lib/live-seek";
import { moveFocus } from "@/lib/tv-focus";
import type { Channel } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
	tvRow,
	tvTiles,
	type TvRowButton,
	type TvRowOptions,
	type TvTile,
	type TvTileOptions,
} from "./tv-buttons";
import { LiveChip } from "./TvNowPlaying";
import { TvClock } from "./ui";

/** A movie or episode's place in it. */
export interface TvVideoBar {
	kind: "video";
	position: number;
	duration: number;
	/** How far the player has loaded, in seconds from the start. */
	bufferedTo: number | null;
	speed: number;
}

/** A live channel's place behind the broadcast. */
export interface TvLiveBar {
	kind: "live";
	channel: Channel;
	/** How many seconds behind live it plays. */
	behind: number;
	/** What the player holds, in seconds behind live, from its oldest to its newest. */
	buffered: { from: number; to: number } | null;
	/** How far back a channel with no guide shows, in seconds. */
	rewind: number;
}

export type TvBar = TvVideoBar | TvLiveBar;

/**
 * Where the subtitles go while the controls show, in percent of the player's
 * height from the top. Only a movie or an episode has subtitles of the app's
 * own, so the live details, which stand taller, need no place of their own.
 */
export const tvSubtitleTop = (view: TvView): number => {
	if (view === "details") return 24;
	if (view === "tray") return 40;
	return view === "controls" ? 58 : 72;
};

const TOP_SHADE = "linear-gradient(to bottom,rgb(0 0 0/.45) 0%,transparent 16%)";
const shade = (stops: string) => `linear-gradient(to top,${stops}),${TOP_SHADE}`;
const SCRIMS = {
	strip: "linear-gradient(to top,rgb(0 0 0/.85) 0%,transparent 26%)",
	controls: shade("rgb(0 0 0/.92) 0%,rgb(0 0 0/.72) 24%,transparent 46%"),
	video: shade("rgb(0 0 0/.94) 0%,rgb(0 0 0/.84) 40%,transparent 72%"),
	live: shade("rgb(0 0 0/.95) 0%,rgb(0 0 0/.86) 52%,transparent 82%"),
	tray: shade("rgb(0 0 0/.94) 0%,rgb(0 0 0/.78) 36%,transparent 62%"),
};

interface TvControlsProps {
	view: TvView;
	/** Shows the bar with the hint under it while no view is open. */
	strip: boolean;
	hint?: string;
	bar: TvBar;
	/** What the row of buttons offers. */
	row: TvRowOptions;
	/** What the tray under the row offers. */
	tiles: TvTileOptions;
	/** What plays, above the row, as Up shows it. */
	details: ReactNode;
	onViewChange: (view: TvView) => void;
	/** Back, or Up with nothing above the row, which go back to the video. */
	onLeave: () => void;
	/** The row has gone, and focus mustn't stay on a button nobody can see. */
	onHide: () => void;
}

/**
 * The player's controls on a TV: the time bar, a row of round buttons, and
 * either what plays above them or a tray of options below. Nothing here takes
 * a pointer, since a TV has only its remote.
 */
export const TvControls = ({
	view,
	strip,
	hint,
	bar,
	row,
	tiles,
	details,
	onViewChange,
	onLeave,
	onHide,
}: TvControlsProps) => {
	const buttons = tvRow(row);
	const rowRef = useRef<HTMLDivElement>(null);
	const trayRef = useRef<HTMLDivElement>(null);
	const onHideRef = useLatestRef(onHide);

	// A hidden button loses focus before the next paint, so this goes first.
	useLayoutEffect(() => {
		if (view === "none") onHideRef.current();
	}, [view, onHideRef]);

	// The tray opens on its first option, and the row on the playback button.
	const focusView = () => {
		const tray = view === "tray";
		const box = tray ? trayRef.current : rowRef.current;
		const target = box?.querySelector<HTMLElement>(tray ? "button" : '[data-id="playback"]');
		target?.focus({ preventScroll: true });
	};
	const focusViewRef = useLatestRef(focusView);
	useEffect(() => focusViewRef.current(), [view, focusViewRef]);
	// The focus falls to the page when a button goes away, as Next does at the
	// last episode.
	useEffect(() => {
		if (document.activeElement === document.body) focusViewRef.current();
	});

	const onRowKey = (e: KeyboardEvent) => {
		switch (e.key) {
			case "ArrowDown":
				onViewChange(view === "controls" ? "tray" : "none");
				break;
			case "ArrowUp":
				// The skip prompt sits above the row while it shows. Above the
				// details there's nowhere to go.
				if (view === "controls" && !moveFocus("up")) onLeave();
				break;
			case "Escape":
				onLeave();
				break;
			default:
				return;
		}
		e.preventDefault();
	};
	const onTrayKey = (e: KeyboardEvent) => {
		switch (e.key) {
			case "ArrowUp":
				onViewChange("controls");
				break;
			case "Escape":
				onLeave();
				break;
			case "ArrowDown":
				break;
			default:
				return;
		}
		e.preventDefault();
	};

	const open = view !== "none";
	const scrim = !open ? SCRIMS.strip : view === "details" ? SCRIMS[bar.kind] : SCRIMS[view];

	return (
		<div
			data-testid="tv-controls"
			className={cn(
				"group/controls absolute inset-0 z-30 flex flex-col justify-end px-[2.8rem] pb-[1.4rem] text-white",
				!open && !strip && "invisible"
			)}
			style={{ background: scrim }}
		>
			{open && (
				<div className="absolute top-[1.4rem] right-[2.8rem] text-[1.1rem]">
					<TvClock />
				</div>
			)}
			{view === "details" && <div className="mb-[1.75rem]">{details}</div>}
			{bar.kind === "live" ? (
				<LiveBar bar={bar} open={open} />
			) : (
				<VideoBar bar={bar} open={open} />
			)}
			{open ? (
				<div
					ref={rowRef}
					role="toolbar"
					aria-label="Player"
					className="mt-[0.9rem] grid h-[3.6rem] grid-cols-3 items-center"
					onKeyDown={onRowKey}
				>
					<RowGroup buttons={buttons.start} className="justify-start" />
					<RowGroup buttons={buttons.center} className="justify-center" />
					<RowGroup buttons={buttons.end} className="justify-end" end />
				</div>
			) : (
				hint && (
					<p className="mt-[0.9rem] text-[0.8rem] leading-[1rem] opacity-60">{hint}</p>
				)
			)}
			{view === "tray" ? (
				<div
					ref={trayRef}
					role="toolbar"
					aria-label="More"
					className="-mx-[0.8rem] mt-[2rem] flex gap-[0.6rem] rounded-[1.2rem] border border-white/12 bg-white/7 p-[0.8rem] shadow-[0_0.9rem_2.5rem_rgb(0_0_0/.45)]"
					onKeyDown={onTrayKey}
				>
					{tvTiles(tiles).map((tile) => (
						<Tile key={tile.id} tile={tile} />
					))}
				</div>
			) : (
				open && (
					<p className="mt-[0.4rem] flex items-center justify-end gap-[0.3rem] text-[0.8rem] leading-[1rem] opacity-60 group-has-[[data-end]:focus]/controls:invisible">
						<ChevronDown aria-hidden className="size-[0.9rem]" />
						More
					</p>
				)
			)}
		</div>
	);
};

const RowGroup = ({
	buttons,
	className,
	end,
}: {
	buttons: readonly TvRowButton[];
	className: string;
	end?: boolean;
}) => (
	<div className={cn("flex items-center gap-[0.8rem]", className)}>
		{buttons.map((button) => (
			<RoundButton key={button.id} button={button} end={end} />
		))}
	</div>
);

/** A round button that shows its name under it while it has the focus. */
const RoundButton = ({
	button: { id, label, icon: Icon, badge, dot, disabled, onPress },
	end,
}: {
	button: TvRowButton;
	end?: boolean;
}) => {
	const main = id === "playback";
	return (
		<button
			type="button"
			data-id={id}
			data-end={end || undefined}
			aria-label={label}
			aria-disabled={disabled || undefined}
			onClick={disabled ? undefined : onPress}
			className={cn(
				"tv-cursor group/button relative flex shrink-0 items-center justify-center rounded-full text-white focus:shadow-[0_0.3rem_1.2rem_rgb(0_0_0/.45)]",
				main ? "size-[3.6rem] bg-white/20" : "size-[2.8rem] bg-white/12",
				disabled && "opacity-40"
			)}
		>
			<Icon aria-hidden className={main ? "size-[1.5rem]" : "size-[1.3rem]"} />
			{badge !== undefined && (
				<span
					data-testid="badge"
					aria-hidden
					className="absolute text-[0.45rem] leading-none font-bold tabular-nums"
				>
					{badge}
				</span>
			)}
			{dot && (
				<span
					data-testid="dot"
					className="absolute top-[0.45rem] right-[0.45rem] size-[0.45rem] rounded-full bg-primary shadow-[0_0_0_0.1rem_hsl(220_14%_10%)]"
				/>
			)}
			<span
				aria-hidden
				className="invisible absolute top-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2 text-[0.8rem] leading-[1rem] font-semibold whitespace-nowrap text-white group-focus/button:visible"
			>
				{label}
			</span>
		</button>
	);
};

const Tile = ({ tile: { id, label, value, icon: Icon, disabled, onPress } }: { tile: TvTile }) => (
	<button
		type="button"
		data-id={id}
		aria-disabled={disabled || undefined}
		onClick={disabled ? undefined : onPress}
		className={cn(
			"tv-cursor flex h-[4.2rem] min-w-0 flex-1 items-center gap-[0.7rem] rounded-[0.7rem] bg-white/8 px-[0.8rem] text-left text-white",
			disabled && "opacity-42"
		)}
	>
		<Icon aria-hidden className="size-[1.3rem] shrink-0" />
		<span className="min-w-0">
			<span className="block text-[0.9rem] leading-[1.2rem] font-semibold whitespace-nowrap">
				{label}
			</span>
			<span className="block truncate text-[0.75rem] leading-[1rem] opacity-70">{value}</span>
		</span>
	</button>
);

/** The line along the bottom with the times at its ends, as both bars draw it. */
const Timeline = ({
	above,
	left,
	right,
	played,
	buffered,
	band,
	bubble,
	chip,
	valueText,
}: {
	/** Over the bar's right end while the controls show. */
	above?: string;
	left: string;
	right: string;
	/** How far along the knob is, in percent. */
	played: number;
	/** How far is loaded, in percent. */
	buffered?: number;
	/** What can be gone back to on live TV, from and to in percent. */
	band?: [number, number];
	/** Over the knob. */
	bubble?: string;
	chip?: ReactNode;
	valueText: string;
}) => (
	<div>
		{above && (
			<p className="mb-[0.5rem] text-right text-[0.8rem] leading-[1rem] tabular-nums opacity-70">
				{above}
			</p>
		)}
		<div className="flex h-[1.2rem] items-center gap-[1rem]">
			<span className="shrink-0 text-base font-medium tabular-nums">{left}</span>
			<div
				role="progressbar"
				aria-label="Position"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(played)}
				aria-valuetext={valueText}
				className="relative h-[0.3rem] flex-1 rounded-full bg-white/22"
			>
				{band && (
					<div
						data-testid="rewindable"
						className="absolute -inset-y-[0.15rem] rounded-[0.3rem] bg-[rgb(120_170_255/.28)]"
						style={{ left: `${band[0]}%`, width: `${band[1] - band[0]}%` }}
					/>
				)}
				{buffered !== undefined && (
					<div
						data-testid="buffered"
						className="absolute inset-y-0 left-0 rounded-full bg-white/30"
						style={{ width: `${buffered}%` }}
					/>
				)}
				<div
					className="absolute inset-y-0 left-0 rounded-full bg-primary"
					style={{ width: `${played}%` }}
				/>
				<div
					data-testid="knob"
					className="absolute top-1/2 size-[0.9rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_0.2rem_rgb(0_0_0/.25)]"
					style={{ left: `${played}%` }}
				/>
				{bubble && (
					<div
						data-testid="bubble"
						className="absolute bottom-[1rem] -translate-x-1/2 rounded-[0.35rem] bg-(--tv-cursor) px-[0.45rem] py-[0.15rem] text-[0.75rem] leading-[1rem] font-bold whitespace-nowrap text-(--tv-ink) tabular-nums"
						style={{ left: `${played}%` }}
					>
						{bubble}
					</div>
				)}
			</div>
			<span className="shrink-0 text-base font-medium tabular-nums opacity-70">{right}</span>
			{chip}
		</div>
	</div>
);

const VideoBar = ({ bar, open }: { bar: TvVideoBar; open: boolean }) => {
	const now = useNow();
	const { position, duration, bufferedTo, speed } = bar;
	if (duration <= 0) {
		return (
			<p className="h-[1.2rem] text-base font-medium tabular-nums">{formatTime(position)}</p>
		);
	}
	const at = (t: number) => toPct(t, 0, duration);
	return (
		<Timeline
			above={open ? `Ends at ${formatHHMM(now + (duration - position) / speed)}` : undefined}
			left={formatTime(position)}
			right={formatTime(duration)}
			played={at(position)}
			buffered={bufferedTo === null ? undefined : at(bufferedTo)}
			valueText={`${formatTime(position)} of ${formatTime(duration)}`}
		/>
	);
};

/** How long a program has left, as "23 min left" or "1 h 5 min left". */
export const timeLeft = (seconds: number): string => {
	const minutes = Math.max(0, Math.ceil(seconds / 60));
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours} h ${minutes % 60} min left` : `${minutes} min left`;
};

/**
 * The program on now, from its start to its end, with the knob where the
 * player is behind live. A channel with no guide shows as far back as the
 * player can go.
 */
const LiveBar = ({ bar, open }: { bar: TvLiveBar; open: boolean }) => {
	const { now, nowNextOf } = useNowNext();
	const { channel, behind, buffered, rewind } = bar;
	const program = nowNextOf(channel).now;
	const start = program ? program.startTime : now - rewind;
	const end = program ? program.endTime : now;
	const at = (t: number) => toPct(t, start, end - start);
	const back = behind > LIVE_SLACK;
	return (
		<Timeline
			above={open && program ? timeLeft(end - now) : undefined}
			left={formatHHMM(start)}
			right={program ? formatHHMM(end) : "Now"}
			played={at(now - behind)}
			band={back && buffered ? [at(now - buffered.from), at(now - buffered.to)] : undefined}
			bubble={back ? formatBehind(behind) : undefined}
			chip={<LiveChip live={!back} />}
			valueText={back ? `${formatBehind(behind)} behind live` : "Live"}
		/>
	);
};
