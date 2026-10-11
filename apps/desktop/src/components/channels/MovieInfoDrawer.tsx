// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect } from "react";
import { X, Play, Clapperboard, Loader2 } from "lucide-react";
import { Select } from "@/components/ui/select";
import type { Channel, OmdbData, WhatsonData } from "@/lib/types";
import {
	fetchOmdbData,
	fetchWhatsonData,
	enqueueMovieDownload,
	stopDownload,
	removeDownload,
} from "@/lib/tauri";
import { channelSources, withSource, describeSource } from "@/lib/sources";
import { RatingsRow } from "@/components/ui/ratings-row";
import { useDownloads } from "@/hooks/useDownloads";
import { useHasOmdbKey } from "@/hooks/useHasOmdbKey";
import { DownloadButton, type DownloadIconState } from "@/components/downloads/DownloadButton";
import { OmdbKeyHint } from "./OmdbKeyHint";

interface MovieInfoDrawerProps {
	movie: Channel;
	onClose: () => void;
	onPlay: (ch: Channel) => void;
	// Optional pre-fetched data from PlayerView to avoid double-fetch
	prefetchedOmdbData?: OmdbData | null;
	prefetchedWhatsonData?: WhatsonData | null;
}

export const MovieInfoDrawer = ({
	movie,
	onClose,
	onPlay,
	prefetchedOmdbData,
	prefetchedWhatsonData,
}: MovieInfoDrawerProps) => {
	const [visible, setVisible] = useState(false);
	// Pre-select the source currently in use (the player opens this drawer for the playing movie).
	const [selectedSourceIdx, setSelectedSourceIdx] = useState(() =>
		Math.max(0, channelSources(movie).indexOf(movie.url))
	);
	const [omdbData, setOmdbData] = useState<OmdbData | null>(prefetchedOmdbData ?? null);
	const [omdbLoading, setOmdbLoading] = useState(prefetchedOmdbData === undefined);
	const [whatsonData, setWhatsonData] = useState<WhatsonData | null>(
		prefetchedWhatsonData ?? null
	);
	const hasOmdbKey = useHasOmdbKey();
	// Without OMDb data, wait for the key check too, so the hint doesn't flash.
	const infoLoading = omdbLoading || (!omdbData && hasOmdbKey === null);

	useEffect(() => {
		const id = requestAnimationFrame(() => setVisible(true));
		return () => cancelAnimationFrame(id);
	}, []);

	// Sync when prefetched Whatson data arrives after drawer opens
	useEffect(() => {
		if (prefetchedWhatsonData !== undefined) {
			setWhatsonData(prefetchedWhatsonData ?? null);
		}
	}, [prefetchedWhatsonData]);

	useEffect(() => {
		if (prefetchedOmdbData !== undefined) return;
		if (!movie) return;
		setOmdbLoading(true);
		setOmdbData(null);
		setWhatsonData(null);
		fetchOmdbData(movie.id, movie.name, "movie")
			.then((data) => {
				setOmdbData(data);
				// Also fetch Whatson if we got an imdb_id
				if (data?.imdbId) {
					const mediaType = movie.contentType === "series" ? "show" : "movie";
					fetchWhatsonData(data.imdbId, mediaType)
						.then(setWhatsonData)
						.catch(() => {});
				}
			})
			.catch(() => {})
			.finally(() => setOmdbLoading(false));
	}, [movie, prefetchedOmdbData]);

	const { byChannel } = useDownloads();
	const dl = byChannel.get(movie.id);
	const downloadState: DownloadIconState =
		dl?.status === "completed"
			? "complete"
			: dl?.status === "downloading" || dl?.status === "queued"
				? "downloading"
				: dl?.status === "failed"
					? "failed"
					: "idle";

	const handleClose = () => {
		setVisible(false);
		setTimeout(onClose, 300);
	};

	const allSources = channelSources(movie);
	const hasSources = allSources.length > 1;

	const sourceOptions = allSources.map((url, idx) => {
		const detail = describeSource(url);
		const label = idx === 0 ? "Source 1 (default)" : `Source ${idx + 1}`;
		return { value: idx, label: detail ? `${label} · ${detail}` : label };
	});

	const handlePlay = () => {
		const url = allSources[selectedSourceIdx] ?? movie.url;
		onPlay(url === movie.url ? movie : withSource(movie, url));
		handleClose();
	};

	// Derived display values
	const posterSrc =
		whatsonData?.image ??
		(omdbData?.posterUrl && omdbData.posterUrl !== "N/A"
			? omdbData.posterUrl
			: (movie.logoUrl ?? null));

	const year = omdbData?.year && omdbData.year !== "N/A" ? omdbData.year : null;
	const rated =
		whatsonData?.certification ??
		(omdbData?.rated && omdbData.rated !== "N/A" ? omdbData.rated : null);
	const genre = omdbData?.genre && omdbData.genre !== "N/A" ? omdbData.genre : null;
	const runtime = omdbData?.runtime && omdbData.runtime !== "N/A" ? omdbData.runtime : null;
	const director = omdbData?.director && omdbData.director !== "N/A" ? omdbData.director : null;
	const actors = omdbData?.actors && omdbData.actors !== "N/A" ? omdbData.actors : null;
	const plot =
		(omdbData?.plot && omdbData.plot !== "N/A" ? omdbData.plot : null) ??
		whatsonData?.tagline ??
		null;

	const truncatedActors = actors && actors.length > 60 ? actors.slice(0, 57) + "..." : actors;

	const genreRuntime = [genre, runtime].filter(Boolean).join(" · ");

	return (
		<div className="fixed inset-0 z-50">
			<div
				className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
					visible ? "opacity-100" : "opacity-0"
				}`}
				onClick={handleClose}
			/>
			<div
				className={`absolute bottom-0 left-0 right-0 bg-card rounded-t-2xl shadow-2xl flex flex-col transition-transform duration-300 ease-out max-h-[85vh] overflow-hidden ${
					visible ? "translate-y-0" : "translate-y-full"
				}`}
			>
				{/* Handle */}
				<div className="flex justify-center pt-3 pb-1 shrink-0">
					<div className="w-9 h-1 rounded-full bg-border" />
				</div>

				{/* Close button */}
				<div className="flex justify-end px-5 pt-1 shrink-0">
					<button
						onClick={handleClose}
						aria-label="Close"
						className="text-muted-foreground hover:text-foreground transition-colors"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* Side-by-side: movie info (left ~65%) + controls (right ~35%) */}
				<div className="flex gap-4 px-5 pb-4 shrink-0">
					{/* Poster */}
					<div className="w-20 h-28 rounded-xl bg-secondary overflow-hidden shrink-0 flex items-center justify-center">
						{posterSrc ? (
							<img
								src={posterSrc}
								alt=""
								className="h-full w-full object-cover"
								loading="lazy"
							/>
						) : (
							<Clapperboard className="h-8 w-8 text-muted-foreground/30" />
						)}
					</div>

					{/* Movie info */}
					<div className="flex flex-col justify-center gap-1.5 flex-[2] min-w-0">
						{infoLoading ? (
							<div className="flex items-center gap-2 text-muted-foreground">
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
								<span className="text-xs">Loading info…</span>
							</div>
						) : (
							<>
								{/* Title + year + rated */}
								<div className="flex items-baseline gap-1.5 flex-wrap">
									<p className="text-base font-semibold leading-tight line-clamp-2">
										{movie.name}
									</p>
									{year && (
										<span className="text-xs text-muted-foreground shrink-0">
											({year})
										</span>
									)}
									{rated && (
										<span className="text-[11px] font-semibold bg-secondary text-muted-foreground px-1.5 py-0.5 rounded shrink-0">
											{rated}
										</span>
									)}
								</div>

								{/* Ratings row */}
								<RatingsRow omdbData={omdbData} whatsonData={whatsonData} />

								{/* Genre + runtime */}
								{genreRuntime && (
									<p className="text-xs text-muted-foreground">{genreRuntime}</p>
								)}

								{/* Director */}
								{director && (
									<p className="text-xs text-muted-foreground truncate">
										Dir: {director}
									</p>
								)}

								{/* Cast */}
								{truncatedActors && (
									<p className="text-xs text-muted-foreground">
										Cast: {truncatedActors}
									</p>
								)}

								{/* Fallback: no OMDB data */}
								{!omdbData &&
									(hasOmdbKey ? (
										<p className="text-xs text-muted-foreground">— · —</p>
									) : (
										<OmdbKeyHint onNavigate={onClose} />
									))}
							</>
						)}
					</div>

					{/* Controls */}
					<div className="flex flex-col justify-center gap-2.5 flex-[1] min-w-0 shrink-0">
						{hasSources && (
							<Select
								value={selectedSourceIdx}
								onChange={setSelectedSourceIdx}
								options={sourceOptions}
								aria-label="Select source"
							/>
						)}
						<button
							onClick={handlePlay}
							className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-xl py-2.5 text-sm font-semibold hover:bg-primary/90 active:bg-primary/80 transition-colors"
						>
							<Play className="h-4 w-4 ml-0.5" />
							Play
						</button>
						{movie.contentType !== "series" && (
							<DownloadButton
								showLabel
								state={downloadState}
								onStart={() => void enqueueMovieDownload(movie.id)}
								onStop={() => dl && void stopDownload(dl.id)}
								onRemove={() => dl && void removeDownload(dl.id)}
								className="w-full justify-center rounded-xl border border-border py-2.5 text-sm font-semibold hover:bg-accent"
							/>
						)}
					</div>
				</div>

				{/* Plot — shown below the main row when available */}
				{plot && !omdbLoading && (
					<div className="px-5 pb-4 shrink-0">
						<div className="border-t border-border mb-3" />
						<p className="text-xs text-muted-foreground leading-relaxed">{plot}</p>
					</div>
				)}

				<div className="shrink-0 pb-2" />
			</div>
		</div>
	);
};
