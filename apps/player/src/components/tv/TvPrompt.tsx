// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";

/** A question over the screen with buttons in a row. Back closes it. */
export const TvPrompt = ({
	title,
	text,
	label = title,
	onClose,
	children,
}: {
	title: string;
	text: ReactNode;
	/** What a screen reader calls it, when that isn't the title. */
	label?: string;
	onClose: () => void;
	children: ReactNode;
}) => (
	<Dialog
		label={label}
		onClose={onClose}
		overlayClassName="bg-black/95"
		className="w-[34rem] text-white"
	>
		<h2 className="truncate text-[2rem] leading-[2.5rem] font-semibold">{title}</h2>
		<p className="mt-[0.5rem] text-base opacity-70">{text}</p>
		<div className="mt-[1.5rem] flex gap-[0.75rem]">{children}</div>
	</Dialog>
);
