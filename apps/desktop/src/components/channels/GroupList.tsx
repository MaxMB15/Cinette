// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Pin, PinOff, ChevronRight } from "lucide-react";
import type { Category } from "@/lib/types";
import { channelCountFor } from "@/lib/channels";
import { isFromInnerButton } from "@/lib/utils";

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
				// The group's name is the button that opens it, and the pin sits
				// beside it rather than inside, so each is reached on its own. A
				// click elsewhere on the row opens the group too.
				<div
					key={name}
					className="flex items-center justify-between rounded-lg bg-secondary hover:bg-accent transition-colors cursor-pointer"
					onClick={(e) => {
						if (!isFromInnerButton(e)) onSelectGroup(name);
					}}
				>
					<button
						type="button"
						onClick={() => onSelectGroup(name)}
						className="flex flex-1 min-w-0 items-center gap-2 p-2.5 text-left rounded-lg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
						<span className="text-sm">{name}</span>
						<span className="text-xs text-muted-foreground">
							{channelCountFor(categories, name)} ch
						</span>
					</button>
					<div className="flex items-center gap-2 pr-2.5">
						<button
							type="button"
							// The label stays fixed and aria-pressed says whether it's pinned.
							aria-label={`Pin ${name}`}
							aria-pressed={isPinned(name)}
							onClick={() => onTogglePin(name)}
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
