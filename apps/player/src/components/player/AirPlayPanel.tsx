// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Airplay, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlaybackCapabilities, PlaybackState } from "@/lib/destination";
import { formatTime } from "@/lib/format";

interface AirPlayPanelProps {
	/** The receiver's name. */
	name: string;
	state: PlaybackState;
	capabilities: PlaybackCapabilities;
	onPlay: () => void;
	onPause: () => void;
	onSeek: (position: number) => void;
	onSubtitle: (trackId: string | null) => void;
	onAudio: (trackId: string) => void;
	/** Ends AirPlay and plays here, from `position` for a movie or episode. */
	onPlayHere: (position: number) => void;
	/** Ends AirPlay and leaves the player. */
	onStop: () => void;
}

const statusLine = (state: PlaybackState): string | null => {
	if (state.connection === "lost") return "Lost the connection to the TV.";
	if (state.error) return state.error.message ?? "The stream stopped on the TV.";
	if (state.connection === "reconnecting") return "Reconnecting…";
	if (state.status === "opening") return "Starting on the TV…";
	if (state.status === "buffering") return "Buffering…";
	if (state.status === "ended") return "Finished.";
	return null;
};

/**
 * What the player shows while AirPlay plays: where it plays, its own
 * controls, and a way back. It covers the video, which is on the TV.
 */
export const AirPlayPanel = ({
	name,
	state,
	capabilities,
	onPlay,
	onPause,
	onSeek,
	onSubtitle,
	onAudio,
	onPlayHere,
	onStop,
}: AirPlayPanelProps) => {
	const over = state.connection === "lost" || state.error !== null || state.status === "ended";
	const playing = state.status === "playing" || state.status === "buffering";
	const line = statusLine(state);
	const resumeAt = capabilities.resumeAt ? state.position : 0;
	return (
		<div
			className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black px-6 text-center text-white"
			role="region"
			aria-label="AirPlay"
		>
			<Airplay className="h-12 w-12 text-white/70" aria-hidden />
			<div>
				<p className="text-lg font-medium">
					{over ? `Stopped on ${name}` : `Playing on ${name}`}
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
					{capabilities.seek && (
						<label className="flex w-full items-center gap-2 text-xs text-white/70">
							<span>{formatTime(state.position)}</span>
							<input
								type="range"
								className="flex-1"
								min={0}
								max={state.duration}
								step={1}
								value={state.position}
								aria-label="Position"
								onChange={(e) => onSeek(Number(e.target.value))}
							/>
							<span>{formatTime(state.duration)}</span>
						</label>
					)}
					{capabilities.subtitles === "select" && (
						<select
							className="rounded bg-white/10 px-2 py-1 text-sm"
							aria-label="Subtitles"
							value={state.subtitleId ?? ""}
							onChange={(e) =>
								onSubtitle(e.target.value === "" ? null : e.target.value)
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
					{capabilities.audioTracks && (
						<select
							className="rounded bg-white/10 px-2 py-1 text-sm"
							aria-label="Audio"
							// Stryker disable next-line StringLiteral: No audio option has an empty id, so any string selects none of them.
							value={state.audioId ?? ""}
							onChange={(e) => onAudio(e.target.value)}
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
