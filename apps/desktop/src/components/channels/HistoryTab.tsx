// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useCallback, useRef } from "react";
import { Trash2, Loader2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getWatchHistory, deleteHistoryEntry, clearWatchHistory } from "@/lib/tauri";
import { ask } from "@tauri-apps/plugin-dialog";
import type { WatchHistoryEntry } from "@/lib/types";

interface HistoryTabProps {
	onPlay: (entry: WatchHistoryEntry) => void;
}

const formatDuration = (seconds: number): string => {
	if (seconds < 60) return `${seconds}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h === 0) return `${m}m`;
	return `${h}h ${m}m`;
};

const formatRelativeDate = (unixSeconds: number): string => {
	const date = new Date(unixSeconds * 1000);
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 86400000);
	const entryDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	if (entryDay.getTime() === today.getTime())
		return `Today ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (entryDay.getTime() === yesterday.getTime()) return `Yesterday`;
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
};

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
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const fetchHistory = useCallback(async () => {
		setLoading(true);
		try {
			const data = await getWatchHistory(200);
			if (mountedRef.current) setEntries(data);
		} catch (e) {
			console.error("[HistoryTab] failed to fetch history:", e);
		} finally {
			if (mountedRef.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchHistory();
	}, [fetchHistory]);

	const handleDelete = useCallback(
		async (e: React.MouseEvent, channelId: string) => {
			e.stopPropagation();
			try {
				await deleteHistoryEntry(channelId);
				if (mountedRef.current) await fetchHistory();
			} catch (err) {
				console.error("[HistoryTab] failed to delete entry:", err);
			}
		},
		[fetchHistory]
	);

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
				<Loader2 className="h-5 w-5 animate-spin text-primary" />
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
					<Trash2 className="h-3.5 w-3.5" />
					Clear All
				</Button>
			</div>

			{/* History list */}
			<div className="flex-1 overflow-auto scrollbar-hide px-3 pb-3">
				<div className="flex flex-col">
					{entries.map((entry) => (
						<div
							key={entry.channelId}
							onClick={() => onPlay(entry)}
							className="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-accent cursor-pointer group"
						>
							{/* Logo */}
							<div className="shrink-0 h-9 w-9 rounded-md overflow-hidden bg-muted flex items-center justify-center">
								{entry.channelLogo ? (
									<img
										src={entry.channelLogo}
										alt={entry.channelName}
										className="h-full w-full object-cover"
										onError={(e) => {
											(e.currentTarget as HTMLImageElement).style.display =
												"none";
											const parent = e.currentTarget.parentElement;
											if (parent) {
												parent.textContent = entry.channelName
													.charAt(0)
													.toUpperCase();
												parent.classList.add(
													"text-sm",
													"font-semibold",
													"text-muted-foreground"
												);
											}
										}}
									/>
								) : (
									<span className="text-sm font-semibold text-muted-foreground">
										{entry.channelName.charAt(0).toUpperCase()}
									</span>
								)}
							</div>

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
									{entry.playCount} {entry.playCount === 1 ? "play" : "plays"} ·{" "}
									{formatDuration(entry.totalDurationSeconds)} total
								</p>
							</div>

							{/* Delete */}
							<button
								onClick={(e) => handleDelete(e, entry.channelId)}
								className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
								aria-label={`Remove ${entry.channelName} from history`}
							>
								<Trash2 className="h-3.5 w-3.5" />
							</button>
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
