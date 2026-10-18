// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useMemo } from "react";
import { X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { clearWatchHistoryOfType, deleteHistoryEntry, deleteHistorySeries } from "@/lib/tauri";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import type { WatchHistoryEntry } from "@/lib/types";

/** How many of the newest entries of its type the row shows. */
const ROW_LIMIT = 50;

interface RecentlyPlayedRowProps {
	contentType: "live" | "movie" | "series";
	onPlay: (entry: WatchHistoryEntry) => void;
}

interface DisplayEntry {
	key: string;
	displayName: string;
	/** The newest entry, which the card plays. */
	entry: WatchHistoryEntry;
	/** Set on a series card, which stands for every episode of the show. */
	seriesTitle?: string;
}

const showOf = (entry: WatchHistoryEntry): string => entry.seriesTitle ?? entry.channelName;

export const RecentlyPlayedRow = ({ contentType, onPlay }: RecentlyPlayedRowProps) => {
	const { entries, change } = useWatchHistory(
		ROW_LIMIT,
		contentType,
		"[RecentlyPlayedRow] failed to load watch history:"
	);

	// Series show one card per show, for its most recent episode.
	const displayEntries = useMemo((): DisplayEntry[] => {
		if (contentType !== "series") {
			return entries.map((e) => ({ key: e.channelId, displayName: e.channelName, entry: e }));
		}
		const byShow = new Map<string, DisplayEntry>();
		for (const entry of entries) {
			const show = showOf(entry);
			if (!byShow.has(show)) {
				byShow.set(show, { key: show, displayName: show, entry, seriesTitle: show });
			}
		}
		return [...byShow.values()];
	}, [entries, contentType]);

	// The deletes run in the backend, so they reach entries older than the
	// ones loaded here. A card whose delete fails stays, matching a reload.
	const dismiss = async ({ entry, seriesTitle }: DisplayEntry) => {
		try {
			if (seriesTitle === undefined) {
				await deleteHistoryEntry(entry.channelId);
				change((prev) => prev.filter((e) => e.channelId !== entry.channelId));
			} else {
				await deleteHistorySeries(seriesTitle);
				change((prev) => prev.filter((e) => showOf(e) !== seriesTitle));
			}
		} catch (err) {
			console.error("[RecentlyPlayedRow] failed to delete history:", err);
		}
	};

	const handleClearAll = async () => {
		try {
			await clearWatchHistoryOfType(contentType);
			change(() => []);
		} catch (err) {
			console.error("[RecentlyPlayedRow] failed to clear history:", err);
		}
	};

	if (displayEntries.length === 0) return null;

	return (
		<div className="px-4 pt-3 pb-1">
			<div className="flex items-center justify-between mb-2">
				<span className="text-sm font-semibold text-muted-foreground">Recently Played</span>
				<button
					onClick={() => void handleClearAll()}
					className="text-[10px] text-primary hover:underline"
				>
					Clear all
				</button>
			</div>
			<ScrollArea className="w-full">
				<div className="flex gap-2.5 pb-2">
					{displayEntries.map((card) => (
						<div
							key={card.key}
							className="relative min-w-[160px] max-w-[180px] bg-secondary rounded-lg p-2.5 text-left hover:bg-accent transition-colors group shrink-0"
						>
							<button
								className="absolute top-1 right-1.5 z-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 transition-opacity p-0.5"
								onClick={() => void dismiss(card)}
								aria-label={`Dismiss ${card.displayName}`}
							>
								<X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
							</button>
							<button className="w-full text-left" onClick={() => onPlay(card.entry)}>
								<div className="text-xs font-medium truncate pr-4">
									{card.displayName}
								</div>
								{contentType === "live" && (
									<div className="text-[9px] text-primary mt-1">&#9679; LIVE</div>
								)}
							</button>
						</div>
					))}
				</div>
			</ScrollArea>
		</div>
	);
};
