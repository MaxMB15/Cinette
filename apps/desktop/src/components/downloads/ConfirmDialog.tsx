// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { ReactNode } from "react";

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
	/** A red confirm button, for actions that delete something. On by default. */
	destructive?: boolean;
	confirmDisabled?: boolean;
	/** More content below the message, such as fields or a warning. */
	children?: ReactNode;
}

export const ConfirmDialog = ({
	open,
	title,
	message,
	confirmLabel,
	onConfirm,
	onCancel,
	destructive = true,
	confirmDisabled = false,
	children,
}: ConfirmDialogProps) => {
	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			onClick={onCancel}
		>
			<div
				role="dialog"
				aria-label={title}
				className="bg-card border border-border rounded-lg p-5 w-[320px] shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="text-sm font-semibold mb-1.5">{title}</h3>
				<p className="text-xs text-muted-foreground mb-4">{message}</p>
				{children && <div className="mb-4">{children}</div>}
				<div className="flex justify-end gap-2">
					<button
						className="px-3 py-1.5 text-xs rounded-md hover:bg-accent"
						onClick={onCancel}
					>
						Cancel
					</button>
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
