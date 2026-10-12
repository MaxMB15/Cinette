// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PinnedGroup, Category } from "@/lib/types";
import { channelCountFor } from "@/lib/channels";

interface PinnedGroupsRowProps {
	pinnedGroups: PinnedGroup[];
	categories: Category[];
	selectedGroup: string | null;
	onSelectGroup: (groupName: string) => void;
	onUnpin: (groupName: string) => void;
}

export const PinnedGroupsRow = ({
	pinnedGroups,
	categories,
	selectedGroup,
	onSelectGroup,
	onUnpin,
}: PinnedGroupsRowProps) => {
	if (pinnedGroups.length === 0) return null;

	return (
		<div className="px-4 py-2">
			<div className="flex items-center gap-1.5 mb-2">
				<span className="text-sm font-semibold text-muted-foreground">Pinned Groups</span>
			</div>
			<ScrollArea className="w-full">
				<div className="flex gap-2 pb-1">
					{pinnedGroups.map((pin) => (
						<div key={pin.groupName} className="flex items-center shrink-0 group">
							<button
								onClick={() => onSelectGroup(pin.groupName)}
								className={`flex items-center gap-2 px-3 py-1.5 rounded-l-lg text-xs border transition-colors ${
									selectedGroup === pin.groupName
										? "bg-primary text-primary-foreground border-primary"
										: "bg-secondary text-secondary-foreground border-border hover:bg-accent"
								}`}
							>
								<span>{pin.groupName}</span>
								<span className="opacity-60 text-[10px]">
									{channelCountFor(categories, pin.groupName)}
								</span>
							</button>
							<button
								onClick={() => onUnpin(pin.groupName)}
								className={`px-1.5 py-1.5 rounded-r-lg border border-l-0 text-xs opacity-0 group-hover:opacity-100 hover:text-destructive transition-all ${
									selectedGroup === pin.groupName
										? "border-primary bg-primary text-primary-foreground"
										: "border-border bg-secondary hover:bg-accent"
								}`}
								aria-label={`Unpin ${pin.groupName}`}
							>
								<X className="h-3 w-3" />
							</button>
						</div>
					))}
				</div>
			</ScrollArea>
		</div>
	);
};
