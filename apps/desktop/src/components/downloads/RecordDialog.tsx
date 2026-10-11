// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { useDownloads } from "@/hooks/useDownloads";
import { useNow } from "@/hooks/useNow";
import {
	MAX_LENGTH_MINUTES,
	formatWindow,
	overlapWarning,
	programWindow,
	rangeWindow,
	readMargins,
	recordNowWindow,
	toLocalInputValue,
	type RecordingMargins,
	type RecordingWindow,
} from "@/lib/recordings";
import { scheduleRecording, stopRecording } from "@/lib/tauri";
import type { Channel, DownloadRecord, EpgProgram } from "@/lib/types";

/** What the user asked to record, or to stop. */
export type RecordRequest =
	| { type: "now"; onAir: EpgProgram | null }
	| { type: "program"; program: EpgProgram }
	| { type: "range" }
	| { type: "stop"; recording: DownloadRecord };

interface RecordDialogProps {
	/** The live channel to record. */
	channel: Channel;
	request: RecordRequest | null;
	onClose: () => void;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const timeOf = (unix: number): string =>
	new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const minutesText = (n: number) => (n === 1 ? "1 minute" : `${n} minutes`);

const afterText = (after: number) => (after > 0 ? ` and ${minutesText(after)} more` : "");

/** How the margins move a program's recording, such as ", from 2 minutes early to 5 minutes late". */
const marginText = ({ before, after }: RecordingMargins): string => {
	if (before === 0 && after === 0) return "";
	if (before === 0) return `, running ${minutesText(after)} late`;
	if (after === 0) return `, starting ${minutesText(before)} early`;
	return `, from ${minutesText(before)} early to ${minutesText(after)} late`;
};

/** The next whole 5 minutes after `unix`, a handy default start. */
const nextFiveMinutes = (unix: number) => Math.ceil((unix + 1) / 300) * 300;

/** Asks before it records a live channel or stops a recording. */
export const RecordDialog = ({ channel, request, onClose }: RecordDialogProps) => {
	if (!request) return null;
	if (request.type === "stop") {
		return <StopRecordingDialog recording={request.recording} onClose={onClose} />;
	}
	return <ScheduleDialog channel={channel} request={request} onClose={onClose} />;
};

const ScheduleDialog = ({
	channel,
	request,
	onClose,
}: {
	channel: Channel;
	request: Exclude<RecordRequest, { type: "stop" }>;
	onClose: () => void;
}) => {
	const { downloads } = useDownloads();
	// Shows the times again as the clock moves on.
	useNow();
	const now = nowSeconds();
	const [margins] = useState(readMargins);
	const [start, setStart] = useState(() => toLocalInputValue(nextFiveMinutes(nowSeconds())));
	const [minutes, setMinutes] = useState("60");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const win: RecordingWindow | null =
		request.type === "now"
			? recordNowWindow(now, request.onAir, margins)
			: request.type === "program"
				? programWindow(request.program, margins)
				: rangeWindow(start, Number(minutes));
	const passed = win !== null && win.endAt <= now;
	const warning = win && !passed ? overlapWarning(win, channel.id, downloads) : null;

	let title: string;
	let message: string;
	if (request.type === "now") {
		title = "Record now";
		message = win?.programTitle
			? `Records ${channel.name} until ${win.programTitle} ends${afterText(margins.after)}. You can stop it sooner.`
			: "There's no guide for this channel, so it records for an hour. You can stop it sooner.";
	} else if (request.type === "program") {
		title = "Record this program";
		message = `Records ${request.program.title} on ${channel.name}${marginText(margins)}.`;
	} else {
		title = "Record a time range";
		message = `Choose when to record ${channel.name}.`;
	}

	const when = !win
		? `Enter a start and a length of up to ${MAX_LENGTH_MINUTES / 60} hours.`
		: passed
			? "That time has already passed."
			: win.startAt <= now
				? `From now until ${timeOf(win.endAt)}`
				: formatWindow(win.startAt, win.endAt, now);

	const confirm = async () => {
		if (!win) return;
		// "Record now" starts when the user confirms, not when the dialog opened.
		const w =
			request.type === "now" ? recordNowWindow(nowSeconds(), request.onAir, margins) : win;
		setBusy(true);
		setError(null);
		try {
			await scheduleRecording(channel.id, w.startAt, w.endAt, w.programTitle);
			onClose();
		} catch (e) {
			setError(String(e));
			setBusy(false);
		}
	};

	return (
		<ConfirmDialog
			open
			title={title}
			message={message}
			confirmLabel="Record"
			destructive={false}
			confirmDisabled={!win || passed || busy}
			onConfirm={() => void confirm()}
			onCancel={onClose}
		>
			<div className="space-y-2 text-xs">
				{request.type === "range" && (
					<div className="space-y-2">
						<label className="block">
							<span className="block mb-1 text-muted-foreground">Start</span>
							<input
								type="datetime-local"
								value={start}
								onChange={(e) => setStart(e.target.value)}
								className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
							/>
						</label>
						<label className="block">
							<span className="block mb-1 text-muted-foreground">
								Length in minutes
							</span>
							<input
								type="number"
								min={1}
								max={MAX_LENGTH_MINUTES}
								value={minutes}
								onChange={(e) => setMinutes(e.target.value)}
								className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
							/>
						</label>
					</div>
				)}
				<p className="font-medium">{when}</p>
				{warning && <p className="text-amber-500">{warning}</p>}
				{error && <p className="text-red-400">{error}</p>}
			</div>
		</ConfirmDialog>
	);
};

/** Asks before it stops a running recording. What it recorded stays. */
export const StopRecordingDialog = ({
	recording,
	onClose,
}: {
	recording: DownloadRecord | null;
	onClose: () => void;
}) => {
	const [error, setError] = useState<string | null>(null);
	if (!recording) return null;
	return (
		<ConfirmDialog
			open
			title="Stop recording?"
			message={`The recording of ${recording.title} keeps what it has so far.`}
			confirmLabel="Stop"
			onConfirm={() => stopRecording(recording.id).then(onClose, (e) => setError(String(e)))}
			onCancel={onClose}
		>
			{error && <p className="text-xs text-red-400">{error}</p>}
		</ConfirmDialog>
	);
};
