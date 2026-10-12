// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@/components/ui/dialog";

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
	/** Leave out for a notice. It then has one button, and clicking outside it or Escape confirms. */
	onCancel?: () => void;
}

const BUTTON =
	"px-3 py-1.5 text-xs rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Asks before an action, or gives a notice with a single button. It renders
 * into the page body so a parent that clips or transforms, like a sheet,
 * can't cut it off. Focus starts on its first button.
 */
export const ConfirmDialog = ({
	open,
	title,
	message,
	confirmLabel,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) => {
	const titleId = useId();
	if (!open) return null;
	return createPortal(
		<Dialog
			onClose={onCancel ?? onConfirm}
			labelledBy={titleId}
			// Above the full screen player, which sits at z-[9999].
			overlayClassName="z-[10000]"
			className="bg-card border border-border rounded-lg p-5 w-[320px] shadow-xl"
		>
			<h3 id={titleId} className="text-sm font-semibold mb-1.5">
				{title}
			</h3>
			<p className="text-xs text-muted-foreground mb-4 max-h-[50vh] overflow-y-auto whitespace-pre-line break-words">
				{message}
			</p>
			<div className="flex justify-end gap-2">
				{onCancel && (
					<button
						type="button"
						className={`${BUTTON} hover:bg-accent`}
						onClick={onCancel}
					>
						Cancel
					</button>
				)}
				<button
					type="button"
					className={`${BUTTON} ${
						onCancel
							? "bg-red-600 text-white hover:bg-red-500"
							: "bg-primary text-primary-foreground hover:bg-primary/90"
					}`}
					onClick={onConfirm}
				>
					{confirmLabel}
				</button>
			</div>
		</Dialog>,
		document.body
	);
};
