// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T> {
	value: T;
	label: string;
	icon?: ReactNode;
}

interface SegmentedControlProps<T> {
	value: T;
	onChange: (value: T) => void;
	options: SegmentedOption<T>[];
	/** Stretches the options to share the full width instead of sizing to their labels. */
	fill?: boolean;
	className?: string;
	"aria-label"?: string;
}

/** A row of buttons where exactly one is chosen, like Off and On. */
export const SegmentedControl = <T extends string | number | boolean>({
	value,
	onChange,
	options,
	fill = false,
	className,
	"aria-label": ariaLabel,
}: SegmentedControlProps<T>) => (
	<div
		role="group"
		aria-label={ariaLabel}
		className={cn(
			"flex bg-secondary rounded-lg",
			fill ? "gap-1 p-1" : "gap-0.5 p-0.5",
			className
		)}
	>
		{options.map((option) => {
			const selected = option.value === value;
			return (
				<button
					key={String(option.value)}
					type="button"
					aria-pressed={selected}
					onClick={() => onChange(option.value)}
					className={cn(
						"rounded-md text-xs font-medium transition-colors",
						fill
							? "flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3"
							: "px-3 py-1",
						selected
							? "bg-background text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground"
					)}
				>
					{option.icon}
					{option.label}
				</button>
			);
		})}
	</div>
);
