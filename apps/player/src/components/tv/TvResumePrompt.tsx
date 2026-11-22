// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Play, RotateCcw } from "lucide-react";
import { formatTime } from "@/lib/format";
import { TvPrompt } from "./TvPrompt";
import { TvButton } from "./ui";

/**
 * Asks where to start something the viewer stopped part-way through. It opens
 * on Resume, so OK goes on watching, and Back leaves.
 */
export const TvResumePrompt = ({
	title,
	position,
	duration,
	onResume,
	onStartOver,
	onCancel,
}: {
	title: string;
	position: number;
	duration: number;
	onResume: () => void;
	onStartOver: () => void;
	onCancel: () => void;
}) => (
	<TvPrompt
		title={title}
		label={`Resume ${title}`}
		text={`You stopped at ${formatTime(position)}${duration > 0 ? ` of ${formatTime(duration)}` : ""}`}
		onClose={onCancel}
	>
		<TvButton onClick={onResume}>
			<Play aria-hidden className="size-[1.25rem] fill-current" />
			Resume
		</TvButton>
		<TvButton onClick={onStartOver}>
			<RotateCcw aria-hidden className="size-[1.25rem]" />
			Start over
		</TvButton>
	</TvPrompt>
);
