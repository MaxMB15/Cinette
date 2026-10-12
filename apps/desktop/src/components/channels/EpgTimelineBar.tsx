// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { EpgProgram } from "@/lib/types";
import { formatHHMM, getGridMarks, toPct } from "@/lib/epg-window";

export const WINDOW_PAST = 3600; // default 1 hour before now
export const WINDOW_FUTURE = 7200; // default 2 hours after now

interface EpgTimelineBarProps {
	programmes: EpgProgram[];
	now: number;
	windowStart?: number;
	windowEnd?: number;
	/** Tailwind h-* class */
	height?: string;
	/** Render time labels below the bar */
	showLabels?: boolean;
	onSelect?: (prog: EpgProgram) => void;
	selected?: EpgProgram | null;
}

export const EpgTimelineBar = ({
	programmes,
	now,
	windowStart: wStart,
	windowEnd: wEnd,
	height = "h-10",
	showLabels = false,
	onSelect,
	selected,
}: EpgTimelineBarProps) => {
	const windowStart = wStart ?? now - WINDOW_PAST;
	const windowEnd = wEnd ?? now + WINDOW_FUTURE;
	const windowTotal = windowEnd - windowStart;

	const pct = (t: number) => toPct(t, windowStart, windowTotal);
	const nowPct = pct(now);
	const gridMarks = getGridMarks(windowStart, windowEnd);

	const visible = programmes.filter((p) => p.endTime > windowStart && p.startTime < windowEnd);

	return (
		<div className="w-full">
			{/* Bar */}
			<div
				className={`relative w-full rounded-md overflow-hidden border border-border/20 ${height}`}
				style={{
					background:
						"linear-gradient(180deg, hsl(var(--secondary)/0.35) 0%, hsl(var(--secondary)/0.18) 100%)",
				}}
			>
				{/* Program blocks — rendered first (lower z) */}
				{visible.map((prog, i) => {
					const left = pct(prog.startTime);
					const right = pct(prog.endTime);
					const width = right - left;
					if (width < 0.3) return null;

					const isCurrent = prog.startTime <= now && prog.endTime > now;
					const isPast = prog.endTime <= now;
					const isSelected =
						selected != null &&
						selected.startTime === prog.startTime &&
						selected.channelId === prog.channelId;

					// Inline gradient so we get depth even without Tailwind opacity classes
					const bg = isSelected
						? "linear-gradient(180deg, hsl(var(--primary)/0.72) 0%, hsl(var(--primary)/0.58) 100%)"
						: isCurrent
							? "linear-gradient(180deg, hsl(var(--primary)/0.50) 0%, hsl(var(--primary)/0.36) 100%)"
							: isPast
								? "linear-gradient(180deg, hsl(var(--muted-foreground)/0.15) 0%, hsl(var(--muted-foreground)/0.08) 100%)"
								: "linear-gradient(180deg, hsl(var(--primary)/0.20) 0%, hsl(var(--primary)/0.12) 100%)";

					const hoverBg = isSelected
						? "hsl(var(--primary)/0.80)"
						: isCurrent
							? "hsl(var(--primary)/0.56)"
							: isPast
								? "hsl(var(--muted-foreground)/0.22)"
								: "hsl(var(--primary)/0.28)";

					return (
						<div
							key={`${prog.channelId}-${prog.startTime}-${i}`}
							role={onSelect ? "button" : undefined}
							tabIndex={onSelect ? 0 : undefined}
							onClick={
								onSelect
									? (e) => {
											e.stopPropagation();
											onSelect(prog);
										}
									: undefined
							}
							onKeyDown={
								onSelect
									? (e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												e.stopPropagation();
												onSelect(prog);
											}
										}
									: undefined
							}
							title={prog.title}
							className={[
								"absolute top-0 bottom-0 border-r border-white/8 z-[1] overflow-hidden",
								"before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-white/18 before:pointer-events-none",
								onSelect
									? "cursor-pointer transition-all duration-100"
									: "cursor-default",
							].join(" ")}
							style={{
								left: `${left.toFixed(3)}%`,
								width: `${width.toFixed(3)}%`,
								background: bg,
							}}
							onMouseEnter={
								onSelect
									? (e) => {
											(e.currentTarget as HTMLDivElement).style.background =
												hoverBg;
										}
									: undefined
							}
							onMouseLeave={
								onSelect
									? (e) => {
											(e.currentTarget as HTMLDivElement).style.background =
												bg;
										}
									: undefined
							}
						>
							{width > 5 && (
								<span
									className={`absolute inset-x-1.5 top-1/2 -translate-y-1/2 truncate pointer-events-none leading-tight text-[9px] font-medium ${
										isCurrent || isSelected
											? "text-foreground/90"
											: isPast
												? "text-foreground/40"
												: "text-foreground/60"
									}`}
								>
									{prog.title}
								</span>
							)}
						</div>
					);
				})}

				{/* Gridlines ON TOP of program blocks at low opacity so they're visible through blocks */}
				{gridMarks.map((t) => (
					<div
						key={t}
						className={`absolute top-0 bottom-0 w-px pointer-events-none z-[2] ${
							t % 3600 === 0 ? "bg-white/18" : "bg-white/8"
						}`}
						style={{ left: `${pct(t).toFixed(3)}%` }}
					/>
				))}

				{/* "Now" marker — on top of everything */}
				<div
					className="absolute top-0 bottom-0 w-0.5 bg-red-400/85 z-[3] pointer-events-none"
					style={{ left: `${nowPct.toFixed(3)}%` }}
				/>
			</div>

			{/* Time labels below bar */}
			{showLabels && (
				<div className="relative w-full h-4 mt-0.5">
					{gridMarks.map((t) => {
						const p = pct(t);
						if (p < 3 || p > 97) return null;
						return (
							<span
								key={t}
								className={`absolute -translate-x-1/2 tabular-nums select-none ${
									t % 3600 === 0
										? "text-[9px] text-muted-foreground/65 font-medium"
										: "text-[8px] text-muted-foreground/40"
								}`}
								style={{ left: `${p.toFixed(3)}%` }}
							>
								{formatHHMM(t)}
							</span>
						);
					})}
				</div>
			)}
		</div>
	);
};
