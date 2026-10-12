// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** Where the subtitles sit, as a percentage of the player's width and height. */
export interface SubtitlePosition {
	x: number;
	y: number;
}

/** Where the subtitles start, near the bottom in the middle. */
export const DEFAULT_SUBTITLE_POSITION: SubtitlePosition = { x: 50, y: 88 };

/** How far one arrow key press moves the subtitles, in percent. */
export const SUBTITLE_NUDGE_STEP = 2;

/** How far each arrow key moves the subtitles. */
const ARROW_STEPS = new Map<string, SubtitlePosition>([
	["ArrowLeft", { x: -SUBTITLE_NUDGE_STEP, y: 0 }],
	["ArrowRight", { x: SUBTITLE_NUDGE_STEP, y: 0 }],
	["ArrowUp", { x: 0, y: -SUBTITLE_NUDGE_STEP }],
	["ArrowDown", { x: 0, y: SUBTITLE_NUDGE_STEP }],
]);

/** `pos` kept far enough from the player's edges that the text stays inside it. */
export const clampSubtitlePosition = ({ x, y }: SubtitlePosition): SubtitlePosition => ({
	x: Math.min(95, Math.max(5, x)),
	y: Math.min(97, Math.max(3, y)),
});

/** Whether `key` is one of the arrow keys that move the subtitles. */
export const isSubtitleNudgeKey = (key: string): boolean => ARROW_STEPS.has(key);

/** `pos` moved one step the way the arrow `key` points. Other keys leave it where it is. */
export const nudgeSubtitle = (pos: SubtitlePosition, key: string): SubtitlePosition => {
	const step = ARROW_STEPS.get(key);
	return step ? clampSubtitlePosition({ x: pos.x + step.x, y: pos.y + step.y }) : pos;
};
