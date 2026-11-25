// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** What a key on the remote does on a TV while the focus is on the video. */
export type TvPlayerAction =
	| { type: "zap"; step: 1 | -1 }
	| { type: "guide" }
	| { type: "controls" }
	| { type: "details" }
	| { type: "seek"; step: 1 | -1 }
	| { type: "episode"; step: 1 | -1 }
	| { type: "info" }
	| { type: "stop" };

const ZAP_UP: TvPlayerAction = { type: "zap", step: -1 };
const ZAP_DOWN: TvPlayerAction = { type: "zap", step: 1 };
const GUIDE: TvPlayerAction = { type: "guide" };
const INFO: TvPlayerAction = { type: "info" };

const LIVE_KEYS: Record<string, TvPlayerAction> = {
	ChannelUp: ZAP_UP,
	PageUp: ZAP_UP,
	ChannelDown: ZAP_DOWN,
	PageDown: ZAP_DOWN,
	Guide: GUIDE,
	ContextMenu: GUIDE,
	ArrowLeft: { type: "seek", step: -1 },
	ArrowRight: { type: "seek", step: 1 },
};

const VIDEO_KEYS: Record<string, TvPlayerAction> = {
	ChannelUp: { type: "episode", step: -1 },
	PageUp: { type: "episode", step: -1 },
	ChannelDown: { type: "episode", step: 1 },
	PageDown: { type: "episode", step: 1 },
	ContextMenu: INFO,
};

const SHARED_KEYS: Record<string, TvPlayerAction> = {
	ArrowUp: { type: "details" },
	ArrowDown: { type: "controls" },
	Info: INFO,
	MediaStop: { type: "stop" },
};

/**
 * The D-pad's Down shows the player's buttons, and Up shows them under the
 * details of what's playing. On live TV, Left and Right move through what the
 * player has buffered, and the Menu key shows the guide. On a movie or
 * episode, the Menu key shows the details and episodes. Only a remote's own
 * channel keys change the channel, so nobody leaves a channel by brushing an
 * arrow. OK plays and pauses, and a movie or episode keeps Left and Right for
 * seeking, which the player's own shortcuts do, so those keys come back null
 * here.
 */
export const resolveTvPlayerKey = (key: string, live: boolean): TvPlayerAction | null =>
	(live ? LIVE_KEYS : VIDEO_KEYS)[key] ?? SHARED_KEYS[key] ?? null;
