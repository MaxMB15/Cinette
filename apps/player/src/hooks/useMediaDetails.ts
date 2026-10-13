// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { fetchOmdbData, fetchWhatsonData } from "@/lib/tauri";
import type { OmdbData, WhatsonData } from "@/lib/types";
import { useOmdbInfoState } from "@/hooks/useHasOmdbKey";

/** The movie or show to look up. */
export interface MediaDetailsRequest {
	/** The channel OMDb's answer is saved for. */
	id: string;
	/** The name OMDb searches for. */
	title: string;
	kind: "movie" | "series";
}

export interface MediaDetails {
	omdbData: OmdbData | null;
	whatsonData: WhatsonData | null;
	/** True until OMDb answers, or fails to. */
	loading: boolean;
}

type Loaded = MediaDetailsRequest & Omit<MediaDetails, "loading">;

const NOTHING: MediaDetails = { omdbData: null, whatsonData: null, loading: false };
const LOADING: MediaDetails = { ...NOTHING, loading: true };

/**
 * Loads OMDb's details for a movie or show, then Whatson's once OMDb gives an
 * IMDb id. Pass null to load nothing.
 *
 * What it returns always belongs to the request it was given. A new request
 * starts out loading and empty, never with the last one's details.
 */
export const useMediaDetails = (request: MediaDetailsRequest | null): MediaDetails => {
	const id = request?.id;
	const title = request?.title;
	const kind = request?.kind;
	const [loaded, setLoaded] = useState<Loaded | null>(null);

	useEffect(() => {
		if (id === undefined || title === undefined || kind === undefined) return;
		let current = true;
		const settle = (omdbData: OmdbData | null, whatsonData: WhatsonData | null) => {
			if (current) setLoaded({ id, title, kind, omdbData, whatsonData });
		};
		fetchOmdbData(id, title, kind)
			.then((omdbData) => {
				settle(omdbData, null);
				if (!current || !omdbData?.imdbId) return;
				fetchWhatsonData(omdbData.imdbId, kind === "series" ? "show" : "movie")
					.then((whatsonData) => settle(omdbData, whatsonData))
					.catch(() => {});
			})
			.catch(() => settle(null, null));
		return () => {
			current = false;
		};
	}, [id, title, kind]);

	if (!request) return NOTHING;
	if (!loaded || loaded.id !== id || loaded.title !== title || loaded.kind !== kind)
		return LOADING;
	return { omdbData: loaded.omdbData, whatsonData: loaded.whatsonData, loading: false };
};

/**
 * The details a movie or series sheet shows. The player hands over what it
 * already loaded, with `prefetchedOmdbData` left undefined until OMDb has
 * answered. Until then, or when opened from the channel list, the sheet
 * loads its own.
 */
export const useSheetDetails = (
	request: MediaDetailsRequest | null,
	prefetchedOmdbData: OmdbData | null | undefined,
	prefetchedWhatsonData: WhatsonData | null | undefined
) => {
	const prefetched = prefetchedOmdbData !== undefined;
	const own = useMediaDetails(prefetched ? null : request);
	const omdbData = prefetched ? prefetchedOmdbData : own.omdbData;
	const whatsonData = prefetched ? (prefetchedWhatsonData ?? null) : own.whatsonData;
	const { hasOmdbKey, infoLoading } = useOmdbInfoState(omdbData, own.loading);
	return { omdbData, whatsonData, omdbLoading: own.loading, hasOmdbKey, infoLoading };
};
