// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useCallback } from "react";
import { Trash, LoaderCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getWatchHistory, deleteHistoryEntry, clearWatchHistory } from "@/lib/tauri";
import { ask } from "@tauri-apps/plugin-dialog";
import type { WatchHistoryEntry } from "@/lib/types";
import { ChannelLogo } from "./ChannelLogo";
import { formatDuration, formatRelativeDate } from "@/lib/watch-history";
import { formatCount } from "@/lib/format";

interface HistoryTabProps {
	onPlay: (entry: WatchHistoryEntry) => void;
}

const BADGE_COLOR: Record<string, string> = {
	live: "bg-red-500/20 text-red-400",
	movie: "bg-blue-500/20 text-blue-400",
	recording: "bg-amber-500/20 text-amber-500",
};

const ContentTypeBadge = ({ type }: { type: string }) => {
	const normalized = type.toLowerCase();
	const known = normalized in BADGE_COLOR;
	const color = known ? BADGE_COLOR[normalized] : "bg-purple-500/20 text-purple-400";
	const label = known ? normalized.toUpperCase() : "SERIES";
	return (
		<span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${color}`}>{label}</span>
	);
};

export const HistoryTab = ({ onPlay }: HistoryTabProps) => {
	const [entries, setEntries] = useState<WatchHistoryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		let current = true;
		getWatchHistory(200)
			.then((data) => {
				if (current) setEntries(data);
			})
			.catch((e) => console.error("[HistoryTab] failed to fetch history:", e))
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, []);

	// The entry leaves the list in place. Loading the history again would show
	// the spinner in its place and lose the scroll position.
	const handleDelete = useCallback(async (e: React.MouseEvent, channelId: string) => {
		e.stopPropagation();
		try {
			await deleteHistoryEntry(channelId);
			setEntries((prev) => prev.filter((entry) => entry.channelId !== channelId));
		} catch (err) {
			console.error("[HistoryTab] failed to delete entry:", err);
		}
	}, []);

	const handleClearAll = useCallback(async () => {
		const confirmed = await ask("Clear all watch history?", {
			title: "Clear History",
			kind: "warning",
		});
		if (!confirmed) return;
		try {
			await clearWatchHistory();
			setEntries([]);
		} catch (err) {
			console.error("[HistoryTab] failed to clear history:", err);
		}
	}, []);

	if (loading) {
		return (
			<div className="flex items-center justify-center h-full py-12">
				<LoaderCircle className="h-5 w-5 animate-spin text-primary" />
			</div>
		);
	}

	if (entries.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2 text-center py-12">
				<Clock className="h-10 w-10 text-muted-foreground/30" />
				<p className="text-sm text-muted-foreground">
					No watch history yet — start watching to track your history.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Header with Clear All */}
			<div className="flex items-center justify-end px-3 py-1 shrink-0">
				<Button
					variant="ghost"
					size="sm"
					onClick={handleClearAll}
					className="text-xs text-muted-foreground hover:text-destructive gap-1.5"
				>
					<Trash className="h-3.5 w-3.5" />
					Clear All
				</Button>
			</div>

			{/* History list */}
			<div className="flex-1 overflow-auto scrollbar-hide px-3 pb-3">
				<div className="flex flex-col">
					{entries.map((entry) => (
						// Play and delete are sibling buttons so each gets its own name and
						// keyboard focus instead of one nested inside the other.
						<div
							key={entry.channelId}
							className="flex items-center gap-3 pr-2 rounded-lg hover:bg-accent group"
						>
							<button
								type="button"
								onClick={() => onPlay(entry)}
								className="flex flex-1 min-w-0 items-center gap-3 pl-2 py-2.5 rounded-lg text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								{/* Logo */}
								<ChannelLogo
									url={entry.channelLogo}
									className="h-9 w-9 rounded-md bg-muted"
									imgClassName="object-cover"
									fallback={
										<span
											aria-hidden="true"
											className="text-sm font-semibold text-muted-foreground"
										>
											{entry.channelName.charAt(0).toUpperCase()}
										</span>
									}
								/>

								{/* Info */}
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 mb-0.5">
										<span className="font-medium text-sm truncate">
											{entry.channelName}
										</span>
										<ContentTypeBadge type={entry.contentType} />
										<span className="text-xs text-muted-foreground ml-auto shrink-0">
											{formatRelativeDate(entry.lastWatchedAt)}
										</span>
									</div>
									<p className="text-xs text-muted-foreground">
										{formatCount(entry.playCount, "play")} ·{" "}
										{formatDuration(entry.totalDurationSeconds)} total
									</p>
								</div>
							</button>

							{/* Delete */}
							<button
								type="button"
								onClick={(e) => handleDelete(e, entry.channelId)}
								className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
								aria-label={`Remove ${entry.channelName} from history`}
							>
								<Trash className="h-3.5 w-3.5" />
							</button>
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
