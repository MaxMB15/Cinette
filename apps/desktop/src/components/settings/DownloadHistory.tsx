// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId } from "react";
import { X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useDownloads } from "@/hooks/useDownloads";
import { deleteAt, deleteLabel } from "@/lib/retention";
import type { DownloadRecord } from "@/lib/types";

const fmtBytes = (b: number | null) => (b == null ? "—" : `${(b / 1_000_000).toFixed(0)} MB`);
const fmtRate = (b: number | null) => (b == null ? "—" : `${(b / 1_000_000).toFixed(1)} MB/s`);
const fmtTime = (t: number | null) => (t == null ? "—" : new Date(t * 1000).toLocaleString());

const statusCell = (d: DownloadRecord) => {
	if (d.status === "completed") return <span className="text-emerald-500">Done</span>;
	if (d.status === "failed")
		return <span className="text-red-400">Failed{d.error ? ` — ${d.error}` : ""}</span>;
	if (d.status === "downloading") {
		const pct = d.totalBytes ? Math.round((d.downloadedBytes / d.totalBytes) * 100) : null;
		return <span className="text-blue-400">{pct == null ? "…" : `${pct}%`}</span>;
	}
	return <span className="text-muted-foreground">{d.status}</span>;
};

/** When the retention setting deletes a finished download. Blank when it never will. */
const deletesCell = (d: DownloadRecord, days: number | null) => {
	if (d.status !== "completed" || !days) return "";
	if (d.keep) return "Kept";
	const at = deleteAt(d, days);
	return at === null ? "" : deleteLabel(at, Date.now() / 1000);
};

export const DownloadHistory = () => {
	const { downloads, retentionDays } = useDownloads();

	if (downloads.length === 0) {
		return <p className="text-xs text-muted-foreground">No downloads yet.</p>;
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full text-xs">
				<thead className="text-muted-foreground">
					<tr>
						<th className="text-left py-2">Title</th>
						<th className="text-left">Type</th>
						<th className="text-left">Size</th>
						<th className="text-left">Avg rate</th>
						<th className="text-left">Started</th>
						<th className="text-left">Finished</th>
						<th className="text-left">Status</th>
						{retentionDays !== null && <th className="text-left pl-2">Deletes</th>}
					</tr>
				</thead>
				<tbody>
					{downloads.map((d) => (
						<tr key={d.id} className="border-t border-border/40">
							<td className="py-2 pr-2 max-w-[180px] truncate">{d.title}</td>
							<td className="pr-2">{d.kind}</td>
							<td className="pr-2 whitespace-nowrap">
								{d.totalBytes
									? `${fmtBytes(d.downloadedBytes)} / ${fmtBytes(d.totalBytes)}`
									: fmtBytes(d.downloadedBytes)}
							</td>
							<td className="pr-2 whitespace-nowrap">{fmtRate(d.avgRateBps)}</td>
							<td className="pr-2 whitespace-nowrap">{fmtTime(d.createdAt)}</td>
							<td className="pr-2 whitespace-nowrap">{fmtTime(d.finishedAt)}</td>
							<td>{statusCell(d)}</td>
							{retentionDays !== null && (
								<td className="pl-2 whitespace-nowrap text-muted-foreground">
									{deletesCell(d, retentionDays)}
								</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};

/** Full-screen overlay wrapping the history table — the Settings pane is too
 *  narrow to show every column, so the table lives in a wide popup. */
export const DownloadHistoryDialog = ({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) => {
	const titleId = useId();
	if (!open) return null;
	return (
		<Dialog
			onClose={onClose}
			labelledBy={titleId}
			overlayClassName="p-4"
			className="bg-card border border-border rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] flex flex-col"
		>
			<div className="flex items-center justify-between px-5 py-3 border-b border-border">
				<h3 id={titleId} className="text-sm font-semibold">
					Download history
				</h3>
				<button
					aria-label="Close"
					className="p-1 rounded-md hover:bg-accent"
					onClick={onClose}
				>
					<X className="h-4 w-4" />
				</button>
			</div>
			<div className="overflow-auto p-5">
				<DownloadHistory />
			</div>
		</Dialog>
	);
};
