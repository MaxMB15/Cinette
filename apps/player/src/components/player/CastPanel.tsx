// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Cast, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PlaybackCapabilities, PlaybackState } from "@/lib/destination";
import { formatTime } from "@/lib/format";

interface CastPanelProps {
	/** The receiver's name. */
	name: string;
	state: PlaybackState;
	capabilities: PlaybackCapabilities;
	onPlay: () => void;
	onPause: () => void;
	onSeek: (position: number) => void;
	/** 0 to 100. */
	onVolume: (volume: number) => void;
	/** Ends the cast and plays here, from `position` for a movie or episode. */
	onPlayHere: (position: number) => void;
	/** Ends the cast and leaves the player. */
	onStop: () => void;
}

const statusLine = (state: PlaybackState): string | null => {
	if (state.error) return "The stream stopped on the TV.";
	if (state.connection === "reconnecting") return "Connecting…";
	if (state.status === "opening") return "Starting on the TV…";
	if (state.status === "buffering") return "Buffering…";
	if (state.status === "ended") return "Finished.";
	return null;
};

/** Where the receiver is now: the last position it reported, moved on by
 *  the time since while it plays. */
export const positionNow = (state: PlaybackState, now: number): number => {
	if (state.status !== "playing") return state.position;
	const moved = state.position + Math.max(0, now - state.positionAt) / 1000;
	return state.duration > 0 ? Math.min(moved, state.duration) : moved;
};

/**
 * What the player shows while it casts: where it plays, the receiver's
 * controls, and a way back. It covers the video, which is on the TV.
 */
export const CastPanel = ({
	name,
	state,
	capabilities,
	onPlay,
	onPause,
	onSeek,
	onVolume,
	onPlayHere,
	onStop,
}: CastPanelProps) => {
	const over = state.error !== null || state.status === "ended";
	const playing = state.status === "playing" || state.status === "buffering";
	const line = statusLine(state);
	const [now, setNow] = useState(() => performance.now());
	// While dragging, the slider shows where it's going, and the seek goes
	// once it's let go, since a converted stream starts again for each.
	const [dragging, setDragging] = useState<number | null>(null);
	useEffect(() => {
		if (state.status !== "playing") return;
		const timer = setInterval(() => setNow(performance.now()), 1000);
		return () => clearInterval(timer);
	}, [state.status]);
	const position = dragging ?? positionNow(state, now);
	const resumeAt = capabilities.resumeAt && state.duration > 0 ? position : 0;
	const commit = () => {
		if (dragging === null) return;
		onSeek(dragging);
		setDragging(null);
	};
	return (
		<div
			className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black px-6 text-center text-white"
			role="region"
			aria-label="Google Cast"
		>
			<Cast className="h-12 w-12 text-white/70" aria-hidden />
			<div>
				<p className="text-lg font-medium">
					{over ? `Stopped on ${name}` : `Casting to ${name}`}
				</p>
				{state.item && <p className="text-sm text-white/60">{state.item.title}</p>}
			</div>
			{line && (
				<p className="text-sm text-white/80" role="status">
					{line}
				</p>
			)}

			{!over && (
				<div className="flex w-full max-w-md flex-col items-center gap-3">
					{capabilities.pause && (
						<Button
							variant="ghost"
							size="icon"
							className="h-12 w-12 text-white hover:bg-white/20"
							onClick={playing ? onPause : onPlay}
							aria-label={playing ? "Pause" : "Play"}
						>
							{playing ? <Pause className="h-7 w-7" /> : <Play className="h-7 w-7" />}
						</Button>
					)}
					{capabilities.seek && state.duration > 0 && (
						<label className="flex w-full items-center gap-2 text-xs text-white/70">
							<span>{formatTime(position)}</span>
							<input
								type="range"
								className="flex-1"
								min={0}
								max={state.duration}
								step={1}
								value={position}
								aria-label="Position"
								onChange={(e) => setDragging(Number(e.target.value))}
								onPointerUp={commit}
								onKeyUp={commit}
							/>
							<span>{formatTime(state.duration)}</span>
						</label>
					)}
					{capabilities.volume === "absolute" && (
						<label className="flex w-48 items-center gap-2 text-xs text-white/70">
							<span>Volume</span>
							<input
								type="range"
								className="flex-1"
								min={0}
								max={100}
								step={1}
								value={state.volume}
								aria-label="Volume"
								onChange={(e) => onVolume(Number(e.target.value))}
							/>
						</label>
					)}
				</div>
			)}

			<div className="flex gap-3">
				<Button variant="secondary" onClick={() => onPlayHere(resumeAt)}>
					{resumeAt > 0 ? `Play here from ${formatTime(resumeAt)}` : "Play here"}
				</Button>
				<Button variant="ghost" className="text-white hover:bg-white/20" onClick={onStop}>
					Stop
				</Button>
			</div>
		</div>
	);
};
