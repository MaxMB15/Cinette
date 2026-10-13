// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { LoaderCircle, RotateCw, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConnectionStatusOverlayProps {
	/** True while the Rust reconnect monitor is actively re-issuing loadfile
	 *  after an `EndFile(Error)` from libmpv. */
	reconnecting: boolean;
	/** Attempt counter shown when `reconnecting` is true. */
	reconnectAttempt: number;
	/** True when mpv's `paused-for-cache` flag has been set for longer than
	 *  the debounce window in `useMpv` (i.e. real network stall, not a
	 *  startup blip). */
	buffering: boolean;
	/** True when the Rust reconnect monitor has exhausted its retry budget
	 *  (URL genuinely unreachable). User must take action — show a retry
	 *  button so they don't get stuck. */
	loadFailed: boolean;
	/** True when the stream stopped before it ever played, for example
	 *  because the server answered with an error. Shown like `loadFailed`
	 *  with wording that fits a first open. */
	openFailed?: boolean;
	/** Transient flag set by `useMpv` for ~2.5 s right after a successful
	 *  reconnect (either via `mpv://reconnected` or the navigator.onLine
	 *  auto-recovery path). Powers the green "Connection restored" banner. */
	recentlyRecovered: boolean;
	/** Invoked when the user clicks the retry button on the failed state. */
	onRetry?: () => void;
	/** Puts the banner below the player's top bar. On phones that bar holds
	 *  the Back button, which the banner would otherwise cover. */
	belowTopBar?: boolean;
}

type Status = "idle" | "buffering" | "reconnecting" | "failed" | "recovered";

/**
 * Prominent overlay surfacing connection health to the user.
 *
 *  - `buffering` (amber): cache drained, FFmpeg silently retrying. Recovery
 *    is usually transparent and happens within seconds of network return.
 *  - `reconnecting` (red): hard `EndFile(Error)` / `eof-reached` — the
 *    monitor is re-issuing `loadfile` with exponential backoff.
 *  - `failed` (red, terminal): all retries exhausted. Shows a retry button.
 *  - `recovered` (green): briefly shown for ~2.5 s after the connection
 *    returns, so the user gets positive confirmation.
 *
 * Priority (high → low when multiple flags are true):
 *   failed > reconnecting > recovered > buffering > idle
 *
 * `recovered` deliberately outranks `buffering` so the green ack survives a
 * post-recovery cache-refill blip on the new stream. It still loses to
 * `reconnecting`/`failed` so a fresh outage immediately overrides the
 * lingering green.
 */
export const ConnectionStatusOverlay = ({
	reconnecting,
	reconnectAttempt,
	buffering,
	loadFailed,
	openFailed = false,
	recentlyRecovered,
	onRetry,
	belowTopBar = false,
}: ConnectionStatusOverlayProps) => {
	const status: Status =
		loadFailed || openFailed
			? "failed"
			: reconnecting
				? "reconnecting"
				: recentlyRecovered
					? "recovered"
					: buffering
						? "buffering"
						: "idle";

	if (status === "idle") return null;

	const config = {
		buffering: {
			container: "border-amber-400/50 bg-amber-950/85 text-amber-100 shadow-amber-500/20",
			iconWrap: "bg-amber-500/20 text-amber-300",
			title: "Connection issues",
			detail: "Stream stalled — waiting for network.",
			Icon: <WifiOff className="h-5 w-5" />,
			Trailing: <LoaderCircle className="h-4 w-4 animate-spin text-amber-300" />,
		},
		reconnecting: {
			container: "border-red-400/50 bg-red-950/85 text-red-100 shadow-red-500/20",
			iconWrap: "bg-red-500/20 text-red-300",
			title: "Connection lost",
			detail:
				reconnectAttempt > 1
					? `Reconnecting to stream (attempt #${reconnectAttempt})…`
					: "Reconnecting to stream…",
			Icon: <WifiOff className="h-5 w-5" />,
			Trailing: <LoaderCircle className="h-4 w-4 animate-spin text-red-300" />,
		},
		failed: {
			container: "border-red-400/60 bg-red-950/90 text-red-100 shadow-red-500/30",
			iconWrap: "bg-red-500/25 text-red-200",
			title: "Stream unavailable",
			detail: loadFailed
				? "Couldn't connect after several attempts. Check your network."
				: "The stream didn't open. The server may be down or the link may have expired.",
			Icon: <WifiOff className="h-5 w-5" />,
			Trailing: onRetry ? (
				<button
					type="button"
					onClick={onRetry}
					className="inline-flex items-center gap-1.5 rounded-md bg-red-500/20 px-2.5 py-1.5 text-xs font-medium text-red-100 ring-1 ring-inset ring-red-400/30 transition hover:bg-red-500/30 focus:outline-hidden focus:ring-2 focus:ring-red-400/60"
				>
					<RotateCw className="h-3.5 w-3.5" />
					Retry
				</button>
			) : null,
		},
		recovered: {
			container:
				"border-emerald-400/50 bg-emerald-950/85 text-emerald-100 shadow-emerald-500/20",
			iconWrap: "bg-emerald-500/20 text-emerald-300",
			title: "Connection restored",
			detail: "Stream is playing again.",
			Icon: (
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="h-5 w-5"
					aria-hidden
				>
					<path d="M5 12l5 5L20 7" />
				</svg>
			),
			Trailing: null as React.ReactNode,
		},
	}[status];

	// Inset from both sides and centered with auto margins, so a phone gets
	// nearly its full width. With left-1/2 the banner could only use half. The
	// top clears the notch or Dynamic Island, and the top bar when asked.
	return (
		<div
			role="status"
			aria-live="polite"
			className={cn(
				"absolute left-4 right-4 z-50 mx-auto w-fit max-w-md flex items-center gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-md",
				belowTopBar
					? "top-[calc(4.5rem+env(safe-area-inset-top))]"
					: "top-[calc(1.5rem+env(safe-area-inset-top))]",
				config.container
			)}
		>
			<div
				className={`flex h-9 w-9 items-center justify-center rounded-full ${config.iconWrap}`}
			>
				{config.Icon}
			</div>
			<div className="flex-1 min-w-0">
				<p className="text-sm font-semibold leading-tight">{config.title}</p>
				<p className="text-xs leading-tight opacity-80 mt-0.5">{config.detail}</p>
			</div>
			{config.Trailing && <div className="shrink-0">{config.Trailing}</div>}
		</div>
	);
};
