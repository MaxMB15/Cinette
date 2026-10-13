// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { RotateCcw, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface SkipIconProps {
	direction: "back" | "forward";
	seconds: number;
	/** Size of the arrow, such as "h-6 w-6". */
	className?: string;
	/** Size of the number inside it. */
	labelClassName?: string;
}

/** A circular arrow with the skip length inside, like Apple's gobackward.10 symbol. */
export const SkipIcon = ({ direction, seconds, className, labelClassName }: SkipIconProps) => {
	const Arrow = direction === "back" ? RotateCcw : RotateCw;
	return (
		<span
			aria-hidden="true"
			className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
		>
			<Arrow className="absolute inset-0 h-full w-full" strokeWidth={1.75} />
			<span className={cn("font-semibold leading-none tabular-nums", labelClassName)}>
				{seconds}
			</span>
		</span>
	);
};
