// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, type ReactNode } from "react";
import { isTopFocusTrap, useFocusTrap } from "@/hooks/useFocusTrap";
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
 * and focus moves into it and stays there until it closes. With one dialog
 * open over another, Escape closes only the top one.
 */
export const Dialog = ({
	onClose,
	overlayClassName,
	className,
	children,
	labelledBy,
	label,
}: DialogProps) => {
	const overlayRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	useFocusTrap(dialogRef);

	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	});

	// Escape pressed while focus is outside the dialog, such as on the page
	// after the focused control went away. It runs before any other handler so
	// the screen behind never sees the key. Keys from inside the dialog are
	// left to the handler on the backdrop, so a control inside can use Escape
	// first.
	useEffect(() => {
		const handleKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !isTopFocusTrap(dialogRef.current)) return;
			if (e.target instanceof Node && overlayRef.current?.contains(e.target)) return;
			e.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("keydown", handleKey, true);
		return () => document.removeEventListener("keydown", handleKey, true);
	}, []);

	return (
		<div
			ref={overlayRef}
			className={cn(
				"fixed inset-0 z-50 flex items-center justify-center bg-black/60",
				overlayClassName
			)}
			onClick={(e) => {
				// A dialog opened from a clickable row, like a channel card, would
				// otherwise pass its clicks on to that row.
				e.stopPropagation();
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
