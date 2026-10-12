// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState } from "react";
import { getSkipSegments } from "@/lib/tauri";
import type { Channel, SkipSegment } from "@/lib/types";

/** What `useSkipSegments` returns while it has nothing, kept the same between renders. */
export const NO_SEGMENTS: readonly SkipSegment[] = Object.freeze([]);

/**
 * How far the stream's length can move from the one the times were looked
 * up with, in seconds, before they're looked up again. The first length a
 * TS or HLS stream reports can be an estimate.
 */
export const LENGTH_DRIFT = 15;

/** The most lookups for one video, counting the ones tried again after a failure. */
export const MAX_LOOKUPS = 3;

/** How long to wait before trying a failed lookup again, in milliseconds. */
export const RETRY_MS = 30_000;

interface SkipSegmentsQuery {
	/** The IMDb ID of the movie or series, which comes from OMDb. */
	imdbId: string | null;
	contentType: Channel["contentType"] | undefined;
	season: number | undefined;
	episode: number | undefined;
	/** The stream playing. A new one, even of the same episode, may differ in length. */
	url: string | null;
	/** The stream's length in seconds, or 0 while it isn't known. */
	duration: number;
	/** False when skipping is off for every kind of segment, so nothing is looked up. */
	enabled: boolean;
}

export interface SkipSegmentsFound {
	/**
	 * Tells videos apart, so `useSegmentSkipping` knows when to start over.
	 * Null when there's nothing to look up.
	 */
	video: string | null;
	/** The parts that can be skipped, in order. */
	segments: readonly SkipSegment[];
}

/** One lookup for a video, kept to decide whether to look it up again. */
interface Lookup {
	video: string;
	/** The length it was looked up with. */
	duration: number;
	/** How many lookups the video has had, this one included. */
	count: number;
	/** When it may be tried again after failing, in epoch milliseconds, or null. */
	retryAt: number | null;
}

/**
 * The parts of the movie or episode playing that can be skipped. They're
 * looked up once the stream's length is known, and again when the length
 * moves by more than `LENGTH_DRIFT` or a lookup fails, up to `MAX_LOOKUPS`
 * times a video. Live channels, and episodes without a season and episode
 * number, have none.
 */
export const useSkipSegments = ({
	imdbId,
	contentType,
	season,
	episode,
	url,
	duration,
	enabled,
}: SkipSegmentsQuery): SkipSegmentsFound => {
	const [found, setFound] = useState<{ video: string; segments: SkipSegment[] } | null>(null);
	// Bumped when a failed lookup may be tried again.
	const [retry, setRetry] = useState(0);
	const lookupRef = useRef<Lookup | null>(null);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(retryTimerRef.current), []);

	const isEpisode = contentType === "series";
	const known = isEpisode
		? season !== undefined && episode !== undefined
		: contentType === "movie";
	const lookupSeason = isEpisode ? (season ?? null) : null;
	const lookupEpisode = isEpisode ? (episode ?? null) : null;
	const video =
		imdbId && url && known ? `${url}|${imdbId}|${lookupSeason}|${lookupEpisode}` : null;
	const ready = enabled && video !== null && duration > 0;

	useEffect(() => {
		if (!ready || video === null || imdbId === null) return;
		const last = lookupRef.current?.video === video ? lookupRef.current : null;
		if (last) {
			if (last.count >= MAX_LOOKUPS) return;
			const due =
				last.retryAt !== null
					? Date.now() >= last.retryAt
					: Math.abs(duration - last.duration) > LENGTH_DRIFT;
			if (!due) return;
		}
		const lookup: Lookup = { video, duration, count: (last?.count ?? 0) + 1, retryAt: null };
		lookupRef.current = lookup;
		getSkipSegments(imdbId, lookupSeason, lookupEpisode, duration)
			.then((segments) => {
				if (lookupRef.current !== lookup) return;
				setFound({ video, segments: [...segments].sort((a, b) => a.start - b.start) });
			})
			.catch((e) => {
				console.warn("[skip] looking up skip times failed:", e);
				if (lookupRef.current !== lookup) return;
				lookup.retryAt = Date.now() + RETRY_MS;
				clearTimeout(retryTimerRef.current);
				retryTimerRef.current = setTimeout(() => setRetry((n) => n + 1), RETRY_MS);
			});
		// The video covers every other input that changes the answer.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready, video, duration, retry]);

	return {
		video,
		segments: found !== null && found.video === video ? found.segments : NO_SEGMENTS,
	};
};
