// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { playerShortcuts } from "@/lib/hotkeys";
import type { SkipIntervals } from "@/lib/player-prefs";

interface ShortcutsOverlayProps {
	/** How far the arrow and J/L keys skip. */
	skip: SkipIntervals;
	onClose: () => void;
}

export const ShortcutsOverlay = ({ skip, onClose }: ShortcutsOverlayProps) => {
	const dialogRef = useRef<HTMLDivElement>(null);
	useFocusTrap(dialogRef);

	return (
		<div
			className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label="Keyboard shortcuts"
				tabIndex={-1}
				className="w-full max-w-md mx-4 rounded-xl border border-white/10 bg-neutral-900/95 p-5 text-white shadow-2xl"
			>
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-base font-semibold">Keyboard shortcuts</h2>
					<Button
						variant="ghost"
						size="icon"
						onClick={onClose}
						className="h-7 w-7 text-white hover:bg-white/20"
						aria-label="Close"
					>
						<X className="h-4 w-4" />
					</Button>
				</div>
				<ul className="space-y-1.5">
					{playerShortcuts(skip).map(({ keys, label }) => (
						<li
							key={label + keys.join()}
							className="flex items-center justify-between gap-4 text-sm"
						>
							<span className="text-white/70">{label}</span>
							<span className="flex gap-1 shrink-0">
								{keys.map((k) => (
									<kbd
										key={k}
										className="min-w-[1.75rem] rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-center text-xs font-mono text-white"
									>
										{k}
									</kbd>
								))}
							</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
};
