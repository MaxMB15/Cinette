// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { Download, DownloadCloud, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { isMobilePlatform } from "@/lib/platform";

/** The mobile apps can't run the ffmpeg sidecar, so they have no downloads. */
const DOWNLOADS_SUPPORTED = !isMobilePlatform();

export type DownloadIconState = "idle" | "downloading" | "partial" | "complete" | "failed";

interface DownloadButtonProps {
	state: DownloadIconState;
	/** Start (idle/partial) — for series/season this is "download all missing".
	 *  Any large-batch confirm is handled by the parent. */
	onStart: () => void;
	/** Stop in-progress (downloading). */
	onStop: () => void;
	stopCount?: number;
	/** Remove completed download(s). */
	onRemove: () => void;
	removeSummary?: string;
	/** Render a text label beside the icon (info page only). */
	showLabel?: boolean;
	className?: string;
}

export const DownloadButton = ({
	state,
	onStart,
	onStop,
	stopCount,
	onRemove,
	removeSummary,
	showLabel = false,
	className = "",
}: DownloadButtonProps) => {
	const [confirm, setConfirm] = useState<null | "stop" | "remove">(null);

	if (!DOWNLOADS_SUPPORTED) return null;

	const handleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		// "failed" behaves like idle: clicking retries the download.
		if (state === "idle" || state === "partial" || state === "failed") onStart();
		else if (state === "downloading") setConfirm("stop");
		else setConfirm("remove"); // complete → remove
	};

	const { Icon, color, label } = iconFor(state);

	return (
		<>
			<button
				onClick={handleClick}
				aria-label={label}
				className={`flex items-center gap-1.5 ${className}`}
			>
				<Icon
					className={`h-3.5 w-3.5 ${color} ${state === "downloading" ? "animate-pulse" : ""}`}
				/>
				{showLabel && <span className={`text-xs ${color}`}>{label}</span>}
			</button>

			<ConfirmDialog
				open={confirm === "stop"}
				title="Stop download?"
				message={
					stopCount && stopCount > 1
						? `Stop ${stopCount} downloads? Partial files are discarded.`
						: "Stop this download? The partial file is discarded."
				}
				confirmLabel="Stop"
				onConfirm={() => {
					setConfirm(null);
					onStop();
				}}
				onCancel={() => setConfirm(null)}
			/>
			<ConfirmDialog
				open={confirm === "remove"}
				title="Remove download?"
				message={
					removeSummary
						? `Remove ${removeSummary}? This deletes the downloaded file(s).`
						: "Remove this download? This deletes the downloaded file."
				}
				confirmLabel="Remove"
				onConfirm={() => {
					setConfirm(null);
					onRemove();
				}}
				onCancel={() => setConfirm(null)}
			/>
		</>
	);
};

const iconFor = (state: DownloadIconState) => {
	switch (state) {
		case "complete":
			return {
				Icon: CheckCircle2,
				color: "text-emerald-500",
				label: "Downloaded",
			};
		case "partial":
			return {
				Icon: DownloadCloud,
				color: "text-amber-400",
				label: "Partially downloaded",
			};
		case "downloading":
			return { Icon: Loader2, color: "text-blue-400", label: "Downloading" };
		case "failed":
			return { Icon: AlertCircle, color: "text-red-500", label: "Download failed — retry" };
		default:
			return { Icon: Download, color: "text-muted-foreground", label: "Download" };
	}
};
