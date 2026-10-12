// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId, type MouseEvent, type ReactNode } from "react";
import { ChevronsRight, SkipForward, Undo2 } from "lucide-react";
import type { SegmentSkipping } from "@/hooks/useSegmentSkipping";
import { COUNTDOWN_MS } from "@/lib/skip-segments";
import { cn } from "@/lib/utils";

/** The look of the prompt's buttons, which sit over the video. */
const BUTTON =
	"pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-md bg-black/70 px-4 text-sm font-medium text-white shadow-lg ring-1 ring-inset ring-white/25 backdrop-blur-sm transition-colors hover:bg-black/85 active:bg-black/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

interface SkipSegmentPromptProps {
	skipping: SegmentSkipping;
	/**
	 * Lifts the prompt above the controls while they show, and keeps a Skip
	 * button up after its first few seconds.
	 */
	controlsVisible: boolean;
	/** The countdown holds while the video is paused. */
	playing: boolean;
	/**
	 * Called after a button press. The pressed button goes away, so this is
	 * where the player takes focus back for its keyboard shortcuts.
	 */
	onPressed?: () => void;
}

/**
 * The Skip button, the countdown to the next episode and the "Skipped intro"
 * notice, in the bottom right corner of the player. `useSegmentSkipping`
 * decides which one shows. Enter does the same as the Skip button, through
 * the player's shortcuts.
 */
export const SkipSegmentPrompt = ({
	skipping,
	controlsVisible,
	playing,
	onPressed,
}: SkipSegmentPromptProps) => {
	const hintId = useId();
	const { offer, notice, countdown } = skipping;

	// Keeps the click from reaching the player, where it would toggle the controls.
	const press = (action: () => void) => (e: MouseEvent) => {
		e.stopPropagation();
		action();
		onPressed?.();
	};

	let content: ReactNode = null;
	if (countdown) {
		content = (
			<div className="flex items-center gap-2">
				<button type="button" onClick={press(skipping.cancelCountdown)} className={BUTTON}>
					{countdown.cancelLabel}
				</button>
				<button
					type="button"
					onClick={press(skipping.skip)}
					className={cn(BUTTON, "relative overflow-hidden")}
				>
					<span
						aria-hidden
						data-testid="countdown-fill"
						className="countdown-fill absolute inset-0 bg-white/25"
						style={{
							animationDuration: `${COUNTDOWN_MS}ms`,
							animationPlayState: playing ? "running" : "paused",
						}}
						onAnimationEnd={() => skipping.skip()}
					/>
					<SkipForward className="relative h-4 w-4" aria-hidden />
					<span className="relative">Next episode</span>
				</button>
			</div>
		);
	} else if (notice) {
		content = (
			<div className="pointer-events-auto flex min-h-11 items-center gap-1 rounded-md bg-black/70 pl-4 pr-1 text-sm text-white shadow-lg ring-1 ring-inset ring-white/25 backdrop-blur-sm">
				<span>{notice.label}</span>
				<button
					type="button"
					onClick={press(skipping.undo)}
					className="inline-flex min-h-9 items-center gap-1.5 rounded px-3 font-medium hover:bg-white/15 active:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
				>
					<Undo2 className="h-4 w-4" aria-hidden />
					Undo
				</button>
			</div>
		);
	} else if (offer && (offer.fresh || controlsVisible)) {
		const Icon = offer.next ? SkipForward : ChevronsRight;
		content = (
			<div className="flex flex-col items-end gap-1">
				<button
					type="button"
					onClick={press(skipping.skip)}
					aria-describedby={offer.unsure ? hintId : undefined}
					className={BUTTON}
				>
					{offer.label}
					<Icon className="h-4 w-4" aria-hidden />
				</button>
				{offer.unsure && (
					<p
						id={hintId}
						title="This video's length doesn't match the one these times were made for."
						className="pointer-events-auto rounded bg-black/60 px-2 py-0.5 text-[11px] text-white/80"
					>
						Times may be off
					</p>
				)}
			</div>
		);
	}

	// The live region stays in the page so screen readers hear what appears in it.
	return (
		<div
			aria-live="polite"
			className={cn(
				"pointer-events-none absolute bottom-[calc(1.5rem_+_env(safe-area-inset-bottom))] right-[calc(1rem_+_env(safe-area-inset-right))] z-10 flex flex-col items-end transition-transform duration-300 ease-out motion-reduce:transition-none",
				controlsVisible && "-translate-y-[6.5rem]"
			)}
		>
			{content}
			{countdown && <span className="sr-only">Next episode starts in a few seconds.</span>}
		</div>
	);
};
