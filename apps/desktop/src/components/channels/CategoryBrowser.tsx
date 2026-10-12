// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { ReactNode } from "react";
import { ChevronRight, FolderOpen, Tv2 } from "lucide-react";
import { formatCount } from "@/lib/format";

interface SuperCategoryInfo {
	name: string;
	groupCount: number;
	channelCount: number;
}

interface CategoryBrowserProps {
	superCategories: SuperCategoryInfo[];
	topLevelGroups: { name: string; channelCount: number }[];
	onSelectCategory: (name: string) => void;
	onSelectGroup: (name: string) => void;
	onManage: () => void;
}

interface CategoryTileProps {
	name: string;
	icon: ReactNode;
	detail: string;
	onSelect: () => void;
}

const CategoryTile = ({ name, icon, detail, onSelect }: CategoryTileProps) => (
	<button
		onClick={onSelect}
		className="flex flex-col items-start gap-1.5 p-3 rounded-xl bg-secondary/80 border border-border/50 hover:bg-accent hover:border-primary/30 transition-all text-left group"
	>
		<div className="flex items-center justify-between w-full">
			{icon}
			<ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 group-hover:text-primary transition-colors" />
		</div>
		<div className="text-sm font-medium leading-tight">{name}</div>
		<div className="text-[10px] text-muted-foreground">{detail}</div>
	</button>
);

export const CategoryBrowser = ({
	superCategories,
	topLevelGroups,
	onSelectCategory,
	onSelectGroup,
	onManage,
}: CategoryBrowserProps) => (
	<div className="px-3 pt-2 pb-1">
		<div className="flex items-center justify-between mb-2">
			<span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
				Categories
			</span>
			<button onClick={onManage} className="text-xs text-primary hover:underline">
				Manage
			</button>
		</div>
		<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
			{superCategories.map((cat) => (
				<CategoryTile
					key={cat.name}
					name={cat.name}
					icon={<FolderOpen className="h-4 w-4 text-primary/70" />}
					detail={`${formatCount(cat.groupCount, "group")} \u00b7 ${cat.channelCount.toLocaleString()} ch`}
					onSelect={() => onSelectCategory(cat.name)}
				/>
			))}
			{topLevelGroups.map((group) => (
				<CategoryTile
					key={group.name}
					name={group.name}
					icon={<Tv2 className="h-4 w-4 text-muted-foreground/70" />}
					detail={formatCount(group.channelCount, "channel")}
					onSelect={() => onSelectGroup(group.name)}
				/>
			))}
		</div>
	</div>
);
