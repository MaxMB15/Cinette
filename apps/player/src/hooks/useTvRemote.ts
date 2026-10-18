// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useLatestRef } from "@/hooks/useLatestRef";
import { directionForKey } from "@/lib/spatial-nav";
import { handleBack } from "@/lib/tv-back";
import { keepsArrow, moveFocus } from "@/lib/tv-focus";

declare global {
	interface Window {
		/**
		 * Called by MainActivity.kt when Back is pressed. Returns false when
		 * the page has nothing to close and the app should close instead.
		 */
		__cinetteBack?: () => boolean;
	}
}

/**
 * The TV remote's D-pad and Back key. An arrow that nothing else used moves
 * focus to the nearest control in its direction, and Back goes through
 * `handleBack`. The player takes its own arrows first.
 */
export const useTvRemote = (): void => {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const atHomeRef = useLatestRef(pathname === "/");

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
			const direction = directionForKey(e.key);
			if (!direction || keepsArrow(e.target, direction)) return;
			if (moveFocus(direction)) e.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		window.__cinetteBack = () =>
			handleBack(document, atHomeRef.current, () => navigate("/")) !== "exit";
		return () => {
			window.removeEventListener("keydown", onKey);
			delete window.__cinetteBack;
		};
	}, [navigate, atHomeRef]);
};
