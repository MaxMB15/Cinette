// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SkipSegmentModes } from "@/lib/player-prefs";
import {
	extendRun,
	NOTICE_MS,
	OFFER_SECONDS,
	reachedAutoSkip,
	segmentAt,
	segmentGroup,
	segmentKey,
	skipActionFor,
	skipLabel,
	skippedLabel,
	type PlayRun,
} from "@/lib/skip-segments";
import type { SkipSegment, SkipSegmentKind } from "@/lib/types";

/**
 * How long a segment stays without its button after a skip, in milliseconds,
 * even if a poll from before the seek lands inside it again.
 */
const SKIP_SETTLE_MS = 3000;

interface SegmentSkippingOptions {
	/** The video's segments, from `useSkipSegments`. A new array means a new video. */
	segments: readonly SkipSegment[];
	position: number;
	duration: number;
	/** Whether the video is playing rather than paused or loading. */
	playing: boolean;
	modes: SkipSegmentModes;
	/** Whether the player goes on to the next episode at the end. */
	autoplay: boolean;
	hasNext: boolean;
	seek: (to: number) => void;
	onNextEpisode: () => void;
}

/** A segment the player offers to skip with a button. */
export interface SkipOffer {
	label: string;
	/** Whether the button goes to the next episode rather than further into this one. */
	next: boolean;
	/** True for the first few seconds of the segment. After that the button only shows with the controls. */
	fresh: boolean;
	/** The video's length is off from the one the times were made for, so they may be too. */
	unsure: boolean;
}

/** Shown for a moment after the player skips a segment on its own. */
export interface SkipNotice {
	label: string;
}

/** A countdown to the next episode, started at the credits. */
export interface NextCountdown {
	/** The label of the button that stops it, such as "Watch credits". */
	cancelLabel: string;
}

export interface SegmentSkipping {
	offer: SkipOffer | null;
	notice: SkipNotice | null;
	countdown: NextCountdown | null;
	/**
	 * Does what the offer's button or the countdown's says. Returns false when
	 * there's nothing to skip.
	 */
	skip: () => boolean;
	/** Goes back to where the player skipped from. */
	undo: () => void;
	/** Stops the countdown and stays on the credits. */
	cancelCountdown: () => void;
}

/**
 * Skips intros, recaps, credits and previews as Settings says. With "button"
 * a Skip button shows while the segment plays. With "auto" the player skips
 * on its own once playback runs into the segment, and offers to undo it. At
 * credits that run to the end, with autoplay on, it counts down to the next
 * episode instead. "auto" falls back to the button when the times aren't
 * sure enough, or when the segment was reached by seeking into it.
 *
 * Each segment is skipped on its own at most once per video, so going back
 * to watch it works.
 */
export const useSegmentSkipping = ({
	segments,
	position,
	duration,
	playing,
	modes,
	autoplay,
	hasNext,
	seek,
	onNextEpisode,
}: SegmentSkippingOptions): SegmentSkipping => {
	const runRef = useRef<PlayRun | null>(null);
	// Segments the player has skipped on its own, or started a countdown at.
	const doneRef = useRef(new Set<string>());
	const [skipped, setSkipped] = useState<{ key: string; at: number } | null>(null);
	const [notice, setNotice] = useState<{
		key: string;
		kind: SkipSegmentKind;
		from: number;
	} | null>(null);
	const [countdown, setCountdown] = useState<{ key: string; kind: SkipSegmentKind } | null>(null);
	const [entered, setEntered] = useState<{ key: string; at: number } | null>(null);

	const current = segmentAt(segments, position);
	const currentKey = current && segmentKey(current);
	const mode = current ? modes[segmentGroup(current.kind)] : "off";
	const action = current && mode !== "off" ? skipActionFor(current, duration, hasNext) : null;

	// A new video starts over.
	useEffect(() => {
		doneRef.current = new Set();
		setSkipped(null);
		setNotice(null);
		setCountdown(null);
		setEntered(null);
	}, [segments]);

	// Note where each segment was first seen playing, for `fresh`.
	useEffect(() => {
		if (currentKey !== null && entered?.key !== currentKey) {
			setEntered({ key: currentKey, at: position });
		}
	}, [currentKey, entered, position]);

	// A segment gets its button back once playback has left it.
	useEffect(() => {
		if (skipped && currentKey !== skipped.key && Date.now() - skipped.at >= SKIP_SETTLE_MS) {
			setSkipped(null);
		}
	}, [skipped, currentKey, position]);

	// Seeking out of the credits stops the countdown.
	useEffect(() => {
		if (countdown && currentKey !== countdown.key) setCountdown(null);
	}, [countdown, currentKey]);

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);

	// The latest values, for the callbacks below, which stay the same between renders.
	const latest = useRef({ current, currentKey, action, seek, onNextEpisode, countdown, notice });
	latest.current = { current, currentKey, action, seek, onNextEpisode, countdown, notice };

	// Skip on its own when playback runs into a segment set to "auto".
	useEffect(() => {
		const run = extendRun(runRef.current, position);
		runRef.current = run;
		if (!playing || !current || mode !== "auto") return;
		const key = segmentKey(current);
		if (doneRef.current.has(key) || !reachedAutoSkip(current, run, position)) return;
		const action = skipActionFor(current, duration, hasNext);
		if (action?.type === "seek") {
			doneRef.current.add(key);
			latest.current.seek(action.to);
			setSkipped({ key, at: Date.now() });
			setNotice({ key, kind: current.kind, from: position });
		} else if (action?.type === "next" && autoplay) {
			doneRef.current.add(key);
			setCountdown({ key, kind: current.kind });
		}
	}, [position, playing, current, mode, duration, hasNext, autoplay]);

	const skip = useCallback((): boolean => {
		const { current, currentKey, action, seek, onNextEpisode, countdown } = latest.current;
		if (countdown) {
			onNextEpisode();
			return true;
		}
		if (!current || currentKey === null || !action) return false;
		if (action.type === "next") {
			onNextEpisode();
			return true;
		}
		doneRef.current.add(currentKey);
		seek(action.to);
		setSkipped({ key: currentKey, at: Date.now() });
		return true;
	}, []);

	const undo = useCallback(() => {
		const { notice, seek } = latest.current;
		if (!notice) return;
		seek(notice.from);
		setNotice(null);
		setSkipped(null);
	}, []);

	const cancelCountdown = useCallback(() => {
		const { countdown } = latest.current;
		if (!countdown) return;
		setCountdown(null);
		setSkipped({ key: countdown.key, at: Date.now() });
	}, []);

	const hidden =
		currentKey === skipped?.key || currentKey === countdown?.key || currentKey === notice?.key;
	const offer: SkipOffer | null =
		current && action && !hidden
			? {
					label: skipLabel(current.kind, action),
					next: action.type === "next",
					fresh: entered?.key !== currentKey || position - entered.at < OFFER_SECONDS,
					unsure: current.fit === "mismatch",
				}
			: null;

	return {
		offer,
		notice: notice && { label: skippedLabel(notice.kind) },
		countdown: countdown && { cancelLabel: `Watch ${countdown.kind}` },
		skip,
		undo,
		cancelCountdown,
	};
};
