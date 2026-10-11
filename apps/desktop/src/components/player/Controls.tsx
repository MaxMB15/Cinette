// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import {
	Play,
	Pause,
	Square,
	Volume2,
	VolumeX,
	Maximize,
	Minimize2,
	Info,
	SkipBack,
	SkipForward,
	Subtitles,
	Layers,
	Keyboard,
	Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/format";
import { describeSource } from "@/lib/sources";
import type { PlayerState } from "@/lib/types";
import { useState, useEffect, useRef } from "react";

interface ControlsProps {
	state: PlayerState;
	visible: boolean;
	isFullscreen?: boolean;
	onPlay: () => void;
	onPause: () => void;
	onStop: () => void;
	onSeek: (position: number) => void;
	onVolumeChange: (volume: number) => void;
	onToggleMute?: () => void;
	onFullscreen?: () => void;
	onInfo?: () => void;
	onPrevEpisode?: () => void;
	onNextEpisode?: () => void;
	autoplay?: boolean;
	onAutoplayChange?: (v: boolean) => void;
	onSubtitles?: () => void;
	hasSubtitles?: boolean;
	/** All stream URLs for the current item; the switcher shows when there are 2+. */
	sources?: string[];
	currentSource?: string | null;
	onSelectSource?: (url: string) => void;
	onShortcuts?: () => void;
	/** False on phones and tablets, where the hardware buttons set the volume. */
	showVolumeSlider?: boolean;
	/** Optional download control rendered in the right cluster. */
	downloadSlot?: React.ReactNode;
}

