// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { Download, DownloadCloud, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { isMobilePlatform } from "@/lib/platform";
import type { DownloadIconState } from "@/lib/types";

/** The mobile apps can't run the ffmpeg sidecar, so they have no downloads. */
const DOWNLOADS_SUPPORTED = !isMobilePlatform();

interface DownloadButtonProps {
	/**
	 * The item the button is for. When this changes, a confirm left open closes,
	 * so it can't stop or remove the next item's download, and focus leaves the
	 * button, so Space can't start one.
	 */
	itemId?: string;
	state: DownloadIconState;
	/** Start (idle/partial). For a series or season this downloads all missing episodes.
	 *  Any large-batch confirm is handled by the parent. */
	onStart: () => void;
	/** Stop in-progress (downloading). */
	onStop: () => void;
	stopCount?: number;
	/** Remove the finished downloads. If it rejects, the user sees the error. */
	onRemove: () => Promise<unknown> | undefined;
	removeSummary?: string;
	/** Render a text label beside the icon (info page only). */
	showLabel?: boolean;
	className?: string;
}

export const DownloadButton = ({
	itemId,
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
	const [removeError, setRemoveError] = useState<string | null>(null);
	// A confirm left open for the last item closes during render, not in an
	// effect, so it never shows for the new one. A removal still running can
	// still report a failure.
	const [confirmItemId, setConfirmItemId] = useState(itemId);
	if (confirmItemId !== itemId) {
		setConfirmItemId(itemId);
		setConfirm(null);
	}

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
			{/* Keyed by item, so each item gets a new button and the old one
			    takes focus with it. A dialog hands focus back on close only to
			    an element still on the page, so neither a confirm nor the
			    failure notice can put focus on the new button, where Space
			    would press it for the new item. */}
			<button
				key={itemId}
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
					onRemove()?.catch((err: unknown) => setRemoveError(String(err)));
				}}
				onCancel={() => setConfirm(null)}
			/>
			<ConfirmDialog
				open={removeError !== null}
				title={
					removeSummary
						? "Couldn't remove every download"
						: "Couldn't remove the download"
				}
				message={removeError ?? ""}
				confirmLabel="OK"
				onConfirm={() => setRemoveError(null)}
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
