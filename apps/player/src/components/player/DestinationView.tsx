// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	destinationControls,
	destinationStatus,
	positionNow,
	type PlaybackDestination,
} from "@/lib/destination";
import { formatTime } from "@/lib/format";
import type { SkipIntervals } from "@/lib/player-prefs";
import { Controls } from "./Controls";

interface DestinationViewProps {
	destination: PlaybackDestination;
	/** The name shown, which follows a rename where the destination has one. */
	name: string;
	/** The region's name, such as "Google Cast". */
	label: string;
	icon: LucideIcon;
	touchLayout: boolean;
	skip: SkipIntervals;
	/** Says why a command didn't work. `seeking` is set for a seek. */
	onFailed: (error: unknown, seeking: boolean) => void;
	/** Stops it there, and whatever else stopping means on this page. */
	onStop: () => void;
	/** Plays it here instead, from `position` for a movie or episode.
	 *  `anchor` is the button, for a system picker. */
	onPlayHere?: (position: number, anchor: DOMRect) => void;
	/** A line under Play here, as on an iPhone, where it opens the AirPlay list. */
	playHereNote?: string;
	onPrevEpisode?: () => void;
	onNextEpisode?: () => void;
	/** Words an error the destination reports, where it has its own words. */
	failure?: (message: string) => string;
}

/**
 * What the player shows while something else plays: a Cast receiver, an
 * AirPlay TV or another Cinette device. The player's own controls drive
 * it, with only what it can do, over a backdrop that says where it plays.
 */
export const DestinationView = ({
	destination,
	name,
	label,
	icon: Icon,
	touchLayout,
	skip,
	onFailed,
	onStop,
	onPlayHere,
	playHereNote,
	onPrevEpisode,
	onNextEpisode,
	failure,
}: DestinationViewProps) => {
	const state = useSyncExternalStore(destination.subscribe, destination.getState);
	const caps = destination.capabilities;
	const [now, setNow] = useState(() => performance.now());
	useEffect(() => {
		if (state.status !== "playing") return;
		const timer = setInterval(() => setNow(performance.now()), 1000);
		return () => clearInterval(timer);
	}, [state.status]);
	// The level Unmute goes back to.
	const lastVolume = useRef(50);
	useEffect(() => {
		if (state.volume > 0) lastVolume.current = state.volume;
	}, [state.volume]);
	const controls = destinationControls(state, caps, now);
	const line = destinationStatus(state, name, failure);
	const resumeAt = caps.resumeAt && state.duration > 0 ? controls.player.position : 0;
	const run = (command: () => Promise<void>, seeking = false) =>
		void command().catch((error: unknown) => onFailed(error, seeking));
	const seekTo = (to: number) =>
		run(() => destination.seek(Math.min(Math.max(0, to), state.duration)), true);
	// Stryker disable next-line StringLiteral: It's only how the two pickers look.
	const select = "max-w-full rounded bg-white/10 px-2 py-1 text-sm pointer-coarse:min-h-11";

	return (
		<div className="absolute inset-0 z-30 bg-black text-white" role="region" aria-label={label}>
			{/* Above the middle row of controls, and scrolling rather than
			    running into it on a short screen. */}
			<div className="absolute inset-x-0 top-0 bottom-1/2 mb-12 flex flex-col items-center justify-end gap-3 overflow-y-auto pt-[calc(4rem+env(safe-area-inset-top))] pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] text-center">
				<Icon
					className="h-12 w-12 shrink-0 text-white/70 [@media(height<30rem)]:hidden"
					aria-hidden
				/>
				<div className="w-full min-w-0">
					<p className="truncate text-lg font-medium" title={name}>
						{!state.item
							? "Nothing playing on "
							: controls.over
								? "Stopped on "
								: "Playing on "}
						<bdi>{name}</bdi>
					</p>
					{state.item && (
						<p className="truncate text-sm text-white/60" title={state.item.title}>
							{state.item.title}
						</p>
					)}
				</div>
				{line && (
					<p className="text-sm text-white/80" role="status">
						{line}
					</p>
				)}
				{!controls.over && (caps.subtitles === "select" || caps.audioTracks) && (
					<div
						role="group"
						aria-label="Tracks"
						className="flex max-w-full flex-wrap justify-center gap-2"
					>
						{caps.subtitles === "select" && (
							<select
								className={select}
								aria-label="Subtitles"
								// Stryker disable next-line StringLiteral: A select whose value matches no option shows its first, which is "No subtitles", the option "" picks.
								value={state.subtitleId ?? ""}
								onChange={(e) =>
									run(() => destination.selectSubtitle(e.target.value || null))
								}
							>
								<option value="">No subtitles</option>
								{state.subtitles.map((t) => (
									<option key={t.id} value={t.id}>
										{t.label}
									</option>
								))}
							</select>
						)}
						{caps.audioTracks && (
							<select
								className={select}
								aria-label="Audio"
								// Stryker disable next-line StringLiteral: No audio option has an empty id, so any string selects none of them.
								value={state.audioId ?? ""}
								onChange={(e) => run(() => destination.selectAudio(e.target.value))}
							>
								{state.audio.map((t) => (
									<option key={t.id} value={t.id}>
										{t.label}
									</option>
								))}
							</select>
						)}
					</div>
				)}
				{onPlayHere && (
					<>
						<Button
							variant="secondary"
							className="shrink-0 pointer-coarse:min-h-11"
							onClick={(e) =>
								onPlayHere(resumeAt, e.currentTarget.getBoundingClientRect())
							}
						>
							{resumeAt > 0 ? `Play here from ${formatTime(resumeAt)}` : "Play here"}
						</Button>
						{playHereNote && <p className="text-xs text-white/50">{playHereNote}</p>}
					</>
				)}
			</div>
			{/* Nothing to drive until something plays there. Every button is
			    big enough to tap on a touch screen. */}
			{state.item && (
				<div className="contents pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11">
					<Controls
						state={controls.player}
						visible
						touchLayout={touchLayout}
						hideCenterControls={controls.over || state.status === "opening"}
						onPlay={() => run(destination.play)}
						onPause={controls.pause ? () => run(destination.pause) : undefined}
						onStop={onStop}
						onSeek={seekTo}
						skip={controls.seek ? skip : undefined}
						onSkip={(seconds) =>
							seekTo(positionNow(state, performance.now()) + seconds)
						}
						onVolumeChange={
							controls.volume
								? (volume) => run(() => destination.setVolume(volume))
								: undefined
						}
						onToggleMute={() =>
							run(() =>
								destination.setVolume(state.volume > 0 ? 0 : lastVolume.current)
							)
						}
						maxVolume={100}
						onPrevEpisode={onPrevEpisode}
						onNextEpisode={onNextEpisode}
					/>
				</div>
			)}
		</div>
	);
};
