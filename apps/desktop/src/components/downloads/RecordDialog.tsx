// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { Input } from "@/components/ui/input";
import { useProviderIds } from "@/hooks/useChannels";
import { useDownloads } from "@/hooks/useDownloads";
import { useNow } from "@/hooks/useNow";
import {
	MAX_LENGTH_MINUTES,
	formatAt,
	formatWindow,
	isActiveRecording,
	isTooLong,
	overlapWarning,
	programWindow,
	rangeWindow,
	readMargins,
	recordNowWindow,
	recordingLabel,
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

const minutesText = (n: number) => (n === 1 ? "1 minute" : `${n} minutes`);

const afterText = (after: number) => (after > 0 ? ` and ${minutesText(after)} more` : "");

/** How the margins move a program's recording, such as ", from 2 minutes early to 5 minutes late". */
const marginText = ({ before, after }: RecordingMargins): string => {
	if (before === 0 && after === 0) return "";
	if (before === 0) return `, running ${minutesText(after)} late`;
	if (after === 0) return `, starting ${minutesText(before)} early`;
	return `, from ${minutesText(before)} early to ${minutesText(after)} late`;
};

/** The inputs are small, to suit the dialog's small text. */
const INPUT_CLASS = "h-8 px-2 py-1.5 text-xs";

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
	const providerIds = useProviderIds();
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
	const tooLong = win !== null && isTooLong(win);
	const warning =
		win && !passed && !tooLong ? overlapWarning(win, channel, downloads, providerIds) : null;

	let title: string;
	let message: string;
	if (request.type === "now") {
		title = "Record now";
		message = win?.program
			? `Records ${channel.name} until ${win.program.title} ends${afterText(margins.after)}. You can stop it sooner.`
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
				? `From now until ${formatAt(win.endAt, now)}`
				: formatWindow(win.startAt, win.endAt, now);

	const confirm = async () => {
		if (!win) return;
		// "Record now" starts when the user confirms, not when the dialog opened.
		const w =
			request.type === "now" ? recordNowWindow(nowSeconds(), request.onAir, margins) : win;
		setBusy(true);
		setError(null);
		try {
			await scheduleRecording(channel.id, w.startAt, w.endAt, w.program);
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
			confirmDisabled={!win || passed || tooLong || busy}
			onConfirm={() => void confirm()}
			onCancel={onClose}
		>
			<div className="space-y-2 text-xs">
				{request.type === "range" && (
					<div className="space-y-2">
						<label className="block">
							<span className="block mb-1 text-muted-foreground">Start</span>
							<Input
								type="datetime-local"
								value={start}
								min={toLocalInputValue(now)}
								onChange={(e) => setStart(e.target.value)}
								className={INPUT_CLASS}
							/>
						</label>
						<label className="block">
							<span className="block mb-1 text-muted-foreground">
								Length in minutes
							</span>
							<Input
								type="number"
								min={1}
								max={MAX_LENGTH_MINUTES}
								value={minutes}
								onChange={(e) => setMinutes(e.target.value)}
								className={`${INPUT_CLASS} w-24`}
							/>
						</label>
					</div>
				)}
				<p className="font-medium">{when}</p>
				{tooLong && (
					<p className="text-red-400">
						A recording can be up to {MAX_LENGTH_MINUTES / 60} hours long.
					</p>
				)}
				{warning && <p className="text-amber-500">{warning}</p>}
				<p className="text-muted-foreground">
					The app has to stay open, with the computer awake, until the recording ends. It
					uses a stream of its own, so with a provider that allows one stream at a time,
					watching while it records can stop one of them.
				</p>
				{error && <p className="text-red-400">{error}</p>}
			</div>
		</ConfirmDialog>
	);
};

/**
 * Asks before it stops a running recording or cancels a waiting one. Either
 * way it acts on the whole recording, which can cover more than one program.
 * A stopped recording keeps what it recorded.
 */
export const StopRecordingDialog = ({
	recording,
	onClose,
}: {
	recording: DownloadRecord | null;
	onClose: () => void;
}) =>
	recording ? (
		<StopRecordingPanel key={recording.id} recording={recording} onClose={onClose} />
	) : null;

const StopRecordingPanel = ({
	recording,
	onClose,
}: {
	recording: DownloadRecord;
	onClose: () => void;
}) => {
	const { downloads } = useDownloads();
	const now = useNow();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// The list has the latest state, such as a waiting recording that has started since.
	const rec = downloads.find((d) => d.id === recording.id) ?? recording;
	const running = rec.status === "recording";
	const when =
		rec.startAt != null && rec.endAt != null
			? `, ${formatWindow(rec.startAt, rec.endAt, now)}`
			: "";

	const confirm = async () => {
		setBusy(true);
		setError(null);
		try {
			await stopRecording(rec.id);
			onClose();
		} catch (e) {
			setError(String(e));
			setBusy(false);
		}
	};

	// It ended while the dialog was open, so there's nothing left to stop.
	if (!isActiveRecording(rec)) return null;

	return (
		<ConfirmDialog
			open
			title={running ? "Stop recording?" : "Cancel this recording?"}
			message={
				running
					? `This stops the whole recording of ${recordingLabel(rec)}${when}. What it recorded so far stays.`
					: `This cancels the whole recording of ${recordingLabel(rec)}${when}.`
			}
			confirmLabel={running ? "Stop" : "Cancel recording"}
			cancelLabel={running ? "Keep recording" : "Keep"}
			confirmDisabled={busy}
			onConfirm={() => void confirm()}
			onCancel={onClose}
		>
			{error && <p className="text-xs text-red-400">{error}</p>}
		</ConfirmDialog>
	);
};
