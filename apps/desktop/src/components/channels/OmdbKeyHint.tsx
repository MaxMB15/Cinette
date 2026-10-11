// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, type RefObject } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

/** Route state that makes Settings scroll to the OMDb key field. */
export const OMDB_KEY_FOCUS = { focus: "omdb" } as const;

/**
 * Scrolls Settings to the OMDb key field when the hint opened it, then clears
 * the route state so going back to that entry doesn't scroll again.
 */
export const useScrollToOmdbKey = (ref: RefObject<HTMLElement | null>) => {
	const location = useLocation();
	const navigate = useNavigate();
	useEffect(() => {
		const state = location.state as { focus?: string } | null;
		if (state?.focus !== OMDB_KEY_FOCUS.focus) return;
		ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
		navigate(location.pathname, { replace: true, state: null });
	}, [location.state, location.pathname, navigate, ref]);
};

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
