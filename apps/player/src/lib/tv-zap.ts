// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel } from "./types";

/**
 * The channels a remote's channel keys step through while watching live on a
 * TV: the list the channel was picked from. It's kept here and not in the
 * router's state, since the router would copy thousands of channels on every
 * navigation.
 */
let zapList: readonly Channel[] = [];

export const setZapList = (channels: readonly Channel[]): void => {
	zapList = channels;
};

export const getZapList = (): readonly Channel[] => zapList;

/**
 * The channel `step` places from this one in the list, going around at its
 * ends. Null when the channel isn't in the list or is the only one in it.
 */
export const zapNeighbor = (
	channelId: string,
	step: number,
	list: readonly Channel[] = zapList
): Channel | null => {
	const index = list.findIndex((ch) => ch.id === channelId);
	if (index < 0 || list.length < 2) return null;
	return list[(index + step + list.length) % list.length];
};

/**
 * The list to step through and show for this channel: the one it was picked
 * from, or every live channel when it came from somewhere else, such as
 * another device.
 */
export const zapListFor = (channelId: string, channels: readonly Channel[]): readonly Channel[] =>
	zapList.some((ch) => ch.id === channelId)
		? zapList
		: channels.filter((ch) => ch.contentType === "live");
