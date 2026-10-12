// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useId, useRef, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { ChevronsRight, SkipForward, Undo2 } from "lucide-react";
import { offerShows, type SegmentSkipping } from "@/hooks/useSegmentSkipping";
import { COUNTDOWN_MS } from "@/lib/skip-segments";
import { cn } from "@/lib/utils";

/** The look of the prompt's buttons, which sit over the video. */
const BUTTON =
	"pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-md bg-black/70 px-4 text-sm font-medium text-white shadow-lg ring-1 ring-inset ring-white/25 backdrop-blur-sm transition-colors hover:bg-black/85 active:bg-black/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

/** Why times made for a video of another length may be off. */
const MISMATCH_HINT = "This video's length doesn't match the one these times were made for.";

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
	 * Hides the prompt and holds the countdown while something is open over
	 * it, such as the shortcuts or the subtitle picker. The prompt stays in
	 * the page, so the countdown goes on from where it was.
	 */
	held?: boolean;
	/**
	 * Called when focus was on one of the prompt's buttons and the button went
	 * away, such as after a press or when the segment ends. This is where the
	 * player takes focus back for its keyboard shortcuts.
	 */
	onFocusLost?: () => void;
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
	held = false,
	onFocusLost,
}: SkipSegmentPromptProps) => {
	const hintId = useId();
	const { offer, notice, countdown } = skipping;
	const wrapperRef = useRef<HTMLDivElement>(null);
	// Whether focus is on one of the buttons, or was until it went away.
	const focusedRef = useRef(false);

	// A button that goes away while focused leaves focus on the page itself,
	// without a blur event in every browser, so this checks after each render.
	useEffect(() => {
		if (!focusedRef.current) return;
		const active = document.activeElement;
		if (wrapperRef.current?.contains(active)) return;
		focusedRef.current = false;
		if (active === null || active === document.body) onFocusLost?.();
	});

	// Focus moving to another element was the user's doing. Moving to nothing
	// may be a button going away, which the check above handles.
	const handleBlur = (e: FocusEvent) => {
		if (e.relatedTarget !== null && !wrapperRef.current?.contains(e.relatedTarget)) {
			focusedRef.current = false;
		}
	};

	// Keeps the click from reaching the player, where it would toggle the controls.
	const press = (action: () => void) => (e: MouseEvent) => {
		e.stopPropagation();
		action();
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
							animationPlayState: playing && !held ? "running" : "paused",
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
			<div className="pointer-events-auto flex items-stretch overflow-hidden rounded-md bg-black/70 text-sm text-white shadow-lg ring-1 ring-inset ring-white/25 backdrop-blur-sm">
				<span className="flex items-center pl-4 pr-3">{notice.label}</span>
				<button
					type="button"
					onClick={press(skipping.undo)}
					className="inline-flex min-h-11 items-center gap-1.5 border-l border-white/20 px-3 font-medium hover:bg-white/15 active:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
				>
					<Undo2 className="h-4 w-4" aria-hidden />
					Undo
				</button>
			</div>
		);
	} else if (offer && offerShows(offer, controlsVisible)) {
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
					<>
						<p
							aria-hidden
							title={MISMATCH_HINT}
							className="pointer-events-auto rounded bg-black/60 px-2 py-0.5 text-[11px] text-white/80"
						>
							Times may be off
						</p>
						{/* The button's description, with the reason the tooltip gives. */}
						<span id={hintId} className="sr-only">
							Times may be off. {MISMATCH_HINT}
						</span>
					</>
				)}
			</div>
		);
	}

	// Screen readers hear what the prompt offers once, when it first comes
	// up, rather than each time the button shows again with the controls.
	const status = countdown
		? "Next episode starts in a few seconds."
		: (notice?.label ?? offer?.label ?? "");

	return (
		<div
			ref={wrapperRef}
			onFocus={() => {
				focusedRef.current = true;
			}}
			onBlur={handleBlur}
			className={cn(
				"pointer-events-none absolute bottom-[calc(1.5rem_+_env(safe-area-inset-bottom))] right-[calc(1rem_+_env(safe-area-inset-right))] z-10 flex flex-col items-end transition-transform duration-300 ease-out motion-reduce:transition-none",
				controlsVisible && "-translate-y-[6.5rem]",
				held && "invisible"
			)}
		>
			{content}
			<p role="status" className="sr-only">
				{status}
			</p>
		</div>
	);
};
