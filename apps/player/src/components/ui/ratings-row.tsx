// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Star } from "lucide-react";
import type { OmdbData, WhatsonData } from "@/lib/types";

interface RatingsRowProps {
	omdbData?: OmdbData | null;
	whatsonData?: WhatsonData | null;
}

const formatVotes = (n: number): string => {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return n.toString();
};

export const RatingsRow = ({ omdbData, whatsonData }: RatingsRowProps) => {
	// Priority: use Whatson data when available, fall back to OMDB
	const rawOmdbRating = omdbData?.imdbRating;
	const omdbRatingClean = rawOmdbRating && rawOmdbRating !== "N/A" ? rawOmdbRating : null;
	const imdbRating =
		whatsonData?.imdbRating != null ? whatsonData.imdbRating.toFixed(1) : omdbRatingClean;
	const imdbVotes = whatsonData?.imdbVotes ?? null;
	const rtCritic = whatsonData?.rtCriticsRating ?? null;
	// When Whatson has no RT score, fall back to OMDB's rottenTomatoes string
	const rtCriticFallback =
		rtCritic === null && omdbData?.rottenTomatoes && omdbData.rottenTomatoes !== "N/A"
			? omdbData.rottenTomatoes
			: null;
	const rtAudience = whatsonData?.rtAudienceRating ?? null;
	const rtAudienceCount = whatsonData?.rtAudienceCount ?? null;
	const rtCriticCount = whatsonData?.rtCriticsCount ?? null;

	const hasAny = imdbRating || rtCritic !== null || rtCriticFallback || rtAudience !== null;
	if (!hasAny) return null;

	return (
		<div className="flex items-center gap-1.5 flex-wrap">
			{imdbRating && (
				<span className="flex items-center gap-1 text-[11px] font-semibold bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 px-2 py-0.5 rounded-full">
					<Star className="h-2.5 w-2.5" />
					{imdbRating}
					{!!imdbVotes && (
						<span className="font-normal opacity-70">· {formatVotes(imdbVotes)}</span>
					)}
				</span>
			)}
			{rtCritic !== null && (
				<span className="text-[11px] font-semibold bg-red-500/15 text-red-500 px-2 py-0.5 rounded-full">
					🍅 {rtCritic}%
					{!!rtCriticCount && (
						<span className="font-normal opacity-70">
							{" "}
							· {formatVotes(rtCriticCount)}
						</span>
					)}
				</span>
			)}
			{rtCriticFallback && (
				<span className="text-[11px] font-semibold bg-red-500/15 text-red-500 px-2 py-0.5 rounded-full">
					🍅 {rtCriticFallback}
				</span>
			)}
			{rtAudience !== null && (
				<span className="text-[11px] font-semibold bg-orange-500/15 text-orange-500 px-2 py-0.5 rounded-full">
					🍿 {rtAudience}%
					{!!rtAudienceCount && (
						<span className="font-normal opacity-70">
							{" "}
							· {formatVotes(rtAudienceCount)}
						</span>
					)}
				</span>
			)}
		</div>
	);
};
