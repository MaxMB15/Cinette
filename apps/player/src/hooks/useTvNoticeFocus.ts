// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, type KeyboardEvent, type RefObject } from "react";
import { getPlatform } from "@/lib/platform";

/**
 * A notice that a TV remote can use. On a TV, `target` takes the focus when
 * the notice shows, or shows something new (`shown` changes), since nothing
 * else would bring the D-pad to it. When it goes, the focus goes back to
 * where it was, if that's still on the page. Elsewhere the focus stays put.
 *
 * Returns the notice's key handler: Escape, which is the TV's Back,
 * dismisses it.
 */
export const useTvNoticeFocus = (
	target: RefObject<HTMLElement | null>,
	shown: unknown,
	onDismiss: () => void
): ((e: KeyboardEvent) => void) => {
	useEffect(() => {
		// Nothing shows, so there's nothing to bring the focus to.
		if (getPlatform() !== "tv" || !target.current) return;
		const before = document.activeElement;
		target.current.focus();
		return () => {
			// The page's element may have gone meanwhile, and focusing one
			// that's off the page does nothing.
			// Stryker disable next-line ConditionalExpression: document.activeElement is always the body or a focused element here, which these are, so no test can make it anything else.
			if (before instanceof HTMLElement || before instanceof SVGElement) before.focus();
		};
	}, [target, shown]);
	return (e) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		onDismiss();
	};
};
