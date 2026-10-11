// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Pin, PinOff, ChevronRight } from "lucide-react";
import type { Category } from "@/lib/types";
import { channelCountFor } from "@/lib/channels";

interface GroupListProps {
	groups: string[];
	categories: Category[];
	onSelectGroup: (name: string) => void;
	isPinned: (name: string) => boolean;
	onTogglePin: (name: string) => void;
}

export const GroupList = ({
	groups,
	categories,
	onSelectGroup,
	isPinned,
	onTogglePin,
}: GroupListProps) => {
	return (
		<div className="px-4 pt-2 flex flex-col gap-1">
			{groups.map((name) => (
				<div
					key={name}
					role="button"
					tabIndex={0}
					className="flex items-center justify-between p-2.5 rounded-lg bg-secondary hover:bg-accent transition-colors cursor-pointer"
					onClick={() => onSelectGroup(name)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onSelectGroup(name);
						}
					}}
				>
					<div className="flex items-center gap-2">
						<span className="text-sm">{name}</span>
						<span className="text-xs text-muted-foreground">
							{channelCountFor(categories, name)} ch
						</span>
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							aria-label={isPinned(name) ? `Unpin ${name}` : `Pin ${name}`}
							aria-pressed={isPinned(name)}
							onClick={(e) => {
								e.stopPropagation();
								onTogglePin(name);
							}}
							onKeyDown={(e) => e.stopPropagation()}
							className={`p-1 rounded hover:bg-background transition-colors ${
								isPinned(name) ? "text-primary" : "text-muted-foreground"
							}`}
						>
							{isPinned(name) ? (
								<PinOff className="h-3.5 w-3.5" />
							) : (
								<Pin className="h-3.5 w-3.5" />
							)}
						</button>
						<ChevronRight className="h-4 w-4 text-muted-foreground" />
					</div>
				</div>
			))}
		</div>
	);
};
