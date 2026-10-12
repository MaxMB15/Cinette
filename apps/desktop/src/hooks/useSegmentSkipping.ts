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
	SKIP_SETTLE_MS,
	skipActionFor,
	skipLabel,
	skippedLabel,
	type PlayRun,
} from "@/lib/skip-segments";
import type { SkipSegment, SkipSegmentKind } from "@/lib/types";

interface SegmentSkippingOptions {
	/** Tells videos apart, from `useSkipSegments`. A different one starts over. */
	video: string | null;
	/** The video's segments, from `useSkipSegments`. */
	segments: readonly SkipSegment[];
	position: number;
	duration: number;
	/**
	 * Whether the video is playing, rather than paused or loading, with nothing
	 * open over the prompt. The player doesn't skip on its own while it's false.
	 */
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
	/**
	 * True for the first few seconds of the segment, counted from where
	 * playback last started in it. After that the button only shows with the
	 * controls.
	 */
	fresh: boolean;
	/** The video's length is off from the one the times were made for, so they may be too. */
	unsure: boolean;
}

/**
 * Whether the Skip button is on screen. After its first few seconds it only
 * shows with the controls.
 */
export const offerShows = (offer: SkipOffer | null, controlsVisible: boolean): boolean =>
	offer !== null && (offer.fresh || controlsVisible);

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
	 * Does what the countdown's or the offer's button says, even when the
	 * offer's button is hidden. Returns false when neither is up, so there's
	 * nothing to skip.
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
	video,
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
	const videoRef = useRef(video);
	const runRef = useRef<PlayRun | null>(null);
	// When the current run began, to tell a seek made after a skip.
	const runStartedAtRef = useRef(0);
	// Where the current run began in the video, for `fresh`.
	const [runStart, setRunStart] = useState<number | null>(null);
	// Segments the player has skipped on its own, or started a countdown at.
	const doneRef = useRef(new Set<string>());
	const [skipped, setSkipped] = useState<{ key: string; at: number } | null>(null);
	const [notice, setNotice] = useState<{
		key: string;
		kind: SkipSegmentKind;
		from: number;
	} | null>(null);
	const [countdown, setCountdown] = useState<{ key: string; kind: SkipSegmentKind } | null>(null);

	// While a stream opens or reconnects, mpv reports no length and a position
	// of 0, which isn't where the viewer is, so those polls are left out.
	const located = duration > 0;
	const current = located ? segmentAt(segments, position) : null;
	const currentKey = current && segmentKey(current);
	const mode = current ? modes[segmentGroup(current.kind)] : "off";
	const action = current && mode !== "off" ? skipActionFor(current, duration, hasNext) : null;

	const hidden =
		currentKey !== null &&
		(currentKey === skipped?.key ||
			currentKey === countdown?.key ||
			currentKey === notice?.key);
	const offer: SkipOffer | null =
		current && action && !hidden
			? {
					label: skipLabel(current.kind, action),
					next: action.type === "next",
					fresh: position - Math.max(current.start, runStart ?? 0) < OFFER_SECONDS,
					unsure: current.fit === "mismatch",
				}
			: null;

	// The latest values, for the callbacks below, which stay the same between renders.
	const latest = useRef({ currentKey, action, offer, countdown, notice, seek, onNextEpisode });
	latest.current = { currentKey, action, offer, countdown, notice, seek, onNextEpisode };

	// A different video starts over. Losing the video for a moment, such as
	// while the player reloads its stream, doesn't.
	useEffect(() => {
		if (video === null || video === videoRef.current) return;
		videoRef.current = video;
		doneRef.current = new Set();
		setSkipped(null);
		setNotice(null);
		setCountdown(null);
	}, [video]);

	// Follow the stretch being played, and skip on its own when playback runs
	// into a segment set to "auto".
	useEffect(() => {
		if (!located) return;
		const last = runRef.current;
		const run = extendRun(last, position);
		runRef.current = run;
		if (run.start !== last?.start) {
			runStartedAtRef.current = Date.now();
			setRunStart(run.start);
		}
		if (!playing || !current || mode !== "auto") return;
		const key = segmentKey(current);
		if (doneRef.current.has(key) || !reachedAutoSkip(current, run, position)) return;
		const action = skipActionFor(current, duration, hasNext);
		if (action?.type === "seek") {
			doneRef.current.add(key);
			latest.current.seek(current.autoTo ?? action.to);
			setSkipped({ key, at: Date.now() });
			setNotice({ key, kind: current.kind, from: position });
		} else if (action?.type === "next" && autoplay) {
			doneRef.current.add(key);
			setCountdown({ key, kind: current.kind });
		}
	}, [located, position, playing, current, mode, duration, hasNext, autoplay]);

	// A skipped segment gets its button back once playback has left it, or
	// once a seek after the skip went back into it.
	useEffect(() => {
		if (!located || !skipped || Date.now() - skipped.at < SKIP_SETTLE_MS) return;
		if (currentKey !== skipped.key || runStartedAtRef.current > skipped.at) setSkipped(null);
	}, [located, skipped, currentKey, position]);

	// The countdown stops when playback leaves the credits, or when autoplay,
	// the next episode or "auto" goes away. A reconnect doesn't stop it.
	const actionType = action?.type;
	useEffect(() => {
		if (!countdown || !located) return;
		if (currentKey !== countdown.key || !autoplay || actionType !== "next" || mode !== "auto") {
			setCountdown(null);
		}
	}, [countdown, located, currentKey, autoplay, actionType, mode]);

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);

	// Each callback clears what it acted on in `latest` until the next render,
	// so a second call in the same moment, such as Enter as the countdown
	// ends, does nothing.
	const skip = useCallback((): boolean => {
		const now = latest.current;
		const { currentKey, action, offer, countdown, seek, onNextEpisode } = now;
		if (countdown) {
			now.countdown = null;
			setCountdown(null);
			setSkipped({ key: countdown.key, at: Date.now() });
			onNextEpisode();
			return true;
		}
		if (!offer || currentKey === null || !action) return false;
		now.offer = null;
		doneRef.current.add(currentKey);
		setSkipped({ key: currentKey, at: Date.now() });
		if (action.type === "next") onNextEpisode();
		else seek(action.to);
		return true;
	}, []);

	const undo = useCallback(() => {
		const now = latest.current;
		const { notice, seek } = now;
		if (!notice) return;
		now.notice = null;
		seek(notice.from);
		setNotice(null);
		setSkipped(null);
	}, []);

	const cancelCountdown = useCallback(() => {
		const now = latest.current;
		const { countdown } = now;
		if (!countdown) return;
		now.countdown = null;
		setCountdown(null);
		setSkipped({ key: countdown.key, at: Date.now() });
	}, []);

	return {
		offer,
		notice: notice && { label: skippedLabel(notice.kind) },
		countdown: countdown && { cancelLabel: `Watch ${countdown.kind}` },
		skip,
		undo,
		cancelCountdown,
	};
};
