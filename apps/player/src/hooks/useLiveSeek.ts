// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { liveBehind, liveEdge, nextAnchor, type LiveAnchor } from "@/lib/live-seek";

interface LiveSeekOptions {
	/** Each stream that loads, so a new one starts over. Null when nothing live plays. */
	session: string | null;
	/** The stream plays, so its position shows how far the broadcast has got. */
	playing: boolean;
	position: number;
	positionAt: number;
}

/**
 * Follows how far a live channel's broadcast has got, from the furthest its
 * stream has played and the time since, and how far behind it the player is.
 * Both are in seconds, as of the poll that read `position`.
 */
export const useLiveSeek = ({ session, playing, position, positionAt }: LiveSeekOptions) => {
	// Stryker disable next-line ObjectLiteral: an empty start sets this same state on the first render.
	const [held, setHeld] = useState<{ session: string | null; anchor: LiveAnchor | null }>({
		session: null,
		anchor: null,
	});
	// Nothing live holds no anchor, so a new stream or none starts over.
	let anchor = held.session === session ? held.anchor : null;
	if (session !== null && playing) anchor = nextAnchor(anchor, { position, at: positionAt });
	// An anchor is only kept with the session it started in, and a new
	// session never keeps the old anchor, so only a new anchor needs saving.
	if (anchor !== held.anchor) setHeld({ session, anchor });
	return {
		edge: anchor ? liveEdge(anchor, positionAt) : null,
		behind: liveBehind(anchor, position, positionAt),
		anchor,
	};
};
