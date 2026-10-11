// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatSkip } from "@/lib/format";
import type { SkipIntervals } from "@/lib/player-prefs";

type Side = "back" | "forward";

/** A second tap on the same side within this time makes a double-tap. */
export const DOUBLE_TAP_MS = 300;
/** After a double-tap, each further tap on that side within this time skips again. */
export const SKIP_CHAIN_MS = 800;
/** Taps this far into the video from either edge, as a fraction of its width, can skip. */
const SIDE_ZONE = 0.4;
/** A touch that moves further than this many pixels is a swipe, not a tap. */
const TAP_SLOP = 12;

interface VideoTapLayerProps {
	/** False when the stream can't seek. Every tap then just toggles the controls. */
	seekable: boolean;
	skip: SkipIntervals;
	onSkip: (seconds: number) => void;
	/** A single tap, which shows or hides the controls. */
	onTap: () => void;
}

/**
 * Tap handling for touch screens. A single tap toggles the controls. A
 * double-tap on the left or right part of the video skips back or forward,
 * and each further tap on that side adds another skip, as on YouTube. A
 * single tap on a side waits a moment to see whether a second tap follows,
 * so a double-tap never toggles the controls.
 */
export const VideoTapLayer = ({ seekable, skip, onSkip, onTap }: VideoTapLayerProps) => {
	const [feedback, setFeedback] = useState<{ side: Side; total: number; shown: boolean } | null>(
		null
	);
	const downRef = useRef<{ x: number; y: number } | null>(null);
	const pendingTapRef = useRef<{ side: Side; timer: ReturnType<typeof setTimeout> } | null>(null);
	const chainRef = useRef<{ side: Side; until: number; total: number } | null>(null);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (pendingTapRef.current) clearTimeout(pendingTapRef.current.timer);
			if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
		},
		[]
	);

	const cancelPendingTap = (): Side | null => {
		const pending = pendingTapRef.current;
		if (!pending) return null;
		clearTimeout(pending.timer);
		pendingTapRef.current = null;
		return pending.side;
	};

	const skipFrom = (side: Side, now: number, previousTotal: number) => {
		const step = side === "back" ? skip.back : skip.forward;
		const total = previousTotal + step;
		chainRef.current = { side, until: now + SKIP_CHAIN_MS, total };
		onSkip(side === "back" ? -step : step);
		setFeedback({ side, total, shown: true });
		if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
		hideTimerRef.current = setTimeout(
			() => setFeedback((f) => f && { ...f, shown: false }),
			SKIP_CHAIN_MS
		);
	};

	const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.isPrimary === false) return;
		const down = downRef.current;
		downRef.current = null;
		if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP) return;

		const rect = e.currentTarget.getBoundingClientRect();
		const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
		const side: Side | null = !seekable
			? null
			: x < SIDE_ZONE
				? "back"
				: x > 1 - SIDE_ZONE
					? "forward"
					: null;
		const now = Date.now();

		const chain = chainRef.current;
		chainRef.current = null;
		if (side && chain && chain.side === side && now < chain.until) {
			cancelPendingTap();
			skipFrom(side, now, chain.total);
			return;
		}
		if (side && cancelPendingTap() === side) {
			skipFrom(side, now, 0);
			return;
		}
		if (side) {
			const timer = setTimeout(() => {
				pendingTapRef.current = null;
				onTap();
			}, DOUBLE_TAP_MS);
			pendingTapRef.current = { side, timer };
			return;
		}
		onTap();
	};

	// Taps are handled here, so the click mustn't reach the player and show the controls too.
	return (
		<div
			className="absolute inset-0 touch-manipulation select-none"
			onPointerDown={(e) => {
				if (e.isPrimary !== false) downRef.current = { x: e.clientX, y: e.clientY };
			}}
			onPointerUp={handlePointerUp}
			onPointerCancel={() => {
				downRef.current = null;
			}}
			onClick={(e) => e.stopPropagation()}
		>
			{feedback && (
				<div
					className={cn(
						"pointer-events-none absolute inset-y-0 flex w-2/5 items-center justify-center bg-white/10 transition-opacity duration-300",
						feedback.side === "back"
							? "left-0 rounded-r-[50%] pl-[env(safe-area-inset-left)]"
							: "right-0 rounded-l-[50%] pr-[env(safe-area-inset-right)]",
						feedback.shown ? "opacity-100" : "opacity-0"
					)}
				>
					<div className="flex flex-col items-center gap-1 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
						{feedback.side === "back" ? (
							<ChevronsLeft className="h-7 w-7" />
						) : (
							<ChevronsRight className="h-7 w-7" />
						)}
						<span className="text-sm font-semibold tabular-nums">
							{formatSkip(
								feedback.side === "back" ? -feedback.total : feedback.total
							)}
						</span>
					</div>
				</div>
			)}
		</div>
	);
};
