// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { createContext, useContext, useEffect, useCallback, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { isActiveDownload } from "@/lib/download-status";
import { setDownloadRetention } from "@/lib/tauri";
import { downloadRetentionQuery, downloadsQuery } from "@/lib/queries";
import type { DownloadRecord, AggregateDownloadState } from "@/lib/types";

/** Pure: compute a series card's aggregate state from its episode downloads. */
export const aggregateForSeries = (
	episodeDownloads: DownloadRecord[],
	totalEpisodes: number
): AggregateDownloadState => {
	if (episodeDownloads.length === 0) return "none";
	if (episodeDownloads.some(isActiveDownload)) return "downloading";
	const completed = episodeDownloads.filter((d) => d.status === "completed").length;
	if (completed === 0) return "none";
	if (totalEpisodes > 0 && completed >= totalEpisodes) return "complete";
	return "partial";
};

/**
 * Pure: should `candidate` replace `current` as the representative record for a
 * channel? A completed record always wins; otherwise the most recent attempt
 * does, so a retry supersedes an earlier failed/cancelled record.
 */
export const supersedes = (candidate: DownloadRecord, current: DownloadRecord): boolean =>
	candidate.status === "completed" ||
	(current.status !== "completed" && candidate.createdAt >= current.createdAt);

/**
 * Pure: collapse the flat download list into per-channel and per-series views,
 * keeping a single representative record per channel (see {@link supersedes}).
 * `byChannel` therefore counts movies + individual episodes (never the series
 * container), and each `bySeries` array holds one record per episode.
 */
export const groupDownloads = (
	downloads: DownloadRecord[]
): {
	byChannel: Map<string, DownloadRecord>;
	bySeries: Map<string, DownloadRecord[]>;
} => {
	const byChannel = new Map<string, DownloadRecord>();
	const bySeriesByChannel = new Map<string, Map<string, DownloadRecord>>();
	for (const d of downloads) {
		const existing = byChannel.get(d.channelId);
		if (!existing || supersedes(d, existing)) byChannel.set(d.channelId, d);
		if (d.seriesChannelId) {
			let inner = bySeriesByChannel.get(d.seriesChannelId);
			if (!inner) {
				inner = new Map<string, DownloadRecord>();
				bySeriesByChannel.set(d.seriesChannelId, inner);
			}
			const prev = inner.get(d.channelId);
			if (!prev || supersedes(d, prev)) inner.set(d.channelId, d);
		}
	}
	const bySeries = new Map<string, DownloadRecord[]>();
	for (const [seriesId, inner] of bySeriesByChannel) {
		bySeries.set(seriesId, Array.from(inner.values()));
	}
	return { byChannel, bySeries };
};

interface DownloadsContextValue {
	downloads: DownloadRecord[];
	byChannel: Map<string, DownloadRecord>;
	bySeries: Map<string, DownloadRecord[]>;
	refresh: () => Promise<void>;
	/** Days finished downloads are kept, or null to keep them until removed. */
	retentionDays: number | null;
	/** Saves the setting. Resolves to how many downloads it deleted right away. */
	setRetentionDays: (days: number | null) => Promise<number>;
}

const DownloadsContext = createContext<DownloadsContextValue | null>(null);

const NO_DOWNLOADS: DownloadRecord[] = [];

export const DownloadsProvider = ({ children }: { children: ReactNode }) => {
	const queryClient = useQueryClient();
	const downloads = useQuery(downloadsQuery()).data ?? NO_DOWNLOADS;
	// A setting that can't be read counts as keeping downloads until removed.
	const retentionDays = useQuery(downloadRetentionQuery()).data ?? null;

	const refresh = useCallback(
		async () => {
			// It rejects when the list can't load, as listDownloads did.
			await queryClient.refetchQueries(
				{ queryKey: downloadsQuery().queryKey },
				{ throwOnError: true }
			);
		},
		// Stryker disable next-line ArrayDeclaration: the query client stays the same object while the provider is mounted, so an empty list gives the same callback.
		[queryClient]
	);

	const setRetentionDays = useCallback(
		async (days: number | null) => {
			const deleted = await setDownloadRetention(days);
			queryClient.setQueryData(downloadRetentionQuery().queryKey, days);
			return deleted;
		},
		// Stryker disable next-line ArrayDeclaration: the query client stays the same object while the provider is mounted, so an empty list gives the same callback.
		[queryClient]
	);

	useEffect(
		() => {
			const key = downloadsQuery().queryKey;
			const unlistenProgress = listen<DownloadRecord>("download://progress", (e) => {
				queryClient.setQueryData(key, (prev = NO_DOWNLOADS) => {
					const next = prev.filter((d) => d.id !== e.payload.id);
					next.push(e.payload);
					return next;
				});
			});
			// Sent when a download is removed, by the user or the retention setting.
			const unlistenRemoved = listen<string>("download://removed", (e) => {
				queryClient.setQueryData(key, (prev = NO_DOWNLOADS) =>
					prev.filter((d) => d.id !== e.payload)
				);
			});
			return () => {
				unlistenProgress.then((f) => f());
				unlistenRemoved.then((f) => f());
			};
		},
		// Stryker disable next-line ArrayDeclaration: the query client stays the same object while the provider is mounted, so the effect runs once either way.
		[queryClient]
	);

	const { byChannel, bySeries } = groupDownloads(downloads);

	return (
		<DownloadsContext.Provider
			value={{ downloads, byChannel, bySeries, refresh, retentionDays, setRetentionDays }}
		>
			{children}
		</DownloadsContext.Provider>
	);
};

export const useDownloads = (): DownloadsContextValue => {
	const ctx = useContext(DownloadsContext);
	if (!ctx) throw new Error("useDownloads must be used within DownloadsProvider");
	return ctx;
};
