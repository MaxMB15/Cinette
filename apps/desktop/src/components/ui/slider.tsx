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
	/** Called once when a drag ends, and on each key press. */
	onValueCommit?: (value: number) => void;
	/** Read out by screen readers instead of the bare number, such as "1:05 of 42:10". */
	"aria-valuetext"?: string;
}

/**
 * A horizontal slider for one value.
 *
 * The thumb and the filled part of the track are both drawn from `value` in
 * the same render, so they can't drift apart. The fill ends under the thumb,
 * which has the same color. The root reaches 8px above and below the track
 * so the thin bar is easier to grab, without taking more room in the layout.
 */
const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
	(
		{
			className,
			value,
			min = 0,
			max = 100,
			onValueChange,
			onValueCommit,
			"aria-label": ariaLabel,
			"aria-valuetext": ariaValueText,
			...props
		},
		ref
	) => (
		<SliderPrimitive.Root
			ref={ref}
			min={min}
			max={max}
			value={[value]}
			onValueChange={onValueChange && (([v]) => onValueChange(v))}
			onValueCommit={onValueCommit && (([v]) => onValueCommit(v))}
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
				className="block h-4 w-4 rounded-full bg-primary shadow ring-offset-background transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
		</SliderPrimitive.Root>
	)
);
Slider.displayName = "Slider";

export { Slider };
