// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId } from "react";

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
}

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
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			onClick={onCancel}
		>
			<div
				className="bg-card border border-border rounded-lg p-5 w-[320px] shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 id={titleId} className="text-sm font-semibold mb-1.5">
					{title}
				</h3>
				<p className="text-xs text-muted-foreground mb-4">{message}</p>
				<div className="flex justify-end gap-2">
					<button
						className="px-3 py-1.5 text-xs rounded-md hover:bg-accent"
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						className="px-3 py-1.5 text-xs rounded-md bg-red-600 text-white hover:bg-red-500"
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
};
