// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel } from "./types";

/** All distinct stream URLs for a channel, in provider order (default source first). */
export const channelSources = (ch: Channel): string[] =>
	ch.sourceList ?? [...new Set([ch.url, ...ch.sources])];

/** The same channel set to play `url`, remembering the full ordered source list. */
export const withSource = (ch: Channel, url: string): Channel => ({
	...ch,
	url,
	sourceList: channelSources(ch),
});

/**
 * Short, credential-free description of a stream URL ("example.com · MKV").
 * Xtream URLs embed the username/password in the path, so only the host and
 * file extension are ever shown.
 */
export const describeSource = (url: string): string | null => {
	try {
		const u = new URL(url);
		const ext = u.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toUpperCase();
		return [u.hostname, ext].filter(Boolean).join(" · ") || null;
	} catch {
		return null;
	}
};
