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

/**
 * The furthest the position can go back between two polls, in seconds, and
 * still count as playing on. mpv can land a seek a few milliseconds before
 * its target, so the first poll after a skip can be just behind the position
 * the player set when it asked for the seek.
 */
export const MAX_PLAY_JITTER = 0.1;

/**
 * The shortest jump the player makes on its own, in seconds. With less than
 * this left of a segment, the rest plays, since so short a jump saves no time
 * and still empties the stream's buffer.
 */
export const MIN_AUTO_SKIP = 1;

/**
 * The shortest jump the player makes on its own, in seconds, after playback
 * was held inside a segment, such as while paused. Held until near the end,
 * the rest plays. Polls that just reached a segment need only `MIN_AUTO_SKIP`,
 * since in a short one the first poll inside can come with less than this to go.
 */
export const MIN_SKIP_AFTER_HOLD = 2;

/** How long the Skip button stays up after a segment starts, in seconds of video. */
export const OFFER_SECONDS = 10;

/** How long "Skipped intro" and its Undo button stay up, in milliseconds. */
export const NOTICE_MS = 5000;

/** How long the countdown to the next episode runs, in milliseconds. */
export const COUNTDOWN_MS = 5000;

/**
 * How long a skipped segment keeps its button hidden, in milliseconds, so a
 * poll from before the seek that lands inside it again doesn't bring the
 * button back.
 */
export const SKIP_SETTLE_MS = 3000;

/** Which Settings choice covers a kind of segment. */
export const segmentGroup = (kind: SkipSegmentKind): keyof SkipSegmentModes =>
	kind === "intro" || kind === "recap" ? "opening" : "ending";

/**
 * Tells segments apart within one video. The backend sends at most one
 * segment of each kind, so the kind is enough, and it stays the same when
 * the times are looked up again for a new length.
 */
export const segmentKey = (s: SkipSegment): string => s.kind;

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
 * Adds a polled position to the stretch played so far. A step back by more
 * than `MAX_PLAY_JITTER`, or forward by more than `MAX_PLAY_STEP`, is a seek
 * and starts a new stretch.
 */
export const extendRun = (run: PlayRun | null, position: number): PlayRun =>
	run && position >= run.last - MAX_PLAY_JITTER && position - run.last <= MAX_PLAY_STEP
		? { start: run.start, last: position }
		: { start: position, last: position };

/**
 * Whether the player may skip a segment on its own at `position`. Playback
 * has to have run into the segment from before it, rather than seek into it,
 * so jumping into an intro to watch it doesn't skip it. Playback that began
 * in the first few seconds of the video counts as coming from before a
 * segment at its very start.
 */
export const reachedAutoSkip = (s: SkipSegment, run: PlayRun, position: number): boolean =>
	s.autoFrom !== null && run.start < Math.max(s.start, MAX_PLAY_STEP) && s.autoFrom <= position;

/**
 * Whether playback was held at or past the point the player may skip `s` from,
 * such as behind an open overlay. It was if the poll before, `last`, had
 * already reached that point in the same stretch as `run`.
 */
export const heldInAutoSkip = (s: SkipSegment, last: PlayRun | null, run: PlayRun): boolean =>
	s.autoFrom !== null && last !== null && last.start === run.start && last.last >= s.autoFrom;
