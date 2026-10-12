// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { getPlatform } from "@/lib/platform";
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
 * Set by a Tab or Shift+Tab keydown and cleared when the key comes up or at
 * the next keydown or press. Focus moves while the key is down, so focus that
 * arrives while it's set came from Tab.
 */
let tabbing = false;
if (typeof document !== "undefined") {
	const startTab = (e: KeyboardEvent) => {
		tabbing = e.key === "Tab";
	};
	const endTab = () => {
		tabbing = false;
	};
	document.addEventListener("keydown", startTab, true);
	document.addEventListener("keyup", endTab, true);
	document.addEventListener("pointerdown", endTab, true);
	// The keyup goes elsewhere when the window loses focus with Tab down.
	window.addEventListener("blur", endTab);
	// A hot update in development loads this module again.
	import.meta.hot?.dispose(() => {
		document.removeEventListener("keydown", startTab, true);
		document.removeEventListener("keyup", endTab, true);
		document.removeEventListener("pointerdown", endTab, true);
		window.removeEventListener("blur", endTab);
	});
}

/**
 * Presses that shouldn't move the slider. Radix takes a press from any button,
 * and a Control-click on a Mac opens the context menu, which takes the
 * release.
 */
const isIgnoredPress = (e: React.PointerEvent): boolean =>
	e.button !== 0 || (e.ctrlKey && e.pointerType === "mouse" && getPlatform() === "macos");

/** The pointer pressing the slider, and the element that holds its capture. */
interface Press {
	id: number;
	target: Element;
}

/**
 * A horizontal slider for one value.
 *
 * The thumb and the filled part of the track are both drawn from `value` in
 * the same render, so they can't drift apart. The fill ends under the thumb,
 * which has the same color. The root reaches 8px above and below the track
 * so the thin bar is easier to grab, without taking more room in the layout.
 *
 * One pointer at a time moves it, and only with the primary button. A
 * right-click, a Control-click on a Mac, or a second finger or a pen while
 * one is pressing it doesn't. A tap while a thumb rests elsewhere on the
 * screen still does. Moves and releases of any other pointer never reach
 * Radix or the `onPointerMove`, `onPointerUp` and `onLostPointerCapture`
 * handlers, and while nothing presses the slider every pointer counts as
 * another, so hover moves don't either. A touch or pen press captures its
 * pointer on its own, so Radix would follow an ignored one otherwise.
 *
 * The focus ring only shows when the thumb was reached with Tab. Focus that
 * comes back to it later, such as from a closed overlay, keeps the source it
 * had.
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
			onPointerMove,
			onPointerUp,
			onLostPointerCapture,
			"aria-label": ariaLabel,
			"aria-valuetext": ariaValueText,
			...props
		},
		ref
	) => {
		const [focusSource, setFocusSource] = React.useState<FocusSource | null>(null);
		const pressRef = React.useRef<Press | null>(null);
		// How the thumb last got focus, or a press on it. It outlives a blur,
		// so focus given back to the thumb gets the same source again.
		const lastSourceRef = React.useRef<FocusSource>("pointer");
		/**
		 * Whether a press is under way. Radix holds the capture until the
		 * release, so a press whose release never arrived, such as one on an
		 * element that went away, doesn't count.
		 */
		const isPressing = (): boolean => {
			const press = pressRef.current;
			return !!press && press.target.hasPointerCapture(press.id);
		};
		/** Whether `e` comes from a pointer other than the one pressing the slider. */
		const isOtherPointer = (e: React.PointerEvent): boolean =>
			e.pointerId !== pressRef.current?.id;

		return (
			<SliderPrimitive.Root
				ref={ref}
				min={min}
				max={max}
				value={[value]}
				onValueChange={onValueChange && (([v]) => onValueChange(v))}
				onPointerDown={(e) => {
					// Radix skips its own handler for a prevented event.
					if (isIgnoredPress(e) || (isPressing() && isOtherPointer(e))) {
						e.preventDefault();
						return;
					}
					pressRef.current = { id: e.pointerId, target: e.target as Element };
					lastSourceRef.current = "pointer";
					// A press on a thumb that already has focus doesn't focus it again.
					setFocusSource((source) => source && "pointer");
					onPointerDown?.(e);
				}}
				onPointerMove={(e) => {
					if (isOtherPointer(e)) {
						e.preventDefault();
						return;
					}
					onPointerMove?.(e);
				}}
				onPointerUp={(e) => {
					if (isOtherPointer(e)) {
						e.preventDefault();
						return;
					}
					pressRef.current = null;
					onPointerUp?.(e);
				}}
				// Also covers a canceled touch, which sends no pointerup.
				onLostPointerCapture={(e) => {
					if (isOtherPointer(e)) return;
					pressRef.current = null;
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
						const source = isPressing()
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
