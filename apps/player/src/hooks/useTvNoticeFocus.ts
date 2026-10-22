// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, type KeyboardEvent } from "react";
import { getPlatform } from "@/lib/platform";

/**
 * A notice that a TV remote can use. Spread what it returns on the notice's
 * panel.
 *
 * On a TV the panel takes the focus when the notice shows, or shows
 * something new (`shown` changes), since nothing else would bring the D-pad
 * to it. The panel, not a button, so a center press meant for the player
 * behind, or a second press right after a dialog's Allow, does nothing; the
 * D-pad moves on into its buttons. When it goes, the focus goes back to
 * where it was. Elsewhere the focus stays put.
 *
 * Escape, which is the TV's Back, dismisses it, and stops there.
 */
export const useTvNoticeFocus = (shown: unknown, onDismiss: () => void) => {
	const panel = useRef<HTMLDivElement>(null);
	const tv = getPlatform() === "tv";
	useEffect(() => {
		// Nothing shows, so there's nothing to bring the focus to.
		if (!tv || !panel.current) return;
		const before = document.activeElement;
		panel.current.focus();
		return () => {
			// The page's element may have gone meanwhile, and focusing one
			// that's off the page does nothing.
			// Stryker disable next-line ConditionalExpression: document.activeElement is always the body or a focused element here, which these are, so no test can make it anything else.
			if (before instanceof HTMLElement || before instanceof SVGElement) before.focus();
		};
	}, [tv, shown]);
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		onDismiss();
	};
	return { ref: panel, tabIndex: tv ? 0 : undefined, onKeyDown };
};
