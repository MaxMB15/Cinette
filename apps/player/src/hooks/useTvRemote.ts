// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { topFocusTrap } from "@/hooks/useFocusTrap";
import { useLatestRef } from "@/hooks/useLatestRef";
import { directionForKey } from "@/lib/spatial-nav";
import { handleBack } from "@/lib/tv-back";
import { focusTvStart, keepsArrow, moveFocus } from "@/lib/tv-focus";

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
 * `handleBack`. The player takes its own arrows first. OK with nothing
 * focused goes to the screen's start, so no press is lost.
 */
export const useTvRemote = (): void => {
	// useNavigate gives a new function on each route change, so the listeners
	// read it through a ref and stay put for the layout's life.
	const navigateRef = useLatestRef(useNavigate());
	const { pathname } = useLocation();
	const atHomeRef = useLatestRef(pathname === "/");

	useEffect(
		() => {
			const onKey = (e: KeyboardEvent) => {
				if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
				if (e.key === "Enter" && document.activeElement === document.body) {
					if (focusTvStart(topFocusTrap() ?? document)) e.preventDefault();
					return;
				}
				const direction = directionForKey(e.key);
				if (!direction || keepsArrow(e.target, direction)) return;
				if (moveFocus(direction)) e.preventDefault();
			};
			// A held OK must stay one press. Otherwise the repeats press whatever
			// the first one opened, such as the first row of a new list.
			const onKeyCapture = (e: KeyboardEvent) => {
				if (e.key !== "Enter" || !e.repeat) return;
				e.preventDefault();
				e.stopPropagation();
			};
			window.addEventListener("keydown", onKey);
			window.addEventListener("keydown", onKeyCapture, { capture: true });
			window.__cinetteBack = () =>
				handleBack(document, atHomeRef.current, () => navigateRef.current("/")) !== "exit";
			return () => {
				window.removeEventListener("keydown", onKey);
				window.removeEventListener("keydown", onKeyCapture, { capture: true });
				delete window.__cinetteBack;
			};
		},
		// Stryker disable next-line ArrayDeclaration: both refs keep their identity, so the effect runs once either way.
		[navigateRef, atHomeRef]
	);
};
