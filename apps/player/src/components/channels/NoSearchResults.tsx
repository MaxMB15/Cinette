// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { SearchX } from "lucide-react";

interface NoSearchResultsProps {
	query: string;
	/** What was searched, e.g. "movies" or "favorites". */
	scope?: string;
	/** A category or favorites-only filter is also narrowing the results. */
	filtered?: boolean;
	onClear: () => void;
}

/** Centered empty state shown when a search matches nothing. */
export const NoSearchResults = ({ query, scope, filtered, onClear }: NoSearchResultsProps) => (
	<div className="flex flex-col items-center justify-center h-full gap-2 text-center py-12 px-6">
		<SearchX className="h-10 w-10 text-muted-foreground/30" />
		<p className="text-sm font-medium">
			No {scope ?? "results"} matching “{query.trim()}”
		</p>
		<p className="text-xs text-muted-foreground max-w-xs">
			{filtered
				? "Try editing your search or removing the active filter."
				: "Check the spelling or try a shorter search."}
		</p>
		<button onClick={onClear} className="text-xs text-primary hover:underline mt-1">
			Clear search
		</button>
	</div>
);
