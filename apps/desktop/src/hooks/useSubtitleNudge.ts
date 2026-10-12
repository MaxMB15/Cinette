// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, type Dispatch, type SetStateAction } from "react";
import { hasOpenFocusTrap } from "@/hooks/useFocusTrap";
import { isSubtitleNudgeKey, nudgeSubtitle, type SubtitlePosition } from "@/lib/subtitle-position";

/**
 * While `active`, the arrow keys move the subtitles a step at a time. A modal
 * open over the player, such as a confirm, keeps its keys.
 */
export const useSubtitleNudge = (
	active: boolean,
	setPosition: Dispatch<SetStateAction<SubtitlePosition>>
): void => {
	useEffect(() => {
		if (!active) return;
		const handleKey = (e: KeyboardEvent) => {
			if (!isSubtitleNudgeKey(e.key) || hasOpenFocusTrap()) return;
			e.preventDefault();
			const key = e.key;
			setPosition((p) => nudgeSubtitle(p, key));
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [active, setPosition]);
};
