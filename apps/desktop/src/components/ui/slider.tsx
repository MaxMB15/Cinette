// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import * as React from "react";
import { cn } from "@/lib/utils";

interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
	value: number;
	min?: number;
	max?: number;
	step?: number;
	onValueChange?: (value: number) => void;
}

// Half the thumb width in px (thumb is w-4 = 16px). The browser offsets the thumb
// so its centre sits exactly at the theoretical percentage position, but it can't
// move past the track edges. At 0 % the centre is 8 px in, at 100 % it is 8 px
// from the right. We apply the same correction to the gradient stop so the filled
// portion always ends exactly at the thumb centre.
const THUMB_HALF = 8;

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
	({ className, value, min = 0, max = 100, step = 1, onValueChange, ...props }, ref) => {
		const range = max - min;
		const percent = range > 0 ? ((value - min) / range) * 100 : 0;
		// offset shrinks from +THUMB_HALF at 0 % to −THUMB_HALF at 100 %
		const offset = THUMB_HALF - (percent / 100) * (THUMB_HALF * 2);
		const stop = `calc(${percent}% + ${offset}px)`;
		return (
			<input
				ref={ref}
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onValueChange?.(Number(e.target.value))}
				className={cn(
					"w-full h-2 rounded-full appearance-none cursor-pointer bg-secondary",
					"[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary",
					className
				)}
				style={{
					background: `linear-gradient(to right, hsl(var(--primary)) ${stop}, hsl(var(--secondary)) ${stop})`,
				}}
				{...props}
			/>
		);
	}
);
Slider.displayName = "Slider";

export { Slider };
