// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

type RootProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>;

interface SliderProps extends Omit<
	RootProps,
	"value" | "defaultValue" | "onValueChange" | "onValueCommit"
> {
	value: number;
	/** Called while the value moves, on every drag step or key press. */
	onValueChange?: (value: number) => void;
	/** Read out by screen readers instead of the bare number, such as "1:05 of 42:10". */
	"aria-valuetext"?: string;
}

/**
 * How the thumb got focus, set on it as `data-focus-source`. A press puts
 * focus on the thumb too, and WebKit then treats it as keyboard focus at the
 * first key, so `:focus-visible` can't tell the two apart. See `isSliderOwnKey`.
 */
type FocusSource = "pointer" | "keyboard";

/**
 * True while Tab or Shift+Tab is moving focus. Focus that arrives any other
 * way, such as an overlay giving it back when it closes, isn't from the
 * keyboard, even though no press is under way.
 */
let tabbing = false;
if (typeof document !== "undefined") {
	document.addEventListener(
		"keydown",
		(e) => {
			tabbing = e.key === "Tab";
		},
		true
	);
	document.addEventListener(
		"pointerdown",
		() => {
			tabbing = false;
		},
		true
	);
}

/**
 * Presses that shouldn't move the slider. Radix only checks for the primary
 * button, but a Control-click on a Mac opens the context menu, which takes the
 * release. A second finger would move the bar while the first is still down.
 */
const isIgnoredPress = (e: React.PointerEvent): boolean =>
	e.button !== 0 || (e.pointerType === "mouse" && e.ctrlKey) || e.isPrimary === false;

/**
 * A horizontal slider for one value.
 *
 * The thumb and the filled part of the track are both drawn from `value` in
 * the same render, so they can't drift apart. The fill ends under the thumb,
 * which has the same color. The root reaches 8px above and below the track
 * so the thin bar is easier to grab, without taking more room in the layout.
 *
 * Only a press with the primary button or the first finger moves it, so a
 * right-click or a Control-click doesn't. The focus ring only shows when the
 * thumb was reached with Tab. Focus that comes back to it later, such as from
 * a closed overlay, keeps the source it had.
 */
const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
	(
		{
			className,
			value,
			min = 0,
			max = 100,
			onValueChange,
			onPointerDown,
			onPointerUp,
			onLostPointerCapture,
			"aria-label": ariaLabel,
			"aria-valuetext": ariaValueText,
			...props
		},
		ref
	) => {
		const [focusSource, setFocusSource] = React.useState<FocusSource | null>(null);
		// True from a press until its release, so focus that arrives in
		// between came from the press.
		const pressingRef = React.useRef(false);
		// How the thumb last got focus. It outlives a blur, so focus given
		// back to the thumb gets the same source again.
		const lastSourceRef = React.useRef<FocusSource>("pointer");
		const endPress = () => {
			pressingRef.current = false;
		};

		return (
			<SliderPrimitive.Root
				ref={ref}
				min={min}
				max={max}
				value={[value]}
				onValueChange={onValueChange && (([v]) => onValueChange(v))}
				onPointerDown={(e) => {
					// Radix skips its own handler for a prevented event.
					if (isIgnoredPress(e)) {
						e.preventDefault();
						return;
					}
					pressingRef.current = true;
					lastSourceRef.current = "pointer";
					// A press on a thumb that already has focus doesn't focus it again.
					setFocusSource((source) => source && "pointer");
					onPointerDown?.(e);
				}}
				onPointerUp={(e) => {
					endPress();
					onPointerUp?.(e);
				}}
				// Also covers a canceled touch, which sends no pointerup.
				onLostPointerCapture={(e) => {
					endPress();
					onLostPointerCapture?.(e);
				}}
				className={cn(
					"relative -my-2 flex w-full cursor-pointer touch-none select-none items-center py-2",
					"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
					className
				)}
				{...props}
			>
				<SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
					<SliderPrimitive.Range className="absolute h-full bg-primary" />
				</SliderPrimitive.Track>
				<SliderPrimitive.Thumb
					aria-label={ariaLabel}
					aria-valuetext={ariaValueText}
					data-focus-source={focusSource ?? undefined}
					onFocus={() => {
						const source = pressingRef.current
							? "pointer"
							: tabbing
								? "keyboard"
								: lastSourceRef.current;
						lastSourceRef.current = source;
						setFocusSource(source);
					}}
					onBlur={() => setFocusSource(null)}
					className={cn(
						"block h-4 w-4 rounded-full bg-primary shadow ring-offset-background transition-transform hover:scale-110 focus-visible:outline-none",
						"data-[focus-source=keyboard]:ring-2 data-[focus-source=keyboard]:ring-ring data-[focus-source=keyboard]:ring-offset-2"
					)}
				/>
			</SliderPrimitive.Root>
		);
	}
);
Slider.displayName = "Slider";

export { Slider };
