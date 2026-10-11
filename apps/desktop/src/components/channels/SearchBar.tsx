// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SearchBarProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}

export const SearchBar = ({
	value,
	onChange,
	placeholder = "Search channels...",
	className,
}: SearchBarProps) => {
	return (
		<div className={cn("relative w-52", className)}>
			<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="pl-8 pr-8 h-8 text-sm bg-secondary border-transparent focus-visible:border-primary focus-visible:ring-0"
			/>
			{value && (
				<button
					onClick={() => onChange("")}
					className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
};
