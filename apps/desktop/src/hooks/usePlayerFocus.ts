// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, type RefObject } from "react";
import { hasOpenFocusTrap } from "./useFocusTrap";

/**
 * Gives the player keyboard focus when it opens and again each time a stream
 * loads, so its keys work without a click first. Focus already inside the
 * player, such as on the resume prompt, stays put. So does focus on a confirm
 * opened from the controls, which renders outside the player.
 */
export const usePlayerFocus = (
	containerRef: RefObject<HTMLElement | null>,
	currentUrl: string | null
): void => {
	useEffect(() => {
		containerRef.current?.focus();
	}, [containerRef]);

	useEffect(() => {
		const container = containerRef.current;
		if (!currentUrl || !container) return;
		if (container.contains(document.activeElement) || hasOpenFocusTrap()) return;
		container.focus();
	}, [containerRef, currentUrl]);
};
