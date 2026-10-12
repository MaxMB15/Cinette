// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Rules for skipping intros, recaps, credits and previews. The times come
// from the backend's get_skip_segments, already checked against the video's
// length.

import type { SkipSegmentModes } from "@/lib/player-prefs";
import type { SkipSegment, SkipSegmentKind } from "@/lib/types";

/** A segment that ends this close to the end of the video, in seconds, runs to the end. */
export const END_TOLERANCE = 5;

/**
 * The furthest the position can move between two polls, in seconds, and
 * still count as playing on. Polls come once a second, so a larger step is a
 * seek. It's below the shortest skip Settings offers.
 */
export const MAX_PLAY_STEP = 3;

/** How long the Skip button stays up after a segment starts, in seconds of video. */
export const OFFER_SECONDS = 10;

/** How long "Skipped intro" and its Undo button stay up, in milliseconds. */
export const NOTICE_MS = 5000;

/** How long the countdown to the next episode runs, in milliseconds. */
export const COUNTDOWN_MS = 5000;

/** Which Settings choice covers a kind of segment. */
export const segmentGroup = (kind: SkipSegmentKind): keyof SkipSegmentModes =>
	kind === "intro" || kind === "recap" ? "opening" : "ending";

/** Tells segments apart within one video. */
export const segmentKey = (s: SkipSegment): string => `${s.kind}@${s.start}`;

/**
 * The segment playing at `position`, if any. Its last second doesn't count,
 * so a skip that lands a little short of the end doesn't offer it again.
 */
export const segmentAt = (segments: readonly SkipSegment[], position: number): SkipSegment | null =>
	segments.find((s) => s.start <= position && position < s.end - 1) ?? null;

/** Whether a segment lasts until the video ends, like credits with nothing after them. */
export const runsToEnd = (s: SkipSegment, duration: number): boolean =>
	duration > 0 && s.end >= duration - END_TOLERANCE;

/** What skipping a segment does. */
export type SkipAction = { type: "seek"; to: number } | { type: "next" };

/**
 * Skipping jumps to the end of the segment. A segment that runs to the end
 * skips to the next episode instead, or can't be skipped when there's none,
 * since there's nothing left to jump to.
 */
export const skipActionFor = (
	s: SkipSegment,
	duration: number,
	hasNext: boolean
): SkipAction | null => {
	if (!runsToEnd(s, duration)) return { type: "seek", to: s.end };
	return hasNext ? { type: "next" } : null;
};

/** The label on the button that skips a segment. */
export const skipLabel = (kind: SkipSegmentKind, action: SkipAction): string =>
	action.type === "next" ? "Next episode" : `Skip ${kind}`;

/** The notice shown after the player skipped a segment on its own. */
export const skippedLabel = (kind: SkipSegmentKind): string => `Skipped ${kind}`;

/** A stretch of the video played without a seek, as far as the polls show. */
export interface PlayRun {
	/** Where the stretch began, in seconds. */
	start: number;
	/** The latest position in it, in seconds. */
	last: number;
}

/**
 * Adds a polled position to the stretch played so far. A step back, or
 * forward by more than `MAX_PLAY_STEP`, is a seek and starts a new stretch.
 */
export const extendRun = (run: PlayRun | null, position: number): PlayRun =>
	run && position >= run.last && position - run.last <= MAX_PLAY_STEP
		? { start: run.start, last: position }
		: { start: position, last: position };

/**
 * Whether the player may skip a segment on its own at `position`. It has to
 * have played into the point it may skip from, rather than seek past it, so
 * jumping into an intro to watch it doesn't skip it.
 */
export const reachedAutoSkip = (s: SkipSegment, run: PlayRun, position: number): boolean =>
	s.autoFrom !== null && run.start <= s.autoFrom && s.autoFrom <= position;
