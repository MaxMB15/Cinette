// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useRef, useCallback } from "react";
import { X, Tv2, Loader2 } from "lucide-react";
import type { Channel, EpgProgram } from "@/lib/types";
import { getEpgProgrammes } from "@/lib/tauri";
import { useSheetDrag } from "@/hooks/useSheetDrag";
import { EpgTimelineBar, WINDOW_PAST, WINDOW_FUTURE } from "./EpgTimelineBar";

interface LiveInfoDrawerProps {
	channel: Channel;
	onClose: () => void;
}

const formatTime = (unix: number): string =>
	new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const formatDuration = (startTime: number, endTime: number): string => {
	const mins = Math.floor((endTime - startTime) / 60);
	if (mins < 60) return `${mins} min`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

export const LiveInfoDrawer = ({ channel, onClose }: LiveInfoDrawerProps) => {
	const [visible, setVisible] = useState(false);
	const [programmes, setProgrammes] = useState<EpgProgram[]>([]);
	const [loading, setLoading] = useState(true);
	const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
	const [selectedProg, setSelectedProg] = useState<EpgProgram | null>(null);
	const currentRowRef = useRef<HTMLLIElement | null>(null);

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
		const channelId = channel.tvgId ?? channel.id;

		setLoading(true);
		getEpgProgrammes(channelId, rangeStart, rangeEnd)
			.then((data) => {
				if (!cancelled) {
					setProgrammes(data);
					const current = data.find((p) => p.startTime <= nowSec && p.endTime > nowSec);
					setSelectedProg(current ?? null);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setProgrammes([]);
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [channel.tvgId, channel.id]);

	// Update `now` every 30 seconds
	useEffect(() => {
		const id = setInterval(() => {
			setNow(Math.floor(Date.now() / 1000));
		}, 30_000);
		return () => clearInterval(id);
	}, []);

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
				className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
					visible ? "opacity-100" : "opacity-0"
				}`}
				onClick={handleClose}
			/>

			{/* Drawer */}
			<div
				ref={sheetRef}
				className={`absolute bottom-0 left-0 right-0 bg-card rounded-t-2xl shadow-2xl flex flex-col transition-[transform,max-height] duration-300 ease-out motion-reduce:transition-none overflow-hidden ${
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
							<Tv2 className="h-5 w-5 text-muted-foreground/30" />
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
						<Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
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
							<Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
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
						<ul className="flex-1 overflow-y-auto px-5 pb-4">
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
									>
										<button
											onClick={() => setSelectedProg(prog)}
											className={`w-full flex items-center gap-3 py-2.5 px-3 rounded-lg mb-0.5 transition-colors text-left ${
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
												className={`text-xs tabular-nums shrink-0 w-12 ${
													isPast && !isCurrent
														? "text-muted-foreground/60"
														: "text-muted-foreground"
												}`}
											>
												{formatTime(prog.startTime)}
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
									</li>
								);
							})}
						</ul>
					)}
				</div>

				<div className="shrink-0 pb-2" />
			</div>
		</div>
	);
};
