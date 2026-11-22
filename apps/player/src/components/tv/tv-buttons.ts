// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import {
	AudioLines,
	Captions,
	CircleDot,
	Download,
	Gauge,
	Info,
	Layers,
	List,
	ListVideo,
	Pause,
	Play,
	RotateCcw,
	RotateCw,
	SkipBack,
	SkipForward,
	type LucideIcon,
} from "lucide-react";

/** One of the round buttons along the bottom of the player. */
export interface TvRowButton {
	/** Stays the same as the label changes, so the button keeps the focus. */
	id: string;
	label: string;
	icon: LucideIcon;
	/** A number inside the icon, such as how far a skip goes. */
	badge?: number;
	/** A dot in the corner, as on Subtitles while some show. */
	dot?: boolean;
	/** Shows faded and does nothing, while the focus can still pass over it. */
	disabled?: boolean;
	onPress: () => void;
}

/** The buttons at the start, in the middle and at the end of the row. */
export interface TvRow {
	start: TvRowButton[];
	center: TvRowButton[];
	end: TvRowButton[];
}

export interface TvRowOptions {
	live: boolean;
	/** A show, whose info lists its episodes. */
	series?: boolean;
	paused: boolean;
	/** The stream has failed or is still opening, so pausing means nothing yet. */
	retrying: boolean;
	onRetry: () => void;
	onTogglePlay: () => void;
	/** How far each way the skip buttons go, in seconds. Unset when there's nowhere to skip. */
	skip?: { back: number; forward: number };
	onSkip: (step: 1 | -1) => void;
	/** Live TV that's already live, so there's nothing to skip forward to. */
	atLive: boolean;
	onZap: (step: 1 | -1) => void;
	onChannels: () => void;
	onPrevEpisode?: () => void;
	onNextEpisode?: () => void;
	onSubtitles?: () => void;
	subtitlesOn: boolean;
	onInfo?: () => void;
}

/** The row of buttons, in the order the D-pad walks them. */
export const tvRow = (o: TvRowOptions): TvRow => {
	const start: TvRowButton[] = [];
	const center: TvRowButton[] = [];
	const end: TvRowButton[] = [];
	if (o.onInfo) {
		start.push({
			id: "info",
			label: o.live ? "Channel info" : o.series ? "Episodes and info" : "Info",
			icon: Info,
			onPress: o.onInfo,
		});
	}
	const before = o.live
		? { id: "prev", label: "Previous channel", onPress: () => o.onZap(-1) }
		: o.onPrevEpisode && { id: "prev", label: "Previous episode", onPress: o.onPrevEpisode };
	const after = o.live
		? { id: "next", label: "Next channel", onPress: () => o.onZap(1) }
		: o.onNextEpisode && { id: "next", label: "Next episode", onPress: o.onNextEpisode };
	if (before) center.push({ ...before, icon: SkipBack });
	if (o.skip) {
		center.push({
			id: "back",
			label: `Back ${o.skip.back} s`,
			icon: RotateCcw,
			badge: o.skip.back,
			onPress: () => o.onSkip(-1),
		});
	}
	// These three share a place, so the focus stays on it as one replaces another.
	center.push(
		o.retrying
			? { id: "playback", label: "Try again", icon: RotateCw, onPress: o.onRetry }
			: {
					id: "playback",
					label: o.paused ? "Play" : "Pause",
					icon: o.paused ? Play : Pause,
					onPress: o.onTogglePlay,
				}
	);
	if (o.skip) {
		center.push({
			id: "forward",
			label: `Forward ${o.skip.forward} s`,
			icon: RotateCw,
			badge: o.skip.forward,
			disabled: o.live && o.atLive,
			onPress: () => o.onSkip(1),
		});
	}
	if (after) center.push({ ...after, icon: SkipForward });
	if (o.onSubtitles) {
		end.push({
			id: "subtitles",
			label: "Subtitles",
			icon: Captions,
			dot: o.subtitlesOn,
			onPress: o.onSubtitles,
		});
	}
	if (o.live) end.push({ id: "channels", label: "Channels", icon: List, onPress: o.onChannels });
	return { start, center, end };
};

/** One of the options in the tray under the row. */
export interface TvTile {
	id: string;
	label: string;
	value: string;
	icon: LucideIcon;
	/** Shows faded and does nothing, while the focus can still pass over it. */
	disabled?: boolean;
	onPress: () => void;
}

export interface TvTileOptions {
	live: boolean;
	/** What the source is, when there's another to go to. */
	source?: string;
	onSource: () => void;
	/** Whether the next episode starts by itself. Unset for anything but a show. */
	autoplay?: boolean;
	onAutoplayChange: (next: boolean) => void;
	/** The audio track that plays, when the stream says. */
	audio?: string;
	onAudio: () => void;
	/** How fast it plays, unset on live TV. */
	speed?: string;
	onSpeed: () => void;
}

const nothing = () => {};

/** The tray's options, in the order the D-pad walks them. */
export const tvTiles = (o: TvTileOptions): TvTile[] => {
	const tiles: TvTile[] = [];
	if (o.source !== undefined) {
		tiles.push({
			id: "source",
			label: "Source",
			value: o.source,
			icon: Layers,
			onPress: o.onSource,
		});
	}
	if (o.autoplay !== undefined) {
		const on = o.autoplay;
		tiles.push({
			id: "autoplay",
			label: "Autoplay",
			value: on ? "On" : "Off",
			icon: ListVideo,
			onPress: () => o.onAutoplayChange(!on),
		});
	}
	if (o.audio !== undefined) {
		tiles.push({
			id: "audio",
			label: "Audio",
			value: o.audio,
			icon: AudioLines,
			onPress: o.onAudio,
		});
	}
	if (o.speed !== undefined) {
		tiles.push({
			id: "speed",
			label: "Speed",
			value: o.speed,
			icon: Gauge,
			onPress: o.onSpeed,
		});
	}
	// Saving needs a place on the device to keep the file, which a TV
	// doesn't have yet.
	tiles.push(
		o.live
			? {
					id: "save",
					label: "Record",
					value: "Needs storage",
					icon: CircleDot,
					disabled: true,
					onPress: nothing,
				}
			: {
					id: "save",
					label: "Download",
					value: "Needs storage",
					icon: Download,
					disabled: true,
					onPress: nothing,
				}
	);
	return tiles;
};
