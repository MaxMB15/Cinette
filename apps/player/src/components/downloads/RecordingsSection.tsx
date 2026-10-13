// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { Disc, Play, Trash } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useNow } from "@/hooks/useNow";
import { formatBytes } from "@/lib/format";
import {
	errorSummary,
	formatWindow,
	recordingChannel,
	recordingProgress,
	recordingStatus,
	recordingStatusColor,
	sortRecordings,
} from "@/lib/recordings";
import { removeDownload } from "@/lib/tauri";
import type { Channel, DownloadRecord } from "@/lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { StopRecordingDialog } from "./RecordDialog";
import { RetentionNote } from "./RetentionNote";

interface RecordingsSectionProps {
	/** Every recording, in any state. */
	recordings: DownloadRecord[];
	onPlay: (channel: Channel) => void;
}

/** The Recordings list in the Downloads tab. */
export const RecordingsSection = ({ recordings, onPlay }: RecordingsSectionProps) => {
	const now = useNow();
	const [stopping, setStopping] = useState<DownloadRecord | null>(null);
	const [deleting, setDeleting] = useState<DownloadRecord | null>(null);
	const [error, setError] = useState<string | null>(null);

	const run = (action: Promise<void>) => {
		setError(null);
		action.catch((e) => setError(String(e)));
	};

	return (
		<section aria-label="Recordings" className="px-4 pt-4">
			<h2 className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-2">
				Recordings
			</h2>
			{error && <p className="text-xs text-red-400 mb-2">{error}</p>}
			<ul className="flex flex-col gap-1.5">
				{sortRecordings(recordings).map((rec) => {
					const when =
						rec.startAt != null && rec.endAt != null
							? formatWindow(rec.startAt, rec.endAt, now)
							: null;
					return (
						<li
							key={rec.id}
							className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
						>
							<Disc
								className={`h-4 w-4 shrink-0 ${
									rec.status === "recording"
										? "text-red-500 animate-pulse"
										: "text-muted-foreground"
								}`}
							/>
							<div className="flex-1 min-w-0">
								<p className="text-sm font-medium truncate">
									{rec.programTitle ?? rec.title}
									{rec.programTitle && (
										<span className="font-normal text-muted-foreground">
											{" "}
											on {rec.title}
										</span>
									)}
								</p>
								<p className="text-xs text-muted-foreground truncate">
									{when && <span>{when}. </span>}
									<span className={recordingStatusColor(rec)}>
										{recordingStatus(rec, now)}
									</span>
									{/* A running recording's size grows as it goes. */}
									{(rec.status === "completed" || rec.status === "recording") &&
										rec.downloadedBytes > 0 && (
											<span>, {formatBytes(rec.downloadedBytes)}</span>
										)}
								</p>
								{rec.status === "recording" && (
									<div
										role="progressbar"
										aria-label={`Recording ${rec.title}`}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={Math.round(
											recordingProgress(rec, now) * 100
										)}
										className="mt-1.5 h-1 rounded-full bg-secondary overflow-hidden"
									>
										<div
											className="h-full bg-red-500 transition-[width] duration-500"
											style={{
												width: `${recordingProgress(rec, now) * 100}%`,
											}}
										/>
									</div>
								)}
								{rec.error && (
									<p
										className="text-xs text-muted-foreground/80 mt-0.5 truncate"
										title={rec.error}
									>
										{errorSummary(rec.error)}
									</p>
								)}
								{rec.status === "completed" && (
									<RetentionNote records={[rec]} className="mt-1" />
								)}
							</div>
							<div className="flex items-center gap-1 shrink-0">
								{rec.status === "scheduled" && (
									<RowButton onClick={() => setStopping(rec)}>Cancel</RowButton>
								)}
								{rec.status === "recording" && (
									<RowButton onClick={() => setStopping(rec)}>Stop</RowButton>
								)}
								{rec.status === "completed" && (
									<>
										<RowButton
											onClick={() => onPlay(recordingChannel(rec))}
											aria-label={`Play ${rec.programTitle ?? rec.title}`}
										>
											<Play className="h-3.5 w-3.5" />
											Play
										</RowButton>
										<RowButton
											onClick={() => setDeleting(rec)}
											aria-label={`Delete ${rec.programTitle ?? rec.title}`}
										>
											<Trash className="h-3.5 w-3.5" />
										</RowButton>
									</>
								)}
								{(rec.status === "missed" || rec.status === "failed") && (
									<RowButton onClick={() => run(removeDownload(rec.id))}>
										Remove
									</RowButton>
								)}
							</div>
						</li>
					);
				})}
			</ul>

			<StopRecordingDialog recording={stopping} onClose={() => setStopping(null)} />
			<ConfirmDialog
				open={deleting !== null}
				title="Delete recording?"
				message="This deletes the recorded file from your computer."
				confirmLabel="Delete"
				onConfirm={() => {
					if (deleting) run(removeDownload(deleting.id));
					setDeleting(null);
				}}
				onCancel={() => setDeleting(null)}
			/>
		</section>
	);
};

/** A small button in a recording's row. */
const RowButton = (props: ButtonProps) => (
	<Button
		variant="ghost"
		size="sm"
		className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
		{...props}
	/>
);
