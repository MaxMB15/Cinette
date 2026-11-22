// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** The height a panel's list can take, under its title. */
export const PANEL_LIST_HEIGHT = 30;

/**
 * A panel along one side of the screen, over the video, which keeps playing
 * beside it. Back closes it.
 */
export const TvPanel = ({
	title,
	side,
	className,
	onClose,
	children,
}: {
	title: string;
	side?: "left" | "right";
	/** A width other than the usual one, for instance. */
	className?: string;
	onClose: () => void;
	children: ReactNode;
}) => (
	<Dialog
		label={title}
		onClose={onClose}
		overlayClassName={cn("bg-transparent", side === "left" ? "justify-start" : "justify-end")}
		className={cn(
			"flex h-full w-[26rem] flex-col bg-black/90 px-[1.25rem] pt-[1.25rem] text-white",
			className
		)}
	>
		<h2 className="mb-[0.75rem] truncate px-[0.5rem] text-[1.5rem] leading-[2rem] font-semibold">
			{title}
		</h2>
		{children}
	</Dialog>
);
