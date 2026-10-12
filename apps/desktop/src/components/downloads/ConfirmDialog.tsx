// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
	/** Leave out for a notice. It then has one button, and clicking outside it confirms. */
	onCancel?: () => void;
}

export const ConfirmDialog = ({
	open,
	title,
	message,
	confirmLabel,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) => {
	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			onClick={onCancel ?? onConfirm}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="bg-card border border-border rounded-lg p-5 w-[320px] shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="text-sm font-semibold mb-1.5">{title}</h3>
				<p className="text-xs text-muted-foreground mb-4 max-h-[50vh] overflow-y-auto whitespace-pre-line break-words">
					{message}
				</p>
				<div className="flex justify-end gap-2">
					{onCancel && (
						<button
							className="px-3 py-1.5 text-xs rounded-md hover:bg-accent"
							onClick={onCancel}
						>
							Cancel
						</button>
					)}
					<button
						className={`px-3 py-1.5 text-xs rounded-md ${
							onCancel
								? "bg-red-600 text-white hover:bg-red-500"
								: "bg-primary text-primary-foreground hover:bg-primary/90"
						}`}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
};
