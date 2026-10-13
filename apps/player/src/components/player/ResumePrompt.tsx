// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { RotateCcw, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatTime } from "@/lib/format";

interface ResumePromptProps {
	title: string;
	position: number;
	duration: number;
	onResume: () => void;
	onStartOver: () => void;
	onCancel: () => void;
}

/** Shown when opening a movie/episode that was previously stopped part-way through. */
export const ResumePrompt = ({
	title,
	position,
	duration,
	onResume,
	onStartOver,
	onCancel,
}: ResumePromptProps) => {
	const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

	return (
		<Dialog
			onClose={onCancel}
			labelledBy="resume-prompt-title"
			overlayClassName="absolute bg-black/70 backdrop-blur-xs"
			className="w-full max-w-sm mx-4 rounded-xl border border-white/10 bg-neutral-900/95 p-5 text-white shadow-2xl"
		>
			<h2 id="resume-prompt-title" className="text-base font-semibold">
				Resume watching?
			</h2>
			<p className="mt-1 text-sm text-white/70 truncate" title={title}>
				{title}
			</p>

			<div className="mt-4">
				<div className="h-1 w-full rounded-full bg-white/15 overflow-hidden">
					<div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
				</div>
				<p className="mt-1.5 text-xs text-white/50">
					Stopped at {formatTime(position)}
					{duration > 0 && ` of ${formatTime(duration)}`}
				</p>
			</div>

			<div className="mt-5 flex flex-col gap-2">
				<Button onClick={onResume} className="w-full justify-center gap-2">
					<Play className="h-4 w-4" />
					Resume from {formatTime(position)}
				</Button>
				<Button
					variant="ghost"
					onClick={onStartOver}
					className="w-full justify-center gap-2 text-white hover:bg-white/10"
				>
					<RotateCcw className="h-4 w-4" />
					Start from the beginning
				</Button>
			</div>
		</Dialog>
	);
};
