// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useMemo, useEffect } from "react";
import {
	X,
	Play,
	ChevronLeft,
	ChevronRight,
	MonitorPlay,
	LoaderCircle,
	Layers,
} from "lucide-react";
import type { Channel, OmdbData, WhatsonData, DownloadRecord } from "@/lib/types";
import {
	enqueueEpisodeDownload,
	enqueueEpisodesBatch,
	stopDownload,
	stopDownloads,
	removeDownload,
	removeDownloads,
	cacheSeriesEpisodes,
} from "@/lib/tauri";
import { RatingsRow } from "@/components/ui/ratings-row";
import { channelSources, withSource, describeSource } from "@/lib/sources";
import { dedupeEpisodes } from "@/lib/episodes";
import { formatCount } from "@/lib/format";
import { aggregateIconState, downloadIconState, isActiveDownload } from "@/lib/download-status";
import { useDownloads, aggregateForSeries } from "@/hooks/useDownloads";
import { useSheetDetails } from "@/hooks/useMediaDetails";
import { useSheetDrag } from "@/hooks/useSheetDrag";
import { DownloadButton } from "@/components/downloads/DownloadButton";
import { RetentionNote } from "@/components/downloads/RetentionNote";
import { ConfirmDialog } from "@/components/downloads/ConfirmDialog";
import { OmdbKeyHint } from "./OmdbKeyHint";

interface SeriesDetailDrawerProps {
	showTitle: string;
	episodes: Channel[];
	/** Series card channel id — used to group episode download records so the
	 *  card/drawer aggregate state stays consistent. */
	seriesChannelId: string;
	onClose: () => void;
	onPlay: (channel: Channel) => void;
	/** URL currently playing (when opened from the player), highlighted in the source list. */
	currentUrl?: string;
	// Optional pre-fetched data from PlayerView to avoid double-fetch
	prefetchedOmdbData?: OmdbData | null;
	prefetchedWhatsonData?: WhatsonData | null;
}

/** Whether an episode already has a download in flight or done (not re-enqueued). */
const isCovered = (r: DownloadRecord | undefined): boolean =>
	!!r && (r.status === "completed" || isActiveDownload(r));

/**
 * What the download button of a season or of the whole series shows and acts
 * on. `records` holds the download `groupDownloads` keeps for each episode
 * that has one.
 */
const episodeGroupDownloads = (eps: Channel[], downloads: Map<string, DownloadRecord>) => {
	const records = eps.map((e) => downloads.get(e.id)).filter((r): r is DownloadRecord => !!r);
	return {
		records,
		state: aggregateIconState(aggregateForSeries(records, eps.length)),
		missing: eps.filter((e) => !isCovered(downloads.get(e.id))),
		activeIds: records.filter(isActiveDownload).map((r) => r.id),
		completedIds: records.filter((r) => r.status === "completed").map((r) => r.id),
	};
};

const episodeTitle = (name: string): string => {
	const stripped = name.replace(/^.*?\bS\d{1,3}E\d{1,3}\s*/i, "").trim();
	return stripped || name;
};

type Step = "seasons" | "episodes" | "sources";

