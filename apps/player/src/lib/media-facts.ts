// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { OmdbData, WhatsonData } from "./types";

/** OMDb says N/A for what it doesn't know. */
const known = (value: string | null | undefined): string | null =>
	value && value !== "N/A" ? value : null;

/** What the detail screens show of a movie or show, from whichever service has it. */
export const mediaFacts = (
	omdb: OmdbData | null | undefined,
	whatson: WhatsonData | null | undefined,
	logoUrl: string | null | undefined
) => ({
	poster: whatson?.image ?? known(omdb?.posterUrl) ?? logoUrl ?? null,
	year: known(omdb?.year),
	rated: whatson?.certification ?? known(omdb?.rated),
	genre: known(omdb?.genre),
	runtime: known(omdb?.runtime),
	director: known(omdb?.director),
	actors: known(omdb?.actors),
	plot: known(omdb?.plot) ?? whatson?.tagline ?? null,
});
