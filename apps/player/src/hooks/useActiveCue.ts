// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { clockAt, followReading, isNewReading, nextTick, startClock } from "@/lib/subtitle-clock";
import { cueAt } from "@/lib/subtitle-timing";
import type { SubtitleCue } from "@/lib/types";

/**
 * The cue to show for the video's position. The player only reads mpv's
 * position once a second, so this runs a clock from the last `position`,
 * which was read at `positionAt` in `performance.now()` milliseconds, and
 * renders again as a cue starts or ends. `moving` is whether the picture
 * moves on, so the clock stops while the video is paused or waits for the
 * stream. A positive `delay` shows each cue later, as mpv's `sub-delay` does.
 */
export const useActiveCue = (
	cues: SubtitleCue[],
	position: number,
	positionAt: number,
	delay: number,
	moving: boolean
): SubtitleCue | undefined => {
	const [clock, setClock] = useState(() => startClock({ position, at: positionAt, moving }));
	// A new reading moves the clock before this render shows anything.
	if (isNewReading(clock, position, positionAt)) {
		setClock(followReading(clock, { position, at: positionAt, moving }));
	}

	useEffect(() => {
		const wait = nextTick(clock, cues, delay, moving, performance.now());
		if (wait === null) return;
		const timer = setTimeout(() => {
			const now = performance.now();
			setClock((c) => ({ ...clockAt(c, now), moving }));
		}, wait);
		return () => clearTimeout(timer);
	}, [clock, cues, delay, moving]);

	return cueAt(cues, clock.position - delay);
};
