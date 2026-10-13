// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { RefreshCw } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BusyButtonProps extends ButtonProps {
	busy: boolean;
	/** Replaces the label while busy, so the button says what it is doing. */
	busyLabel: string;
}

/** A small refresh button that spins its icon and stays disabled while its action runs. */
export const BusyButton = ({ busy, busyLabel, disabled, children, ...props }: BusyButtonProps) => (
	<Button variant="secondary" size="sm" disabled={busy || disabled} {...props}>
		<RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", busy && "animate-spin")} />
		{busy ? busyLabel : children}
	</Button>
);
