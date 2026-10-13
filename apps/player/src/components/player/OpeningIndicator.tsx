// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { LoaderCircle, RotateCw } from "lucide-react";

/** After this long, add a line saying a slow server is normal. */
const SLOW_OPEN_MS = 15_000;
/** After this long, offer to start over. Some streams never get past opening,
 *  for example a playlist whose segments never arrive. */
const STUCK_OPEN_MS = 45_000;

interface OpeningIndicatorProps {
	/** Loads the stream again. The button only shows when this is set. */
	onRetry?: () => void;
}

/**
 * Centered spinner shown while a stream opens, so a slow server isn't just a
 * black screen. It ignores the pointer so taps and double-clicks still reach
 * the player underneath. Only the "Try again" button takes them, and it sits
 * above any layer that catches taps on the video.
 */
export const OpeningIndicator = ({ onRetry }: OpeningIndicatorProps) => {
	const [slow, setSlow] = useState(false);
	const [stuck, setStuck] = useState(false);

	useEffect(() => {
		const slowTimer = setTimeout(() => setSlow(true), SLOW_OPEN_MS);
		const stuckTimer = setTimeout(() => setStuck(true), STUCK_OPEN_MS);
		return () => {
			clearTimeout(slowTimer);
			clearTimeout(stuckTimer);
		};
	}, []);

	return (
		<div className="pointer-events-none flex flex-col items-center gap-3 p-6 text-center">
			<div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
				<LoaderCircle className="h-10 w-10 animate-spin text-white/80" aria-hidden />
				<p className="text-sm font-medium text-white/90">Opening stream</p>
				{slow && (
					<p className="max-w-xs text-xs text-white/60">
						Some servers take a while to respond.
					</p>
				)}
			</div>
			{stuck && onRetry && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onRetry();
					}}
					onDoubleClick={(e) => e.stopPropagation()}
					className="pointer-events-auto relative z-10 mt-1 inline-flex min-h-11 items-center gap-2 rounded-full bg-white/10 px-5 text-sm font-medium text-white ring-1 ring-inset ring-white/20 transition hover:bg-white/20 active:bg-white/20 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-white/60"
				>
					<RotateCw className="h-4 w-4" aria-hidden />
					Try again
				</button>
			)}
		</div>
	);
};
