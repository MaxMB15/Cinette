// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Clock, Pin } from "lucide-react";
import { useDownloads } from "@/hooks/useDownloads";
import { useNow } from "@/hooks/useNow";
import { daysUntil, deleteLabel, summarize } from "@/lib/retention";
import { setDownloadKeep } from "@/lib/tauri";
import type { DownloadRecord } from "@/lib/types";

interface RetentionNoteProps {
	/** One download, or every episode download of a series. */
	records: DownloadRecord[];
	/** An icon and day count for tight rows, with the full text as its tooltip. */
	compact?: boolean;
	className?: string;
}

/**
 * Says when the "Delete downloads after" setting deletes these downloads, with
 * a button to keep them. Renders nothing while the setting is off.
 */
export const RetentionNote = ({ records, compact = false, className = "" }: RetentionNoteProps) => {
	const { retentionDays } = useDownloads();
	const now = useNow();
	const summary = summarize(records, retentionDays);
	if (summary.state === "none") return null;

	const kept = summary.state === "kept";
	const many = summary.count > 1;
	const label = kept ? (many ? "All kept" : "Kept") : deleteLabel(summary.at, now, many);
	const action = kept ? "Don't keep" : many ? "Keep all" : "Keep";

	const toggle = (e: React.MouseEvent) => {
		e.stopPropagation();
		for (const r of records) {
			if (r.status === "completed" && r.keep === kept) {
				setDownloadKeep(r.id, !kept).catch((err) =>
					console.error("[Downloads] failed to change Keep:", err)
				);
			}
		}
	};

	if (compact) {
		const days = kept ? null : daysUntil(summary.at, now);
		const hint = kept ? "Click to stop keeping." : `Click to ${action.toLowerCase()}.`;
		return (
			<button
				onClick={toggle}
				title={`${label}. ${hint}`}
				aria-label={`${label}. ${action}`}
				className={`flex items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground hover:text-foreground ${className}`}
			>
				{kept ? <Pin className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
				{days !== null && (days > 0 ? `${days}d` : "soon")}
			</button>
		);
	}

	return (
		<div
			className={`flex items-center justify-between gap-2 text-xs text-muted-foreground ${className}`}
		>
			<span className="flex items-center gap-1 truncate">
				{kept ? (
					<Pin className="h-3 w-3 shrink-0" />
				) : (
					<Clock className="h-3 w-3 shrink-0" />
				)}
				{label}
			</span>
			<button
				onClick={toggle}
				className="shrink-0 font-medium text-foreground hover:underline"
			>
				{action}
			</button>
		</div>
	);
};
