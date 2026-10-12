// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId, type ReactNode } from "react";

interface FieldProps {
	label: string;
	/** Keeps the label for screen readers only, for compact forms that show placeholders instead. */
	hideLabel?: boolean;
	className?: string;
	/** Gets the id to put on the control so the label names it. */
	children: (id: string) => ReactNode;
}

export const Field = ({ label, hideLabel = false, className, children }: FieldProps) => {
	const id = useId();
	return (
		<div className={className}>
			<label
				htmlFor={id}
				className={hideLabel ? "sr-only" : "text-xs text-muted-foreground mb-1 block"}
			>
				{label}
			</label>
			{children(id)}
		</div>
	);
};
