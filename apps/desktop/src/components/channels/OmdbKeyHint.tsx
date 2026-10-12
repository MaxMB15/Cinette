// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Link } from "react-router-dom";
import { OMDB_KEY_FOCUS } from "@/hooks/useScrollToOmdbKey";

interface OmdbKeyHintProps {
	/** Closes the sheet the hint sits in before Settings opens. */
	onNavigate: () => void;
}

/** Shown in an info sheet in place of the OMDb details when no key is saved. */
export const OmdbKeyHint = ({ onNavigate }: OmdbKeyHintProps) => (
	// The padding makes the link easier to tap and the negative margin keeps
	// the layout as it was.
	<Link
		to="/settings"
		state={OMDB_KEY_FOCUS}
		onClick={onNavigate}
		className="block -my-2 py-2 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
	>
		Add an OMDb API key in <span className="underline underline-offset-2">Settings</span> to see
		the plot, cast and ratings.
	</Link>
);
