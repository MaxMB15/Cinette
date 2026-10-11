// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SkipIntervals } from "@/lib/player-prefs";
import { SkipIcon } from "./SkipIcon";

interface CenterControlsProps {
	visible: boolean;
	/** True while paused or stopped, so the middle button plays. */
	paused: boolean;
	onPlay: () => void;
	onPause: () => void;
	/** How far the skip buttons jump. Leave out when the stream can't seek. */
	skip?: SkipIntervals;
	onSkip?: (seconds: number) => void;
	onPrevEpisode?: () => void;
	onNextEpisode?: () => void;
}

/**
 * The middle row of the touch player. Skip back, play or pause and skip
 * forward sit in the middle, with the previous and next episode further out.
 * Only the buttons take taps, so a double-tap beside them still reaches the
 * video.
 */
export const CenterControls = ({
	visible,
	paused,
	onPlay,
	onPause,
	skip,
	onSkip,
	onPrevEpisode,
	onNextEpisode,
}: CenterControlsProps) => {
	const hasEpisodes = !!onPrevEpisode || !!onNextEpisode;
	const skipButtons = skip && onSkip ? { skip, onSkip } : null;
	const button = cn(
		"flex shrink-0 items-center justify-center rounded-full text-white transition-transform active:scale-90",
		visible && "pointer-events-auto"
	);
	// An empty slot keeps play and pause in the middle when only one episode button shows.
	const episodeSlot = <span className="h-11 w-11 shrink-0" />;

	return (
		<div
			className={cn(
				"pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 transition-opacity duration-300",
				visible ? "opacity-100" : "opacity-0"
			)}
		>
			<div className="flex items-center gap-4 drop-shadow-[0_1px_3px_rgba(0,0,0,0.5)] sm:gap-8">
				{hasEpisodes &&
					(onPrevEpisode ? (
						<button
							type="button"
							onClick={onPrevEpisode}
							aria-label="Previous episode"
							className={cn(button, "h-11 w-11 bg-black/30 active:bg-white/20")}
						>
							<SkipBack className="h-5 w-5 fill-current" />
						</button>
					) : (
						episodeSlot
					))}

				{skipButtons && (
					<button
						type="button"
						onClick={() => skipButtons.onSkip(-skipButtons.skip.back)}
						aria-label={`Skip back ${skipButtons.skip.back} seconds`}
						className={cn(button, "h-14 w-14 active:bg-white/20")}
					>
						<SkipIcon
							direction="back"
							seconds={skipButtons.skip.back}
							className="h-10 w-10"
							labelClassName="text-xs"
						/>
					</button>
				)}

				<button
					type="button"
					onClick={paused ? onPlay : onPause}
					aria-label={paused ? "Play" : "Pause"}
					className={cn(
						button,
						"h-16 w-16 bg-black/40 active:bg-white/20 sm:h-20 sm:w-20"
					)}
				>
					{paused ? (
						<Play className="ml-1 h-8 w-8 fill-current sm:h-10 sm:w-10" />
					) : (
						<Pause className="h-8 w-8 fill-current sm:h-10 sm:w-10" />
					)}
				</button>

				{skipButtons && (
					<button
						type="button"
						onClick={() => skipButtons.onSkip(skipButtons.skip.forward)}
						aria-label={`Skip forward ${skipButtons.skip.forward} seconds`}
						className={cn(button, "h-14 w-14 active:bg-white/20")}
					>
						<SkipIcon
							direction="forward"
							seconds={skipButtons.skip.forward}
							className="h-10 w-10"
							labelClassName="text-xs"
						/>
					</button>
				)}

				{hasEpisodes &&
					(onNextEpisode ? (
						<button
							type="button"
							onClick={onNextEpisode}
							aria-label="Next episode"
							className={cn(button, "h-11 w-11 bg-black/30 active:bg-white/20")}
						>
							<SkipForward className="h-5 w-5 fill-current" />
						</button>
					) : (
						episodeSlot
					))}
			</div>
		</div>
	);
};
