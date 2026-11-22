// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { resolveTvPlayerKey } from "@/lib/tv-player-keys";
import { zapListFor, zapNeighbor } from "@/lib/tv-zap";
import type { Channel } from "@/lib/types";

/**
 * How long a channel has to stay picked before it loads, so stepping past a
 * few channels doesn't open a stream for each of them.
 */
export const ZAP_DELAY_MS = 350;

/** The side panels over the video. */
export type TvPlayerPanel = "channels" | "sources" | "audio" | "speed";

/**
 * What the bar along the bottom shows: the buttons, the buttons under the
 * details of what's playing, or the buttons over the tray of options. With
 * none of them, the bar only shows where the video is, when it shows at all.
 */
export type TvView = "none" | "controls" | "details" | "tray";

interface UseTvPlayerOptions {
	channel: Channel | null;
	channels: readonly Channel[];
	play: (channel: Channel) => void;
	onChannels: () => void;
	onEpisode: (step: 1 | -1) => void;
	onInfo: () => void;
	onStop: () => void;
	/** Moves a skip back or forward on live TV. */
	onSeek: (step: 1 | -1) => void;
	/** Keeps the bar up, since the keys that change the view don't reach the player. */
	onActivity: () => void;
}

/** What a TV's remote does in the player while the focus is on the video. */
export const useTvPlayer = ({
	channel,
	channels,
	play,
	onChannels,
	onEpisode,
	onInfo,
	onStop,
	onSeek,
	onActivity,
}: UseTvPlayerOptions) => {
	const [view, setViewState] = useState<TvView>("none");
	const [zapTarget, setZapTarget] = useState<Channel | null>(null);
	const zapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const cancelZap = () => {
		clearTimeout(zapTimerRef.current);
		setZapTarget(null);
	};

	const setView = (next: TvView) => {
		setViewState(next);
		if (next !== "none") onActivity();
	};

	useEffect(
		() => () => clearTimeout(zapTimerRef.current),
		// Stryker disable next-line ArrayDeclaration: any list that never changes runs the effect once, as this one does.
		[]
	);

	const zap = (step: 1 | -1) => {
		// Only a live channel's keys zap, so there's a channel.
		const from = channel!;
		const next = zapNeighbor((zapTarget ?? from).id, step, zapListFor(from.id, channels));
		if (!next) return;
		clearTimeout(zapTimerRef.current);
		setZapTarget(next);
		// The details show which channel is coming, unless the buttons are
		// already up, where the bar shows it.
		setView(view === "none" ? "details" : view);
		zapTimerRef.current = setTimeout(() => {
			setZapTarget(null);
			play(next);
		}, ZAP_DELAY_MS);
	};

	/** Takes the key if it's one of the TV's own. Returns whether it did. */
	const handleKey = (e: KeyboardEvent): boolean => {
		const action = resolveTvPlayerKey(e.key, channel?.contentType === "live");
		if (!action) return false;
		e.preventDefault();
		switch (action.type) {
			case "zap":
				zap(action.step);
				break;
			case "channels":
				onChannels();
				break;
			case "controls":
			case "details":
				setView(action.type);
				break;
			case "seek":
				onSeek(action.step);
				break;
			case "episode":
				onEpisode(action.step);
				break;
			case "info":
				onInfo();
				break;
			case "stop":
				onStop();
				break;
		}
		return true;
	};

	return {
		view,
		setView,
		zapTarget,
		/** Steps to the next or previous channel, which loads after a pause. */
		zap,
		/** Plays a channel picked from the list, ahead of one still waiting to load. */
		playNow: (next: Channel) => {
			cancelZap();
			play(next);
		},
		handleKey,
	};
};
