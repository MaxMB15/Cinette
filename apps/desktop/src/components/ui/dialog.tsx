// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { cn } from "@/lib/utils";

type DialogName = { labelledBy: string; label?: never } | { label: string; labelledBy?: never };

type DialogProps = DialogName & {
	onClose: () => void;
	/** Added to the backdrop, a fixed overlay over the whole window by default. */
	overlayClassName?: string;
	/** The dialog box itself. */
	className?: string;
	children: ReactNode;
};

/**
 * A modal over a dimmed backdrop. A click on the backdrop or Escape closes it,
 * and focus moves into it and stays there until it closes.
 */
export const Dialog = ({
	onClose,
	overlayClassName,
	className,
	children,
	labelledBy,
	label,
}: DialogProps) => {
	const dialogRef = useRef<HTMLDivElement>(null);
	useFocusTrap(dialogRef);

	return (
		<div
			className={cn(
				"fixed inset-0 z-50 flex items-center justify-center bg-black/60",
				overlayClassName
			)}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key !== "Escape") return;
				// The screen behind may have its own Escape shortcut, like leaving full screen.
				e.stopPropagation();
				onClose();
			}}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={labelledBy}
				aria-label={label}
				tabIndex={-1}
				className={cn("focus:outline-none", className)}
			>
				{children}
			</div>
		</div>
	);
};
