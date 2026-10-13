// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useRef, useCallback } from "react";
import { X, TvMinimal, LoaderCircle, Circle, Square, CalendarClock } from "lucide-react";
import type { Channel, DownloadRecord, EpgProgram } from "@/lib/types";
import { getEpgProgrammes } from "@/lib/tauri";
import { formatHHMM } from "@/lib/epg-window";
import { isMobilePlatform } from "@/lib/platform";
import { isRecordingOf, recordingOfProgram } from "@/lib/recordings";
import { useProviderIds } from "@/hooks/useChannels";
import { useDownloads } from "@/hooks/useDownloads";
import { useNow } from "@/hooks/useNow";
import { useSheetDrag } from "@/hooks/useSheetDrag";
import { RecordDialog, type RecordRequest } from "@/components/downloads/RecordDialog";
import { EpgTimelineBar, WINDOW_PAST, WINDOW_FUTURE } from "./EpgTimelineBar";

// Recording runs ffmpeg on the computer, so phones and tablets don't offer it.
const RECORDING_SUPPORTED = !isMobilePlatform();

const NO_PROGRAMMES: EpgProgram[] = [];

interface LiveInfoDrawerProps {
	channel: Channel;
	onClose: () => void;
}

const formatDuration = (startTime: number, endTime: number): string => {
	const mins = Math.floor((endTime - startTime) / 60);
	if (mins < 60) return `${mins} min`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

export const LiveInfoDrawer = ({ channel, onClose }: LiveInfoDrawerProps) => {
	const [visible, setVisible] = useState(false);
	const epgId = channel.tvgId ?? channel.id;
	// The schedule is kept with the guide id it's for, so a new channel shows
	// the spinner until its own schedule arrives.
	const [schedule, setSchedule] = useState<{ epgId: string; programmes: EpgProgram[] } | null>(
		null
	);
	const loading = schedule?.epgId !== epgId;
	const programmes = schedule && !loading ? schedule.programmes : NO_PROGRAMMES;
	const now = useNow();
	const [selectedProg, setSelectedProg] = useState<EpgProgram | null>(null);
	const currentRowRef = useRef<HTMLLIElement | null>(null);
	const { downloads } = useDownloads();
	const providerIds = useProviderIds();
	const [recordRequest, setRecordRequest] = useState<RecordRequest | null>(null);
	// The channel's recordings, found by its name too, since a refresh can change its id.
	const recordings = RECORDING_SUPPORTED
		? downloads.filter((r) => isRecordingOf(r, channel, providerIds))
		: [];
	const running = recordings.find((r) => r.status === "recording");
	const onAir = programmes.find((p) => p.startTime <= now && p.endTime > now) ?? null;

	useEffect(() => {
		const id = requestAnimationFrame(() => setVisible(true));
		return () => cancelAnimationFrame(id);
	}, []);

	// Fetch schedule: 12 hours before now through 12 hours ahead
	useEffect(() => {
		let cancelled = false;
		const nowSec = Math.floor(Date.now() / 1000);
		const rangeStart = nowSec - 12 * 3600;
		const rangeEnd = nowSec + 12 * 3600;

		getEpgProgrammes(epgId, rangeStart, rangeEnd)
			.then((data) => {
				if (cancelled) return;
				setSchedule({ epgId, programmes: data });
				const current = data.find((p) => p.startTime <= nowSec && p.endTime > nowSec);
				setSelectedProg(current ?? null);
			})
			.catch(() => {
				if (!cancelled) setSchedule({ epgId, programmes: [] });
			});

		return () => {
			cancelled = true;
		};
	}, [epgId]);

	// Auto-scroll to current programme after programmes load
	useEffect(() => {
		if (!loading && currentRowRef.current) {
			currentRowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}, [loading]);

	const handleClose = useCallback(() => {
		setVisible(false);
		setTimeout(onClose, 300);
	}, [onClose]);
	const { sheetRef, handleProps } = useSheetDrag({ onClose: handleClose, enabled: visible });

	return (
		<div className="fixed inset-0 z-50">
			{/* Backdrop */}
			<div
				className={`absolute inset-0 bg-black/60 backdrop-blur-xs transition-opacity duration-300 ${
					visible ? "opacity-100" : "opacity-0"
				}`}
				onClick={handleClose}
			/>

			{/* Drawer */}
			<div
				ref={sheetRef}
				className={`absolute bottom-0 left-0 right-0 bg-card rounded-t-2xl shadow-2xl flex flex-col transition-[translate,max-height] duration-300 ease-out motion-reduce:transition-none overflow-hidden ${
					visible ? "translate-y-0" : "translate-y-full"
				}`}
			>
				{/* Handle */}
				<div
					{...handleProps}
					className="flex justify-center pt-3 pb-1 shrink-0 select-none"
				>
					<div className="w-9 h-1 rounded-full bg-border" />
				</div>

				{/* Header row: logo + name + close */}
				<div
					{...handleProps}
					className="flex items-center gap-3 px-5 pt-2 pb-4 shrink-0 select-none"
				>
					<div className="w-10 h-10 rounded-lg bg-secondary overflow-hidden shrink-0 flex items-center justify-center">
						{channel.logoUrl ? (
							<img
								src={channel.logoUrl}
								alt=""
								className="h-full w-full object-contain p-0.5"
								loading="lazy"
							/>
						) : (
							<TvMinimal className="h-5 w-5 text-muted-foreground/30" />
						)}
					</div>

					<div className="flex flex-col justify-center gap-0.5 flex-1 min-w-0">
						<div className="flex items-center gap-1.5">
							<span className="flex items-center gap-1 text-[10px] font-medium text-red-400">
								<span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
								LIVE
							</span>
						</div>
						<p className="text-sm font-semibold leading-tight truncate">
							{channel.name}
						</p>
					</div>

					{RECORDING_SUPPORTED &&
						(running ? (
							<button
								onClick={() =>
									setRecordRequest({ type: "stop", recording: running })
								}
								className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
							>
								<Square className="h-3 w-3 fill-current" />
								Stop recording
							</button>
						) : (
							<button
								onClick={() => setRecordRequest({ type: "now", onAir })}
								// Until the guide loads, it can't tell when the program on air ends.
								disabled={loading}
								className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium hover:bg-secondary/60 transition-colors shrink-0 disabled:opacity-50 disabled:pointer-events-none"
							>
								<Circle className="h-3 w-3 fill-red-500 text-red-500" />
								Record
							</button>
						))}
					{RECORDING_SUPPORTED && (
						<button
							onClick={() => setRecordRequest({ type: "range" })}
							aria-label="Record a time range"
							title="Record a time range"
							className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
						>
							<CalendarClock className="h-4 w-4" />
						</button>
					)}

					<button
						onClick={handleClose}
						aria-label="Close"
						className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="border-t border-border mx-5 shrink-0" />

				{/* 3-hour timeline */}
				{loading ? (
					<div className="flex items-center justify-center py-8 shrink-0">
						<LoaderCircle className="h-5 w-5 text-muted-foreground animate-spin" />
					</div>
				) : programmes.length > 0 ? (
					<div className="px-5 pt-4 pb-1 shrink-0">
						<p className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-2.5">
							On Air
						</p>
						<EpgTimelineBar
							programmes={programmes}
							now={now}
							windowStart={now - WINDOW_PAST}
							windowEnd={now + WINDOW_FUTURE}
							height="h-16"
							showLabels={true}
							selected={selectedProg}
							onSelect={setSelectedProg}
						/>
					</div>
				) : null}

				{programmes.length > 0 && (
					<div className="border-t border-border mx-5 mt-3 shrink-0" />
				)}

				{/* Schedule list */}
				<div className="flex flex-col flex-1 min-h-0">
					<div className="px-5 pt-4 pb-2 shrink-0">
						<p className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
							Schedule
						</p>
					</div>

					{loading ? (
						<div className="flex items-center justify-center flex-1 py-8">
							<LoaderCircle className="h-5 w-5 text-muted-foreground animate-spin" />
						</div>
					) : programmes.length === 0 ? (
						<div className="flex flex-col items-center justify-center flex-1 py-8 px-5 gap-2 text-center">
							<p className="text-sm text-muted-foreground">
								Schedule unavailable for this channel.
							</p>
							<p className="text-xs text-muted-foreground/60">
								No EPG data matched. Configure an EPG URL in provider settings to
								enable programme guides.
							</p>
						</div>
					) : (
						<ul className="flex-1 overflow-y-auto overscroll-y-none px-5 pb-4">
							{programmes.map((prog, idx) => {
								const isCurrent = prog.startTime <= now && prog.endTime > now;
								const isPast = prog.endTime <= now;
								const isSelected =
									selectedProg?.startTime === prog.startTime &&
									selectedProg?.channelId === prog.channelId;

								return (
									<li
										key={`${prog.channelId}-${prog.startTime}-${idx}`}
										ref={isCurrent ? currentRowRef : null}
										className="flex items-center gap-1"
									>
										<button
											onClick={() => setSelectedProg(prog)}
											className={`flex-1 min-w-0 flex items-center gap-3 py-2.5 px-3 rounded-lg mb-0.5 transition-colors text-left ${
												isSelected
													? "bg-primary/15"
													: isCurrent
														? "bg-primary/10 hover:bg-primary/15"
														: "hover:bg-secondary/40"
											}`}
										>
											{/* Left accent bar */}
											<div
												className={`w-0.5 h-8 rounded-full shrink-0 ${
													isSelected
														? "bg-primary"
														: isCurrent
															? "bg-primary/70"
															: isPast
																? "bg-border"
																: "bg-border/50"
												}`}
											/>

											{/* Time */}
											<span
												className={`text-xs tabular-nums shrink-0 min-w-12 whitespace-nowrap ${
													isPast && !isCurrent
														? "text-muted-foreground/60"
														: "text-muted-foreground"
												}`}
											>
												{formatHHMM(prog.startTime)}
											</span>

											{/* Duration */}
											<span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums w-14">
												{formatDuration(prog.startTime, prog.endTime)}
											</span>

											{/* Title */}
											<span
												className={`flex-1 text-sm leading-tight ${
													isCurrent || isSelected
														? "font-semibold text-foreground"
														: isPast
															? "text-muted-foreground/70"
															: "text-foreground"
												}`}
											>
												{prog.title}
											</span>

											{/* Badge */}
											{isCurrent ? (
												<span className="text-[10px] font-semibold text-primary shrink-0">
													▶ now
												</span>
											) : isPast ? (
												<span className="text-[10px] text-muted-foreground/50 shrink-0">
													✓
												</span>
											) : null}
										</button>
										{RECORDING_SUPPORTED && isPast && (
											<span className="w-8 shrink-0" aria-hidden />
										)}
										{RECORDING_SUPPORTED && !isPast && (
											<ProgramRecordButton
												program={prog}
												covering={recordingOfProgram(recordings, prog, now)}
												onRecord={() =>
													setRecordRequest({
														type: "program",
														program: prog,
													})
												}
												onStop={(recording) =>
													setRecordRequest({ type: "stop", recording })
												}
											/>
										)}
									</li>
								);
							})}
						</ul>
					)}
				</div>

				<div className="shrink-0 pb-2" />
			</div>

			{RECORDING_SUPPORTED && (
				<RecordDialog
					channel={channel}
					request={recordRequest}
					onClose={() => setRecordRequest(null)}
				/>
			)}
		</div>
	);
};

/**
 * The record button on a program in the schedule. It records the program, or
 * asks before it cancels or stops the recording that covers it, which can
 * cover more than this program.
 */
const ProgramRecordButton = ({
	program,
	covering,
	onRecord,
	onStop,
}: {
	program: EpgProgram;
	covering: DownloadRecord | undefined;
	onRecord: () => void;
	onStop: (recording: DownloadRecord) => void;
}) => {
	const base =
		"shrink-0 h-8 w-8 mb-0.5 flex items-center justify-center rounded-lg transition-colors";

	if (covering?.status === "recording") {
		return (
			<button
				onClick={() => onStop(covering)}
				aria-label={`Stop recording ${program.title}`}
				title="Recording"
				className={`${base} hover:bg-red-500/10`}
			>
				<span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
			</button>
		);
	}
	if (covering) {
		return (
			<button
				onClick={() => onStop(covering)}
				aria-label={`Cancel the recording of ${program.title}`}
				title="Scheduled. Click to cancel."
				className={`${base} hover:bg-red-500/10`}
			>
				<Circle className="h-3 w-3 fill-red-500 text-red-500" />
			</button>
		);
	}
	return (
		<button
			onClick={onRecord}
			aria-label={`Record ${program.title}`}
			title="Record"
			className={`${base} text-muted-foreground/50 hover:text-red-400 hover:bg-secondary/40`}
		>
			<Circle className="h-3 w-3" />
		</button>
	);
};
