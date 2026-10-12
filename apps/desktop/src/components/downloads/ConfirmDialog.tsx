// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId, useRef, type ReactNode } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
	/** Leave out for a notice. It then has one button, and clicking outside it confirms. */
	onCancel?: () => void;
	/** The label of the button that closes the dialog without acting. */
	cancelLabel?: string;
	/**
	 * A red confirm button, for actions that delete something. On by default
	 * when the dialog asks, off for a notice.
	 */
	destructive?: boolean;
	confirmDisabled?: boolean;
	/** More content below the message, such as fields or a warning. */
	children?: ReactNode;
}

/**
 * A modal that asks before an action, or a notice with one button. Focus
 * moves into it when it opens and stays there, Escape closes it the way a
 * click outside it does, and keys pressed in it don't reach what is behind
 * it, such as the player's shortcuts.
 */
export const ConfirmDialog = (props: ConfirmDialogProps) =>
	props.open ? <ConfirmPanel {...props} /> : null;

/** Mounted only while the dialog is open, so the focus trap starts on each open. */
const ConfirmPanel = ({
	title,
	message,
	confirmLabel,
	onConfirm,
	onCancel,
	cancelLabel = "Cancel",
	destructive = onCancel !== undefined,
	confirmDisabled = false,
	children,
}: ConfirmDialogProps) => {
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	useFocusTrap(dialogRef);
	const dismiss = onCancel ?? onConfirm;
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			onClick={dismiss}
			onKeyDown={(e) => {
				// The focus trap listens for Tab on the document, so Tab carries on.
				if (e.key === "Tab") return;
				e.stopPropagation();
				if (e.key === "Escape") dismiss();
			}}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				className="bg-card border border-border rounded-lg p-5 w-[320px] shadow-xl outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 id={titleId} className="text-sm font-semibold mb-1.5">
					{title}
				</h3>
				<p className="text-xs text-muted-foreground mb-4 max-h-[50vh] overflow-y-auto whitespace-pre-line break-words">
					{message}
				</p>
				{children && <div className="mb-4">{children}</div>}
				<div className="flex justify-end gap-2">
					{onCancel && (
						<button
							className="px-3 py-1.5 text-xs rounded-md hover:bg-accent"
							onClick={onCancel}
						>
							{cancelLabel}
						</button>
					)}
					<button
						className={`px-3 py-1.5 text-xs rounded-md disabled:opacity-50 disabled:pointer-events-none ${
							destructive
								? "bg-red-600 text-white hover:bg-red-500"
								: "bg-primary text-primary-foreground hover:bg-primary/90"
						}`}
						onClick={onConfirm}
						disabled={confirmDisabled}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
};
