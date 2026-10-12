// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState } from "react";
import { getSkipSegments } from "@/lib/tauri";
import type { Channel, SkipSegment } from "@/lib/types";

/** What `useSkipSegments` returns while it has nothing, kept the same between renders. */
export const NO_SEGMENTS: readonly SkipSegment[] = Object.freeze([]);

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

/**
 * The parts of the movie or episode playing that can be skipped, in order.
 * They're looked up once the stream's length is known, and again only for a
 * new stream. Live channels, and episodes without a season and episode
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
}: SkipSegmentsQuery): readonly SkipSegment[] => {
	const [found, setFound] = useState<{ key: string; segments: SkipSegment[] } | null>(null);
	// The length is only read when the lookup starts, so the small changes
	// some streams report while playing don't look the times up again.
	const durationRef = useRef(duration);
	durationRef.current = duration;

	const isEpisode = contentType === "series";
	const known = isEpisode
		? season !== undefined && episode !== undefined
		: contentType === "movie";
	const key =
		enabled && imdbId && url && duration > 0 && known
			? `${url}|${imdbId}|${season}|${episode}`
			: null;

	useEffect(() => {
		if (key === null || imdbId === null) return;
		let cancelled = false;
		getSkipSegments(
			imdbId,
			isEpisode ? (season ?? null) : null,
			isEpisode ? (episode ?? null) : null,
			durationRef.current
		)
			.then((segments) => {
				if (cancelled) return;
				setFound({ key, segments: [...segments].sort((a, b) => a.start - b.start) });
			})
			.catch((e) => console.warn("[skip] looking up skip times failed:", e));
		return () => {
			cancelled = true;
		};
		// The key covers every input that changes the answer.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);

	return found !== null && found.key === key ? found.segments : NO_SEGMENTS;
};