export const SeriesDetailModal = ({
	showTitle,
	episodes,
	seriesChannelId,
	onClose,
	onPlay,
	currentUrl,
	prefetchedOmdbData,
	prefetchedWhatsonData,
}: SeriesDetailDrawerProps) => {
	const [visible, setVisible] = useState(false);
	const [step, setStep] = useState<Step>("seasons");
	const [batchConfirm, setBatchConfirm] = useState<{
		count: number;
		onConfirm: () => void;
	} | null>(null);
	const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
	const [sourceEp, setSourceEp] = useState<Channel | null>(null);
	const firstEp = episodes[0];
	const { omdbData, whatsonData, omdbLoading, hasOmdbKey, infoLoading } = useSheetDetails(
		firstEp ? { id: firstEp.id, title: showTitle, kind: "series" } : null,
		prefetchedOmdbData,
		prefetchedWhatsonData
	);
	const showLogoUrl = firstEp?.logoUrl;

	useEffect(() => {
		const id = requestAnimationFrame(() => setVisible(true));
		return () => cancelAnimationFrame(id);
	}, []);

	const handleClose = () => {
		setVisible(false);
		setTimeout(onClose, 300);
	};
	const { sheetRef, handleProps } = useSheetDrag({ onClose: handleClose, enabled: visible });

	const { bySeries } = useDownloads();
	// Episode channelId → its download record, for this series.
	const episodeDownloadMap = useMemo(() => {
		const map = new Map<string, DownloadRecord>();
		for (const rec of bySeries.get(seriesChannelId) ?? []) {
			map.set(rec.channelId, rec);
		}
		return map;
	}, [bySeries, seriesChannelId]);

	// Persist the full episode list so the selector works offline once any
	// episode of this series has been downloaded.
	const persistEpisodeList = () => {
		void cacheSeriesEpisodes(seriesChannelId, episodes);
	};

	/** Enqueue a batch, prompting first when it's large (≥10 episodes). */
	const startBatch = (missing: Channel[]) => {
		if (missing.length === 0) return;
		const run = () => {
			persistEpisodeList();
			void enqueueEpisodesBatch(missing, seriesChannelId, showTitle);
		};
		if (missing.length >= 10) {
			setBatchConfirm({
				count: missing.length,
				onConfirm: () => {
					setBatchConfirm(null);
					run();
				},
			});
		} else {
			run();
		}
	};

	const deduped = useMemo(() => dedupeEpisodes(episodes), [episodes]);

	const seasons = useMemo(() => {
		const map = new Map<number, Channel[]>();
		for (const ep of deduped) {
			const s = ep.season ?? 0;
			if (!map.has(s)) map.set(s, []);
			map.get(s)!.push(ep);
		}
		for (const [, eps] of map) {
			eps.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
		}
		return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
	}, [deduped]);

	const currentEpisodes = useMemo(
		() =>
			selectedSeason !== null ? (seasons.find(([s]) => s === selectedSeason)?.[1] ?? []) : [],
		[seasons, selectedSeason]
	);

	// The header's download control covers the whole series.
	const series = episodeGroupDownloads(deduped, episodeDownloadMap);

	const handleSeasonClick = (season: number) => {
		setSelectedSeason(season);
		setStep("episodes");
	};

	// Clicking an episode plays its default source; other sources are picked
	// via the episode's "sources" button (or the player's source menu).
	const handleEpisodeClick = (ep: Channel) => {
		onPlay(ep);
		handleClose();
	};

	const handleShowSources = (ep: Channel) => {
		setSourceEp(ep);
		setStep("sources");
	};

	const handleBack = () => {
		if (step === "sources") {
			setSourceEp(null);
			setStep("episodes");
		} else if (step === "episodes") {
			setStep("seasons");
		}
	};

	const handleSourcePick = (channel: Channel) => {
		onPlay(channel);
		handleClose();
	};

	const backLabel =
		step === "episodes"
			? showTitle
			: step === "sources"
				? selectedSeason === 0
					? "Unknown Season"
					: `Season ${selectedSeason}`
				: "";

	// Derived display values
	const posterSrc =
		whatsonData?.image ??
		(omdbData?.posterUrl && omdbData.posterUrl !== "N/A"
			? omdbData.posterUrl
			: (showLogoUrl ?? null));

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
	const genreRuntime = [genre, runtime ? `${runtime}/ep` : null].filter(Boolean).join(" · ");

	return (
		<div className="fixed inset-0 z-50">
			{/* Backdrop */}
			<div
				className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
					visible ? "opacity-100" : "opacity-0"
				}`}
				onClick={handleClose}
			/>

			{/* Drawer */}
			<div
				ref={sheetRef}
				className={`absolute bottom-0 left-0 right-0 bg-card rounded-t-2xl shadow-2xl flex flex-col transition-[transform,max-height] duration-300 ease-out motion-reduce:transition-none ${
					visible ? "translate-y-0" : "translate-y-full"
				}`}
			>
				{/* Handle */}
				<div
					{...handleProps}
					className="flex justify-center pt-3 pb-1 shrink-0 select-none"
				>
					<div className="w-9 h-1 rounded-full bg-border" />
				</div>

				{/* Header row */}
				<div
					{...handleProps}
					className="flex items-center justify-between px-5 py-2 shrink-0 select-none"
				>
					{step !== "seasons" ? (
						<button
							onClick={handleBack}
							className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
						>
							<ChevronLeft className="h-4 w-4" />
							{backLabel}
						</button>
					) : (
						<div className="flex-1 flex items-center gap-3">
							<DownloadButton
								showLabel
								state={series.state}
								onStart={() => startBatch(series.missing)}
								onStop={() => void stopDownloads(series.activeIds)}
								stopCount={series.activeIds.length}
								onRemove={() => removeDownloads(series.completedIds)}
								removeSummary={formatCount(series.completedIds.length, "episode")}
								className="text-sm text-muted-foreground hover:text-foreground"
							/>
							<RetentionNote records={series.records} compact />
						</div>
					)}
					<button
						onClick={handleClose}
						aria-label="Close"
						className="shrink-0 text-muted-foreground hover:text-foreground transition-colors ml-3"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* Info card — seasons step only */}
				{step === "seasons" && (
					<>
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
									<MonitorPlay className="h-8 w-8 text-muted-foreground/30" />
								)}
							</div>

							{/* Show info — ~65% of remaining space */}
							<div className="flex flex-col justify-center gap-1.5 flex-[2] min-w-0">
								{infoLoading ? (
									<div className="flex items-center gap-2 text-muted-foreground">
										<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
										<span className="text-xs">Loading info…</span>
									</div>
								) : (
									<>
										{/* Title + year + rated */}
										<div className="flex items-baseline gap-1.5 flex-wrap">
											<p className="text-base font-semibold leading-tight line-clamp-2">
												{showTitle}
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
											<p className="text-xs text-muted-foreground">
												{genreRuntime}
											</p>
										)}

										{/* Director / Created by */}
										{director && (
											<p className="text-xs text-muted-foreground truncate">
												Created by: {director}
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
												<p className="text-xs text-muted-foreground">
													Series · —
												</p>
											) : (
												<OmdbKeyHint onNavigate={onClose} />
											))}
									</>
								)}
							</div>

							{/* Season/episode stats — ~35% of remaining space */}
							<div className="flex flex-col justify-center gap-2.5 flex-[1] min-w-0 shrink-0">
								<div className="flex flex-col gap-1.5">
									<div className="flex flex-col items-center justify-center rounded-xl bg-secondary px-3 py-2.5 text-center">
										<span className="text-base font-bold tabular-nums leading-none">
											{seasons.length}
										</span>
										<span className="text-[11px] text-muted-foreground mt-0.5">
											{seasons.length === 1 ? "Season" : "Seasons"}
										</span>
									</div>
									<div className="flex flex-col items-center justify-center rounded-xl bg-secondary px-3 py-2.5 text-center">
										<span className="text-base font-bold tabular-nums leading-none">
											{deduped.length}
										</span>
										<span className="text-[11px] text-muted-foreground mt-0.5">
											{deduped.length === 1 ? "Episode" : "Episodes"}
										</span>
									</div>
								</div>
							</div>
						</div>

						{/* Plot — shown below the main row when available */}
						{plot && !omdbLoading && (
							<div className="px-5 pb-3 shrink-0">
								<p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
									{plot}
								</p>
							</div>
						)}

						<div className="border-t border-border mx-5 shrink-0" />
					</>
				)}

				{/* Step: Seasons */}
				{step === "seasons" && (
					<div className="overflow-y-auto overscroll-y-none flex-1 px-3 py-2">
						{seasons.map(([s, eps]) => {
							const season = episodeGroupDownloads(eps, episodeDownloadMap);
							return (
								<div
									key={s}
									className="w-full flex items-center gap-3 px-3 rounded-xl hover:bg-accent transition-colors"
								>
									<button
										onClick={() => handleSeasonClick(s)}
										className="flex-1 flex items-center gap-3 py-3 text-left min-w-0"
									>
										<div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
											<span className="text-[10px] font-bold text-muted-foreground">
												{s === 0 ? "?" : String(s)}
											</span>
										</div>
										<div className="flex-1 min-w-0">
											<p className="text-sm font-medium">
												{s === 0 ? "Unknown Season" : `Season ${s}`}
											</p>
											<p className="text-xs text-muted-foreground mt-0.5">
												{formatCount(eps.length, "episode")}
											</p>
										</div>
										<ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
									</button>
									<DownloadButton
										state={season.state}
										onStart={() => startBatch(season.missing)}
										onStop={() => void stopDownloads(season.activeIds)}
										stopCount={season.activeIds.length}
										onRemove={() => removeDownloads(season.completedIds)}
										removeSummary={formatCount(
											season.completedIds.length,
											"episode"
										)}
										className="shrink-0 h-8 w-8 justify-center rounded-md hover:bg-accent"
									/>
								</div>
							);
						})}
						{seasons.length === 0 && (
							<p className="text-sm text-muted-foreground text-center py-8">
								No episodes found
							</p>
						)}
					</div>
				)}

				{/* Step: Episodes */}
				{step === "episodes" && (
					<div className="overflow-y-auto overscroll-y-none flex-1 px-3 py-2">
						{currentEpisodes.map((ep) => {
							const sourceCount = channelSources(ep).length;
							const epDl = episodeDownloadMap.get(ep.id);
							const epState = downloadIconState(epDl);
							return (
								<div
									key={ep.id}
									className="flex items-center gap-1 pr-2 rounded-xl hover:bg-accent transition-colors"
								>
									<button
										onClick={() => handleEpisodeClick(ep)}
										className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 text-left"
									>
										<div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
											<span className="text-[10px] font-bold text-muted-foreground">
												{ep.episode != null
													? String(ep.episode).padStart(2, "0")
													: "?"}
											</span>
										</div>
										<div className="flex-1 min-w-0">
											<p className="text-sm truncate">
												{episodeTitle(ep.name)}
											</p>
										</div>
										{sourceCount <= 1 && (
											<Play className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
										)}
									</button>
									{sourceCount > 1 && (
										<button
											onClick={() => handleShowSources(ep)}
											title="Choose source"
											aria-label={`Choose from ${sourceCount} sources`}
											className="flex items-center gap-1 px-2 py-1 rounded-full bg-secondary/80 hover:bg-secondary text-[10px] font-medium text-muted-foreground hover:text-foreground shrink-0 transition-colors"
										>
											<Layers className="h-3 w-3" />
											{sourceCount} sources
											<ChevronRight className="h-3 w-3" />
										</button>
									)}
									{epDl && (
										<RetentionNote
											records={[epDl]}
											compact
											className="shrink-0 px-1"
										/>
									)}
									<DownloadButton
										state={epState}
										onStart={() => {
											persistEpisodeList();
											void enqueueEpisodeDownload(
												ep,
												seriesChannelId,
												showTitle
											);
										}}
										onStop={() => epDl && void stopDownload(epDl.id)}
										onRemove={() => epDl && removeDownload(epDl.id)}
										className="shrink-0 h-8 w-8 justify-center rounded-md hover:bg-accent"
									/>
								</div>
							);
						})}
						{currentEpisodes.length === 0 && (
							<p className="text-sm text-muted-foreground text-center py-8">
								No episodes
							</p>
						)}
					</div>
				)}

				{/* Step: Sources */}
				{step === "sources" && sourceEp && (
					<div className="flex flex-col flex-1 overflow-hidden">
						<div className="px-5 pb-3 shrink-0">
							<p className="text-sm font-semibold truncate">
								{episodeTitle(sourceEp.name)}
							</p>
							<p className="text-xs text-muted-foreground mt-0.5">
								Choose a source to play
							</p>
						</div>
						<div className="border-t border-border mx-4 shrink-0" />
						<div className="overflow-y-auto overscroll-y-none flex-1 py-2 px-3">
							{channelSources(sourceEp).map((src, idx) => {
								const detail = describeSource(src);
								return (
									<button
										key={src}
										className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-accent transition-colors text-left"
										onClick={() =>
											handleSourcePick(
												src === sourceEp.url
													? sourceEp
													: withSource(sourceEp, src)
											)
										}
									>
										<div
											className={
												idx === 0
													? "w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"
													: "w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0"
											}
										>
											<Play
												className={
													idx === 0
														? "h-3.5 w-3.5 text-primary ml-0.5"
														: "h-3.5 w-3.5 text-muted-foreground ml-0.5"
												}
											/>
										</div>
										<div className="flex-1 min-w-0">
											<p className="text-sm font-medium">Source {idx + 1}</p>
											<p className="text-xs text-muted-foreground truncate">
												{[
													idx === 0 ? "Default" : null,
													src === currentUrl ? "Playing" : null,
													detail,
												]
													.filter(Boolean)
													.join(" · ")}
											</p>
										</div>
										<ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
									</button>
								);
							})}
						</div>
					</div>
				)}

				<div className="shrink-0 pb-2" />
			</div>

			<ConfirmDialog
				open={batchConfirm !== null}
				title="Download episodes?"
				message={`Download ${batchConfirm?.count ?? 0} episodes? This may use significant disk space and bandwidth.`}
				confirmLabel="Download"
				onConfirm={() => batchConfirm?.onConfirm()}
				onCancel={() => setBatchConfirm(null)}
			/>
		</div>
	);
};