export const Controls = ({
	state,
	visible,
	isFullscreen,
	onPlay,
	onPause,
	onStop,
	onSeek,
	onVolumeChange,
	onToggleMute,
	onFullscreen,
	onInfo,
	onPrevEpisode,
	onNextEpisode,
	autoplay,
	onAutoplayChange,
	onSubtitles,
	hasSubtitles,
	sources,
	currentSource,
	onSelectSource,
	onShortcuts,
	showVolumeSlider = true,
	downloadSlot,
}: ControlsProps) => {
	const [localPos, setLocalPos] = useState(state.position);
	const isSeeking = useRef(false);
	const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
	const sourceMenuRef = useRef<HTMLDivElement>(null);
	const hasSourceChoice = !!onSelectSource && (sources?.length ?? 0) > 1;

	// Close the source menu on any click outside it.
	useEffect(() => {
		if (!sourceMenuOpen) return;
		const handle = (e: PointerEvent) => {
			if (!sourceMenuRef.current?.contains(e.target as Node)) setSourceMenuOpen(false);
		};
		window.addEventListener("pointerdown", handle);
		return () => window.removeEventListener("pointerdown", handle);
	}, [sourceMenuOpen]);

	useEffect(() => {
		if (!visible) setSourceMenuOpen(false);
	}, [visible]);

	useEffect(() => {
		if (!isSeeking.current) {
			setLocalPos(state.position);
		}
	}, [state.position]);

	const handleSeekChange = (v: number) => {
		isSeeking.current = true;
		setLocalPos(v);
	};

	const handleSeekCommit = () => {
		isSeeking.current = false;
		onSeek(localPos);
	};

	return (
		<div
			className={cn(
				"absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12 pb-[calc(1rem_+_env(safe-area-inset-bottom))] pl-[calc(1rem_+_env(safe-area-inset-left))] pr-[calc(1rem_+_env(safe-area-inset-right))] transition-opacity duration-300",
				visible ? "opacity-100" : "opacity-0 pointer-events-none"
			)}
		>
			{state.duration > 0 && (
				<div className="mb-3">
					<div onPointerUp={handleSeekCommit}>
						<Slider
							value={localPos}
							min={0}
							max={state.duration}
							step={1}
							onValueChange={handleSeekChange}
						/>
					</div>
					<div className="flex justify-between text-xs text-white/60 mt-1">
						<span>{formatTime(localPos)}</span>
						<span>{formatTime(state.duration)}</span>
					</div>
				</div>
			)}

			<div className="flex items-center gap-2">
				{/* Info button — leftmost */}
				{onInfo && (
					<Button
						variant="ghost"
						size="icon"
						className="text-white hover:bg-white/20"
						onClick={onInfo}
						aria-label="Channel info"
					>
						<Info className="h-5 w-5" />
					</Button>
				)}

				{onInfo && <div className="w-px h-4 bg-white/20 mx-0.5 shrink-0" />}

				{/* Playback controls */}
				{state.isPaused || !state.isPlaying ? (
					<Button
						variant="ghost"
						size="icon"
						onClick={onPlay}
						className="text-white hover:bg-white/20"
						aria-label="Play"
					>
						<Play className="h-5 w-5" />
					</Button>
				) : (
					<Button
						variant="ghost"
						size="icon"
						onClick={onPause}
						className="text-white hover:bg-white/20"
						aria-label="Pause"
					>
						<Pause className="h-5 w-5" />
					</Button>
				)}

				<Button
					variant="ghost"
					size="icon"
					onClick={onStop}
					className="text-white hover:bg-white/20"
					aria-label="Stop"
				>
					<Square className="h-4 w-4" />
				</Button>

				{/* Volume */}
				<div className="flex items-center gap-2 ml-2">
					<Button
						variant="ghost"
						size="icon"
						onClick={onToggleMute ?? (() => onVolumeChange(state.volume > 0 ? 0 : 100))}
						className="text-white hover:bg-white/20"
						aria-label={state.volume === 0 ? "Unmute" : "Mute"}
					>
						{state.volume === 0 ? (
							<VolumeX className="h-5 w-5" />
						) : (
							<Volume2 className="h-5 w-5" />
						)}
					</Button>
					{showVolumeSlider && (
						<div className="w-24">
							<Slider
								value={state.volume}
								min={0}
								max={150}
								step={1}
								onValueChange={onVolumeChange}
							/>
						</div>
					)}
				</div>

				<div className="flex-1" />

				{/* Episode navigation — right side */}
				{onPrevEpisode && (
					<Button
						variant="ghost"
						size="icon"
						className="text-white hover:bg-white/20"
						onClick={onPrevEpisode}
						aria-label="Previous episode"
					>
						<SkipBack className="h-5 w-5" />
					</Button>
				)}

				{onNextEpisode && (
					<Button
						variant="ghost"
						size="icon"
						className="text-white hover:bg-white/20"
						onClick={onNextEpisode}
						aria-label="Next episode"
					>
						<SkipForward className="h-5 w-5" />
					</Button>
				)}

				{/* Autoplay toggle — only shown for series (when episode nav is available) */}
				{onAutoplayChange !== undefined &&
					(onPrevEpisode !== undefined || onNextEpisode !== undefined) && (
						<button
							onClick={() => onAutoplayChange(!autoplay)}
							aria-label={autoplay ? "Autoplay on" : "Autoplay off"}
							className="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-white/10 transition-colors"
						>
							<span
								className={cn(
									"text-[10px] font-medium uppercase tracking-wide",
									autoplay ? "text-white/70" : "text-white/30"
								)}
							>
								Auto
							</span>
							{/* Pill toggle */}
							<div
								className={cn(
									"relative w-7 h-3.5 rounded-full transition-colors duration-200",
									autoplay ? "bg-blue-500" : "bg-white/20"
								)}
							>
								<div
									className={cn(
										"absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform duration-200",
										autoplay ? "translate-x-[14px]" : "translate-x-0.5"
									)}
								/>
							</div>
						</button>
					)}

				{hasSourceChoice && (
					<div className="relative" ref={sourceMenuRef}>
						<Button
							variant="ghost"
							size="icon"
							className={cn(
								"text-white hover:bg-white/20",
								sourceMenuOpen && "bg-white/20"
							)}
							onClick={() => setSourceMenuOpen((v) => !v)}
							aria-label="Source"
							aria-expanded={sourceMenuOpen}
							title="Source"
						>
							<Layers className="h-5 w-5" />
						</Button>
						{sourceMenuOpen && (
							<div
								role="menu"
								className="absolute bottom-full right-0 mb-2 w-60 max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-black/90 p-1 shadow-xl backdrop-blur-sm"
							>
								<p className="px-2.5 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-white/40">
									Source
								</p>
								{sources!.map((url, idx) => {
									const active = url === currentSource;
									const detail = describeSource(url);
									return (
										<button
											key={url}
											role="menuitemradio"
											aria-checked={active}
											onClick={() => {
												setSourceMenuOpen(false);
												if (!active) onSelectSource!(url);
											}}
											className={cn(
												"flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-white hover:bg-white/10",
												active && "bg-white/10"
											)}
										>
											<span className="w-3.5 shrink-0">
												{active && (
													<Check className="h-3.5 w-3.5 text-blue-400" />
												)}
											</span>
											<span className="min-w-0 flex-1">
												<span className="block text-xs font-medium">
													Source {idx + 1}
													{idx === 0 && (
														<span className="text-white/40 font-normal">
															{" "}
															(default)
														</span>
													)}
												</span>
												{detail && (
													<span className="block truncate text-[10px] text-white/50">
														{detail}
													</span>
												)}
											</span>
										</button>
									);
								})}
							</div>
						)}
					</div>
				)}

				{onSubtitles && (
					<Button
						variant="ghost"
						size="icon"
						className={cn(
							"text-white hover:bg-white/20",
							hasSubtitles && "text-blue-400"
						)}
						onClick={onSubtitles}
						aria-label="Subtitles"
					>
						<Subtitles className="h-5 w-5" />
					</Button>
				)}

				{downloadSlot && (
					<div className="flex items-center justify-center h-9 w-9 text-white">
						{downloadSlot}
					</div>
				)}
				{onShortcuts && (
					<Button
						variant="ghost"
						size="icon"
						className="text-white hover:bg-white/20"
						onClick={onShortcuts}
						aria-label="Keyboard shortcuts"
						title="Keyboard shortcuts (?)"
					>
						<Keyboard className="h-5 w-5" />
					</Button>
				)}

				{onFullscreen && (
					<Button
						variant="ghost"
						size="icon"
						className="text-white hover:bg-white/20"
						onClick={onFullscreen}
						aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
					>
						{isFullscreen ? (
							<Minimize2 className="h-5 w-5" />
						) : (
							<Maximize className="h-5 w-5" />
						)}
					</Button>
				)}
			</div>
		</div>
	);
};
