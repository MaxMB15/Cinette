// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { SubtitleCue } from "./types";

/** The cue to show `time` seconds into the subtitles, or undefined for none. */
export const cueAt = (cues: SubtitleCue[], time: number): SubtitleCue | undefined =>
	cues.find((cue) => time >= cue.start && time <= cue.end);

/**
 * Seconds from `time` to the next start or end of a cue, or null when none
 * comes after it. A cue shows up to and including its end, so the end of a
 * cue that's showing counts, even when `time` is on it.
 */
export const nextCueChange = (cues: SubtitleCue[], time: number): number | null => {
	let next = Infinity;
	for (const cue of cues) {
		if (cue.start > time) next = Math.min(next, cue.start);
		else if (cue.end >= time) next = Math.min(next, cue.end);
	}
	return next === Infinity ? null : next - time;
};
