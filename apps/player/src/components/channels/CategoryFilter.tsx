// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Category } from "@/lib/types";

interface CategoryFilterProps {
	categories: Category[];
	selected: string | null;
	onSelect: (name: string | null) => void;
}

export const CategoryFilter = ({ categories, selected, onSelect }: CategoryFilterProps) => (
	<ScrollArea className="w-full">
		<div className="flex gap-1.5 pb-1">
			<Chip active={selected === null} onClick={() => onSelect(null)}>
				All
			</Chip>
			{categories.map((cat) => (
				<Chip
					key={cat.id}
					active={selected === cat.name}
					onClick={() => onSelect(cat.name === selected ? null : cat.name)}
				>
					{cat.name}
					<span className="ml-1.5 text-[10px] opacity-60">{cat.channelCount}</span>
				</Chip>
			))}
		</div>
	</ScrollArea>
);

const Chip = ({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) => {
	return (
		<button
			onClick={onClick}
			className={cn(
				"shrink-0 px-3 py-1 rounded-md text-xs font-medium transition-colors",
				active
					? "bg-primary text-primary-foreground"
					: "bg-secondary text-secondary-foreground hover:bg-accent hover:text-foreground"
			)}
		>
			{children}
		</button>
	);
};
