// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState } from "react";
import { cueAt, nextCueChange } from "@/lib/subtitle-timing";
import type { SubtitleCue } from "@/lib/types";

/**
 * The furthest the clock runs past the last position, in seconds. The player
 * reads the position every second, so one that's older than this means the
 * stream has stalled.
 */
export const MAX_AHEAD_SECONDS = 1.5;

/**
 * The cue to show while mpv plays at `position`. The player only reads mpv's
 * position once a second, so while `playing`, this counts the time since the
 * position arrived and renders again as a cue starts or ends. The app has no
 * speed control, so a second played is a second of video. A positive `delay`
 * shows each cue later, as mpv's `sub-delay` does.
 */
export const useActiveCue = (
	cues: SubtitleCue[],
	position: number,
	delay: number,
	playing: boolean
): SubtitleCue | undefined => {
	// Seconds played since `position` arrived, as of the last cue change. A
	// new position starts again from 0, and so does the cue change a timer for
	// the old position sets after it arrived.
	const [clock, setClock] = useState({ position, ahead: 0 });
	const ahead = clock.position === position ? clock.ahead : 0;

	// When `ahead` was last right. A new position or the video playing again
	// starts the count from here.
	const since = useRef(0);
	useEffect(() => {
		since.current = performance.now();
	}, [position, playing]);

	useEffect(() => {
		if (!playing) return;
		const wait = nextCueChange(cues, position + ahead - delay);
		if (wait === null || ahead + wait > MAX_AHEAD_SECONDS) return;
		// A millisecond more puts the clock past the end of a cue.
		const timer = setTimeout(
			() => {
				const now = performance.now();
				const played = ahead + (now - since.current) / 1000;
				since.current = now;
				setClock({ position, ahead: Math.min(played, MAX_AHEAD_SECONDS) });
			},
			Math.ceil(wait * 1000) + 1
		);
		return () => clearTimeout(timer);
	}, [cues, position, delay, playing, ahead]);

	return cueAt(cues, position + ahead - delay);
};
