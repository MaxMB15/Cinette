// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, type RefObject } from "react";
import { useLocation, useNavigate } from "react-router";

/** Route state that opens Settings at the OMDb key field. */
export const OMDB_KEY_FOCUS = { focus: "omdb" } as const;

/**
 * Scrolls Settings to the OMDb key field and focuses it when the hint in an
 * info sheet opened the page, then clears the route state so going back to
 * that entry doesn't do it again.
 */
export const useScrollToOmdbKey = (ref: RefObject<HTMLInputElement | null>) => {
	const location = useLocation();
	const navigate = useNavigate();
	useEffect(() => {
		const state = location.state as { focus?: string } | null;
		if (state?.focus !== OMDB_KEY_FOCUS.focus) return;
		const input = ref.current;
		if (input) {
			input.scrollIntoView({ block: "center", behavior: "smooth" });
			// Focusing scrolls at once, which would cut the smooth scroll short.
			input.focus({ preventScroll: true });
		}
		navigate(location.pathname, { replace: true, state: null });
	}, [location.state, location.pathname, navigate, ref]);
};
