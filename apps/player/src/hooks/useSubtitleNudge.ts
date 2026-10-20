// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, type Dispatch, type SetStateAction } from "react";
import { hasOpenFocusTrap } from "@/hooks/useFocusTrap";
import { isSubtitleNudgeKey, nudgeSubtitle, type SubtitlePosition } from "@/lib/subtitle-position";

/**
 * While `active`, the arrow keys move the subtitles a step at a time. A modal
 * open over the player, such as a confirm, keeps its keys.
 *
 * It listens on the document, which hears a key before the window does, so
 * a TV remote's window listener (`useTvRemote`) sees the key was used and
 * doesn't move focus as well.
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
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [active, setPosition]);
};
